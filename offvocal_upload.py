#!/usr/bin/env python3
# MV のオフボーカル(WAV など)と、歌詞を、GitHub の Releases にアップロードして、その MV のページに「ダウンロード」ボタンを付ける(標準ライブラリ + gh コマンド)
# 重い WAV をリポジトリに入れると、Git の履歴が重くなって戻せないので、Releases(1ファイル2GBまで)に置きます。
# 使い方: python3 offvocal_upload.py                   質問に答える(どの MV か → ファイルをドラッグして貼る)
#         python3 offvocal_upload.py ファイル [歌詞]      ファイル(と歌詞)を指定して、MV だけ選ぶ
# 歌詞のファイル(txt・pdf)も渡すと、オフボーカルと歌詞を1つの ZIP にまとめて、「オフボーカル + 歌詞」の1つのボタンにします。
# 選ぶ一覧には、オフボーカルが入っていない MV だけを出します(入れ済みの MV は非表示。置き換えたいときは、フォルダ名の頭を入力するか、--all で全部出します)。
#         python3 offvocal_upload.py --all              入れ済みの MV も、一覧に出す
#         python3 offvocal_upload.py --dry-run          何をするかだけ表示(アップロードも、書き込みもしません)
# しくみ: Releases の「offvocal」(なければ作ります)に、<作品フォルダ名>-offvocal.wav(歌詞つきは .zip)という名前でアップロードし、
#         作品の info.txt に offvocal: URL・offvocal-size:・offvocal-type:(歌詞つきは offvocal-bundle: lyrics も)を書きます。サイトを作り直すと、ボタンが出ます(公開は、いつもの手順で)。
# 事前に、gh コマンドのログインが必要です(ターミナルで gh auth login。済んでいなければ、このコマンドが案内します)。
import atexit
import json
import os
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

import build
import import_works as iw

TAG = "offvocal"
EXTS = {".wav", ".mp3", ".flac", ".m4a", ".zip"}
LYRICS_EXTS = {".txt", ".pdf", ".docx", ".doc"}  # docx・doc は、txt に変換して、ZIP に入れる
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def docx_to_text(path):
    """Word(.docx)の歌詞を、プレーンテキストにする(標準ライブラリだけ。段落ごとに1行、空の段落は空行)。
    ルビ(ふりがな)は読み飛ばして、本文だけにする。書式(太字・色など)は、捨てる"""
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read("word/document.xml"))

    def walk(node, buf):
        for ch in node:
            if ch.tag == W + "t":
                buf.append(ch.text or "")
            elif ch.tag == W + "tab":
                buf.append("\t")
            elif ch.tag in (W + "br", W + "cr"):
                buf.append("\n")
            elif ch.tag == W + "rt":  # ルビ(ふりがな)
                continue
            else:
                walk(ch, buf)
    lines = []
    for p in root.iter(W + "p"):
        buf = []
        walk(p, buf)
        lines.append("".join(buf))
    while lines and not lines[-1].strip():  # 最後の空行は、落とす
        lines.pop()
    return "\n".join(lines) + "\n"


def to_txt(src):
    """歌詞が docx / doc なら、txt に変換した一時ファイルを返す(そうでなければ、そのまま)。失敗したら None"""
    if src.suffix.lower() not in (".docx", ".doc"):
        return src
    text = None
    if src.suffix.lower() == ".docx":
        try:
            text = docx_to_text(src)
        except (zipfile.BadZipFile, KeyError, ET.ParseError):
            text = None
    if text is None and shutil.which("textutil"):  # .doc(古い形式)と、読めなかった docx は、Mac の textutil で
        r = subprocess.run(["textutil", "-convert", "txt", "-encoding", "UTF-8", "-stdout", str(src)], capture_output=True)
        if r.returncode == 0:
            text = r.stdout.decode("utf-8", "replace").replace("\r\n", "\n").replace("\r", "\n").rstrip("\n") + "\n"
    if text is None:
        return None
    d = tempfile.mkdtemp()
    atexit.register(shutil.rmtree, d, ignore_errors=True)
    out = Path(d) / "lyrics.txt"
    out.write_text(text, encoding="utf-8")
    return out
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


