#!/bin/bash
# ダブルクリックで、Spotify のアルバムのURLを貼り付けて、対応する作品にリンクを付ける
cd "$(dirname "$0")"
python3 add_spotify.py
echo
read -p "サイトを更新して公開しますか? [Y/n]: " ans
if [ -z "$ans" ] || [ "$ans" = "y" ] || [ "$ans" = "Y" ]; then
  python3 build.py && git add -A && (git diff --cached --quiet && echo "変更はありませんでした。" || (git commit -q -m "Add Spotify links $(date +%F)" && git pull --rebase -q origin main && git push && echo "送信しました。公開の反映まで1〜2分かかります。"))
fi
echo
read -n 1 -s -r -p "キーを押すと閉じます"
