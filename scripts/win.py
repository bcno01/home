#!/usr/bin/env python3
# Windows 用の入口(コマンド/*.bat から呼ぶ)。流れは Mac の コマンド/*.command と同じで、次の2つだけ違う
#   ・始めに GitHub の最新を取り込む(毎日の自動取り込みで、GitHub 側が先に進むことがあるため)
#   ・公開の前に、送る変更の一覧を出して確認する(Enter だけでは公開しない)
import datetime
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 名前: (実行するスクリプト, 続けて公開するときのコミットの題名。None なら公開しない)
TASKS = {
    "new": ("new.py", None),
    "mv": ("add_youtube.py", "Add MV"),
    "spotify": ("add_spotify.py", "Add Spotify links"),
    "event": ("add_event.py", "Add event"),
    "bgclip": ("add_bgclip.py", "Add background clip"),
    "offvocal": ("offvocal_upload.py", None),
    "bpm": ("bpm_sheet.py", None),
    "update": ("import_works.py", "update"),
}


def run(*cmd):
    return subprocess.run(cmd, cwd=ROOT).returncode


def script(name):
    return run(sys.executable, str(ROOT / "scripts" / name))


def git_output(*args):
    return subprocess.run(["git", "-c", "core.quotepath=false", *args], cwd=ROOT, check=True,
                          capture_output=True, encoding="utf-8", errors="replace").stdout


def publish(message):
    if script("build.py"):
        print("ビルドに失敗しました。")
        return 1
    changes = git_output("status", "--short", "--untracked-files=all")
    if not changes:
        print("変更はありませんでした。")
        return 0
    print("\n公開する変更:\n" + changes)
    try:
        answer = input("これを GitHub に送って公開します。よろしいですか? [y/N]: ").strip().lower()
    except EOFError:  # 入力がないときは、公開しない
        answer = ""
    if answer not in ("y", "yes"):
        print("公開しませんでした(変更は、このPCに残っています)。")
        return 0
    title = "%s %s" % (message, datetime.date.today().isoformat())
    for cmd in (("add", "-A"), ("commit", "-q", "-m", title), ("pull", "--rebase", "-q", "origin", "main"), ("push",)):
        if run("git", *cmd):
            print("送信に失敗しました。ネット接続か GitHub のログイン状態を確認してください。")
            return 1
    print("送信しました。公開の反映まで1〜2分かかります。")
    return 0


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in TASKS:
        print("使い方: python scripts/win.py [%s]" % " | ".join(TASKS))
        return 1
    task = sys.argv[1]
    name, message = TASKS[task]
    if run("git", "pull", "--ff-only", "-q", "origin", "main"):
        print("(GitHub の最新を取り込めませんでした。そのまま続けます)")
    failed = script(name)
    if failed:
        if task == "update":
            print("(新着の取り込みに失敗しました。そのまま続けます)")
        elif task != "spotify":
            return failed
    if message:
        return publish(message)
    return failed


if __name__ == "__main__":
    sys.exit(main())
