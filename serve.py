#!/usr/bin/env python3
"""本地运行「墨西哥电视直播」页面。

除了提供静态文件，还附带一个可选接口 /api/youtube-live?channel=<频道 ID>：
在本机读取 YouTube 频道的 /live 页面，返回当前直播的视频 ID 和是否正在直播。
页面拿到视频 ID 后会直接嵌入具体的直播视频，比按频道嵌入更稳定；
用其他静态服务器托管时没有这个接口，页面会自动退回到按频道嵌入。

用法：python3 serve.py [--host 127.0.0.1] [--port 8000]
"""

import argparse
import http.client
import json
import re
import threading
import time
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parent
CHANNEL_ID = re.compile(r"^UC[\w-]{22}$")
CANONICAL = re.compile(r'<link rel="canonical" href="([^"]+)"')
WATCH_ID = re.compile(r"[?&]v=([\w-]{11})")
CACHE_SECONDS = 300
YT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
    "Accept-Language": "es-MX,es;q=0.9,en;q=0.8",
    # 跳过欧盟地区的 Cookie 同意页，否则拿不到频道页面
    "Cookie": "SOCS=CAI",
}

_cache = {}
_lock = threading.Lock()


def resolve_live(channel_id):
    now = time.monotonic()
    with _lock:
        hit = _cache.get(channel_id)
    if hit and now - hit[0] < CACHE_SECONDS:
        return hit[1]

    request = urllib.request.Request(f"https://www.youtube.com/channel/{channel_id}/live", headers=YT_HEADERS)
    with urllib.request.urlopen(request, timeout=12) as response:
        html = response.read(4_000_000).decode("utf-8", "replace")

    match = CANONICAL.search(html)
    canonical = match.group(1) if match else ""
    video = WATCH_ID.search(canonical)
    if video:
        # 频道有预告中的直播时 /live 也会指向该视频，所以还要确认它此刻正在直播
        result = {"live": '"isLive":true' in html, "videoId": video.group(1)}
    elif "/channel/" in canonical or "/@" in canonical:
        result = {"live": False, "videoId": None}
    else:
        result = {"live": None, "videoId": None}

    with _lock:
        _cache[channel_id] = (now, result)
    return result


class Handler(SimpleHTTPRequestHandler):
    # Windows 注册表有时把 .js 登记成 text/plain，浏览器会因此拒绝加载 ES 模块
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".json": "application/json",
    }

    def do_GET(self):
        url = urlsplit(self.path)
        if url.path == "/api/youtube-live":
            self.youtube_live(parse_qs(url.query).get("channel", [""])[0])
            return
        super().do_GET()

    def youtube_live(self, channel_id):
        if not CHANNEL_ID.match(channel_id):
            self.send_json(400, {"error": "invalid channel id"})
            return
        try:
            self.send_json(200, resolve_live(channel_id))
        except (OSError, http.client.HTTPException) as err:
            self.send_json(502, {"error": str(err)})

    def send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    parser = argparse.ArgumentParser(description="本地运行墨西哥电视直播页面")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址；想让同一局域网的手机访问时用 0.0.0.0")
    parser.add_argument("--port", type=int, default=8000, help="端口，默认 8000")
    args = parser.parse_args()

    handler = partial(Handler, directory=str(ROOT))
    with ThreadingHTTPServer((args.host, args.port), handler) as httpd:
        host = "127.0.0.1" if args.host in ("", "0.0.0.0") else args.host
        print(f"墨西哥电视直播已启动：http://{host}:{args.port}/   按 Ctrl+C 停止", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n已停止")


if __name__ == "__main__":
    main()
