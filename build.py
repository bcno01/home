#!/usr/bin/env python3
# works/ の作品フォルダ群から公開用サイト docs/ を生成する(標準ライブラリのみ)
import datetime
import html
import re
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

ROOT = Path(__file__).resolve().parent
WORKS = ROOT / "works"
OUT = ROOT / "docs"
THEME = ROOT / "theme"
IMG_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg"}

TYPES = {"music": "音楽", "video": "動画", "goods": "通販・グッズ", "other": "その他"}
TYPE_ALIAS = {
    "音楽": "music", "曲": "music", "動画": "video", "映像": "video",
    "グッズ": "goods", "通販": "goods", "商品": "goods", "shop": "goods",
    "その他": "other",
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


def read_work(d):
    info = d / "info.txt"
    if not info.exists():
        print("  ! %s に info.txt がないので飛ばしました" % d.name)
        return None
    f, links, body = parse_info(info.read_text(encoding="utf-8"))
    if truthy(f.get("draft")):
        return None
    t = f.get("type", "").strip()
    t = TYPE_ALIAS.get(t, t.lower())
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
    embeds = [e for e in (embed_for(u) for _, u in links) if e][:3]
    date = parse_date(f.get("date")) or parse_date(d.name)
    if not date:
        print("  ! %s: 日付がありません(info.txt に date: を書くか、フォルダ名の頭に 2026-10-01- を付けてください)。今日の日付になります" % d.name)
        date = datetime.date.today()
    return {
        "slug": d.name,
        "dir": d,
        "title": f.get("title") or d.name,
        "date": date,
        "type": t if t in TYPES else infer_type(links),
        "desc": f.get("description", ""),
        "body": body,
        "links": [(lab or platform_label(u), u) for lab, u in links],
        "embeds": embeds,
        "cover": cover,
        "cover_url": cover_url,
        "gallery": [p for p in images if p != cover],
    }


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


def page(site, title, desc, body, root, og_image=None, canonical=None, body_class=""):
    meta = ['<meta name="description" content="%s">' % esc(desc)] if desc else []
    meta += ['<meta property="og:title" content="%s">' % esc(title),
             '<meta property="og:type" content="website">']
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


def link_buttons(links):
    return "\n".join('<a class="btn%s" href="%s" target="_blank" rel="noopener">%s<span aria-hidden="true"> ↗</span></a>'
                     % ("" if i else " primary", esc(u), esc(lab)) for i, (lab, u) in enumerate(links))


def render_embed(e, title):
    kind, src, h = e
    if kind == "video":
        return ('<div class="embed video"><iframe src="%s" title="%s" loading="lazy" allowfullscreen '
                'allow="accelerometer; encrypted-media; gyroscope; picture-in-picture"></iframe></div>') % (esc(src), esc(title))
    return ('<div class="embed audio"><iframe src="%s" title="%s" loading="lazy" style="height:%dpx" '
            'allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"></iframe></div>') % (
        esc(src), esc(title), h)


def render_work(site, w):
    meta = '<p class="meta"><span class="badge">%s</span><time>%s</time></p>' % (TYPES[w["type"]], fmt_date(w["date"]))
    gallery = ""
    if w["gallery"]:
        gallery = '<div class="gallery">%s</div>' % "".join(
            '<a href="%s" target="_blank"><img src="%s" alt="" loading="lazy"></a>' % ((quote(p.name),) * 2)
            for p in w["gallery"])
    body = """<header class="top"><div class="wrap"><a href="../../">← %s</a></div></header>
<main class="wrap work">
<div class="work-head">
<div class="work-cover">%s</div>
<div class="work-info">
%s
<h1>%s</h1>
%s
<div class="links">%s</div>
</div>
</div>
%s
<div class="body">%s</div>
%s
</main>""" % (
        esc(site["name"]), cover_html(w, ""),
        meta, esc(w["title"]),
        '<p class="lead">%s</p>' % esc(w["desc"]) if w["desc"] else "",
        link_buttons(w["links"]),
        "".join(render_embed(e, w["title"]) for e in w["embeds"]),
        paragraphs(w["body"]), gallery)
    og = None
    if site.get("url") and w["cover"]:
        og = site["url"].rstrip("/") + "/w/%s/%s" % (quote(w["slug"]), quote(w["cover"].name))
    canon = site["url"].rstrip("/") + "/w/%s/" % quote(w["slug"]) if site.get("url") else None
    return page(site, "%s | %s" % (w["title"], site["name"]), w["desc"] or site["tagline"], body, "../../", og, canon,
                "work-page")


def background_ids(site):
    """背景に流す動画ID。background: が空/works なら Works の YouTube 動画すべて、URLならその1本、off なら無し"""
    bg = site["background"].strip()
    if bg.lower() in ("off", "none", "なし"):
        return []
    if bg and bg.lower() not in ("works", "auto"):
        vid = youtube_id(bg)
        return [vid] if vid else []
    return site.get("work_videos", [])


def render_bgvideo(site):
    """背景のYouTube動画。再生順のシャッフルと src の組み立ては fx.js(PCだけ読み込む)"""
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
    return '<a href="%s"%s>%s</a>' % (esc(url), ' target="_blank" rel="noopener"' if ext else "", esc(label))


def cover_src(w):
    """トップのリストでホバー時に出すジャケット画像(なければ空)"""
    if w["cover"]:
        return "w/%s/%s" % (quote(w["slug"]), quote(w["cover"].name))
    return w["cover_url"] or ""


def render_index(site, works):
    types_present = [t for t in TYPES if any(w["type"] == t for w in works)]
    chips = ""
    if len(types_present) > 1:
        chips = '<nav class="chips" aria-label="絞り込み"><button class="chip" data-type="all" aria-pressed="true">All</button>%s</nav>' % "".join(
            '<button class="chip" data-type="%s" aria-pressed="false">%s</button>' % (t, TYPES[t]) for t in types_present)
    rows = "\n".join(
        '<a class="row" data-type="%s" data-cover="%s" href="w/%s/"><time>%s</time><span class="t">%s</span>'
        '<span class="k">%s</span></a>'
        % (w["type"], esc(cover_src(w)), quote(w["slug"]), fmt_date(w["date"]), esc(w["title"]), TYPES[w["type"]])
        for w in works)
    if not rows:
        rows = '<p class="empty">まだ作品がありません。works フォルダに作品フォルダを追加してください。</p>'

    bgvideo = render_bgvideo(site)

    items = ([("Works", "#works")] + ([("About", "#about")] if site["about"] else []) + site["menu"]
             + ([("Contact", contact_href(site["contact"]))] if site["contact"] else []))
    nav = "\n".join(nav_link(lab or platform_label(u), u) for lab, u in items)
    sns = "".join(nav_link(lab or platform_label(u), u) for lab, u in site["links"])
    logo = ('<h1 class="logo"><img src="%s" alt="%s"></h1>' % (quote(site["logo"]), esc(site["name"]))
            if site["logo"] else '<h1 class="logo">%s</h1>' % esc(site["name"]))
    about = ('<section class="about wrap" id="about"><h2>About</h2>%s</section>' % paragraphs(site["about"])
             if site["about"] else "")
    script = """<script>
document.querySelectorAll('.chip').forEach(function (b) {
  b.addEventListener('click', function () {
    var t = b.dataset.type;
    document.querySelectorAll('.chip').forEach(function (c) { c.setAttribute('aria-pressed', c === b); });
    document.querySelectorAll('.row').forEach(function (c) { c.hidden = t !== 'all' && c.dataset.type !== t; });
  });
});
</script>"""
    body = """%s
<main class="stage">
<section class="menu">
%s
%s
<nav class="nav">
%s
</nav>
<p class="sns">%s</p>
</section>
<section class="works-list" id="works" aria-label="Works">
%s
<div class="rows">
%s
</div>
</section>
</main>
%s
%s""" % (bgvideo, logo, '<p class="tagline">%s</p>' % esc(site["tagline"]) if site["tagline"] else "",
         nav, sns, chips, rows, about, script)
    og = None
    for w in works:
        if site.get("url") and w["cover"]:
            og = site["url"].rstrip("/") + "/w/%s/%s" % (quote(w["slug"]), quote(w["cover"].name))
            break
    return page(site, site["name"], site["tagline"], body, "", og, site.get("url") or None, "home")


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
        "mosaic": mosaic,
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

    (OUT / "index.html").write_text(render_index(site, works), encoding="utf-8")
    shutil.copy2(THEME / "style.css", OUT / "style.css")
    shutil.copy2(THEME / "fx.js", OUT / "fx.js")
    if site["logo"]:
        shutil.copy2(ROOT / site["logo"], OUT / site["logo"])
    (OUT / ".nojekyll").touch()
    print("%d 件の作品から docs/ を生成しました" % len(works))


if __name__ == "__main__":
    sys.exit(main())
