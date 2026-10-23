#!/usr/bin/env python3
# YouTube の動画(過去の MV など)を、URL からサイトの作品として追加する(標準ライブラリのみ)
# 自動の取り込みは、チャンネルの新着(直近15本)だけが対象なので、それより前の動画は、これで足します。
# 使い方: python3 add_youtube.py                       質問に答える(URL を1行ずつ貼る)
#         python3 add_youtube.py URL [URL ...]          URL をいくつでも指定(動画のURLも、プレイリストのURLも使えます)
#         python3 add_youtube.py --dry-run URL          何が追加されるかだけ表示
#         python3 add_youtube.py --force URL            以前に消した・除外した動画も、もう一度追加する
#         python3 add_youtube.py --bpm 128 URL         MV に BPM を付けて追加(MV にだけ入ります。質問に答える形のときは、1本ごとに聞きます)
#         python3 add_youtube.py --type 案件 URL        「案件」(関わらせて頂いた作品)として追加する(すでにサイトにある動画は、そのまま)
#         python3 add_youtube.py --type 案件 --reclassify URL   すでにサイトにある動画も、分類を「案件」に変える
#         python3 add_youtube.py --refresh-links            自動で取り込んだ「案件」すべての概要欄から、配信リンクを足す(--dry-run で一覧だけ)
# 「案件」は、概要欄の配信・販売のリンク(Spotify / Apple Music / ニコニコ動画 / Bandcamp / BOOTH / linkco.re など)も、ボタンとして自動で付きます。
# タイトル・公開日・概要欄のオフボーカルなどの配布リンクは、動画のページから自動で読み取ります。
# 作られるのは、自動取り込みと同じ形の works/<公開日>-yt-<動画ID>/info.txt です(取り込み済みの記録にも残るので、あとで重複しません)。
import html
import json
import re
import sys
import time
import urllib.request
from urllib.parse import parse_qs, urlparse

import build
import check_links
import import_works as iw


def watch_page(vid):
    req = urllib.request.Request("https://www.youtube.com/watch?v=" + vid, headers=iw.HEADERS)
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read().decode("utf-8", "replace")


def parse_page(page):
    """動画のページから (タイトル, 公開日(UTC の日付), 概要欄) を取り出す。見つからなければ空"""
    m = re.search(r'<meta property="og:title" content="([^"]*)"', page)
    title = html.unescape(m.group(1)).strip() if m else ""
    m = re.search(r'itemprop="datePublished" content="([^"]+)"', page) or re.search(r'"publishDate":"([^"]+)"', page)
    date = ""
    if m:
        import datetime
        try:
            dt = datetime.datetime.fromisoformat(m.group(1))
            date = (dt.astimezone(datetime.timezone.utc) if dt.tzinfo else dt).date().isoformat()
        except ValueError:
            date = m.group(1)[:10]
    m = re.search(r'"shortDescription":"((?:[^"\\]|\\.)*)"', page)
    desc = json.loads('"%s"' % m.group(1)) if m else ""
    return title, date, desc


def playlist_id(text):
    """プレイリストのURL(/playlist?list=…)からIDを取り出す。動画のURLに list= が付いているだけのものは、その動画1本として扱う"""
    u = urlparse(text.strip())
    if u.netloc.endswith("youtube.com") and u.path.startswith("/playlist"):
        v = parse_qs(u.query).get("list")
        return v[0] if v else None
    return None


def playlist_videos(pl):
    """プレイリストのページから (タイトル, [動画ID...]) を取り出す。公開ページの先頭100本まで(それ以降は読み込めません)"""
    req = urllib.request.Request("https://www.youtube.com/playlist?list=" + pl, headers=iw.HEADERS)
    with urllib.request.urlopen(req, timeout=20) as r:
        page = r.read().decode("utf-8", "replace")
    m = re.search(r'<meta property="og:title" content="([^"]*)"', page)
    title = html.unescape(m.group(1)).strip() if m else pl
    i = page.find('"playlistVideoListRenderer"')
    ids = []
    for m in re.finditer(r'"videoId":"([\w-]{11})"', page[i:] if i >= 0 else page):
        if m.group(1) not in ids:
            ids.append(m.group(1))
    return title, ids


