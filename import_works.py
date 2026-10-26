#!/usr/bin/env python3
# Apple Music と YouTube の新着を works/ に取り込み、Spotify のリンクを付ける(標準ライブラリのみ)
# Spotify のリンクだけは、Spotify の開発者アプリのキー(SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET)が必要。なければスキップする
# 使い方: python3 import_works.py            取り込み
#         python3 import_works.py --dry-run  何が取り込まれるか表示するだけ
# 設定は import.txt。取り込み済みの記録は works/.imported.txt(消した作品が復活しないように残す)
import base64
import datetime
import html
import json
import os
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
BOOTH_FILE = ROOT / "booth-items.json"  # BOOTH の商品一覧(サイトのビルドはこのファイルだけを使う)
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; portfolio-importer)", "Accept-Language": "ja,en;q=0.8",
           "Cookie": "CONSENT=YES+1"}
YES = ("yes", "true", "1", "on", "y", "はい")


def fetch(url, headers=None):
    last = None
    for i in range(3):
        try:
            req = urllib.request.Request(url, headers=dict(HEADERS, **(headers or {})))
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
        self.created_items = []   # (日付, タイトル, フォルダ名)。新作の通知に使う
        self.booth_new = []       # 新しく見つかった BOOTH の商品名
        self.enriched = []
        self.linked = []
        self.materials = []       # 素材(オフボーカルなど)のリンクを付けた作品
        self.booth = []

    def known(self, key, needle):
        return key in self.ledger or any(needle in t for t in self.texts)

    def create(self, key, folder, fields, links, cover=None):
        title = fields[0][1]
        self.created.append("%s  %s" % (fields[1][1], title))
        self.created_items.append((fields[1][1], title, folder))
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


def apple_lookup(cid, country, genre=None):
    """(収録曲名のリスト, 追加の情報)。収録曲名は Apple Music に登録された日本語表記。
    追加の情報は info.txt の項目の [(名前, 値)]: genre(ジャンル)・duration(全曲の合計の秒数)・copyright(℗ の表記)
    genre を指定すると(import.txt の genre:)、Apple Music の表記の代わりに、すべての作品に、その表記を使う"""
    r = json.loads(fetch("https://itunes.apple.com/lookup?id=%s&entity=song&country=%s&lang=ja_jp" % (cid, country)))
    res = r.get("results", [])
    coll = next((x for x in res if x.get("wrapperType") == "collection"), {})
    songs = [x for x in res if x.get("wrapperType") == "track"]
    extra = []
    if genre or coll.get("primaryGenreName"):
        extra.append(("genre", genre or coll["primaryGenreName"]))
    secs = round(sum(x.get("trackTimeMillis", 0) for x in songs) / 1000)
    if secs:
        extra.append(("duration", str(secs)))
    if coll.get("copyright"):
        extra.append(("copyright", coll["copyright"]))
    return [x["trackName"] for x in songs], extra


def apple_tracks(cid, country):
    """アルバムの収録曲名(Apple Music に登録された日本語表記)"""
    return apple_lookup(cid, country)[0]


def apple_naming(r, tracks):
    """(作品名, Appleの登録名, 種別)。シングルは、曲名(日本語表記)を作品名にする"""
    name = r["collectionName"]
    m = re.search(r"\s+-\s+(Single|EP)$", name)
    release = {"Single": "single", "EP": "ep"}[m.group(1)] if m else "album"
    album_title = re.sub(r"\s+-\s+(Single|EP)$", "", name).strip()
    title = album_title
    if release == "single":
        names = []
        for t in tracks:
            if re.search(r"instrumental|inst\.|off ?vocal|カラオケ", t, re.I):
                continue
            c = build.clean_track(t)
            if c and c not in names:
                names.append(c)
        if len(names) == 1:
            title = names[0]
    return title, album_title, release


