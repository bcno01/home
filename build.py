#!/usr/bin/env python3
# works/ の作品フォルダ群から公開用サイト docs/ を生成する(標準ライブラリのみ)
import datetime
import html
import itertools
import json
import re
import shutil
import zipfile
import subprocess
import sys
import unicodedata
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

ROOT = Path(__file__).resolve().parent

WORKS = ROOT / "works"
OUT = ROOT / "docs"
THEME = ROOT / "theme"
IMG_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg"}
# 作品のフォルダに置くと、作品ページに「ダウンロード」ボタンが出るファイル(ファイル名の頭が、offvocal / lyrics)
DL_KINDS = (("offvocal", "オフボーカル", {".mp3", ".wav", ".m4a", ".flac", ".zip"}),
            ("lyrics", "歌詞", {".txt", ".pdf"}))

TYPES = {"video": "MV", "music": "Streaming", "project": "Projects", "goods": "通販・グッズ", "other": "その他"}
TYPE_ALIAS = {
    "音楽": "music", "曲": "music", "動画": "video", "映像": "video", "streaming": "music", "mv": "video",
    "グッズ": "goods", "通販": "goods", "商品": "goods", "shop": "goods",
    "その他": "other",
    "案件": "project", "project": "project", "projects": "project", "参加作品": "project",
}
KEY_ALIAS = {
    "タイトル": "title", "日付": "date", "種類": "type", "説明": "description",
    "下書き": "draft", "リンク": "links", "表紙": "cover", "名前": "name",
    "キャッチコピー": "tagline", "メニュー": "menu", "連絡先": "contact", "ロゴ": "logo",
}

# (ドメイン, 表示名)。上にあるものが優先。末尾が "." のものは部分一致
PLATFORMS = [
    ("open.spotify.com", "Spotify"), ("music.apple.com", "Apple Music"),
    ("music.youtube.com", "YouTube Music"), ("youtube.com", "YouTube"),
    ("youtu.be", "YouTube"), ("soundcloud.com", "SoundCloud"),
    ("bandcamp.com", "Bandcamp"), ("nicovideo.jp", "ニコニコ動画"),
    ("booth.pm", "BOOTH"), ("amazon.", "Amazon"), ("amzn.", "Amazon"),
    ("rakuten.", "楽天"), ("suzuri.jp", "SUZURI"), ("base.shop", "BASE"),
    ("thebase.in", "BASE"), ("stores.jp", "STORES"), ("line.me", "LINE MUSIC"),
    ("note.com", "note"), ("github.com", "GitHub"), ("x.com", "X"),
    ("twitter.com", "X"), ("instagram.com", "Instagram"), ("tiktok.com", "TikTok"),
]
MUSIC_HOSTS = {"Spotify", "Apple Music", "YouTube Music", "SoundCloud", "Bandcamp", "LINE MUSIC"}
VIDEO_HOSTS = {"YouTube", "ニコニコ動画", "TikTok"}
GOODS_HOSTS = {"BOOTH", "Amazon", "楽天", "SUZURI", "BASE", "STORES"}

URL_RE = re.compile(r"https?://\S+")
esc = html.escape


def host_of(url):
    return re.sub(r"^www\.", "", urlparse(url).netloc.lower())


def platform_label(url):
    host = host_of(url)
    for key, name in PLATFORMS:
        if host == key or host.endswith("." + key) or (key.endswith(".") and key in host + "."):
            return name
    return host or url


def parse_info(text):
    """`キー: 値` の行、`links:` 以下のURL行、`---` 以降の本文を読み取る"""
    fields, links, menu, body = {}, [], [], []
    list_key = None
    in_body = False
    for raw in text.splitlines():
        line = raw.strip()
        if in_body:
            body.append(raw)
            continue
        if line == "---":
            in_body = True
            continue
        if not line or line.startswith("#"):
            continue
        m = re.match(r"^(.+?)\s*[:：]\s*(#[a-z]+)$", line)  # メニューの「Guideline: #guideline」のような、サイト内のパネルへの項目
        if m and list_key == "menu":
            menu.append((m.group(1).strip(), m.group(2)))
            continue
        m = URL_RE.search(line)
        if m and (list_key or m.start() == 0):
            label = line[:m.start()].strip(" :：-－・|｜\t　")
            (menu if list_key == "menu" else links).append((label, m.group(0)))
            continue
        m = re.match(r"^([^\s:：]+)\s*[:：]\s*(.*)$", line)
        if not m:
            continue
        key = m.group(1).lower()
        key = KEY_ALIAS.get(key, key)
        list_key = key if key in ("links", "menu") else None
        if not list_key:
            fields[key] = m.group(2).strip()
    if menu:
        fields["_menu"] = menu
    return fields, links, "\n".join(body).strip()


def truthy(v):
    return (v or "").strip().lower() in ("yes", "true", "1", "on", "y", "はい")


def parse_date(s):
    m = re.match(r"(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?", s or "")
    if not m:
        return None
    try:
        return datetime.date(int(m[1]), int(m[2]), int(m[3] or 1))
    except ValueError:
        return None


def fmt_date(d):
    return "%d.%02d.%02d" % (d.year, d.month, d.day)


def infer_type(links):
    names = {platform_label(u) for _, u in links}
    if names & MUSIC_HOSTS:
        return "music"
    if names & VIDEO_HOSTS:
        return "video"
    if names & GOODS_HOSTS:
        return "goods"
    return "other"


def youtube_id(url):
    u = urlparse(url)
    host = host_of(url)
    if host == "youtu.be":
        return u.path.strip("/").split("/")[0] or None
    if host in ("youtube.com", "music.youtube.com"):
        v = parse_qs(u.query).get("v")
        if v:
            return v[0]
        m = re.match(r"^/(?:shorts|embed|live)/([\w-]+)", u.path)
        if m:
            return m.group(1)
    return None


def embed_for(url):
    """URLから埋め込みプレーヤー情報(種類, src, 高さ)を返す。対応外は None"""
    host = host_of(url)
    u = urlparse(url)
    vid = youtube_id(url)
    if vid:
        return ("video", "https://www.youtube-nocookie.com/embed/" + vid, None)
    if host in ("youtube.com", "music.youtube.com"):
        pl = parse_qs(u.query).get("list")
        if pl and u.path.startswith("/playlist"):
            return ("video", "https://www.youtube-nocookie.com/embed/videoseries?list=" + pl[0], None)
    if host == "open.spotify.com":
        m = re.search(r"/(track|album|playlist|episode|show|artist)/(\w+)", u.path)
        if m:
            h = 152 if m.group(1) in ("track", "episode") else 352
            return ("audio", "https://open.spotify.com/embed/%s/%s" % (m.group(1), m.group(2)), h)
    if host == "soundcloud.com" and u.path.count("/") >= 2:
        return ("audio", "https://w.soundcloud.com/player/?url=%s&visual=false" % quote(url, safe=""), 166)
    if host == "music.apple.com":
        src = "https://embed.music.apple.com" + u.path + ("?" + u.query if u.query else "")
        return ("audio", src, 175 if "i=" in u.query else 450)
    if host == "nicovideo.jp":
        m = re.match(r"^/watch/((?:sm|nm|so)?\d+)", u.path)
        if m:
            return ("video", "https://embed.nicovideo.jp/watch/" + m.group(1), None)
    return None


