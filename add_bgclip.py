#!/usr/bin/env python3
# 動画ファイルから、背景用の短いクリップ(480p・約20秒)を作って、作品のフォルダに入れる(ffmpeg が必要)
# 使い方: python3 add_bgclip.py                              質問に答える
#         python3 add_bgclip.py 動画.mp4 --work 3 --start 1:05 --length 20
#         (--work は一覧の番号。--slug 2025-09-03-apple-… でフォルダ名の指定もできる)
# 作られた works/<作品>/bg.mp4 は、ビルドするとサイトに載り、トップの背景でランダムに再生される。
import argparse
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


def make_clip(src, dst, start, length):
    """src の start 秒から length 秒を、480p の小さな mp4 にして dst に書き出す。サイズ(バイト)を返す"""
    _, has_audio = probe(src)
    fade = min(0.5, length / 4)
    vf = "fps=24,scale=-2:%d,fade=t=in:st=0:d=%.2f,fade=t=out:st=%.2f:d=%.2f" % (HEIGHT, fade, length - fade, fade)
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-ss", str(start), "-t", str(length), "-i", str(src), "-vf", vf,
           "-c:v", "libx264", "-crf", "30", "-maxrate", MAX_RATE, "-bufsize", "2400k", "-preset", "slow",
           "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
    if has_audio:
        cmd += ["-af", "afade=t=in:st=0:d=%.2f,afade=t=out:st=%.2f:d=%.2f" % (fade, length - fade, fade),
                "-c:a", "aac", "-b:a", "64k"]
    else:
        cmd += ["-an"]
    tmp = dst.with_name("bg.part.mp4")
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
    a = ap.parse_args()

    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        print("ffmpeg が見つかりません。ターミナルで brew install ffmpeg を実行してから、もう一度試してください。")
        return 1

    raw = a.video or input("動画ファイル(Finderからドラッグ&ドロップして Enter): ").strip()
    parts = shlex.split(raw) if raw else []
    src = Path(parts[0]).expanduser() if parts else None
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
            mark = "  [背景あり]" if (w["dir"] / "bg.mp4").exists() else ""
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
