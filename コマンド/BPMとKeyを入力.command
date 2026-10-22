#!/bin/bash
# ダブルクリックで、MV の BPM と Key を、スプレッドシートでまとめて入力する(公開はしません。公開は「サイトを更新.command」で)
cd "$(dirname "$0")/.."
python3 bpm_sheet.py
echo
read -n 1 -s -r -p "キーを押すと閉じます"