def _resize(src, dst, max_px):
    """長辺が max_px を超えるときだけ縮小して保存。処理したら True"""
    try:
        from PIL import Image, ImageOps
        with Image.open(src) as im:
            if max(im.size) <= max_px:
                return False
            im = ImageOps.exif_transpose(im)
            im.thumbnail((max_px, max_px))
            fmt = {".jpg": "JPEG", ".jpeg": "JPEG", ".png": "PNG", ".webp": "WEBP"}[src.suffix.lower()]
            if fmt == "JPEG" and im.mode != "RGB":
                im = im.convert("RGB")
            im.save(dst, fmt, quality=85)
            return True
    except ImportError:
        pass
    except Exception:
        return False
    if not shutil.which("sips"):
        return False
    r = subprocess.run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", str(src)],
                       capture_output=True, text=True)
    sizes = [int(n) for n in re.findall(r"pixel(?:Width|Height): (\d+)", r.stdout)]
    if not sizes or max(sizes) <= max_px:
        return False
    r = subprocess.run(["sips", "-Z", str(max_px), str(src), "--out", str(dst)], capture_output=True)
    return r.returncode == 0


def save_image(src, dst, max_px, written):
    written.add(dst)
    if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    if src.suffix.lower() in (".svg", ".gif") or not _resize(src, dst, max_px):
        shutil.copy2(src, dst)


# ---- 見出し文・曲名・関連作品 ----
KINDS = {"single": "シングル", "ep": "EP", "album": "アルバム"}
_NOISE = re.compile(r"\s*[\(（\[]\s*(?:feat\.?|featuring|ft\.?|instrumental|inst\.?|off\s*vocal)[^\)）\]]*[\)）\]]\s*", re.I)
_BRACKETS = re.compile(r"[\(（\[［【〈《].*?[\)）\]］】〉》]")
_PUNCT = re.compile(r"[\s\-_.,!?'\"~・:;/\\|]+")
_MV = re.compile(r"^\s*[\[【\(]?\s*(?:MV|M/V|Music\s*Video)\s*[\]】\)]?\s*[「『](.+?)[」』]", re.I)


def clean_track(name):
    """曲名から (feat. ○○) や (Instrumental) を取り除く"""
    return _NOISE.sub(" ", name).strip()


def norm_song(s):
    """曲名の比較用: 全角半角・大文字小文字・括弧書き・記号をそろえる"""
    s = unicodedata.normalize("NFKC", s)
    return _PUNCT.sub("", _BRACKETS.sub("", s).casefold())


def video_song(title):
    """動画タイトルから曲名を取り出す(MV「曲名」…、アーティスト - 曲名 など)"""
    m = _MV.match(title) or re.search(r"[「『](.+?)[」』]", title)
    if m:
        return m.group(1).strip()
    return title.split(" - ", 1)[1].strip() if " - " in title else title.strip()


def make_headline(w, f):
    """作品の見出し文。info.txt の headline: があればそれを使う"""
    if f.get("headline"):
        return f["headline"]
    if w["type"] == "music":
        return "%s「%s」を配信開始しました" % (KINDS.get(f.get("release", ""), ""), w["title"])
    if w["type"] == "video":
        if _MV.match(w["title"]):
            return "「%s」のMVを公開しました" % video_song(w["title"])
        return "「%s」を公開しました" % video_song(w["title"])
    return ""


BOOTH_FILE = ROOT / "booth-items.json"
_CD = re.compile(r"(EP|Album|Single)「")


def load_booth():
    try:
        return json.loads(BOOTH_FILE.read_text(encoding="utf-8")) if BOOTH_FILE.exists() else []
    except ValueError:
        return []


def attach_booth(works, items):
    """作品の名前(別名・原題も)が商品名に含まれていれば、その商品を作品に紐づける。
    info.txt の booth: 商品ID(カンマ区切り)で、手で指定もできる。自分の商品は w["booth"]、関連作品の商品は w["booth_rel"]"""
    by_id = {str(i["id"]): i for i in items}
    inorm = {i["id"]: norm_song(i["name"]) for i in items}
    for w in works:
        names = {norm_song(x) for x in [w["title"], w["title_orig"]] + w["aliases"] if x}
        names = {n for n in names if len(n) >= 3}
        own = [i for i in items if w["type"] not in ("video", "project") and any(n in inorm[i["id"]] for n in names)]
        own += [by_id[x] for x in w["booth_ids"] if x in by_id and by_id[x] not in own]
        w["booth"] = sorted(own, key=lambda i: (not _CD.search(i["name"]), -i["id"]))
    for w in works:
        seen = {i["id"] for i in w["booth"]}
        rel = []
        for r in w["related"]:
            for i in r["booth"]:
                if i["id"] not in seen:
                    seen.add(i["id"])
                    rel.append((r, i))
        w["booth_rel"] = sorted(rel, key=lambda ri: (not _CD.search(ri[1]["name"]), -ri[1]["id"]))


def link_related(works):
    """同じ曲を含む作品どうし(と info.txt の related: で指定したもの)を相互に関連づける"""
    def explicit(a, b):
        return any(b["slug"].startswith(t) or b["title"] == t for t in a["related_raw"])
    for w in works:
        w["related"] = []
    for i, a in enumerate(works):
        for b in works[i + 1:]:
            if a["songs"] & b["songs"] or explicit(a, b) or explicit(b, a):
                a["related"].append(b)
                b["related"].append(a)


def parse_bpm(v):
    """info.txt の bpm: 128 や bpm: 128.5 や bpm: 128 BPM。30〜300 の範囲だけ受け付ける(それ以外・書いていないときは None)"""
    m = re.search(r"\d+(?:\.\d+)?", v or "")
    if not m:
        return None
    x = float(m.group())
    return x if 30 <= x <= 300 else None


def fmt_bpm(x):
    return str(int(x)) if x == int(x) else ("%.1f" % x)


def beat_seconds(bpm):
    """1拍の長さ(秒)。速い曲(200BPMより上)は、点滅のように見えないよう、2拍ぶんにそろえる"""
    sec = 60.0 / bpm
    while sec < 0.3:
        sec *= 2
    return sec