_TAG = re.compile(r"\s*[【\[\(（]\s*(?:official(?:\s+music)?\s+video|music\s+video|オリジナルMV|歌ってみた|MV|VocaDuo\w*)\s*[】\]\)）]", re.I)


def tidy_title(title):
    """案件の長い題名を短くする: ハッシュタグ・「Official Music Video」などの注記・末尾の MV・英語の訳の括弧を除き、
    「○○に「曲名」を歌ってもらったよ」は「曲名(○○)」にする。動画の元の題名は、info.txt の yt-title: に残す"""
    t = re.sub(r"\s*#\S*", "", title)
    t = _TAG.sub("", t)
    t = re.sub(r'\s*\(["“][^)]*\)\s*$', "", t)
    t = re.sub(r"\s*MV\s*$", "", t)
    m = re.match(r"^(.+?)に「(.+?)」を歌ってもらったよ\s*(.*)$", t)
    if m:
        t = "%s(%s)" % (m.group(2), m.group(1).strip())
    return re.sub(r"\s+", " ", t).strip() or title


def video_id(text):
    text = text.strip()
    vid = build.youtube_id(text)
    if vid:
        return vid
    return text if re.fullmatch(r"[\w-]{11}", text) else None


EXCLUDE = []  # import.txt の youtube-exclude(Trailer など)。プレイリストをまとめて追加するときだけ、これを含む動画を飛ばす


def reclassify(vid, wtype, dry):
    """すでにサイトにある動画の分類(type:)を変える。変えたら True"""
    for info in sorted(iw.WORKS.glob("*/info.txt")):
        text = info.read_text(encoding="utf-8")
        if vid not in text:
            continue
        f = build.parse_info(text)[0]
        cur = build.TYPE_ALIAS.get(f.get("type", ""), build.TYPE_ALIAS.get(f.get("type", "").lower(), f.get("type", "").lower()))
        if cur == wtype:
            return False
        print("  ~ %s: 分類を「%s」に変更%s" % (f.get("title", vid), build.TYPES_JA.get(wtype, wtype), "(予定)" if dry else ""))
        if not dry:
            iw.rewrite_info(info, {"type": wtype})
        return True
    return False


def ask_bpm(title):
    """MV を追加するときに、BPM を聞く(わからなければ空Enter)。BPM の文字(なければ空)"""
    bpm = ""
    while True:
        raw = input("  「%s」の BPM(わからなければ空Enter): " % title[:30]).strip()
        if not raw:
            break
        x = build.parse_bpm(raw)
        if x:
            bpm = build.fmt_bpm(x)
            break
        print("    ! 30〜300 の数字で入力してください(例: 128)")
    return bpm


