"""本机自测用的假源服务器（不属于 Docker 镜像，容器里不会打包这个文件）。

用途：在没有公网 IPTV 源的情况下，验证 IPTV Auto Tester 的测速逻辑确实是在
「看真实流」而不是看 HTTP 200：

  /live/test.ts      真 MPEG-TS（h264 + aac）      → 期望 可用
  /live/test.m3u8    真 HLS                        → 期望 可用
  /live/fake.m3u8    HTTP 200 但内容是 HTML 文本    → 期望 解析失败/无视频流（负向控制）
  /live/audio.ts     只有音频的 TS                  → 期望 可用(仅音频)
  /live/slow.ts      50KB/s 涓流的真 TS            → 期望 速度过慢
  /live/missing.ts   404                           → 期望 HTTP错误
  /dead              直接断开（无响应）              → 期望 连接失败
  /subscribe.m3u     一个混合 M3U 订阅文件           → 期望 源更新能解析
  /<任意名>.m3u       www/ 下的其他订阅文件           → 供大列表压测使用

用法：
  python dev-tools/fake_origin_server.py --port 8099 --www dev-tools/www
  python dev-tools/fake_origin_server.py --port 8100 --bind ::1   # IPv6 回环源
"""

from __future__ import annotations

import argparse
import http.server
import os
import socket
import socketserver
import sys
import time

CHUNK = 16 * 1024


class Handler(http.server.BaseHTTPRequestHandler):
    www = "www"
    slow_bytes_per_second = 50 * 1024

    def log_message(self, *args) -> None:  # 安静
        pass

    def _path(self) -> str:
        return self.path.split("?", 1)[0]

    def _send_file(self, name: str, content_type: str, rate_limit: int = 0) -> None:
        full = os.path.join(self.www, name)
        if not os.path.isfile(full):
            self.send_error(404, "not found")
            return
        size = os.path.getsize(full)
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(size))
        self.end_headers()
        # 限速按「累计已发字节 / 目标速率」这条绝对时间线走，而不是每块各睡 len/rate：
        # 后者会把每次 sleep 的抖动和写 socket 的耗时一路累进总时长，档位越大偏得越多
        # （2000000B/s 那档实测只剩 800KB/s），拿它当测速判据就不可信了。
        pace_chunk = CHUNK if not rate_limit else min(4 * CHUNK, max(4096, rate_limit // 20))
        started = time.monotonic()
        sent = 0
        with open(full, "rb") as fh:
            while True:
                chunk = fh.read(pace_chunk)
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    return
                sent += len(chunk)
                if rate_limit:
                    delay = sent / rate_limit - (time.monotonic() - started)
                    if delay > 0:
                        time.sleep(delay)

    def _redirect(self, path: str) -> bool:
        """/redir/<剩余跳数>/<路径> —— 模拟 IPTV 源站常见的 302 换 CDN。

        最后一跳会把 URL 换成带临时签名参数的地址（?tm=…&key=…），
        用来验证：检测要跟着跳转走并记下最终地址，但产物里必须仍然写原始 URL。
        返回 True 表示这个请求已经处理完了。
        """
        rest = path[len("/redir/") :]
        hops_text, sep, target = rest.partition("/")
        if not sep or not target:
            self.send_error(404, "bad /redir/ path")
            return True
        try:
            hops = int(hops_text)
        except ValueError:
            self.send_error(404, "bad /redir/ hops")
            return True
        if hops > 0:
            host = self.headers.get("Host") or "127.0.0.1"
            if hops == 1:
                # 倒数第一跳就把签名参数挂上，最终 URL 会带 query
                location = (
                    f"http://{host}/redir/0/{target}"
                    f"?tm={int(time.time())}&key=deadbeef01"
                )
            else:
                location = f"http://{host}/redir/{hops - 1}/{target}"
            self.send_response(302)
            self.send_header("Location", location)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return True
        # 最后一跳：路径改写回正常形态，交给下面的通用逻辑发文件
        self.path = "/" + target
        self.do_GET()
        return True

    def _rate_limited(self, path: str) -> bool:
        """/rate/<字节每秒>/<www 里的文件名> —— 给同一个文件造出可控快慢。

        跨源择优（同一个 tvg-id 只留实测最快的一条）需要两条都「可用」但速度不同的地址，
        光靠本机回环的快慢不稳定，所以这里显式限速。返回 True 表示已处理。
        """
        rest = path[len("/rate/") :]
        rate_text, sep, name = rest.partition("/")
        if not sep or not rate_text.isdigit() or not name:
            self.send_error(404, "bad /rate/ path")
            return True
        safe = os.path.basename(name)
        self._send_file(safe, "video/mp2t", rate_limit=int(rate_text))
        return True

    def do_GET(self) -> None:  # noqa: N802
        path = self._path()
        if path.startswith("/redir/"):
            self._redirect(path)
            return
        if path.startswith("/rate/"):
            self._rate_limited(path)
            return
        if not path.startswith("/live/") and path.rsplit(".", 1)[-1] in ("m3u", "m3u8", "txt", "conf"):
            # 订阅文件按名字直接落在 www/ 下，方便 dev-tools 造大列表 / TXT 源
            name = os.path.basename(path)
            if os.path.isfile(os.path.join(self.www, name)):
                self._send_file(name, "audio/x-mpegurl")
                return
        if path.startswith("/live/"):
            name = path[len("/live/") :]
            if name == "fake.m3u8":
                body = b"<html><body>service temporarily unavailable</body></html>\n" * 4
                self.send_response(200)
                self.send_header("Content-Type", "application/vnd.apple.mpegurl")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if name == "slow.ts":
                self._send_file("test.ts", "video/mp2t", rate_limit=self.slow_bytes_per_second)
                return
            if name.endswith(".m3u8"):
                self._send_file(name, "application/vnd.apple.mpegurl")
                return
            if name.startswith("hls_") or name.endswith(".ts"):
                self._send_file(name, "video/mp2t")
                return
        if path == "/subscribe.m3u":
            self._send_file("subscribe.m3u", "audio/x-mpegurl")
            return
        if path == "/dead":
            # 直接关掉连接，模拟 TCP 层失败
            try:
                self.connection.close()
            except OSError:
                pass
            return
        self.send_error(404, "no such path")

    do_HEAD = do_GET


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8099)
    parser.add_argument("--www", default=os.path.join(os.path.dirname(__file__), "www"))
    parser.add_argument("--bind", default="127.0.0.1")
    args = parser.parse_args()
    Handler.www = args.www
    os.makedirs(args.www, exist_ok=True)
    Server.address_family = socket.AF_INET6 if ":" in args.bind else socket.AF_INET
    with Server((args.bind, args.port), Handler) as httpd:
        print(f"fake origin server on http://{args.bind}:{args.port}/  www={args.www}", flush=True)
        httpd.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
