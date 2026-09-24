@echo off
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\kimi-usage-widget-watcher.vbs" 2>nul
for /f "tokens=2" %%p in ('wmic process where "name='pythonw.exe' and CommandLine like '%%watch-patch.py%%'" get ProcessId 2^>nul ^| findstr /r "[0-9]"') do taskkill /f /pid %%p
echo 已移除开机自启并停止监听进程
pause
