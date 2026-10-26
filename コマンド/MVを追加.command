#!/bin/bash
# ダブルクリックで、過去のMV(YouTube の動画)を、URLからサイトに追加する(終わったら公開もできる)
cd "$(dirname "$0")/.."
python3 scripts/add_youtube.py || { echo; read -n 1 -s -r -p "キーを押すと閉じます"; exit 1; }
echo
read -p "公開しますか? [Y/n]: " ans
if [ -z "$ans" ] || [ "$ans" = "y" ] || [ "$ans" = "Y" ]; then
  python3 scripts/build.py && git add -A && (git diff --cached --quiet && echo "変更はありませんでした。" || (git commit -q -m "Add MV $(date +%F)" && git pull --rebase -q origin main && git push && echo "送信しました。公開の反映まで1〜2分かかります。"))
fi
echo
read -n 1 -s -r -p "キーを押すと閉じます"
