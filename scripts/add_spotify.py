#!/usr/bin/env python3
# Spotify のアルバムURLを、対応する作品に紐づける(APIキー不要)
# 使い方: python3 scripts/add_spotify.py URL [URL ...]
#         引数なしで実行すると、URL を1行ずつ貼り付けられる(空Enterで終了)
# Spotify のアプリで「共有 → アルバムのリンクをコピー」したURLをそのまま使える。
import json
import re
import sys
import urllib.parse

import build
import import_works as iw


def album_url(s):
    m = re.search(r"open\.spotify\.com/(?:intl-[a-z]+/)?album/([A-Za-z0-9]{22})", s)
    return "https://open.spotify.com/album/" + m.group(1) if m else None


def album_title(url):
    """Spotify の oEmbed(公開・キー不要)からアルバム名を取る"""
    r = json.loads(iw.fetch("https://open.spotify.com/oembed?url=" + urllib.parse.quote(url, safe="")))
    return r.get("title", "")


def music_works():
    out = []
    for d in sorted(iw.WORKS.iterdir()) if iw.WORKS.exists() else []:
        info = d / "info.txt"
        if not (d.is_dir() and info.exists()):
            continue
        f, links, _ = build.parse_info(info.read_text(encoding="utf-8"))
        if build.TYPE_ALIAS.get(f.get("type", ""), f.get("type", "")) != "music":
            continue
        extra = [x.strip() for x in re.split(r"[,、]", f.get("aliases", "")) if x.strip()]
        names = {build.norm_song(x) for x in [f.get("title", ""), f.get("title-orig", "")] + extra if x}
        out.append((d, f, links, names - {""}))
    return out


def attach(raw_urls):
    works = music_works()
    for raw in raw_urls:
        url = album_url(raw)
        if not url:
            print("  ! アルバムのURLではありません: %s" % raw)
            continue
        try:
            title = album_title(url)
        except Exception as e:
            print("  ! %s の名前を取得できませんでした: %s" % (url, e))
            continue
        hits = [w for w in works if build.norm_song(title) in w[3]]
        if not hits:
            print("  - 対応する作品が見つかりません: 「%s」 %s" % (title, url))
        elif len(hits) > 1:
            print("  ? 候補が複数あります: 「%s」 → %s" % (title, ", ".join(w[0].name for w in hits)))
        else:
            d, f, links, _ = hits[0]
            if any("open.spotify.com" in u for _, u in links):
                print("  = すでにリンクがあります: 「%s」" % title)
                continue
            iw.rewrite_info(d / "info.txt", {}, add_links=[("Spotify", url)])
            links.append(("Spotify", url))
            print("  + 「%s」 → %s" % (title, d.name))


def main():
    urls = sys.argv[1:]
    if not urls:
        print("Spotify のアルバムのURLを1行ずつ貼り付けてください(終わったら空Enter)")
        while True:
            line = input("  URL: ").strip()
            if not line:
                break
            urls.append(line)
    attach(urls)


if __name__ == "__main__":
    main()
