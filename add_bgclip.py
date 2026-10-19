#!/usr/bin/env python3
# 動画ファイルから、背景用の短いクリップ(480p・約20秒)を作って、作品のフォルダに入れる(ffmpeg が必要)
# 使い方: python3 add_bgclip.py                              質問に答える
#         python3 add_bgclip.py 動画.mp4 --work 3 --start 1:05 --length 20
#         (--work は一覧の番号。--slug 2025-09-03-apple-… でフォルダ名の指定もできる)
# 作られた works/<作品>/bg.mp4(2本目以降は bg-<名前>.mp4)は、ビルドするとサイトに載り、トップの背景でランダムに再生される。
#   1つの作品に何本でも置ける。--name 名前 で bg-名前.mp4 として追加する。
import argparse
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

import build

HEIGHT = 480        # クリップの高さ(px)。背景はモザイクと暗いかぶせ越しなので、小さくて足りる
MAX_RATE = "1200k"  # 映像の最大ビットレート(20秒で約3MB以内に収める上限)


def parse_time(s):
    """'65' / '65.5' / '1:05' / '01:02:03' を秒にする"""
    parts = [float(x) for x in s.strip().split(":")]
    sec = 0.0
    for p in parts:
        sec = sec * 60 + p
    return sec


def fmt_time(sec):
    sec = int(round(sec))
    return "%d:%02d" % (sec // 60, sec % 60)


def probe(path):
    """(長さ[秒], 音声があるか)"""
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                         capture_output=True, text=True).stdout.strip()
    audio = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index",
                            "-of", "csv=p=0", str(path)], capture_output=True, text=True).stdout.strip()
    return float(out), bool(audio)


def detect_crop(src, start, length):
    """黒帯(レターボックス)を検出して crop フィルタの値を返す。なければ None。
    暗い場面での誤検出を避けるため、サンプルした全フレームのうち一番大きい枠を採用する"""
    out = subprocess.run(["ffmpeg", "-ss", str(start), "-t", str(length), "-i", str(src), "-vf",
                          "fps=2,cropdetect=limit=24:round=2:reset=0", "-f", "null", "-"],
                         capture_output=True, text=True).stderr
    boxes = [tuple(map(int, m)) for m in re.findall(r"crop=(\d+):(\d+):(\d+):(\d+)", out)]
    if not boxes:
        return None
    w, h, x, y = max(boxes, key=lambda b: b[0] * b[1])
    vw, vh = probe_size(src)
    if w >= vw * 0.97 and h >= vh * 0.97:
        return None
    return "crop=%d:%d:%d:%d" % (w, h, x, y)


def probe_size(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                          "-of", "csv=p=0:s=x", str(path)], capture_output=True, text=True).stdout.strip()
    w, h = out.split("x")
    return int(w), int(h)


def make_clip(src, dst, start, length):
    """src の start 秒から length 秒を、480p の小さな mp4 にして dst に書き出す。サイズ(バイト)を返す。
    映像の頭と尻のフェードは付けない(サイト側のクロスフェードでつなぐ)"""
    _, has_audio = probe(src)
    fade = min(0.25, length / 8)  # 音のプチ音防止だけ
    crop = detect_crop(src, start, length)
    if crop:
        print("  黒帯を検出して切り落とします(%s)" % crop)
    vf = ",".join(([crop] if crop else []) + ["fps=24", "scale=-2:%d" % HEIGHT])
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-ss", str(start), "-t", str(length), "-i", str(src), "-vf", vf,
           "-c:v", "libx264", "-crf", "30", "-maxrate", MAX_RATE, "-bufsize", "2400k", "-preset", "slow",
           "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
    if has_audio:
        cmd += ["-af", "afade=t=in:st=0:d=%.2f,afade=t=out:st=%.2f:d=%.2f" % (fade, length - fade, fade),
                "-c:a", "aac", "-b:a", "64k"]
    else:
        cmd += ["-an"]
    tmp = dst.with_name("bg.part.mp4")  # 書き出し中のファイル(ビルドは無視する)
    subprocess.run(cmd + [str(tmp)], check=True)
    tmp.replace(dst)
    return dst.stat().st_size


