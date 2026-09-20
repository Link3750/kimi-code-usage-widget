#!/usr/bin/env python3
"""Kimi Code 桌面版补丁自动重装监听.

每 30 秒检查 desktop-dist/index.html 是否还含有 kimi-usage-widget 注入标记,
被自动更新覆盖后自动重跑 patch-desktop.py 恢复补丁。
写入开机启动项后常驻, 日志见 watcher.log。
"""
import os
import subprocess
import sys
import time
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
PATCH_SCRIPT = os.path.join(HERE, "patch-desktop.py")
MARKER = "kimi-usage-widget"
CHECK_INTERVAL = 30          # 秒
REPATCH_COOLDOWN = 120       # 重打后冷却, 防止更新过程中反复触发
LOG_FILE = os.path.join(HERE, "watcher.log")

_target_cache = None


def detect_index_html():
    """与 patch-desktop.py 相同的安装目录探测."""
    global _target_cache
    if _target_cache:
        return _target_cache
    candidates = []
    if os.environ.get("KIMI_CODE_APP_DIR"):
        candidates.append(os.environ["KIMI_CODE_APP_DIR"])
    local = os.environ.get("LOCALAPPDATA", "")
    if local:
        candidates.append(os.path.join(local, "Programs", "Kimi Code"))
    candidates.append(r"C:\Program Files\Kimi Code")
    candidates.append(r"D:\kimi_code\Kimi Code")
    for base in candidates:
        p = os.path.join(base, "resources", "desktop-dist", "index.html")
        if os.path.isfile(p):
            _target_cache = p
            return p
    return None


def log(msg):
    line = f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    try:
        if sys.stdout:
            print(line, flush=True)
    except Exception:
        pass
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def is_patched():
    target = detect_index_html()
    if not target:
        return True  # 找不到安装目录, 下轮再看
    try:
        with open(target, "rb") as f:
            return MARKER.encode() in f.read()
    except OSError:
        return True  # 文件暂时读不到(更新中?), 当作已打补丁, 下轮再看


def repatch():
    log("检测到补丁被覆盖, 开始重装…")
    try:
        result = subprocess.run(
            [sys.executable, PATCH_SCRIPT],
            capture_output=True, text=True, timeout=60,
        )
        if result.returncode == 0 and is_patched():
            log("重装成功 (重载桌面版界面后生效)")
        else:
            log(f"重装可能失败: {result.stdout[-300:]} {result.stderr[-300:]}")
    except Exception as e:
        log(f"重装异常: {e}")


def main():
    log("监听启动")
    last_repatch = 0.0
    while True:
        if not is_patched() and time.time() - last_repatch > REPATCH_COOLDOWN:
            last_repatch = time.time()
            repatch()
        time.sleep(CHECK_INTERVAL)


if __name__ == "__main__":
    main()
