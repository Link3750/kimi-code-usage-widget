@echo off
echo Set ws = CreateObject("Wscript.Shell")> "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\kimi-usage-widget-watcher.vbs"
echo ws.Run "pythonw.exe ""%~dp0watch-patch.py""", 0, False>> "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\kimi-usage-widget-watcher.vbs"
echo 已写入开机启动项
wscript "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\kimi-usage-widget-watcher.vbs"
echo 监听进程已启动,日志见 watcher.log
pause