def list_works():
    out = []
    for d in sorted(build.WORKS.iterdir()) if build.WORKS.exists() else []:
        if d.is_dir() and not d.name.startswith((".", "_")):
            w = build.read_work(d)
            if w:
                out.append(w)
    out.sort(key=lambda w: (w["date"], w["slug"]), reverse=True)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video", nargs="?")
    ap.add_argument("--work", type=int)
    ap.add_argument("--slug")
    ap.add_argument("--start")
    ap.add_argument("--length", type=float)
    ap.add_argument("--name", help="2本目以降の名前(bg-名前.mp4 として追加する)")
    a = ap.parse_args()

    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        print("ffmpeg が見つかりません。ターミナルで brew install ffmpeg を実行してから、もう一度試してください。")
        return 1

    if a.video:  # コマンドの引数は、空白を含むパスもそのまま使う
        src = Path(a.video).expanduser()
    else:  # ドラッグ&ドロップで貼り付けたパスは、空白が \ で escape されているので shlex で戻す
        parts = shlex.split(input("動画ファイル(Finderからドラッグ&ドロップして Enter): ").strip() or "''")
        src = Path(parts[0]).expanduser() if parts and parts[0] else None
    if not src or not src.is_file():
        print("動画ファイルが見つかりません。")
        return 1
    duration, has_audio = probe(src)
    print("動画の長さ: %s(音声: %s)" % (fmt_time(duration), "あり" if has_audio else "なし"))

    works = list_works()
    if a.slug:
        work = next((w for w in works if w["slug"] == a.slug), None)
    elif a.work:
        work = works[a.work - 1] if 1 <= a.work <= len(works) else None
    else:
        print("\nどの作品の背景にしますか?")
        for i, w in enumerate(works, 1):
            n = len([p for p in w["dir"].glob("bg*.mp4") if p.name != "bg.part.mp4"])
            mark = "  [背景 %d本]" % n if n else ""
            print("  %2d  %s  %s%s" % (i, build.fmt_date(w["date"]), w["headline"] or w["title"], mark))
        n = input("番号: ").strip()
        work = works[int(n) - 1] if n.isdigit() and 1 <= int(n) <= len(works) else None
    if not work:
        print("作品を選べませんでした。")
        return 1

    default_start = min(30.0, max(0.0, duration * 0.2))
    s = a.start or input("切り出し開始位置(例: 1:05 や 65。Enterで %s): " % fmt_time(default_start)).strip()
    start = parse_time(s) if s else default_start
    length = a.length or float(input("長さ(秒。Enterで 20): ").strip() or 20)
    length = min(length, max(1.0, duration - start))
    if start >= duration:
        print("開始位置が動画の長さを超えています。")
        return 1

    existing = sorted(p for p in work["dir"].glob("bg*.mp4") if p.name != "bg.part.mp4")
    if a.name:
        dst = work["dir"] / ("bg-%s.mp4" % re.sub(r"[^A-Za-z0-9_-]+", "-", a.name).strip("-"))
    elif existing and not (a.video and (a.work or a.slug)):  # 質問に答える形で、すでにクリップがあるとき
        print("\nこの作品には、すでに背景クリップが %d 本あります: %s" % (len(existing), ", ".join(p.name for p in existing)))
        if input("追加しますか?(Enter=追加 / o=bg.mp4 を作り直して上書き): ").strip().lower() == "o":
            dst = work["dir"] / "bg.mp4"
        else:
            n = 2
            while (work["dir"] / ("bg-%d.mp4" % n)).exists():
                n += 1
            dst = work["dir"] / ("bg-%d.mp4" % n)
    else:
        dst = work["dir"] / "bg.mp4"
    print("\n作成中…(%s から %s 秒)" % (fmt_time(start), int(length)))
    size = make_clip(src, dst, start, length)
    print("できました: %s(%.1f MB)" % (dst.relative_to(build.ROOT), size / 1048576))
    if size > 4 * 1048576:
        print("  ! 4MB を超えました。長さを短くするか、動きの少ない場面にすると軽くなります。")
    print("ビルドすると、トップの背景でランダムに再生される候補に入ります。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