def read_work(d):
    info = d / "info.txt"
    if not info.exists():
        print("  ! %s に info.txt がないので飛ばしました" % d.name)
        return None
    f, links, body = parse_info(info.read_text(encoding="utf-8"))
    if truthy(f.get("draft")):
        return None
    t = f.get("type", "").strip()
    t = TYPE_ALIAS.get(t, TYPE_ALIAS.get(t.lower(), t.lower()))
    images = sorted(p for p in d.iterdir()
                    if p.suffix.lower() in IMG_EXT and not p.name.startswith((".", "_")))
    cover = None
    if f.get("cover") and (d / f["cover"]).exists():
        cover = d / f["cover"]
    else:
        cover = next((p for p in images if p.stem.lower() == "cover"), None) or (images[0] if images else None)
    cover_url = None
    if not cover:
        for _, u in links:
            vid = youtube_id(u)
            if vid:
                cover_url = "https://i.ytimg.com/vi/%s/hqdefault.jpg" % vid
                break
    embeds = [e for e in (embed_for(u) for _, u in links) if e]
    audio = [e for e in embeds if e[0] == "audio"]
    if len(audio) > 1:  # 音楽プレーヤーは1つだけ(Spotify があれば優先)
        keep = next((e for e in audio if "open.spotify.com" in e[1]), audio[0])
        embeds = [e for e in embeds if e[0] != "audio" or e is keep]
    embeds = embeds[:3]
    date = parse_date(f.get("date")) or parse_date(d.name)
    if not date:
        print("  ! %s: 日付がありません(info.txt に date: を書くか、フォルダ名の頭に 2026-10-01- を付けてください)。今日の日付になります" % d.name)
        date = datetime.date.today()
    try:
        tracks = json.loads(f["tracks"]) if f.get("tracks") else []
    except ValueError:
        tracks = []
    downloads = []  # ダウンロードのボタン。{"name": ボタンの名前, "path": 作品フォルダのファイル(なければ None), "url": 外部のURL, "ext": 種類, "size": バイト数}
    for stem, name, exts in DL_KINDS:
        for p in sorted(d.iterdir()):  # 作品のフォルダに置いたファイル(offvocal.mp3 / lyrics.txt など)
            if p.is_file() and p.stem.lower() == stem and p.suffix.lower() in exts and not p.name.startswith((".", "_")):
                downloads.append({"name": name, "path": p, "url": "", "ext": p.suffix[1:].upper(), "size": p.stat().st_size})
                if p.stat().st_size > 50 * 1048576:
                    print("  ! %s: %s は %s あります。GitHub は 1ファイル100MBまでで、公開サイトも重くなるので、mp3 にするか、GitHub の Releases に置くことをおすすめします(オフボーカルを置く.command)" % (d.name, p.name, fmt_size(p.stat().st_size)))
        url = f.get(stem, "").strip()  # info.txt の offvocal: URL / lyrics: URL(GitHub の Releases に置いたファイルなど。種類と大きさは offvocal-type: / offvocal-size:)
        if url.startswith("http"):
            size = f.get(stem + "-size", "").strip()
            bundled = stem == "offvocal" and f.get("offvocal-bundle", "").strip().lower() in ("lyrics", "歌詞", "yes")  # 歌詞も一緒に ZIP にしてある
            downloads.append({"name": "オフボーカル + 歌詞" if bundled else name, "path": None, "url": url, "size": int(size) if size.isdigit() else 0,
                              "ext": (f.get(stem + "-type", "") or Path(url.split("?")[0]).suffix[1:]).strip().upper()})
    local_off = [x for x in downloads if x["path"] and x["name"] == "オフボーカル"]
    local_lyr = [x for x in downloads if x["path"] and x["name"] == "歌詞"]
    if local_off and local_lyr:  # フォルダに両方あるときは、1つの ZIP にまとめて、ボタンも1つにする(ZIP は、ビルドのときに作る)
        picked = [("offvocal", local_off[0]["path"]), ("lyrics", local_lyr[0]["path"])]
        downloads = [x for x in downloads if x not in (local_off[0], local_lyr[0])]
        downloads.insert(0, {"name": "オフボーカル + 歌詞", "path": None, "url": d.name + "-offvocal.zip", "bundle": picked, "ext": "ZIP", "size": 0})
    w = {
        "downloads": downloads,
        "bpm": parse_bpm(f.get("bpm", "")),
        "genre": f.get("genre", "").strip(),
        "duration": int(f["duration"]) if f.get("duration", "").strip().isdigit() else 0,  # 全曲の合計の秒数(Apple Music から取り込む)
        "copyright": f.get("copyright", "").strip(),
        "slug": d.name,
        "dir": d,
        "title": f.get("title") or d.name,
        "title_orig": f.get("title-orig", ""),
        "aliases": [x.strip() for x in re.split(r"[,、]", f.get("aliases", "")) if x.strip()],
        "date": date,
        "type": t if t in TYPES else infer_type(links),
        "tracks": tracks,
        "release": f.get("release", "").strip().lower(),
        "related_raw": [x.strip() for x in f.get("related", "").split(",") if x.strip()],
        "booth_ids": [x.strip() for x in re.split(r"[,、]", f.get("booth", "")) if x.strip()],
        "related": [],
        "desc": f.get("description", ""),
        "body": body,
        "links": [(lab or platform_label(u), u) for lab, u in links],
        "embeds": embeds,
        "cover": cover,
        "cover_url": cover_url,
        "clips": sorted(p for p in d.glob("bg*.mp4") if p.name != "bg.part.mp4"),  # 背景用のクリップ(add_bgclip.py が作る)
        "gallery": [p for p in images if p != cover],
    }
    if w["type"] != "video" and w["bpm"]:  # BPM は MV にだけ出す
        print("  ! %s: bpm: は MV(type: video)にだけ表示します(この作品では表示しません)" % d.name)
        w["bpm"] = None
    w["headline"] = make_headline(w, f)
    songs = {norm_song(clean_track(x)) for x in tracks}
    songs.add(norm_song(video_song(w["title"]) if w["type"] == "video" else w["title"]))
    w["songs"] = {x for x in songs if x}
    return w


def hue(title):
    return sum(map(ord, title)) % 360


def cover_html(w, base):
    """base: 表紙画像があるフォルダへの相対パス(末尾スラッシュ付き、同じ階層なら空)"""
    if w["cover"]:
        src = base + quote(w["cover"].name)
    elif w["cover_url"]:
        src = w["cover_url"]
    else:
        return '<div class="ph" style="--h:%d" aria-hidden="true"><span>%s</span></div>' % (
            hue(w["title"]), esc(w["title"][:1]))
    return '<img src="%s" alt="%s" loading="lazy">' % (esc(src), esc(w["title"]))


def paragraphs(text):
    out = []
    for block in re.split(r"\n\s*\n", text.strip()):
        if not block.strip():
            continue
        h = esc(block.strip()).replace("\n", "<br>")
        h = re.sub(r"(https?://[^\s<]+)", r'<a href="\1" rel="noopener">\1</a>', h)
        out.append("<p>%s</p>" % h)
    return "\n".join(out)


def ld_script(data):
    """検索エンジン向けの構造化データ(JSON-LD)"""
    return '<script type="application/ld+json">%s</script>' % json.dumps(data, ensure_ascii=False).replace("</", "<\\/")


def site_base(site):
    return site["url"].rstrip("/") if site.get("url") else ""


def work_jsonld(site, w):
    """作品ページの構造化データ。音楽は MusicAlbum、動画は VideoObject、それ以外は CreativeWork"""
    base = site_base(site)
    if not base:
        return None
    url = base + "/w/%s/" % quote(w["slug"])
    image = base + "/w/%s/%s" % (quote(w["slug"]), quote(w["cover"].name)) if w["cover"] else w["cover_url"]
    same = [u for _, u in w["links"] if u.startswith("http")]
    d = {"@context": "https://schema.org", "name": w["title"], "url": url, "datePublished": w["date"].isoformat(),
         "inLanguage": "ja"}
    if image:
        d["image"] = image
    if same:
        d["sameAs"] = same
    artist = {"@type": "MusicGroup", "name": site["name"], "url": base + "/"}
    if w["type"] == "music":
        d["@type"] = "MusicAlbum"
        d["byArtist"] = artist
        rel = {"single": "SingleRelease", "ep": "EPRelease", "album": "AlbumRelease"}.get(w["release"])
        if rel:
            d["albumReleaseType"] = "https://schema.org/" + rel
        if w["tracks"]:
            d["numTracks"] = len(w["tracks"])
            d["track"] = [{"@type": "MusicRecording", "name": t, "byArtist": artist} for t in w["tracks"]]
    elif w["type"] in ("video", "project") and image:
        d["@type"] = "VideoObject"
        d["description"] = w["headline"] or w["desc"] or w["title"]
        d["thumbnailUrl"] = image
        d["uploadDate"] = w["date"].isoformat()
        emb = next((e[1] for e in w["embeds"] if e[0] == "video"), None)
        if emb:
            d["embedUrl"] = emb
    else:
        d["@type"] = "CreativeWork"
        d["creator"] = artist
    return d


def home_jsonld(site):
    base = site_base(site)
    if not base:
        return None
    same = [u for _, u in list(site["links"]) + list(site["menu"]) if u.startswith("http")]
    group = {"@type": "MusicGroup", "name": site["name"], "url": base + "/"}
    if same:
        group["sameAs"] = same
    return {"@context": "https://schema.org", "@graph": [
        {"@type": "WebSite", "name": site["name"], "url": base + "/", "inLanguage": "ja"}, group]}


def render_sitemap(site, works):
    """sitemap.xml(トップと全作品ページ)。lastmod は作品の日付"""
    base = site_base(site)
    if not base:
        return None
    latest = max((w["date"] for w in works), default=datetime.date.today())
    rows = [(base + "/", latest)] + [(base + "/w/%s/" % quote(w["slug"]), w["date"]) for w in works]
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n%s\n</urlset>\n'
            % "\n".join("<url><loc>%s</loc><lastmod>%s</lastmod></url>" % (esc(u), d.isoformat()) for u, d in rows))