def import_apple(imp, cfg):
    ids = re.findall(r"\d{6,}", cfg["apple"])
    if not ids:
        print("  ! import.txt の apple: からアーティストIDを読み取れませんでした")
        return
    country = cfg.get("apple-country", "jp")
    url = "https://itunes.apple.com/lookup?id=%s&entity=album&country=%s&limit=200" % (ids[-1], country)
    albums = [r for r in json.loads(fetch(url)).get("results", []) if r.get("wrapperType") == "collection"]
    for r in albums:
        cid = str(r["collectionId"])
        key = "apple-" + cid
        if imp.known(key, cid):
            continue
        tracks, extra = apple_lookup(cid, country, cfg.get("genre", "").strip() or None)
        title, album_title, release = apple_naming(r, tracks)
        date = r["releaseDate"][:10]
        art = r.get("artworkUrl100", "").replace("100x100bb", "800x800bb")
        cover = None
        if art and not imp.dry:
            try:
                cover = fetch(art)
            except Exception:
                print("  ! %s のジャケット画像を取得できませんでした" % title)
        fields = [("title", title), ("date", date), ("type", "music"), ("description", r.get("artistName", ""))]
        if album_title != title:
            fields.append(("title-orig", album_title))
        fields += [("release", release), ("tracks", json.dumps(tracks, ensure_ascii=False))] + extra
        imp.create(key, "%s-apple-%s" % (date, cid), fields,
                   ["Apple Music: " + r["collectionViewUrl"].split("?")[0]], cover)
    enrich_apple(imp, albums, country)
    backfill_apple_meta(imp, country, cfg.get("genre", "").strip() or None)


def backfill_apple_meta(imp, country, genre=None):
    """すでにある Apple Music の作品のうち、ジャンル・再生時間・℗ の情報がまだないものに、足す(手で直した項目は、書き換えない)。
    ケース(CDケースの3D表示)の内側に出る。情報が1つでも入ったら、その作品はもう調べない"""
    for d in sorted(WORKS.glob("*-apple-*")):
        info = d / "info.txt"
        f = build.parse_info(info.read_text(encoding="utf-8"))[0]
        cid = f.get("source", "").replace("apple-", "")
        if not cid.isdigit() or any(k in f for k in ("genre", "duration", "copyright")):
            continue
        try:
            extra = apple_lookup(cid, country, genre)[1]
        except Exception as e:
            print("  ! %s: Apple Music の情報を読み込めませんでした(%s)" % (f.get("title", d.name), e))
            continue
        if extra:
            print("  + %s: %s" % (f.get("title", d.name), "  ".join("%s=%s" % kv for kv in extra)))
            if not imp.dry:
                rewrite_info(info, dict(extra))
        time.sleep(0.3)


def rewrite_info(path, updates, add_links=None):
    """info.txt の項目を更新する(links や本文、ほかの項目はそのまま残す)。add_links は [(名前, URL)]"""
    f, links, body = build.parse_info(path.read_text(encoding="utf-8"))
    for k, v in updates.items():
        f[k] = " ".join(str(v).split())
    links = links + list(add_links or [])
    lines = ["%s: %s" % (k, v) for k, v in f.items() if not k.startswith("_")]
    lines.append("links:")
    lines += [("%s: %s" % (lab, u)) if lab else u for lab, u in links]
    if body:
        lines += ["---", body]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def enrich_apple(imp, albums, country):
    """以前の取り込み(収録曲の情報がない作品)に、日本語の作品名・種別・収録曲を補う"""
    by_id = {str(r["collectionId"]): r for r in albums}
    for d in sorted(WORKS.glob("*-apple-*")):
        info = d / "info.txt"
        f = build.parse_info(info.read_text(encoding="utf-8"))[0]
        cid = f.get("source", "").replace("apple-", "")
        if f.get("tracks") or cid not in by_id or f.get("auto") != "yes":
            continue
        r = by_id[cid]
        tracks = apple_tracks(cid, country)
        title, album_title, release = apple_naming(r, tracks)
        updates = {"release": release, "tracks": json.dumps(tracks, ensure_ascii=False)}
        if f.get("title") == album_title:  # 手で直していない場合だけ、作品名を日本語表記に
            updates["title"] = title
            if title != album_title:
                updates["title-orig"] = album_title
        imp.enriched.append("%s → %s" % (f.get("title"), updates.get("title", f.get("title"))))
        if not imp.dry:
            rewrite_info(info, updates)
        time.sleep(0.3)


def spotify_keys():
    """環境変数(GitHub の Secrets)か、手元の spotify-keys.txt からキーを読む"""
    cid, sec = os.environ.get("SPOTIFY_CLIENT_ID"), os.environ.get("SPOTIFY_CLIENT_SECRET")
    path = ROOT / "spotify-keys.txt"
    if not (cid and sec) and path.exists():
        f = build.parse_info(path.read_text(encoding="utf-8"))[0]
        cid, sec = f.get("client_id"), f.get("client_secret")
    return (cid.strip(), sec.strip()) if cid and sec else None


