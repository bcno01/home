#!/bin/bash
# ダブルクリックで、MV のオフボーカル(WAV など)を GitHub の Releases にアップロードして、その MV のページにダウンロードボタンを付ける(公開はしません)
cd "$(dirname "$0")/.."
python3 scripts/offvocal_upload.py
echo
read -n 1 -s -r -p "キーを押すと閉じます"
