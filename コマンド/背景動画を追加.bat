@echo off
set PYTHONUTF8=1
cd /d "%~dp0.."
python scripts\win.py bgclip
echo.
pause
