#!/usr/bin/env python3
"""Kimi Code 用量小组件 - 原型 B 的本地数据服务.

数据源:
  1. 桌面版/CLI 内嵌 kap-server 的 /api/v1/oauth/usage (额度) 与 /api/v1/oauth/userinfo (账户)
     端口从 ~/.kimi-code/server/instances/*.json 自动发现(取心跳最新的存活实例)
  2. ~/.kimi-code/sessions/**/agents/*/wire.jsonl 中的 usage.record 行(按天统计 token 消耗)

仅用 Python 标准库。用法: python server.py [--port 8391] [--open]
"""
import argparse
import glob
import json
import os
import time
import urllib.request
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
KIMI_HOME = os.environ.get("KIMI_CODE_HOME") or os.path.join(os.path.expanduser("~"), ".kimi-code")
INSTANCES_DIR = os.path.join(KIMI_HOME, "server", "instances")
USAGE_CACHE_TTL = 20       # 秒,额度代理缓存
STATS_CACHE_TTL = 60       # 秒,wire.jsonl 统计缓存

_cache = {}


def _http_get_json(url, timeout=8):
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def discover_server():
    """返回 (port, None) 或 (None, 错误说明). 按 heartbeat_at 从新到旧尝试."""
    instances = []
    for path in glob.glob(os.path.join(INSTANCES_DIR, "*.json")):
        try:
            with open(path, encoding="utf-8") as f:
                info = json.load(f)
            if info.get("host") and info.get("port"):
                instances.append(info)
        except (OSError, ValueError):
            continue
    instances.sort(key=lambda i: i.get("heartbeat_at", 0), reverse=True)
    for info in instances:
        base = f"http://{info['host']}:{info['port']}"
        try:
            _http_get_json(base + "/api/v1/oauth/usage", timeout=3)
            return base, None
        except Exception:
            continue
    return None, "no live kap-server instance (Kimi Code 桌面版或 kimi web 是否在运行?)"


def get_usage():
    now = time.time()
    hit = _cache.get("usage")
    if hit and now - hit[0] < USAGE_CACHE_TTL:
        return hit[1]
    base, err = discover_server()
    if err:
        result = {"ok": False, "error": err}
    else:
        out = {"ok": True, "server": base, "fetchedAt": int(now * 1000)}
        try:
            out["usage"] = _http_get_json(base + "/api/v1/oauth/usage").get("data")
        except Exception as e:
            out["usageError"] = str(e)
        try:
            out["userInfo"] = _http_get_json(base + "/api/v1/oauth/userinfo").get("data", {}).get("userInfo")
        except Exception as e:
            out["userInfoError"] = str(e)
        result = out
    _cache["usage"] = (now, result)
    return result


def get_stats():
    """解析 wire.jsonl 的 usage.record, 按本地日期聚合最近 30 天."""
    now = time.time()
    hit = _cache.get("stats")
    if hit and now - hit[0] < STATS_CACHE_TTL:
        return hit[1]
    days = {}
    pattern = os.path.join(KIMI_HOME, "sessions", "**", "agents", "*", "wire.jsonl")
    for path in glob.glob(pattern, recursive=True):
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                for line in f:
                    if '"usage.record"' not in line:
                        continue
                    try:
                        rec = json.loads(line)
                    except ValueError:
                        continue
                    if rec.get("type") != "usage.record":
                        continue
                    ts = rec.get("time")
                    usage = rec.get("usage") or {}
                    if not ts:
                        continue
                    day = datetime.fromtimestamp(ts / 1000).strftime("%Y-%m-%d")
                    d = days.setdefault(day, {"input": 0, "cacheRead": 0, "cacheCreation": 0, "output": 0, "turns": 0})
                    d["input"] += usage.get("inputOther", 0)
                    d["cacheRead"] += usage.get("inputCacheRead", 0)
                    d["cacheCreation"] += usage.get("inputCacheCreation", 0)
                    d["output"] += usage.get("output", 0)
                    if rec.get("usageScope") == "turn":
                        d["turns"] += 1
        except OSError:
            continue
    result = {
        "ok": True,
        "days": [
            {"date": k, **v, "total": v["input"] + v["cacheRead"] + v["cacheCreation"] + v["output"]}
            for k, v in sorted(days.items())
        ],
    }
    _cache["stats"] = (now, result)
    return result


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # 静默
        pass

    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path, content_type):
        try:
            with open(path, "rb") as f:
                body = f.read()
        except OSError:
            self._send_json({"ok": False, "error": "not found"}, 404)
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/widget-debug":
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length).decode("utf-8", errors="replace")[:2000]
            line = json.dumps({"ts": datetime.now().isoformat(timespec="seconds"), "body": body}, ensure_ascii=False)
            with open(os.path.join(HERE, "widget-debug.log"), "a", encoding="utf-8") as f:
                f.write(line + "\n")
            self._send_json({"ok": True})
        else:
            self._send_json({"ok": False, "error": "unknown endpoint"}, 404)

    def do_GET(self):
        path, _, query = self.path.partition("?")
        if path in ("/", "/index.html", "/widget.html"):
            self._send_file(os.path.join(HERE, "widget.html"), "text/html; charset=utf-8")
        elif path in ("/dashboard", "/dashboard.html"):
            self._send_file(os.path.join(HERE, "dashboard.html"), "text/html; charset=utf-8")
        elif path == "/api/usage":
            self._send_json(get_usage())
        elif path == "/api/stats":
            # ?days=N 取最近 N 天; days=0 或不传返回全部
            limit = 0
            for kv in query.split("&"):
                if kv.startswith("days="):
                    try:
                        limit = int(kv[5:])
                    except ValueError:
                        pass
            result = get_stats()
            if limit > 0:
                result = {**result, "days": result["days"][-limit:]}
            self._send_json(result)
        elif path == "/api/health":
            self._send_json({"ok": True})
        else:
            self._send_json({"ok": False, "error": "unknown endpoint"}, 404)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8391)
    ap.add_argument("--open", action="store_true", help="启动后在浏览器打开")
    args = ap.parse_args()
    port = args.port
    while port < args.port + 20:
        try:
            server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError:
            port += 1
    else:
        raise SystemExit("没有可用端口")
    url = f"http://127.0.0.1:{port}/"
    print(f"Kimi 用量小组件: {url}  (Ctrl+C 停止)")
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
