#!/usr/bin/env python3
"""给 Kimi Code 桌面版打用量面板补丁 (原型 A 安装器).

做两件事:
  1. 把 kimi-usage-widget.js 复制到 desktop-dist/
  2. 在 desktop-dist/index.html 的 </head> 前插入 <script defer src="/kimi-usage-widget.js"></script>

幂等, 可重复执行 (桌面版升级覆盖后重新跑一次即可)。
卸载: python patch-desktop.py --uninstall

用法: python patch-desktop.py [--target "D:\\kimi_code\\Kimi Code\\resources\\desktop-dist"]
"""
import argparse
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WIDGET_JS = os.path.join(HERE, "desktop-patch", "kimi-usage-widget.js")
SCRIPT_SRC = "/kimi-usage-widget.js"
SCRIPT_TAG = f'<script defer src="{SCRIPT_SRC}"></script>'
LEGACY_TAGS = [
    f'<script defer src="{SCRIPT_SRC}" '
    'onerror="navigator.sendBeacon(\'http://127.0.0.1:8391/api/widget-debug\', \'stage=script-load-fail\')"></script>',
]
BACKUP_SUFFIX = ".bak-kimi-widget"


def detect_desktop_dist():
    """按常见安装位置探测桌面版的 desktop-dist 目录."""
    candidates = []
    if os.environ.get("KIMI_CODE_APP_DIR"):
        candidates.append(os.environ["KIMI_CODE_APP_DIR"])
    local = os.environ.get("LOCALAPPDATA", "")
    if local:
        candidates.append(os.path.join(local, "Programs", "Kimi Code"))
    candidates.append(r"C:\Program Files\Kimi Code")
    candidates.append(r"D:\kimi_code\Kimi Code")
    for base in candidates:
        d = os.path.join(base, "resources", "desktop-dist")
        if os.path.isfile(os.path.join(d, "index.html")):
            return d
    return None


def install(target):
    index = os.path.join(target, "index.html")
    if not os.path.isfile(index):
        sys.exit(f"找不到 {index}, 请用 --target 指定 desktop-dist 目录")

    shutil.copy2(WIDGET_JS, os.path.join(target, "kimi-usage-widget.js"))
    print(f"[ok] 已复制 kimi-usage-widget.js -> {target}")

    with open(index, "rb") as f:
        content = f.read()
    upgraded = False
    for legacy in LEGACY_TAGS:
        if legacy.encode() in content:
            content = content.replace(legacy.encode(), SCRIPT_TAG.encode(), 1)
            upgraded = True
            break
    if upgraded:
        with open(index, "wb") as f:
            f.write(content)
        print("[ok] 已将旧版注入标签升级为最新版本")
        return
    if SCRIPT_TAG.encode() in content:
        print("[ok] index.html 已包含注入标签, 无需修改")
        return
    backup = index + BACKUP_SUFFIX
    if not os.path.exists(backup):
        shutil.copy2(index, backup)
        print(f"[ok] 已备份原 index.html -> {backup}")
    marker = b"</head>"
    if marker not in content:
        sys.exit("index.html 中找不到 </head>, 中止 (未做修改)")
    content = content.replace(marker, ("    " + SCRIPT_TAG + "\n  ").encode() + marker, 1)
    with open(index, "wb") as f:
        f.write(content)
    print("[ok] 已在 index.html 注入脚本标签")
    print()
    print("完成。重启桌面版应用后生效。")


def uninstall(target):
    index = os.path.join(target, "index.html")
    backup = index + BACKUP_SUFFIX
    if os.path.exists(backup):
        shutil.copy2(backup, index)
        os.remove(backup)
        print("[ok] 已从备份恢复 index.html")
    elif os.path.isfile(index):
        with open(index, "rb") as f:
            content = f.read()
        if SCRIPT_TAG.encode() in content:
            content = content.replace(("    " + SCRIPT_TAG + "\n  ").encode(), b"", 1)
            content = content.replace(SCRIPT_TAG.encode(), b"", 1)
            with open(index, "wb") as f:
                f.write(content)
            print("[ok] 已移除注入标签")
    js = os.path.join(target, "kimi-usage-widget.js")
    if os.path.exists(js):
        os.remove(js)
        print("[ok] 已删除 kimi-usage-widget.js")
    print("完成。按 Ctrl+R 或重启应用后生效。")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", default=None, help="desktop-dist 目录, 缺省自动探测")
    ap.add_argument("--uninstall", action="store_true")
    args = ap.parse_args()
    target = args.target or detect_desktop_dist()
    if not target:
        sys.exit("未能自动定位 Kimi Code 桌面版, 请用 --target 指定 desktop-dist 目录,"
                 " 或设置环境变量 KIMI_CODE_APP_DIR 指向应用安装目录")
    print(f"[ok] 目标: {target}")
    if args.uninstall:
        uninstall(target)
    else:
        install(target)


if __name__ == "__main__":
    main()
