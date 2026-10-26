#!/usr/bin/env python3
# 新作などの取り込み結果(import_works.py が書き出した文章)を、Discord に送る(標準ライブラリのみ)
# 使い方: python3 scripts/notify.py 文章のファイル
# 環境変数 DISCORD_WEBHOOK_URL がなければ、何もしない(Discord を使わない場合)。GitHub への Issue 通知は、ワークフロー側で行う
import json
import os
import sys
import urllib.request
from pathlib import Path


def main():
    url = os.environ.get("DISCORD_WEBHOOK_URL", "").strip()
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    if not url or not path or not path.is_file() or not path.read_text(encoding="utf-8").strip():
        return 0
    text = path.read_text(encoding="utf-8")
    if len(text) > 1900:  # Discord の1通の上限(2000文字)に収める
        text = text[:1900] + "\n…"
    req = urllib.request.Request(url, data=json.dumps({"content": text}).encode("utf-8"),
                                 headers={"Content-Type": "application/json", "User-Agent": "portfolio-notifier"})
    try:
        urllib.request.urlopen(req, timeout=15).read()
        print("Discord に通知しました")
    except Exception as e:  # 通知に失敗しても、サイトの公開は止めない
        print("Discord への通知に失敗しました: %s" % e)
    return 0


if __name__ == "__main__":
    sys.exit(main())
