#!/bin/bash
# ダブルクリックで作品追加ウィザードを起動
cd "$(dirname "$0")"
python3 new.py
echo
read -n 1 -s -r -p "Enterか何かキーを押すと閉じます"