def page(site, title, desc, body, root, og_image=None, canonical=None, body_class="", jsonld=None):
    meta = ['<meta name="description" content="%s">' % esc(desc)] if desc else []
    meta += ['<meta property="og:title" content="%s">' % esc(title),
             '<meta property="og:type" content="website">',
             '<meta property="og:site_name" content="%s">' % esc(site["name"]),
             '<meta property="og:locale" content="ja_JP">']
    if canonical:
        meta.append('<link rel="canonical" href="%s">' % esc(canonical))
    if jsonld:
        meta.append(ld_script(jsonld))
    if desc:
        meta.append('<meta property="og:description" content="%s">' % esc(desc))
    if canonical:
        meta.append('<meta property="og:url" content="%s">' % esc(canonical))
    if og_image:
        meta += ['<meta property="og:image" content="%s">' % esc(og_image),
                 '<meta name="twitter:card" content="summary_large_image">']
    return """<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>%s</title>
%s
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Montserrat:wght@600;700&display=swap">
<script>document.documentElement.className += " js"</script>
<link rel="stylesheet" href="%sstyle.css">
<script src="%sfx.js" defer></script>
</head>
<body class="%s">
%s
<footer class="foot"><div class="wrap"><p>© %d %s</p></div></footer>
</body>
</html>
""" % (esc(title), "\n".join(meta), root, root, body_class, body,
       datetime.date.today().year, esc(site["name"]))


def svc_of(url):
    """ボタンの色分け用。サービス名(style.css の .btn[data-svc=…] に対応)"""
    name = platform_label(url)
    return {"Apple Music": "apple", "Spotify": "spotify", "YouTube": "youtube", "YouTube Music": "youtube",
            "ニコニコ動画": "niconico", "BOOTH": "booth", "SoundCloud": "soundcloud", "Bandcamp": "bandcamp"}.get(name, "")


def portable_text(path):
    """歌詞の txt を、Mac でも Windows でも文字化けしない形(UTF-8 + BOM、改行は CRLF)にした bytes を返す。元のファイルは変えない。
    元の文字コードは、UTF-8 → Shift-JIS(cp932)→ UTF-16 の順に試す。どれでも読めなければ、そのまま返す"""
    raw = Path(path).read_bytes()
    for enc in ("utf-8-sig", "cp932", "utf-16"):
        try:
            text = raw.decode(enc)
            break
        except (UnicodeDecodeError, UnicodeError):
            continue
    else:
        return raw
    text = text.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    if text and not text.endswith("\n"):
        text += "\n"
    return ("\ufeff" + text.replace("\n", "\r\n")).encode("utf-8")


def bundle_readme(title, site_url):
    """オフボーカルと歌詞をまとめた ZIP に入れる、README.txt の文面: 作品名と、ガイドライン全文(note。guideline.txt の link:)へのURLだけ。
    Windows のメモ帳でも文字化けしないよう、先頭に BOM を付け、改行は CRLF にする"""
    g = load_guideline()
    lines = [title, "オフボーカル・歌詞", "", "【ご利用の前に、必ずお読みください】"]
    if g and g["link"]:
        lines.append("ガイドライン全文: " + g["link"])
    elif site_url:
        lines.append("ガイドライン: " + site_url.rstrip("/") + "/#guideline")
    return "\ufeff" + "\r\n".join(lines) + "\r\n"


def make_bundle(paths, dst, title, site_url):
    """オフボーカルと歌詞のファイルを、1つの ZIP にまとめる(ZIP の中の名前は、offvocal.wav / lyrics.txt / README.txt)。paths: [(名前の頭, ファイル)]"""
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for stem, p in paths:
            if stem == "lyrics" and p.suffix.lower() == ".txt":  # 歌詞の txt は、文字化けしない形に直して入れる
                z.writestr(stem + ".txt", portable_text(p))
            else:
                z.write(p, stem + p.suffix.lower())
        z.writestr("README.txt", bundle_readme(title, site_url))


def fmt_size(n):
    return "%.1fMB" % (n / 1048576) if n >= 1048576 else "%dKB" % max(1, round(n / 1024))


def download_buttons(w):
    """作品のフォルダに置いたオフボーカル・歌詞のファイルを、直接ダウンロードするボタン(あるときだけ)"""
    if not w["downloads"]:
        return ""
    def btn(x):
        info = " · ".join(v for v in (esc(x["ext"]), fmt_size(x["size"]) if x["size"] else "") if v)
        return ('<a class="btn dl" href="%s" download%s>%s<span aria-hidden="true"> ↓</span>%s</a>'
                % (esc(x["url"] if x["url"].startswith("http") else quote(x["url"] or x["path"].name)), ' rel="noopener"' if x["url"].startswith("http") else "", esc(x["name"]),
                   "<small>%s</small>" % info if info else ""))
    btns = "\n".join(btn(x) for x in w["downloads"])
    g = load_guideline()  # ダウンロードを押したときの確認(fx.js)で、読んでもらうガイドライン全文のURL(note)
    gl = g["link"] if g and g["link"] else ""
    return '<div class="downloads"%s><div class="links">%s</div></div>' % (' data-guideline="%s"' % esc(gl) if gl else "", btns)


def link_buttons(links):
    out = []
    for i, (lab, u) in enumerate(links):
        svc = svc_of(u)
        out.append('<a class="btn%s"%s href="%s" target="_blank" rel="noopener">%s<span aria-hidden="true"> ↗</span></a>'
                   % (" primary" if (i == 0 and not svc) else "", ' data-svc="%s"' % svc if svc else "", esc(u), esc(lab)))
    return "\n".join(out)


def booth_buttons(w):
    """BOOTH のボタン。自分の CD、なければ関連作品の CD(最大2つ)"""
    own = [i for i in w["booth"] if _CD.search(i["name"])]
    if own:
        return [("BOOTH", i["url"]) for i in own[:2]]
    return [("BOOTH(%s)" % r["title"], i["url"]) for r, i in w["booth_rel"] if _CD.search(i["name"])][:2]


def render_booth(w):
    rel_only = not w["booth"]
    rows = [(i, None) for i in w["booth"]] + ([(i, r) for r, i in w["booth_rel"][:4]] if rel_only else [])
    if not rows:
        return ""
    body = "\n".join('<a class="row" href="%s" target="_blank" rel="noopener"><span class="p">¥%s</span><span class="t">%s</span>'
                     '<span class="k">%s</span></a>' % (esc(i["url"]), "{:,}".format(i["price"]), esc(i["name"]),
                                                      esc(r["title"]) if r else "BOOTH ↗") for i, r in rows)
    more = ""
    if rel_only and len(w["booth_rel"]) > 4:
        more = '<p class="more-link"><a href="https://myship.booth.pm/" target="_blank" rel="noopener">%s</a></p>' % "ほかの商品は BOOTH で ↗"
    return '<section class="booth"><h2>%s</h2><div class="rows">%s</div>%s</section>' % (
        "BOOTH" if w["booth"] else "関連する商品(BOOTH)", body, more)


def render_embed(e, title):
    kind, src, h = e
    if kind == "video":
        return ('<div class="embed video"><iframe src="%s" title="%s" loading="lazy" allowfullscreen '
                'allow="accelerometer; encrypted-media; gyroscope; picture-in-picture"></iframe></div>') % (esc(src), esc(title))
    return ('<div class="embed audio"><iframe src="%s" title="%s" loading="lazy" style="height:%dpx" '
            'allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"></iframe></div>') % (
        esc(src), esc(title), h)


