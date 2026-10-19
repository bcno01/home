#!/usr/bin/env python3
# Apple Music と YouTube の新着を works/ に取り込む(標準ライブラリのみ・APIキー不要)
# 使い方: python3 import_works.py            取り込み
#         python3 import_works.py --dry-run  何が取り込まれるか表示するだけ
# 設定は import.txt。取り込み済みの記録は works/.imported.txt(消した作品が復活しないように残す)
import json
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

import build

ROOT = Path(__file__).resolve().parent
WORKS = ROOT / "works"
LEDGER = WORKS / ".imported.txt"
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; portfolio-importer)", "Accept-Language": "ja,en;q=0.8",
           "Cookie": "CONSENT=YES+1"}
YES = ("yes", "true", "1", "on", "y", "はい")


def fetch(url):
    last = None
    for i in range(3):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=25) as r:
                return r.read()
        except Exception as e:  # 通信の一時的な失敗は少し待って再試行
            last = e
            time.sleep(2 * (i + 1))
    raise last


def read_ledger():
    return set(LEDGER.read_text(encoding="utf-8").split()) if LEDGER.exists() else set()


def existing_texts():
    """作品フォルダの info.txt を全部読む(手で作った作品との重複チェック用)"""
    out = []
    for d in WORKS.iterdir() if WORKS.exists() else []:
        info = d / "info.txt"
        if d.is_dir() and info.exists():
            out.append(info.read_text(encoding="utf-8"))
    return out


class Importer:
    def __init__(self, dry):
        self.dry = dry
        self.ledger = read_ledger()
        self.texts = existing_texts()
        self.created = []

    def known(self, key, needle):
        return key in self.ledger or any(needle in t for t in self.texts)

    def create(self, key, folder, fields, links, cover=None):
        title = fields[0][1]
        self.created.append("%s  %s" % (fields[1][1], title))
        if self.dry:
            return
        d = WORKS / folder
        d.mkdir(parents=True, exist_ok=True)
        lines = ["%s: %s" % (k, " ".join(str(v).split())) for k, v in fields]
        lines += ["source: " + key, "auto: yes", "links:"] + links
        (d / "info.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
        if cover:
            (d / "cover.jpg").write_bytes(cover)
        with LEDGER.open("a", encoding="utf-8") as f:
            f.write(key + "\n")
        self.ledger.add(key)


def import_apple(imp, cfg):
    ids = re.findall(r"\d{6,}", cfg["apple"])
    if not ids:
        print("  ! import.txt の apple: からアーティストIDを読み取れませんでした")
        return
    country = cfg.get("apple-country", "jp")
    url = "https://itunes.apple.com/lookup?id=%s&entity=album&country=%s&limit=200" % (ids[-1], country)
    data = json.loads(fetch(url))
    for r in data.get("results", []):
        if r.get("wrapperType") != "collection":
            continue
        cid = str(r["collectionId"])
        key = "apple-" + cid
        if imp.known(key, cid):
            continue
        title = re.sub(r"\s+-\s+(Single|EP)$", "", r["collectionName"]).strip()
        date = r["releaseDate"][:10]
        art = r.get("artworkUrl100", "").replace("100x100bb", "800x800bb")
        cover = None
        if art and not imp.dry:
            try:
                cover = fetch(art)
            except Exception:
                print("  ! %s のジャケット画像を取得できませんでした" % title)
        imp.create(key, "%s-apple-%s" % (date, cid),
                   [("title", title), ("date", date), ("type", "music"), ("description", r.get("artistName", ""))],
                   ["Apple Music: " + r["collectionViewUrl"].split("?")[0]], cover)


def youtube_channel_id(v):
    m = re.search(r"UC[\w-]{22}", v)
    if m:
        return m.group(0)
    url = v if v.startswith("http") else "https://www.youtube.com/" + v.lstrip("/")
    html = fetch(url).decode("utf-8", "replace")
    m = re.search(r'"channelId":"(UC[\w-]{22})"', html) or re.search(r"channel/(UC[\w-]{22})", html)
    return m.group(1) if m else None


def import_youtube(imp, cfg):
    ch = youtube_channel_id(cfg["youtube"])
    if not ch:
        print("  ! import.txt の youtube: からチャンネルIDを取得できませんでした。UC から始まるIDを直接書いてください")
        return
    root = ET.fromstring(fetch("https://www.youtube.com/feeds/videos.xml?channel_id=" + ch))
    ns = {"a": "http://www.w3.org/2005/Atom", "yt": "http://www.youtube.com/xml/schemas/2015"}
    shorts = cfg.get("youtube-shorts", "no").lower() in YES
    for e in root.findall("a:entry", ns):
        vid = e.find("yt:videoId", ns).text
        key = "youtube-" + vid
        link = e.find("a:link", ns)
        if imp.known(key, vid) or (not shorts and "/shorts/" in (link.get("href", "") if link is not None else "")):
            continue
        date = e.find("a:published", ns).text[:10]
        imp.create(key, "%s-yt-%s" % (date, vid),
                   [("title", e.find("a:title", ns).text or vid), ("date", date), ("type", "video")],
                   ["YouTube: https://www.youtube.com/watch?v=" + vid])


def main():
    dry = "--dry-run" in sys.argv
    cfg_path = ROOT / "import.txt"
    cfg = build.parse_info(cfg_path.read_text(encoding="utf-8"))[0] if cfg_path.exists() else {}
    WORKS.mkdir(exist_ok=True)
    imp = Importer(dry)
    for name, fn in (("apple", import_apple), ("youtube", import_youtube)):
        if cfg.get(name):
            try:
                fn(imp, cfg)
            except Exception as e:
                print("  ! %s の取り込みに失敗しました: %s" % (name, e))
    if imp.created:
        print("%s %d 件:" % ("取り込み予定" if dry else "取り込みました", len(imp.created)))
        for line in imp.created:
            print("  " + line)
    else:
        print("新しい作品はありませんでした")


if __name__ == "__main__":
    main()