def add(imp, vid, force=False, bulk=False, wtype="video", reclass=False, bpm=None):
    key = "youtube-" + vid
    if any(vid in t for t in imp.texts):
        if reclass and reclassify(vid, wtype, imp.dry):
            return True
        print("  - %s: すでにサイトにあります(分類は、そのままです)" % vid)
        return False
    if key in imp.ledger and not force:  # フォルダは無いが、取り込み済みの記録がある(消した・除外した作品)
        if bulk:
            print("  - %s: 以前に消した(または除外した)記録があるので、飛ばしました(追加するなら --force)" % vid)
            return False
        if not (sys.stdin.isatty() and input("  ? %s: 以前に取り込んだあと、消した(または除外した)記録があります。もう一度追加しますか? [y/N]: " % vid).strip().lower() in ("y", "yes")):
            print("  - %s: 飛ばしました(もう一度追加するには --force を付けて実行します)" % vid)
            return False
    try:
        title, date, desc = parse_page(watch_page(vid))
    except Exception as e:
        print("  ! %s: 動画のページを読み込めませんでした(%s)" % (vid, e))
        return False
    if not title or not date:
        print("  ! %s: タイトルか公開日を読み取れませんでした。動画のURLを確かめてください" % vid)
        return False
    if bulk and not force and any(w in title.lower() for w in EXCLUDE):
        print("  - %s: 「%s」は除外ワードを含むので、飛ばしました(追加するなら --force)" % (vid, title))
        return False
    mats = iw.material_links(desc)
    if wtype == "project":  # 案件は、概要欄の配信・販売のリンクも、ボタンにする
        mats += alive([m for m in iw.stream_links(desc) if m[1] not in {u for _, u in mats}])
    fields = [("title", title), ("date", date), ("type", wtype)]
    if wtype == "project":  # 案件は、長い題名を短くする(元の題名は yt-title: に残す)
        short = tidy_title(title)
        if short != title:
            fields = [("title", short), ("date", date), ("type", wtype), ("yt-title", title)]
            title = short
    if wtype == "video":  # BPM は MV にだけ入れる(--bpm で指定、なければ、対話のときだけ聞く)
        if bpm is None and not bulk and not imp.dry and sys.stdin.isatty():
            bpm = ask_bpm(title)
        if bpm:
            fields.append(("bpm", bpm))
    imp.create(key, "%s-yt-%s" % (date, vid),
               fields,
               ["YouTube: https://www.youtube.com/watch?v=" + vid] + ["%s: %s" % m for m in mats])
    print("  + %s  %s%s" % (date, title, "  (配布リンク %d 件)" % len(mats) if mats else ""))
    return True


def alive(links):
    """リンクが切れていない(404 など)ものだけを残す。切れているものは、表示して飛ばす"""
    out = []
    for lab, u in links:
        if check_links.classify(u)[0] == "broken":
            print("    (リンク切れのため飛ばしました: %s %s)" % (lab, u))
        else:
            out.append((lab, u))
    return out


def refresh_links(dry):
    """自動で取り込んだ「案件」すべての概要欄を読み直して、まだ付いていない配信・販売のリンクを足す(同じサービスのリンクがすでにあれば、足さない)"""
    changed = 0
    for info in sorted(iw.WORKS.glob("*/info.txt")):
        f, links, _ = build.parse_info(info.read_text(encoding="utf-8"))
        if f.get("type") != "project" or not build.truthy(f.get("auto")):
            continue
        vid = next((build.youtube_id(u) for _, u in links if build.youtube_id(u)), None)
        if not vid:
            continue
        try:
            desc = parse_page(watch_page(vid))[2]
        except Exception as e:
            print("  ! %s: 動画のページを読み込めませんでした(%s)" % (f.get("title", vid), e))
            continue
        have = {build.svc_of(u) or lab for lab, u in links} | {iw.norm_url(u) for _, u in links}
        new = [(lab, u) for lab, u in iw.stream_links(desc) if (build.svc_of(u) or lab) not in have and iw.norm_url(u) not in have]
        new = alive(new)
        time.sleep(0.3)
        if not new:
            continue
        changed += 1
        print("  + %s  %s" % (f.get("title", vid)[:34], "  ".join("%s %s" % (lab, u) for lab, u in new)))
        if not dry:
            iw.rewrite_info(info, {}, add_links=new)
    print("\n%d 件の作品に、配信リンクを%s。" % (changed, "足す予定です(--dry-run なので、何も変えていません)" if dry else "足しました"))
    return 0


