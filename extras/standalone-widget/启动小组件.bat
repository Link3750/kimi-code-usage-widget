@echo off
cd /d %~dp0
start "" python server.py --port 8391 --open
