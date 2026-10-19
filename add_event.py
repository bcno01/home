#!/usr/bin/env python3
# イベント出演の予定を events.txt に1行追加する
# 使い方: python3 add_event.py                                  質問に答える
#         python3 add_event.py 2026-12-24 "イベント名" "場所" "URL"
import sys

import build


def main():
    a = sys.argv[1:]
    if len(a) >= 2:
        date, title, venue, url = (a + ["", ""])[:4]
    else:
        date = input("日付(例: 2026-12-24): ").strip()
        title = input("イベント名: ").strip()
        venue = input("場所(なければ Enter): ").strip()
        url = input("詳細のURL(なければ Enter): ").strip()
    d = build.parse_date(date)
    if not d or not title:
        print("日付(例: 2026-12-24)とイベント名が必要です。")
        return 1
    line = " | ".join([d.isoformat(), title.replace("|", "/"), venue.replace("|", "/"), url]).rstrip(" |")
    with build.EVENTS_FILE.open("a", encoding="utf-8") as f:
        f.write(line + "\n")
    print("追加しました: " + line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