def orig_line(w):
    """見出しを出したときに、作品名(と Apple 上の原題)を添える"""
    if not w["headline"]:
        return ""
    parts = ["作品名: " + esc(w["title"]) + (" <span>(%s)</span>" % esc(w["title_orig"]) if w["title_orig"] else "")]
    if w["aliases"]:
        parts.append("別名: " + esc("、".join(w["aliases"])))
    return '<p class="orig">%s</p>' % "　".join(parts)


def render_tracks(w):
    if len(w["tracks"]) < 2:
        return ""
    return '<section class="tracks"><h2>%s</h2><ol>%s</ol></section>' % ("収録曲", "".join(
        "<li>%s</li>" % esc(t) for t in w["tracks"]))


def render_related(w):
    if not w["related"]:
        return ""
    rows = "\n".join(
        '<a class="row" href="../%s/"><time>%s</time><span class="t">%s</span><span class="k">%s</span></a>'
        % (quote(r["slug"]), fmt_date(r["date"]), esc(r["headline"] or r["title"]), TYPES[r["type"]])
        for r in w["related"])
    return '<section class="related"><h2>%s</h2><div class="rows">%s</div></section>' % ("関連作品", rows)


def fmt_duration(sec):
    """秒数を、m:ss(1時間以上は h:mm:ss)にする"""
    h, rest = divmod(int(sec), 3600)
    m, s = divmod(rest, 60)
    return "%d:%02d:%02d" % (h, m, s) if h else "%d:%02d" % (m, s)


def cd_attrs(w):
    """Streaming(音楽)の作品のジャケットを、押すと CD ケースの3D表示になるようにする属性(表示は fx.js と style.css)。表紙の画像があるときだけ"""
    if w["type"] != "music" or not w["cover"]:
        return ""
    data = {"title": w["title"], "artist": w["desc"], "date": fmt_date(w["date"]), "tracks": list(w["tracks"]),
            "short": [clean_track(t) or t for t in w["tracks"]]}  # short: 裏面用に、(feat. ○○)などを除いた曲名
    # ケースの内側に出す、Apple Music の情報(ジャンル・曲数と合計の再生時間・℗ の表記)。あるものだけ
    if w["genre"]:
        data["genre"] = w["genre"]
    if w["duration"]:
        data["time"] = fmt_duration(w["duration"])
    if w["copyright"]:
        data["copyright"] = w["copyright"]
    return (' data-cd="%s" role="button" tabindex="0" aria-label="CDケースの3D表示で見る"'
            % esc(json.dumps(data, ensure_ascii=False)))


def render_work(site, w):
    song = ""
    if w["bpm"]:
        song += '<span class="sd">BPM <b>%s</b><i class="beats" aria-hidden="true"><i></i><i></i><i></i><i></i></i></span>' % fmt_bpm(w["bpm"])
    meta = '<p class="meta"><span class="badge">%s</span><time>%s</time>%s</p>' % (TYPES[w["type"]], fmt_date(w["date"]), song)
    gallery = ""
    if w["gallery"]:
        gallery = '<div class="gallery">%s</div>' % "".join(
            '<a href="%s" target="_blank"><img src="%s" alt="" loading="lazy"></a>' % ((quote(p.name),) * 2)
            for p in w["gallery"])
    body = """<header class="top"><div class="wrap"><a href="../../">← %s</a></div></header>
<main class="wrap work">
<div class="work-head%s"%s>
<div class="work-cover"%s>%s</div>
<div class="work-info">
%s
<h1>%s</h1>
%s
%s
<div class="links">%s</div>
%s
%s
</div>
</div>
%s
<div class="body">%s</div>
%s
%s
</main>""" % (
        esc(site["name"]),
        " pulse" if w["bpm"] else "", ' style="--beat:%.3fs"' % beat_seconds(w["bpm"]) if w["bpm"] else "",
        cd_attrs(w), cover_html(w, ""),
        meta, esc(w["headline"] or w["title"]),
        '<p class="lead">%s</p>' % esc(w["desc"]) if w["desc"] else "",
        orig_line(w),
        link_buttons(list(w["links"]) + booth_buttons(w)), download_buttons(w), render_tracks(w),
        "".join(render_embed(e, w["title"]) for e in w["embeds"]),
        paragraphs(w["body"]), render_booth(w) + render_related(w), gallery)
    og = None
    if site.get("url") and w["cover"]:
        og = site["url"].rstrip("/") + "/w/%s/%s" % (quote(w["slug"]), quote(w["cover"].name))
    canon = site["url"].rstrip("/") + "/w/%s/" % quote(w["slug"]) if site.get("url") else None
    return page(site, "%s | %s" % (w["title"], site["name"]), w["headline"] or w["desc"] or site["tagline"], body, "../../", og,
                canon, "work-page", work_jsonld(site, w))


def background_ids(site):
    """背景に流す動画ID。background: が空/works なら Works の YouTube 動画すべて、URLならその1本、off なら無し"""
    bg = site["background"].strip()
    if bg.lower() in ("off", "none", "なし"):
        return []
    if bg and bg.lower() not in ("works", "auto"):
        vid = youtube_id(bg)
        return [vid] if vid else []
    return site.get("work_videos", [])


def background_clips(site):
    """背景に流す自前クリップ(works/<作品>/bg.mp4)。background: が空/works のときだけ使う"""
    bg = site["background"].strip().lower()
    if bg in ("off", "none", "なし") or (bg and bg not in ("works", "auto")):
        return []
    return site.get("work_clips", [])


def render_bgvideo(site):
    """背景の動画。自前クリップがあればそれを、なければ YouTube を使う。再生順のシャッフルは fx.js(PCだけ読み込む)"""
    clips = background_clips(site)
    if clips:
        pixel = ' data-mosaic="pixel"' if site["mosaic_style"] == "pixel" and site["mosaic"] > 0 else ""
        return ('<div class="bgvideo" aria-hidden="true" style="--cell:%dpx" data-clips="%s"%s>'
                '<video muted playsinline preload="auto" tabindex="-1"></video></div>\n') % (
            site["mosaic"], esc(",".join(clips)), pixel)
    ids = background_ids(site)
    if not ids:
        return ""
    return ('<div class="bgvideo" aria-hidden="true" style="--cell:%dpx" data-videos="%s">'
            '<iframe tabindex="-1" allow="autoplay; encrypted-media" title=""></iframe></div>\n') % (
        site["mosaic"], esc(",".join(ids)))


def contact_href(v):
    if not v or "://" in v or v.startswith("mailto:"):
        return v
    return "mailto:" + v


def nav_link(label, url):
    ext = url.startswith("http")
    panel = {"#works": "works", "#events": "events", "#contact": "contact", "#guideline": "guideline"}.get(url)
    attrs = ' target="_blank" rel="noopener"' if ext else (
        ' class="pn" data-panel="%s" aria-controls="%s"' % (panel, panel) if panel else "")
    return '<a href="%s"%s>%s</a>' % (esc(url), attrs, esc(label))


def cover_src(w):
    """トップのリストでホバー時に出すジャケット画像(なければ空)"""
    if w["cover"]:
        return "w/%s/%s" % (quote(w["slug"]), quote(w["cover"].name))
    return w["cover_url"] or ""


EVENTS_FILE = ROOT / "events.txt"


def load_events():
    """events.txt の「日付 | タイトル | 場所 | URL」を読む(# で始まる行は無視)"""
    out = []
    if EVENTS_FILE.exists():
        for line in EVENTS_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = [x.strip() for x in line.split("|")] + ["", "", ""]
            d = parse_date(parts[0])
            if d and parts[1]:
                out.append({"date": d, "title": parts[1], "venue": parts[2], "url": parts[3]})
    return out


