#!/bin/bash
# ダブルクリックで、動画ファイルから背景用の短いクリップを作り、作品に付ける(終わったら公開もできる)
cd "$(dirname "$0")"
python3 add_bgclip.py || { echo; read -n 1 -s -r -p "キーを押すと閉じます"; exit 1; }
echo
read -p "サイトを更新して公開しますか? [Y/n]: " ans
if [ -z "$ans" ] || [ "$ans" = "y" ] || [ "$ans" = "Y" ]; then
  python3 build.py && git add -A && (git diff --cached --quiet && echo "変更はありませんでした。" || (git commit -q -m "Add background clip $(date +%F)" && git pull --rebase -q origin main && git push && echo "送信しました。公開の反映まで1〜2分かかります。"))
fi
echo
read -n 1 -s -r -p "キーを押すと閉じます"
