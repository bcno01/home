#!/usr/bin/env python3
# MV のオフボーカル(WAV など)を、GitHub の Releases にアップロードして、その MV のページに「ダウンロード」ボタンを付ける(標準ライブラリ + gh コマンド)
# 重い WAV をリポジトリに入れると、Git の履歴が重くなって戻せないので、Releases(1ファイル2GBまで)に置きます。
# 使い方: python3 offvocal_upload.py                   質問に答える(どの MV か → ファイルをドラッグして貼る)
#         python3 offvocal_upload.py ファイル            ファイルを指定して、MV だけ選ぶ
#         python3 offvocal_upload.py --dry-run          何をするかだけ表示(アップロードも、書き込みもしません)
# しくみ: Releases の「offvocal」(なければ作ります)に、<作品フォルダ名>-offvocal.wav という名前でアップロードし、
#         作品の info.txt に offvocal: URL・offvocal-size:・offvocal-type: を書きます。サイトを作り直すと、ボタンが出ます(公開は、いつもの手順で)。
# 事前に、gh コマンドのログインが必要です(ターミナルで gh auth login。済んでいなければ、このコマンドが案内します)。
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import build
import import_works as iw

TAG = "offvocal"
EXTS = {".wav", ".mp3", ".flac", ".m4a", ".zip"}
LIMIT = 2 * 1024 ** 3  # GitHub の Releases は、1ファイル 2GB まで


def gh(*args, check=True):
    return subprocess.run(["gh", *args], capture_output=True, text=True, check=check)


def clean_path(raw):
    """ターミナルにドラッグして貼ったパス(引用符や、空白の \\ つき)を、ふつうのパスにする"""
    p = raw.strip().strip("'\"")
    return Path(p.replace("\\ ", " ").replace("\\(", "(").replace("\\)", ")")).expanduser()


def mv_works():
    rows = []
    for info in iw.WORKS.glob("*/info.txt"):
        f = build.parse_info(info.read_text(encoding="utf-8"))[0]
        t = f.get("type", "").strip()
        t = build.TYPE_ALIAS.get(t, build.TYPE_ALIAS.get(t.lower(), t.lower()))
        if t != "video" or build.truthy(f.get("draft")):
            continue
        rows.append((info.parent.name, f.get("title", info.parent.name), f.get("offvocal", ""), info))
    rows.sort(reverse=True)
    return rows


def pick_work(rows):
    print("\nどの MV に付けますか?(新しい順。番号か、フォルダ名の頭を入力。Enter で、先頭の MV)")
    for i, (slug, title, url, _) in enumerate(rows[:15], 1):
        print("  %2d. %s  %s%s" % (i, slug[:10], title[:36], "   [オフボーカルあり]" if url else ""))
    if len(rows) > 15:
        print("  …ほか %d 本(フォルダ名の頭、例: 2022-11 で選べます)" % (len(rows) - 15))
    while True:
        a = input("選ぶ: ").strip()
        if not a:
            return rows[0]
        if a.isdigit() and 1 <= int(a) <= min(15, len(rows)):
            return rows[int(a) - 1]
        hit = [r for r in rows if r[0].startswith(a)]
        if len(hit) == 1:
            return hit[0]
        print("  ! 1つに決まりませんでした(%d 件)。もう少し長く入力してください" % len(hit) if hit else "  ! 見つかりませんでした")


def main():
    argv = sys.argv[1:]
    dry = "--dry-run" in argv
    args = [a for a in argv if not a.startswith("--")]
    if not shutil.which("gh"):
        print("gh コマンドが見つかりません。https://cli.github.com/ からインストールして、ターミナルで gh auth login を実行してください。")
        return 1
    if gh("auth", "status", check=False).returncode != 0:
        print("gh にログインしていません。ターミナルで gh auth login を実行してから、もう一度やり直してください。")
        return 1
    repo = gh("repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner", check=False).stdout.strip()
    if not repo:
        print("リポジトリを調べられませんでした(このフォルダが、GitHub のリポジトリか確認してください)。")
        return 1
    rows = mv_works()
    if not rows:
        print("MV の作品が見つかりません。")
        return 1
    slug, title, old, info = pick_work(rows)
    raw = args[0] if args else input("\nオフボーカルのファイルを、ここにドラッグして Enter(%s): " % "/".join(sorted(e[1:] for e in EXTS)))
    src = clean_path(raw)
    if not src.is_file():
        print("ファイルが見つかりません: %s" % src)
        return 1
    if src.suffix.lower() not in EXTS:
        print("対応していない形式です(%s)。%s のどれかにしてください。" % (src.suffix, " ".join(sorted(EXTS))))
        return 1
    size = src.stat().st_size
    if size > LIMIT:
        print("ファイルが大きすぎます(%s)。GitHub の Releases は、1ファイル 2GB までです。" % build.fmt_size(size))
        return 1
    asset = "%s-offvocal%s" % (slug, src.suffix.lower())
    url = "https://github.com/%s/releases/download/%s/%s" % (repo, TAG, asset)
    print("\n  作品    : %s(%s)\n  ファイル: %s(%s)\n  置き場所: GitHub Releases「%s」→ %s\n  リンク  : %s" %
          (title, slug, src.name, build.fmt_size(size), TAG, asset, url))
    if old and not dry and input("\nこの MV には、すでにオフボーカルがあります。置き換えますか? [y/N]: ").strip().lower() not in ("y", "yes"):
        print("中止しました。")
        return 0
    if dry:
        print("\n(--dry-run なので、アップロードも、書き込みもしていません)")
        return 0
    if input("\nアップロードします(公開のリリースに置かれ、誰でもダウンロードできるようになります)。よろしいですか? [y/N]: ").strip().lower() not in ("y", "yes"):
        print("中止しました。")
        return 0
    if gh("release", "view", TAG, check=False).returncode != 0:
        r = gh("release", "create", TAG, "--title", "オフボーカル", "--notes",
               "サイトのオフボーカルのダウンロード用のファイルを置いています。ファイルは、サイトの各作品のページから、ダウンロードしてください。", check=False)
        if r.returncode != 0:
            print("リリースを作れませんでした: %s" % r.stderr.strip())
            return 1
    tmp = Path(tempfile.mkdtemp())
    link = tmp / asset  # gh は、ファイル名でアップロードするので、ASCII の名前の入口を作る
    try:
        os.symlink(src.resolve(), link)
    except OSError:
        shutil.copy2(src, link)
    print("アップロード中…(%s。少し時間がかかります)" % build.fmt_size(size))
    r = subprocess.run(["gh", "release", "upload", TAG, str(link), "--clobber"], text=True)
    shutil.rmtree(tmp, ignore_errors=True)
    if r.returncode != 0:
        print("アップロードに失敗しました。")
        return 1
    iw.rewrite_info(info, {"offvocal": url, "offvocal-size": size, "offvocal-type": src.suffix[1:].upper()})
    print("\n完了しました。%s の info.txt に、リンクを書き込みました。" % slug)
    if input("サイトを作り直して、表示を確認しますか? [Y/n]: ").strip().lower() in ("", "y", "yes"):
        build.main()
    print("公開は、いつもの手順(サイトを更新.command など)で行ってください。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