def main():
    argv = sys.argv[1:]
    if "--refresh-links" in argv:
        return refresh_links("--dry-run" in argv)
    wtype, type_given = "video", "--type" in argv
    if "--type" in argv:  # --type 案件(または project)
        i = argv.index("--type")
        raw = argv[i + 1] if i + 1 < len(argv) else ""
        del argv[i:i + 2]
        wtype = build.TYPE_ALIAS.get(raw, build.TYPE_ALIAS.get(raw.lower(), raw.lower()))
        if wtype not in build.TYPES_JA:
            print("--type は、MV(video)・案件(project)などのように指定してください: %s" % raw)
            return 1
    bpm = None  # --bpm 128(MV にだけ入る。1本ずつ追加するとき用)
    if "--bpm" in argv:
        i = argv.index("--bpm")
        raw = argv[i + 1] if i + 1 < len(argv) else ""
        del argv[i:i + 2]
        x = build.parse_bpm(raw)
        if not x:
            print("--bpm は 30〜300 の数字で指定してください: %s" % raw)
            return 1
        bpm = build.fmt_bpm(x)
    args = [a for a in argv if not a.startswith("--")]
    dry = "--dry-run" in argv
    force = "--force" in argv
    reclass = "--reclassify" in argv
    if not args:
        print("追加する YouTube の動画のURLを、1行ずつ貼り付けてください(終わったら空Enter)")
        while True:
            u = input("  URL: ").strip() if sys.stdin.isatty() else ""
            if not u:
                break
            args.append(u)
        if args and not type_given and sys.stdin.isatty():  # ウィザードのときは、分類も聞く
            if input("分類 [Enter = MV(自分の動画) / 2 = 案件(関わらせて頂いた作品)]: ").strip() == "2":
                wtype = "project"
    cfg_path = iw.ROOT / "import.txt"
    cfg = build.parse_info(cfg_path.read_text(encoding="utf-8"))[0] if cfg_path.exists() else {}
    EXCLUDE[:] = [w.strip().lower() for w in re.split(r"[,、]", cfg.get("youtube-exclude", "")) if w.strip()]
    jobs = []  # (動画ID, プレイリストからか)
    for a in args:
        pl = playlist_id(a)
        if pl:
            try:
                title, vids = playlist_videos(pl)
            except Exception as e:
                print("  ! プレイリストを読み込めませんでした(%s): %s" % (e, a))
                continue
            print("プレイリスト「%s」: %d 本%s" % (title, len(vids), "(先頭100本まで)" if len(vids) >= 100 else ""))
            if not vids:
                print("  ! 動画が見つかりませんでした(非公開のプレイリストでは読み取れません)")
                continue
            if len(vids) > 1 and sys.stdin.isatty() and not dry and \
                    input("  この %d 本を、サイトの作品として追加しますか? [Y/n]: " % len(vids)).strip().lower() not in ("", "y", "yes"):
                continue
            jobs += [(v, True) for v in vids]
            continue
        vid = video_id(a)
        if vid:
            jobs.append((vid, False))
        else:
            print("  ! URL を読み取れませんでした: %s" % a)
    seen, ids = set(), []
    for vid, bulk in jobs:
        if vid not in seen:
            seen.add(vid)
            ids.append((vid, bulk))
    if not ids:
        print("追加する動画がありませんでした。")
        return 1
    iw.WORKS.mkdir(exist_ok=True)
    imp = iw.Importer(dry)
    added = 0
    for n, (vid, bulk) in enumerate(ids):
        added += 1 if add(imp, vid, force, bulk, wtype, reclass, bpm) else 0
        if bulk and n + 1 < len(ids):
            time.sleep(0.5)  # 続けて読み込みすぎないように、少し間をあける
    if not added:
        return 0
    if dry:
        print("\n(--dry-run なので、何も作っていません)")
        return 0
    print("\n%d 件を追加しました。" % added)
    if sys.stdin.isatty() and input("サイトを更新しますか? [Y/n]: ").strip().lower() in ("", "y", "yes"):
        build.main()
    return 0


if __name__ == "__main__":
    sys.exit(main())
