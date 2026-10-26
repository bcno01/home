#!/usr/bin/env python3
# 質問に答えるだけで works/ に新しい作品フォルダを作る
import datetime
import json
import re
import shlex
import shutil
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path

import build

ROOT = Path(__file__).resolve().parent.parent


def ask(prompt):
    try:
        return input(prompt).strip()
    except EOFError:
        return ""


def oembed(url):
    """YouTube / Spotify のURLからタイトルとサムネイルURLを取得(失敗したら空)"""
    host = build.host_of(url)
    if host in ("youtube.com", "youtu.be", "music.youtube.com"):
        endpoint = "https://www.youtube.com/oembed?format=json&url="
    elif host == "open.spotify.com":
        endpoint = "https://open.spotify.com/oembed?url="
    else:
        return {}
    try:
        with urllib.request.urlopen(endpoint + urllib.parse.quote(url, safe=""), timeout=6) as r:
            return json.load(r)
    except Exception:
        return {}


def slugify(title):
    s = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return s or "work"


def main():
    print("新しい作品を追加します。(スキップしたい項目はそのままEnter)\n")
    urls = []
    print("リンクのURLを1行ずつ貼り付けてください(終わったら空Enter)")
    while True:
        u = ask("  URL: ")
        if not u:
            break
        urls.append(u)

    meta = next((m for m in (oembed(u) for u in urls) if m), {})
    guess = meta.get("title", "")
    title = ask("タイトル%s: " % (" [%s]" % guess if guess else "")) or guess
    if not title:
        print("タイトルが必要です。中止しました。")
        return 1

    print("種類: 1=Streaming(音楽) 2=MV(動画) 3=通販・グッズ 4=その他 (Enterで自動判定)")
    t = {"1": "music", "2": "video", "3": "goods", "4": "other"}.get(ask("種類: "), "")
    desc = ask("一言説明: ")
    today = datetime.date.today().isoformat()
    date = ask("日付 [%s]: " % today) or today
    cover = ask("表紙画像(Finderからドラッグ&ドロップ。なければEnter): ")

    base = ROOT / "works" / ("%s-%s" % (date, slugify(title)))
    folder, n = base, 2
    while folder.exists():
        folder = base.with_name("%s-%d" % (base.name, n))
        n += 1
    folder.mkdir(parents=True)

    lines = ["title: " + title, "date: " + date]
    if t:
        lines.append("type: " + t)
    if desc:
        lines.append("description: " + desc)
    lines.append("links:")
    lines += urls
    (folder / "info.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")

    if cover:
        parts = shlex.split(cover)
        src = Path(parts[0]).expanduser() if parts else None
        if src and src.is_file() and src.suffix.lower() in build.IMG_EXT:
            shutil.copy2(src, folder / ("cover" + src.suffix.lower()))
        else:
            print("  ! 表紙画像が読み込めませんでした(jpg/png/webp/gif/svg のみ対応)")
    elif meta.get("thumbnail_url"):
        try:
            urllib.request.urlretrieve(meta["thumbnail_url"], str(folder / "cover.jpg"))
        except Exception:
            pass

    print("\n作成しました: %s" % folder.relative_to(ROOT))
    print("(写真を追加したい場合は、このフォルダに入れるだけでギャラリーになります)")
    if ask("\nサイトを更新しますか? [Y/n]: ").lower() in ("", "y", "yes"):
        build.main()
    return 0


if __name__ == "__main__":
    sys.exit(main())