def render_events(events):
    today = datetime.date.today()
    up = sorted((e for e in events if e["date"] >= today), key=lambda e: e["date"])
    past = sorted((e for e in events if e["date"] < today), key=lambda e: e["date"], reverse=True)[:6]

    def row(e, cls=""):
        inner = '<time>%s</time><div class="evt"><span class="t">%s</span>%s</div>' % (
            fmt_date(e["date"]), esc(e["title"]), ('<span class="v">%s</span>' % esc(e["venue"])) if e["venue"] else "")
        if e["url"]:  # URL があれば、日付・名前・場所の上も含めて、行全体がリンク
            return '<a class="ev%s" href="%s" target="_blank" rel="noopener">%s<span class="k">%s</span></a>' % (
                cls, esc(e["url"]), inner, "詳細 ↗")
        return '<div class="ev%s">%s<span></span></div>' % (cls, inner)
    body = "".join(row(e) for e in up) or '<p class="empty">%s</p>' % "現在、出演予定はありません。"
    if past:
        body += '<h3 class="sub">%s</h3>' % "過去の出演" + "".join(row(e, " past") for e in past)
    return '<section class="rpanel" id="events" aria-label="Events"><h2 class="ptitle">Events</h2>%s</section>' % body


GUIDELINE_FILE = ROOT / "guideline.txt"
PRICING_FILE = ROOT / "pricing.txt"


def yen(n):
    return "¥{:,}".format(n)


def load_guideline():
    """guideline.txt を {link, updated, intro, sections:[(見出し, [項目])]} に読む。なければ None"""
    path = GUIDELINE_FILE
    if not path.exists():
        return None
    g = {"link": "", "updated": "", "intro": "", "sections": []}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") and not line.startswith("##"):
            continue
        if line.startswith("##"):
            g["sections"].append((line.lstrip("#").strip(), []))
            continue
        m = re.match(r"^(link|updated|intro)\s*:\s*(.*)$", line)
        if m and not g["sections"]:
            g[m.group(1)] = m.group(2).strip()
        elif g["sections"]:
            g["sections"][-1][1].append(line)
    return g if g["sections"] else None


def render_guideline(g):
    """Guideline パネル(二次利用ガイドラインの要点)。全文へのリンク付き"""
    if not g:
        return ""
    body = ""
    if g["link"]:  # 全文へのリンクは、いちばん上に置く
        body += '<p class="more-link gl-link"><a href="%s" target="_blank" rel="noopener">%s</a></p>' % (esc(g["link"]), "ガイドライン全文を読む(note) ↗")
    if g["intro"]:
        body += '<p class="note">%s</p>' % esc(g["intro"])
    for title, items in g["sections"]:
        body += '<h3 class="sub">%s</h3><ul class="gl">%s</ul>' % (esc(title), "".join("<li>%s</li>" % esc(i) for i in items))
    if g["updated"]:
        body += '<p class="gdate">%s</p>' % esc(g["updated"])
    return '<section class="rpanel" id="guideline" aria-label="Guideline"><h2 class="ptitle">Guideline</h2>%s</section>' % body


def _read_pricing(path):
    plans, opts, notes = [], [], []
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = [x.strip() for x in line.split("|")] + ["", "", "", "", ""]
            kind = parts[0].lower()
            if kind == "note" and parts[2]:
                notes.append(parts[2])
            elif kind in ("plan", "option") and parts[2]:
                digits = re.sub(r"\D", "", parts[3])
                entry = {"group": parts[1], "item": parts[2], "price": int(digits) if digits and parts[3].replace(",", "").replace("¥", "").strip().isdigit() else None,
                         "label": parts[3], "note": parts[4], "target": parts[5]}
                (plans if kind == "plan" else opts).append(entry)
    return plans, opts, notes


def load_pricing():
    """pricing.txt を (プラン, オプション, 注意事項) に読む。プラン/オプションは {group, item, price(整数 or None), note}"""
    return _read_pricing(PRICING_FILE)


def price_text(e):
    return yen(e["price"]) if e["price"] is not None else (e["label"] or "要相談")


def render_prices(plans, opts, notes):
    """料金表(折りたたみ)。pricing.txt から作る"""
    def table(entries):
        out, last = [], None
        for e in entries:
            if e["group"] != last:
                out.append('<h4>%s</h4>' % esc(e["group"]))
                last = e["group"]
            out.append('<div class="pr"><span>%s</span><span>%s%s</span></div>' % (
                esc(e["item"]), esc(price_text(e)), (' <small>%s</small>' % esc(e["note"])) if e["note"] else ""))
        return "".join(out)
    notes_html = ('<h4>%s</h4><ul>%s</ul>' % ("ご依頼にあたって", "".join("<li>%s</li>" % esc(n) for n in notes))) if notes else ""
    return '<details class="prices"><summary>%s</summary>%s%s%s</details>' % ("料金表を見る(税込)", table(plans), table(opts), notes_html)


def render_contact(site):
    """依頼受付フォーム。form: にフォームのURLがあれば埋め込み、なければ pricing.txt の料金表をもとにした、メールの下書きを作るフォーム"""
    to = site["contact"] if "@" in site["contact"] and "://" not in site["contact"] else ""
    note = '<p class="note">%s</p>' % "お仕事のご依頼・ご相談はこちらから。内容を確認のうえ、ご返信します。"
    required_note = '<p class="note">%s</p>' % "※ オプション以外の項目は、すべて入力が必要です。"
    if site["form"]:
        u = esc(site["form"])
        inner = ('%s<iframe class="form-embed" src="%s" title="%s" loading="lazy"></iframe>'
                 '<p class="more-link"><a href="%s" target="_blank" rel="noopener">%s</a></p>') % (note, u, "依頼受付フォーム", u, "表示されないときは別のタブで開く ↗")
    elif to:
        plans, opts, notes = load_pricing()
        kinds = [("楽曲制作", ""), ("編曲", ""), ("MIX・Mastering", "1"), ("イベント出演", ""), ("その他", "")]
        kind_opts = '<option value="" disabled selected>%s</option>' % "選んでください" + "".join(
            '<option value="%s"%s>%s</option>' % (k, ' data-mix="1"' if mix else "", k) for k, mix in kinds)
        mixbox = ""
        if plans:  # 「MIX・Mastering」を選んだときだけ表示する、プラン・オプション・料金表・見積りの目安
            groups, order = {}, []
            for e in plans:
                if e["group"] not in groups:
                    groups[e["group"]] = []
                    order.append(e["group"])
                groups[e["group"]].append(e)
            plan_opts = '<option value="" disabled selected>%s</option>' % "選んでください" + "".join(
                '<optgroup label="%s">%s</optgroup>' % (esc(g), "".join(
                    '<option value="%s" data-price="%s" data-group="%s" data-item="%s" data-pt="%s">%s(%s)</option>' % (
                        esc("%s / %s" % (e["group"], e["item"])), "" if e["price"] is None else e["price"], esc(g), esc(e["item"]), esc(price_text(e)),
                        esc(e["item"]), esc(price_text(e)))
                    for e in groups[g])) for g in order)
            options = ""
            if opts:
                options = '<fieldset class="opts" hidden><legend>%s</legend>%s</fieldset>' % ("オプション(任意・複数選べます)", "".join(
                    '<label class="chk" data-for="%s"><input type="checkbox" name="オプション" value="%s" data-price="%s"> %s <span class="pc">%s%s</span></label>' % (
                        esc(e["target"]), esc(e["item"]), "" if e["price"] is None else e["price"], esc(e["item"]),
                        ("+" if e["price"] is not None else "") + esc(price_text(e)),
                        (' <small>%s</small>' % esc(e["note"])) if e["note"] else "") for e in opts))
            mixbox = ('<div class="mixbox" hidden>%s<label>%s<select name="プラン" disabled required>%s</select></label>%s'
                      '<p class="est" aria-live="polite" hidden></p></div>') % (render_prices(plans, opts, notes), "ご依頼のプラン", plan_opts, options)
        direct = bool(site["form_key"])  # 送信用のキーがあれば、フォームから直接送る(なければ、メールの下書きを作る)
        endpoint = ' data-endpoint="%s" data-key="%s"' % (esc(site["form_endpoint"]), esc(site["form_key"])) if direct else ""
        inner = (note + required_note + '<form class="req" data-to="%s" action="mailto:%s" method="post" enctype="text/plain"' + endpoint + '>'
                 '<div class="fields">'
                 '<div class="prog" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-label="' + "入力の進み具合" + '">'
                 '<div class="bar"><i></i></div><p class="pt"></p></div>'
                 '<label>' + "お名前" + '<input name="お名前" required autocomplete="name"></label>'
                 '<label>' + "返信先のメールアドレス" + '<input name="返信先" type="email" required autocomplete="email"></label>'
                 '<label>' + "ご依頼の内容" + '<select name="種類" required>%s</select></label>'
                 '%s'
                 '<label>' + "ご希望の納期" + '<input type="date" name="納期" required></label>'
                 '<label class="chk"><input type="checkbox" name="納期未定"> ' + "日付は未定・相談したい" + '</label>'
                 '<label>' + "詳細・ご要望(曲名・トラック数・参考URLなど)" + '<textarea name="内容" rows="6" required></textarea></label>'
                 + ('<input type="checkbox" name="botcheck" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">' if direct else '') +
                 '<div class="actions"><button type="submit" class="send">%s</button>%s</div>'
                 '<p class="status" role="status" aria-live="polite" hidden></p>'
                 '<p class="fine">%s</p>'
                 '</div>'
                 '<div class="thanks" hidden><p class="big">Thank you</p>'
                 '<p class="done">' + "送信完了" + '</p>'
                 '<div class="recap"><p class="rl">' + "送信した内容" + '</p><pre></pre></div>'
                 '<p class="cp"><a class="copy" href="#">' + "控えをメールで受け取る" + '</a></p>'
                 '<p class="cn">' + "ご入力のメールアドレス宛の下書きが、メールアプリで開きます。送信すると、控えとして手元に残ります。" + '</p>'
                 '<button type="button" class="again">' + "もう一度入力する" + '</button></div>'
                 '</form>') % (esc(to), esc(to), kind_opts, mixbox,
                               "この内容で送信する" if direct else "メールの下書きを作る",
                               '<button type="button" class="draft">%s</button>' % "メールアプリで下書きを作る" if direct else "",
                               "送信内容は、メール配信サービス(Web3Forms)を経由して、BCNO に届きます。メールアプリで送りたいときは、「メールアプリで下書きを作る」を押してください。" if direct
                               else "ボタンを押すと、メールアプリが開いて、入力内容が下書きされます。送信はメールアプリで行ってください。")
    elif site["contact"]:
        inner = note + '<p><a class="btn primary" href="%s" target="_blank" rel="noopener">%s <span aria-hidden="true">↗</span></a></p>' % (esc(site["contact"]), "依頼フォームを開く")
    else:
        inner = note
    return '<section class="rpanel" id="contact" aria-label="%s"><h2 class="ptitle">%s</h2>%s</section>' % ("依頼受付フォーム", "依頼受付フォーム", inner)