def spotify_token(cid, sec):
    auth = base64.b64encode(("%s:%s" % (cid, sec)).encode()).decode()
    req = urllib.request.Request("https://accounts.spotify.com/api/token", data=b"grant_type=client_credentials",
                                 headers={"Authorization": "Basic " + auth,
                                          "Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.load(r)["access_token"]


def spotify_albums(token, artist_id, market):
    url = ("https://api.spotify.com/v1/artists/%s/albums?include_groups=album,single,appears_on,compilation"
           "&market=%s&limit=50" % (artist_id, market))
    out = []
    while url:
        d = json.loads(fetch(url, {"Authorization": "Bearer " + token}))
        out += d.get("items", [])
        url = d.get("next")
        time.sleep(0.2)
    return out


def spotify_date(s):
    y, m, d = (s + "-01-01").split("-")[:3]  # 年だけ・年月だけの日付にも対応
    return datetime.date(int(y), int(m), int(d))


def match_spotify(albums, names, date, ntracks):
    """Apple の作品に対応する Spotify のアルバムを探す。同じ名前(作品名・原題のどちらか)を優先し、なければ「近い日付・同じ曲数」で1件に絞れたときだけ"""
    nts = {build.norm_song(n) for n in names if n} - {""}
    same, close = [], []
    for a in albums:
        try:
            gap = abs((spotify_date(a["release_date"]) - date).days)
        except Exception:
            continue
        if build.norm_song(a["name"]) in nts:
            same.append((gap, a))
        elif gap <= 3 and a.get("total_tracks") == ntracks:
            close.append(a)
    if same:
        return min(same, key=lambda x: x[0])[1]
    return close[0] if len(close) == 1 else None


def import_spotify(imp, cfg):
    keys = spotify_keys()
    if not keys:
        print("  (Spotify のキーが未設定なので、Spotify のリンクはスキップしました)")
        return
    m = re.search(r"[A-Za-z0-9]{22}", cfg["spotify"])
    if not m:
        print("  ! import.txt の spotify: からアーティストIDを読み取れませんでした")
        return
    albums = spotify_albums(spotify_token(*keys), m.group(0), cfg.get("apple-country", "jp").upper())
    for d in sorted(WORKS.glob("*-apple-*")):
        info = d / "info.txt"
        f, links, _ = build.parse_info(info.read_text(encoding="utf-8"))
        if any("open.spotify.com" in u for _, u in links):
            continue
        date = build.parse_date(f.get("date"))
        try:
            ntracks = len(json.loads(f.get("tracks", "[]")))
        except ValueError:
            ntracks = 0
        a = match_spotify(albums, [f.get("title"), f.get("title-orig")] + re.split(r"[,、]", f.get("aliases", "")), date, ntracks) if date else None
        if not a:
            continue
        url = a["external_urls"]["spotify"]
        imp.linked.append("%s → %s" % (f.get("title"), url))
        if not imp.dry:
            rewrite_info(info, {}, add_links=[("Spotify", url)])


def import_booth(imp, cfg):
    """BOOTH のショップの全商品(名前・価格・URL)を booth-items.json に保存する"""
    m = re.match(r"https?://([a-z0-9-]+\.booth\.pm)", cfg["booth"].strip())
    if not m:
        print("  ! import.txt の booth: からショップのURLを読み取れませんでした")
        return
    base = "https://%s/items" % m.group(1)
    ids = []
    for page in range(1, 11):  # 商品が増えても、10ページ(最大約300点)まで
        raw = html.unescape(fetch(base + ("?page=%d" % page if page > 1 else "")).decode("utf-8", "replace"))
        new = [i for i in dict.fromkeys(re.findall(r'"tracking_data":\{"product_id":(\d+)', raw)) if i not in ids]
        if not new:
            break
        ids += new
    items = []
    for pid in ids:
        d = json.loads(fetch("https://booth.pm/ja/items/%s.json" % pid))
        items.append({"id": int(pid), "name": d["name"], "price": int(re.sub(r"\D", "", str(d.get("price", "0"))) or 0),
                      "url": d.get("url") or "https://%s/items/%s" % (m.group(1), pid)})
        time.sleep(0.3)
    items.sort(key=lambda x: -x["id"])
    old = json.loads(BOOTH_FILE.read_text(encoding="utf-8")) if BOOTH_FILE.exists() else []
    if items != old:
        added = [i["name"] for i in items if i["id"] not in {o["id"] for o in old}]
        imp.booth.append("%d 点(新しい商品 %d 点)" % (len(items), len(added)))
        imp.booth_new += added
        if not imp.dry:
            BOOTH_FILE.write_text(json.dumps(items, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def youtube_channel_id(v):
    m = re.search(r"UC[\w-]{22}", v)
    if m:
        return m.group(0)
    url = v if v.startswith("http") else "https://www.youtube.com/" + v.lstrip("/")
    html = fetch(url).decode("utf-8", "replace")
    m = re.search(r'"channelId":"(UC[\w-]{22})"', html) or re.search(r"channel/(UC[\w-]{22})", html)
    return m.group(1) if m else None


_MATERIAL = re.compile(r"off\s*vocal|オフボーカル|オフヴォーカル|素材|ダウンロード|download|配布|\bDL\b", re.I)


def materials_on():
    """import.txt の materials: が no なら、概要欄からの素材リンクの自動取り込みをしない"""
    path = ROOT / "import.txt"
    cfg = build.parse_info(path.read_text(encoding="utf-8"))[0] if path.exists() else {}
    return cfg.get("materials", "yes").strip().lower() not in ("no", "off", "false", "0", "いいえ")


def material_links(desc):
    """動画の概要欄から、オフボーカル・素材などの配布リンクを拾う。「OffVocal / 歌詞 - https://…」のような行が対象。[(名前, URL)]"""
    out = []
    if not materials_on():
        return out
    for line in desc.splitlines():
        m = re.search(r"https?://\S+", line)
        if not m or not _MATERIAL.search(line[:m.start()]):
            continue
        label = line[:m.start()].strip(" \t\u3000-－:：・|｜→➡▶▷>＞")
        if label and (label, m.group(0)) not in out:
            out.append((label, m.group(0)))
    return out


def norm_url(u):
    """リンクの重複判定用: 追跡用の ?si= などと、Spotify の intl-ja、スキームの違い、末尾の / をそろえる"""
    from urllib.parse import urlparse
    p = urlparse(u.strip())
    host = p.netloc.lower().replace("www.", "")
    path = re.sub(r"^/intl-[a-z]+", "", p.path).rstrip("/")
    return host + path


def _stream_label(u):
    """配信・販売などのリンクなら、ボタンの名前を返す(それ以外は None)。ユーザーやアーティストのページは対象外"""
    from urllib.parse import urlparse
    p = urlparse(u)
    host, path = p.netloc.lower().replace("www.", ""), re.sub(r"^/intl-[a-z]+", "", p.path)
    if host == "open.spotify.com" and re.match(r"^/(track|album|playlist|episode)/", path):
        return "Spotify"
    if host in ("music.apple.com", "itunes.apple.com") and not re.search(r"/artist/", path):
        return "Apple Music"
    if host == "nicovideo.jp" and path.startswith("/watch/"):
        return "ニコニコ動画"
    if host.endswith(".bandcamp.com") and re.match(r"^/(album|track)/", path):
        return "Bandcamp"
    if host.endswith("booth.pm") and path.startswith("/items/"):
        return "BOOTH"
    if host in ("linkco.re", "orcd.co", "lnk.to") or host.endswith(".lnk.to"):
        return "配信リンク"
    return None


def stream_links(desc):
    """動画の概要欄から、配信・販売のリンク(Spotify / Apple Music / ニコニコ動画 / Bandcamp / BOOTH / リンクまとめ)を拾う。
    同じサービスは、最初の1つだけ。[(名前, URL)]"""
    out, seen = [], set()
    for u in re.findall(r"https?://[^\s<>\"'\u3000]+", desc):
        u = u.rstrip(".,、。)」』】")
        lab = _stream_label(u)
        if lab and lab not in seen:
            seen.add(lab)
            out.append((lab, re.sub(r"^http://", "https://", re.sub(r"/intl-[a-z]+", "", re.sub(r"[?&]si=[^&]*", "", u))).rstrip("?")))
    return out


def import_youtube(imp, cfg):
    ch = youtube_channel_id(cfg["youtube"])
    if not ch:
        print("  ! import.txt の youtube: からチャンネルIDを取得できませんでした。UC から始まるIDを直接書いてください")
        return
    root = ET.fromstring(fetch("https://www.youtube.com/feeds/videos.xml?channel_id=" + ch))
    ns = {"a": "http://www.w3.org/2005/Atom", "yt": "http://www.youtube.com/xml/schemas/2015",
          "m": "http://search.yahoo.com/mrss/"}
    shorts = cfg.get("youtube-shorts", "no").lower() in YES
    exclude = [w.strip().lower() for w in re.split(r"[,、]", cfg.get("youtube-exclude", "")) if w.strip()]
    for e in root.findall("a:entry", ns):
        vid = e.find("yt:videoId", ns).text
        key = "youtube-" + vid
        link = e.find("a:link", ns)
        desc_el = e.find("m:group/m:description", ns)
        mats = material_links(desc_el.text or "") if desc_el is not None else []
        if mats and imp.known(key, vid):  # すでに取り込んだ作品に、素材のリンクがなければ足す(自動で取り込んだ作品だけ)
            info = WORKS / ("%s-yt-%s" % (e.find("a:published", ns).text[:10], vid)) / "info.txt"
            if info.is_file():
                f, links, _ = build.parse_info(info.read_text(encoding="utf-8"))
                if build.truthy(f.get("auto")):
                    have = {u for _, u in links}
                    new = [(lab, u) for lab, u in mats if u not in have]
                    if new:
                        imp.materials.append("%s → %s" % (f.get("title", vid), ", ".join(u for _, u in new)))
                        if not imp.dry:
                            rewrite_info(info, {}, add_links=new)
        if imp.known(key, vid) or (not shorts and "/shorts/" in (link.get("href", "") if link is not None else "")):
            continue
        date = e.find("a:published", ns).text[:10]
        title = e.find("a:title", ns).text or vid
        if any(w in title.lower() for w in exclude):
            continue  # 除外ワードを含む動画は取り込まない
        imp.create(key, "%s-yt-%s" % (date, vid),
                   [("title", title), ("date", date), ("type", "video")],
                   ["YouTube: https://www.youtube.com/watch?v=" + vid] + ["%s: %s" % m for m in mats])


def summary_text(imp, base_url):
    """新作などの取り込み結果を、通知用の文章(Markdown)にする。通知するものがなければ空"""
    base = base_url.rstrip("/")
    parts = []
    if imp.created_items:
        lines = []
        for date, title, folder in imp.created_items:
            url = "%s/w/%s/" % (base, urllib.parse.quote(folder)) if base else ""
            lines.append("- %s [%s](%s)" % (date, title, url) if url else "- %s %s" % (date, title))
        parts.append("## 新しい作品\n" + "\n".join(lines))
    if imp.linked:
        parts.append("## Spotify のリンクを付けた作品\n" + "\n".join("- " + x for x in imp.linked))
    if imp.materials:
        parts.append("## 素材(オフボーカルなど)のリンクを付けた作品\n" + "\n".join("- " + x for x in imp.materials))
    if imp.booth_new:
        parts.append("## BOOTH の新しい商品\n" + "\n".join("- " + x for x in imp.booth_new))
    if not parts:
        return ""
    head = "新しい作品などを自動で取り込みました。サイトには、このあと数分で自動で公開されます。\nタイトルや説明を直したいときは、works/<フォルダ名>/info.txt を編集して push してください。\n"
    return head + "\n" + "\n\n".join(parts) + "\n"


def main():
    dry = "--dry-run" in sys.argv
    cfg_path = ROOT / "import.txt"
    cfg = build.parse_info(cfg_path.read_text(encoding="utf-8"))[0] if cfg_path.exists() else {}
    WORKS.mkdir(exist_ok=True)
    imp = Importer(dry)
    for name, fn in (("apple", import_apple), ("youtube", import_youtube), ("spotify", import_spotify), ("booth", import_booth)):
        if cfg.get(name):
            try:
                fn(imp, cfg)
            except Exception as e:
                print("  ! %s の取り込みに失敗しました: %s" % (name, e))
    if imp.created:
        print("%s %d 件:" % ("取り込み予定" if dry else "取り込みました", len(imp.created)))
        for line in imp.created:
            print("  " + line)
    if imp.enriched:
        print("%s %d 件(日本語の作品名・種別・収録曲を補う):" % ("補完予定" if dry else "補完しました", len(imp.enriched)))
        for line in imp.enriched:
            print("  " + line)
    if imp.linked:
        print("%s %d 件(Spotify のリンク):" % ("リンク予定" if dry else "リンクを付けました", len(imp.linked)))
        for line in imp.linked:
            print("  " + line)
    if imp.materials:
        print("%s %d 件(オフボーカルなど素材のリンク):" % ("リンク予定" if dry else "リンクを付けました", len(imp.materials)))
        for line in imp.materials:
            print("  " + line)
    if imp.booth:
        print("%s BOOTH の商品一覧: %s" % ("更新予定" if dry else "更新しました", imp.booth[0]))
    if not imp.created and not imp.enriched and not imp.linked and not imp.booth and not imp.materials:
        print("新しい作品・リンクはありませんでした")
    # 環境変数 IMPORT_SUMMARY にファイルのパスがあれば、新作などの通知用の文章を書き出す(GitHub Actions が、これを Issue や Discord に送る)
    out = os.environ.get("IMPORT_SUMMARY")
    if out:
        text = summary_text(imp, build.load_site().get("url", ""))
        Path(out).write_text(text, encoding="utf-8")


if __name__ == "__main__":
    main()
