@echo off
chcp 65001 >nul
cd /d %~dp0
python patch-desktop.py
echo.
echo 补丁已重新打√,请重启桌面版(或在开发者工具 Console 执行 location.reload()
pause