MUSIC_HOSTS = {"open.spotify.com", "music.apple.com", "itunes.apple.com", "soundcloud.com", "music.youtube.com", "music.amazon.co.jp", "linkco.re"}


def render_index(site, works):
    types_present = [t for t in TYPES if any(w["type"] == t for w in works)]
    chips = ""
    if len(types_present) > 1:
        chips = '<nav class="chips" aria-label="%s"><button class="chip" data-type="all" aria-pressed="true">All</button>%s</nav>' % ("絞り込み", "".join(
            '<button class="chip" data-type="%s" aria-pressed="false">%s</button>' % (t, TYPES[t]) for t in types_present))
    def row_html(w):
        return ('<a class="row" data-type="%s" data-cover="%s" href="w/%s/"><time>%s</time><span class="t">%s</span>'
                '<span class="k">%s</span></a>'
                % (w["type"], esc(cover_src(w)), quote(w["slug"]), fmt_date(w["date"]), esc(w["headline"] or w["title"]), TYPES[w["type"]]))
    # 年ごとに折りたたむ(いちばん新しい年だけ開いておく)。works は新しい順
    rows = "\n".join(
        '<details class="yr" data-year="%d"%s><summary><span class="y">%d</span><small>%d</small></summary><div class="rows">\n%s\n</div></details>'
        % (year, " open" if i == 0 else "", year, len(ws), "\n".join(row_html(w) for w in ws))
        for i, (year, ws) in enumerate((y, list(g)) for y, g in itertools.groupby(works, key=lambda w: w["date"].year)))
    if not rows:
        rows = '<p class="empty">%s</p>' % "まだ作品がありません。works フォルダに作品フォルダを追加してください。"

    bgvideo = render_bgvideo(site)

    guideline = load_guideline()
    menu = [(lab, u) for lab, u in site["menu"] if u != "#guideline" or guideline]  # guideline.txt がなければ「Guideline」の項目は出さない
    items = ([("Works", "#works"), ("Events", "#events")] + ([("About", "#about")] if site["about"] else []) + menu
             + ([("Contact", "#contact")] if (site["contact"] or site["form"]) else []))
    nav = "\n".join(nav_link(lab or platform_label(u), u) for lab, u in items)
    # メニューの下の小さなリンクは、SNS などの行(上)と、音楽サービス(Spotify・Apple Music など)の行(下)に分けて並べる
    music = [(lab, u) for lab, u in site["links"] if host_of(u) in MUSIC_HOSTS or host_of(u).endswith(".bandcamp.com")]
    others = [(lab, u) for lab, u in site["links"] if (lab, u) not in music]
    sns = "".join('<p class="sns">%s</p>' % "".join(nav_link(lab or platform_label(u), u) for lab, u in row)
                  for row in (others, music) if row)
    logo = ('<h1 class="logo"><img src="%s" alt="%s"></h1>' % (quote(site["logo"]), esc(site["name"]))
            if site["logo"] else '<h1 class="logo">%s</h1>' % esc(site["name"]))
    about = ('<section class="about wrap" id="about"><h2>About</h2>%s</section>' % paragraphs(site["about"])
             if site["about"] else "")
    script = """<script>
(function () {
  var wrap = document.querySelector('.yrs');
  var yrs = wrap ? Array.prototype.slice.call(wrap.querySelectorAll('.yr')) : [];
  var tabs = [], bar = null;
  // JavaScript が使えるときは、年ごとの折りたたみを、横並びのタブ(スマホでは横スワイプ)に切り替える。使えないときは、折りたたみのまま
  if (yrs.length > 1) {
    bar = document.createElement('div');
    bar.className = 'ytabs';
    bar.setAttribute('role', 'tablist');
    bar.setAttribute('aria-label', '年');
    yrs.forEach(function (y) {
      var t = document.createElement('button');
      t.type = 'button';
      t.className = 'ytab';
      t.setAttribute('role', 'tab');
      t.innerHTML = '<span class="y">' + y.dataset.year + '</span><small>' + y.querySelector('summary small').textContent + '</small>';
      t.addEventListener('click', function () { show(y); });
      bar.appendChild(t);
      tabs.push(t);
    });
    wrap.insertBefore(bar, wrap.firstChild);
    wrap.classList.add('tabbed');
    yrs.forEach(function (y) { y.open = true; });
  }
  function show(y, auto) {
    yrs.forEach(function (o, i) {
      var on = o === y;
      o.classList.toggle('cur', on);
      tabs[i].setAttribute('aria-selected', on);
      // 自分でタブを押したときは動かさない。絞り込みで年が自動で切り替わったときだけ、そのタブが見える位置まで最小限に動かす
      if (on && auto) {
        var tr = tabs[i].getBoundingClientRect(), br = bar.getBoundingClientRect();
        if (tr.left < br.left) bar.scrollLeft += tr.left - br.left;
        else if (tr.right > br.right) bar.scrollLeft += tr.right - br.right;
      }
    });
  }
  if (bar) show(yrs[0]);
  document.querySelectorAll('.chip').forEach(function (b) {
    b.addEventListener('click', function () {
      var t = b.dataset.type;
      document.querySelectorAll('.chip').forEach(function (c) { c.setAttribute('aria-pressed', c === b); });
      document.querySelectorAll('.row').forEach(function (c) { c.hidden = t !== 'all' && c.dataset.type !== t; });
      // 年ごとのまとまり: 件数を数え直す。タブのときは、該当のない年のタブを隠して、該当のある最新の年を選び直す
      // 折りたたみのときは、空の年を隠し、種類で絞ったときは該当のある年をすべて開き、「All」に戻したら、いちばん新しい年だけ開く
      var first = true, pick = null;
      yrs.forEach(function (y, i) {
        var n = y.querySelectorAll('.row:not([hidden])').length;
        y.querySelector('summary small').textContent = n;
        if (bar) {
          tabs[i].querySelector('small').textContent = n;
          tabs[i].hidden = !n;
          y.hidden = !n;
          if (n && !pick) pick = y;
          return;
        }
        y.hidden = !n;
        if (!n) return;
        y.open = t !== 'all' || first;
        first = false;
      });
      if (bar && pick) show(pick, true);
    });
  });
})();
</script>"""
    body = """%s
<main class="stage">
<section class="menu">
%s
%s
<button type="button" class="menu-toggle" aria-expanded="false" aria-controls="site-nav">MENU<span class="mt-mark" aria-hidden="true"></span></button>
<nav class="nav" id="site-nav">
%s
</nav>
%s
</section>
<div class="rpanels">
<section class="rpanel works-list" id="works" aria-label="Works">
%s
<div class="yrs">
%s
</div>
</section>
%s
%s
%s
</div>
</main>
%s
%s""" % (bgvideo, logo, '<p class="tagline">%s</p>' % esc(site["tagline"]) if site["tagline"] else "",
         nav, sns,
         chips, rows, render_events(load_events()), render_guideline(guideline), render_contact(site), about, script)
    og = None
    if site.get("url") and site["og_image"] and (ROOT / site["og_image"]).is_file():  # site.txt の og-image: で指定した画像
        og = site["url"].rstrip("/") + "/" + quote(Path(site["og_image"]).name)
    for w in works:
        if og:
            break
        if site.get("url") and w["cover"]:  # 指定がなければ、いちばん新しい作品の表紙
            og = site["url"].rstrip("/") + "/w/%s/%s" % (quote(w["slug"]), quote(w["cover"].name))
            break
    canon = site["url"].rstrip("/") + "/" if site.get("url") else None
    return page(site, site["name"], site["tagline"], body, "", og, canon, "home", home_jsonld(site))