def pick_work(rows, show_all=False):
    shown = rows if show_all else [r for r in rows if not r[2]]
    hidden = len(rows) - len(shown)
    if not shown:
        print("\nオフボーカルが入っていない MV はありません(入れ済みの %d 本は、非表示です)。置き換えるときは、フォルダ名の頭を入力してください。" % hidden)
    else:
        print("\nどの MV に付けますか?(新しい順。番号か、フォルダ名の頭を入力。Enter で、先頭の MV)")
    for i, (slug, title, url, _) in enumerate(shown[:15], 1):
        print("  %2d. %s  %s%s" % (i, slug[:10], title[:36], "   [オフボーカルあり]" if url else ""))
    if len(shown) > 15:
        print("  …ほか %d 本(フォルダ名の頭、例: 2022-11 で選べます)" % (len(shown) - 15))
    if hidden and shown:
        print("  (オフボーカル入れ済みの %d 本は、非表示です。置き換えるときは、フォルダ名の頭を入力するか、--all で全部出します)" % hidden)
    while True:
        a = input("選ぶ: ").strip()
        if not a and shown:
            return shown[0]
        if a.isdigit() and 1 <= int(a) <= min(15, len(shown)):
            return shown[int(a) - 1]
        hit = [r for r in rows if a and r[0].startswith(a)]
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
    slug, title, old, info = pick_work(rows, "--all" in argv)
    raw = args[0] if args else input("\nオフボーカルのファイルを、ここにドラッグして Enter(%s): " % "/".join(sorted(e[1:] for e in EXTS)))
    src = clean_path(raw)
    if not src.is_file():
        print("ファイルが見つかりません: %s" % src)
        return 1
    if src.suffix.lower() not in EXTS:
        print("対応していない形式です(%s)。%s のどれかにしてください。" % (src.suffix, " ".join(sorted(EXTS))))
        return 1
    lyr, lyr_name = None, ""
    if src.suffix.lower() != ".zip":  # 歌詞も、一緒に ZIP にできる
        raw2 = args[1] if len(args) > 1 else input("歌詞のファイル(txt・pdf・docx)も一緒に入れるなら、ここにドラッグして Enter(docx は txt に変換して入れます。なければ、そのまま Enter): ")
        if raw2.strip():
            lyr = clean_path(raw2)
            if not lyr.is_file() or lyr.suffix.lower() not in LYRICS_EXTS:
                print("歌詞のファイルを読み取れませんでした(%s)。txt・pdf・docx のどれかを指定してください。" % lyr)
                return 1
            lyr_name = lyr.name
            conv = to_txt(lyr)
            if conv is None:
                print("歌詞を txt に変換できませんでした(%s)。txt か pdf で、もう一度試してください。" % lyr.name)
                return 1
            if conv != lyr:
                lines = conv.read_text(encoding="utf-8").splitlines()
                print("  歌詞を txt に変換しました(%d行)。先頭: %s" % (len(lines), " / ".join(l for l in lines[:3] if l.strip())[:60]))
            lyr = conv
    size = src.stat().st_size
    if size > LIMIT:
        print("ファイルが大きすぎます(%s)。GitHub の Releases は、1ファイル 2GB までです。" % build.fmt_size(size))
        return 1
    asset = "%s-offvocal%s" % (slug, ".zip" if lyr else src.suffix.lower())
    url = "https://github.com/%s/releases/download/%s/%s" % (repo, TAG, asset)
    print("\n  作品    : %s(%s)\n  ファイル: %s(%s)%s\n  置き場所: GitHub Releases「%s」→ %s\n  リンク  : %s" %
          (title, slug, src.name, build.fmt_size(size), "\n  歌詞    : %s(オフボーカルと一緒に、1つの ZIP にまとめます)" % lyr_name if lyr else "", TAG, asset, url))
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
    if lyr:  # オフボーカル・歌詞・README を、1つの ZIP に
        print("ZIP にまとめています…")
        build.make_bundle([("offvocal", src), ("lyrics", lyr)], link, title, build.load_site().get("url", ""))
        size = link.stat().st_size
    else:
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
    updates = {"offvocal": url, "offvocal-size": size, "offvocal-type": "ZIP" if lyr else src.suffix[1:].upper()}
    if lyr:
        updates["offvocal-bundle"] = "lyrics"
    elif old:  # 歌詞なしで置き換えたときは、前の「歌詞つき」の印を外す
        updates["offvocal-bundle"] = ""
    iw.rewrite_info(info, updates)
    print("\n完了しました。%s の info.txt に、リンクを書き込みました。" % slug)
    if input("サイトを作り直して、表示を確認しますか? [Y/n]: ").strip().lower() in ("", "y", "yes"):
        build.main()
    print("公開は、いつもの手順(サイトを更新.command など)で行ってください。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
