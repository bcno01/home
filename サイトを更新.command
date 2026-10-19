#!/bin/bash
# ダブルクリックで、確認用にサイトを作り直し、変更を GitHub に送って公開する(公開用のビルドは GitHub 側で自動)
cd "$(dirname "$0")"
if ! python3 build.py; then
  echo "ビルドに失敗しました。"
  read -n 1 -s -r -p "キーを押すと閉じます"
  exit 1
fi
if git rev-parse --is-inside-work-tree >/dev/null 2>&1 && [ -n "$(git remote)" ]; then
  git add -A
  if git diff --cached --quiet; then
    echo "変更はありませんでした。"
  else
    git commit -q -m "update $(date +%F)" && git push && echo "送信しました。公開の反映まで1〜2分かかります。" || echo "送信に失敗しました。ネット接続か GitHub のログイン状態を確認してください。"
  fi
else
  echo "(GitHub への接続が未設定なので、確認用の docs/ を作っただけです)"
fi
echo
read -n 1 -s -r -p "キーを押すと閉じます"