def load_site():
    path = ROOT / "site.txt"
    f, links, about = parse_info(path.read_text(encoding="utf-8")) if path.exists() else ({}, [], "")
    logo = f.get("logo", "")
    try:
        mosaic = max(0, min(64, int(f.get("mosaic", "16"))))
    except ValueError:
        mosaic = 16
    return {
        "background": f.get("background", ""),
        "form": f.get("form", ""),
        "form_key": f.get("form-key", "").strip(),
        "form_endpoint": f.get("form-endpoint", "https://api.web3forms.com/submit").strip(),
        "mosaic_style": f.get("mosaic-style", "grid").strip().lower(),
        "mosaic": mosaic,
        "og_image": f.get("og-image", "").strip(),  # リンクのプレビュー(Discord・X など)に出す、サイト全体の画像
        "name": f.get("name") or "My Works",
        "tagline": f.get("tagline", ""),
        "url": f.get("url", ""),
        "contact": f.get("contact", ""),
        "logo": logo if logo and (ROOT / logo).is_file() else "",
        "menu": f.get("_menu", []),
        "about": about,
        "links": links,
    }


def main():
    site = load_site()
    works = []
    for d in sorted(WORKS.iterdir()) if WORKS.exists() else []:
        if d.is_dir() and not d.name.startswith((".", "_")):
            w = read_work(d)
            if w:
                works.append(w)
    works.sort(key=lambda w: (w["date"], w["slug"]), reverse=True)
    link_related(works)
    attach_booth(works, load_booth())
    site["work_clips"] = ["w/%s/%s" % (quote(w["slug"]), quote(p.name)) for w in works for p in w["clips"]]
    site["work_videos"] = list(dict.fromkeys(
        v for w in works for _, u in w["links"] for v in [youtube_id(u)] if v))

    OUT.mkdir(exist_ok=True)
    written = set()
    for w in works:
        wdir = OUT / "w" / w["slug"]
        wdir.mkdir(parents=True, exist_ok=True)
        if w["cover"]:
            save_image(w["cover"], wdir / w["cover"].name, 900, written)
        for p in w["gallery"]:
            save_image(p, wdir / p.name, 1800, written)
        for x in w["downloads"]:
            if x.get("bundle"):  # フォルダのオフボーカルと歌詞を、1つの ZIP にまとめる
                dst = wdir / x["url"]
                written.add(dst)
                newest = max([p.stat().st_mtime for _, p in x["bundle"]] + [GUIDELINE_FILE.stat().st_mtime if GUIDELINE_FILE.exists() else 0])  # ガイドラインを直したときも、作り直す
                if not (dst.exists() and dst.stat().st_mtime >= newest):
                    make_bundle(x["bundle"], dst, w["title"], site.get("url", ""))
                x["size"] = dst.stat().st_size
                continue
            if not x["path"]:
                continue
            p = x["path"]
            dst = wdir / p.name
            written.add(dst)
            if x["name"] == "歌詞" and p.suffix.lower() == ".txt":  # 歌詞の txt は、文字化けしない形に直して出す(UTF-8 + BOM、改行は CRLF)。毎回、作り直す
                dst.write_bytes(portable_text(p))
            elif not (dst.exists() and dst.stat().st_mtime >= p.stat().st_mtime):
                shutil.copy2(p, dst)
            x["size"] = dst.stat().st_size
        for clip in w["clips"]:
            dst = wdir / clip.name
            written.add(dst)
            if not (dst.exists() and dst.stat().st_mtime >= clip.stat().st_mtime):
                shutil.copy2(clip, dst)
        (wdir / "index.html").write_text(render_work(site, w), encoding="utf-8")
        written.add(wdir / "index.html")
        if not w["links"] and not w["embeds"]:
            print("  ! %s: リンクが書かれていません" % w["slug"])

    # 削除・改名した作品の残骸を消す
    for p in sorted((OUT / "w").rglob("*"), reverse=True) if (OUT / "w").exists() else []:
        if p.is_file() and p not in written:
            p.unlink()
        elif p.is_dir() and not any(p.iterdir()):
            p.rmdir()
    shutil.rmtree(OUT / "en", ignore_errors=True)  # 以前の英語版(/en/)の残りを消す

    (OUT / "index.html").write_text(render_index(site, works), encoding="utf-8")
    shutil.copy2(THEME / "style.css", OUT / "style.css")
    shutil.copy2(THEME / "fx.js", OUT / "fx.js")
    if site["logo"]:
        shutil.copy2(ROOT / site["logo"], OUT / site["logo"])
    if site["og_image"] and (ROOT / site["og_image"]).is_file():
        shutil.copy2(ROOT / site["og_image"], OUT / Path(site["og_image"]).name)
    sm = render_sitemap(site, works)
    if sm:
        (OUT / "sitemap.xml").write_text(sm, encoding="utf-8")
    elif (OUT / "sitemap.xml").exists():
        (OUT / "sitemap.xml").unlink()
    (OUT / ".nojekyll").touch()
    print("%d 件の作品から docs/ を生成しました" % len(works))


if __name__ == "__main__":
    sys.exit(main())
