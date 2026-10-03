"""强制协议族的本地 HTTP/HTTPS 代理。

为什么需要它：FFprobe/FFmpeg 没有「只用 IPv6 / 只用某个 IP」的参数。
把 URL 里的域名换成 IP 又会破坏 HTTPS 的 SNI 和虚拟主机（Host 头）。

做法：在 127.0.0.1 上给每次测试开一个专用监听端口，
  - 普通 HTTP：FFmpeg 发绝对形式请求，代理改成 origin-form 并保留正确的 Host 头，
    然后由代理按指定协议族（IPv4/IPv6 的指定地址）拨号；
  - HTTPS：FFmpeg 通过代理建立 CONNECT 隧道，TLS 握手仍在 FFmpeg 与源站之间完成，
    SNI/证书校验完全正常，代理只负责按指定地址拨号并搬运字节。

顺带在代理里就能拿到真实指标：HTTP 状态码、TCP 连接耗时、首字节时间、下载字节数。
"""

from __future__ import annotations

import asyncio
import time
from typing import Any
from urllib.parse import urlsplit

_MAX_HEAD = 64 * 1024
_CHUNK = 65536
_RELAY_LIMIT_SECONDS = 120.0
_BODY_HEAD_LIMIT = 1024


class ProxyError(Exception):
    pass


class ForcedProxy:
    """一次测试一个实例；退出上下文时关闭监听与所有连接。"""

    def __init__(
        self,
        *,
        family: str,
        target_ip: str,
        origin_host: str,
        connect_timeout: float = 5.0,
        resolver=None,
    ) -> None:
        self.family = family
        self.target_ip = target_ip
        self.origin_host = origin_host
        self.connect_timeout = connect_timeout
        self._resolver = resolver
        self._server: asyncio.Server | None = None
        self._tasks: set[asyncio.Task] = set()
        self._closed = False

        # 统计量
        self.bytes_down = 0
        self.bytes_up = 0
        self.requests = 0
        self.dial_failures = 0
        self.last_dial_error = ""
        self.origin_responded = False  # 只有源站真回过响应头，才认为 http_status 可信
        self.tunnel_established = False  # HTTPS 隧道已建立（源站可达，状态码要从 ffmpeg 输出取）
        self.http_status: int | None = None
        self.status_line = ""
        # 重定向与内容类型：IPTV 源站常常 302 到另一个带临时签名的地址，
        # 检测要跟着跳，但对外播放列表里写的必须仍然是订阅文件给的原始地址。
        self.redirect_hops = 0
        self.final_url = ""
        self.content_type = ""
        # HLS 会派生出一堆分片请求：某个分片 404 不能算「源站返回 404」，单独记
        self.segment_requests = 0  # 原始地址定论之后的派生请求数（分片、二次探测）
        self.segment_ok = 0
        self.segment_error: int | None = None
        self.first_segment_error_path = ""
        self._pending_location: str | None = None
        # 原始地址那条链上最后一次响应的开头，用来判断「200 但给的是 HTML 页面」
        self.body_head = b""
        self._capture_body = False
        self.connect_ms: float | None = None
        self.first_byte_ms: float | None = None
        self.started_at = time.monotonic()
        self._request_sent_at: float | None = None
        self.last_byte_at: float | None = None
        self.tunnel_bytes = 0  # CONNECT 隧道（HTTPS）搬运的字节
        # 测速窗口：源站真正开始吐数据的那一刻起算，进程启动/建连/发请求都不算进分母。
        # 否则一条 0.3 秒就能下完的快源会被 0.5 秒的 ffmpeg 启动时间拖成「慢」，
        # 跨源择优就会挑到更慢的那条。
        self.window_open = False
        self.window_limit = 0.0
        self.window_base_bytes = 0
        self.window_first_at: float | None = None
        self.window_capped_at: float | None = None
        self.window_capped_bytes = 0

    # -- 生命周期 ----------------------------------------------------------
    async def start(self) -> None:
        self._server = await asyncio.start_server(
            self._handle, host="127.0.0.1", port=0, limit=4 * 1024 * 1024
        )
        self.started_at = time.monotonic()

    async def stop(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._server is not None:
            self._server.close()
            try:
                await self._server.wait_closed()
            except Exception:
                pass
        for task in list(self._tasks):
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)

    @property
    def proxy_url(self) -> str:
        if self._server is None:
            raise ProxyError("代理未启动")
        host, port = self._server.sockets[0].getsockname()[:2]
        return f"http://{host}:{port}"

    def open_speed_window(self, limit_seconds: float) -> None:
        """开始统计一次吞吐采样，只计到「窗口上限」那一刻（流一直吐时会在这里掐表）。"""
        self.window_limit = max(0.1, float(limit_seconds))
        self.window_base_bytes = self.bytes_down
        self.window_first_at = None
        self.window_capped_at = None
        self.window_capped_bytes = 0
        self.window_open = True

    def close_speed_window(self) -> tuple[int, float]:
        """返回 (窗口内字节数, 有效传输秒数)。没等到任何字节时秒数为 0。"""
        self.window_open = False
        start = self.window_first_at
        if start is None:
            return 0, 0.0
        if self.window_capped_at is not None:
            # 采样到点时流还没断：只认掐表那一刻之前的字节，别把杀进程的延迟算成吞吐量
            return self.window_capped_bytes, round(self.window_capped_at - start, 3)
        end = self.last_byte_at if self.last_byte_at is not None else time.monotonic()
        return max(0, self.bytes_down - self.window_base_bytes), round(max(0.0, end - start), 3)

    def _note_window(self) -> None:
        """在把一批字节计入总量之前先掐表：跨界那一批不算进窗口，宁可少算不虚报。"""
        if not self.window_open:
            return
        now = time.monotonic()
        if self.window_first_at is None:
            self.window_first_at = now
            return
        if self.window_capped_at is None and now - self.window_first_at >= self.window_limit:
            self.window_capped_at = now
            self.window_capped_bytes = max(0, self.bytes_down - self.window_base_bytes)

    @property
    def saw_origin(self) -> bool:
        """源站给过可信响应：HTTP 响应头，或成功建立的 HTTPS 隧道。"""
        return self.origin_responded or self.tunnel_established

    @property
    def segment_test(self) -> str:
        """分片级验证结论（HLS 才有派生请求，单文件流是 none）。

        ok       —— 取到过内容，没有分片报错
        partial  —— 有分片报错，但别的分片取到了：HLS 直播列表切片边界常见，不判死
        failed   —— 全是报错：playlist 本身能读却一个分片都取不到，才算真坏
        none     —— 没有派生请求（直连 .ts / 探针提前结束）
        unknown  —— HTTPS 走 CONNECT 隧道，代理看不见里面的 HTTP 状态
        """
        if self.segment_requests == 0:
            if self.tunnel_established and not self.origin_responded:
                return "unknown"
            return "none"
        if self.segment_error is None:
            return "ok"
        return "partial" if self.segment_ok else "failed"

    @property
    def body_kind(self) -> str:
        """原始地址最终给回来的内容形态：hls / html / other / unknown。

        只看了正文头 1KB，够分辨播放列表、HTML 报错页和裸 TS（裸 TS 首字节是 0x47）。
        """
        head = self.body_head[:512].lstrip()
        if not head:
            return "unknown"
        lowered = head.lower()
        if lowered.startswith(b"#extm3u") or b"#ext-x-targetduration" in lowered or b"#extinf" in lowered:
            return "hls"
        if lowered.startswith(b"<!doctype html") or lowered.startswith(b"<html") or b"<html" in lowered:
            return "html"
        return "other"

    # -- 拨号 --------------------------------------------------------------
    async def _dial(self, host: str, port: int) -> tuple[Any, Any]:
        """按指定协议族拨号；目标域名与原始域名一致时用固定 IP，否则自行解析。"""
        address = self.target_ip
        if host.lower() != self.origin_host.lower():
            address = await self._resolve_same_family(host, port)
        if not address:
            self.dial_failures += 1
            self.last_dial_error = f"目标 {host} 没有可用的 {self.family} 地址"
            raise ProxyError(self.last_dial_error)

        loop_start = time.perf_counter()
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(address, port), timeout=self.connect_timeout
            )
        except asyncio.TimeoutError:
            self.dial_failures += 1
            self.last_dial_error = f"连接 {host}:{port}({address}) 超时"
            raise ProxyError(self.last_dial_error)
        except (OSError, ValueError) as exc:
            self.dial_failures += 1
            self.last_dial_error = f"连接 {host}:{port}({address}) 失败：{exc}"
            raise ProxyError(self.last_dial_error)
        elapsed_ms = (time.perf_counter() - loop_start) * 1000.0
        if self.connect_ms is None or elapsed_ms < self.connect_ms:
            self.connect_ms = round(elapsed_ms, 1)
        return reader, writer

    async def _resolve_same_family(self, host: str, port: int) -> str | None:
        if self._resolver is None:
            return host
        v4, v6 = await self._resolver(host, port)
        return (v4[0] if v4 else None) if self.family == "ipv4" else (v6[0] if v6 else None)

    # -- 连接处理 -----------------------------------------------------------
    async def _handle(self, client_reader: asyncio.StreamReader, client_writer: Any) -> None:
        task = asyncio.current_task()
        if task is not None:
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)
        upstream_writer = None
        try:
            head = await asyncio.wait_for(self._read_head(client_reader), 15)
            if not head:
                return
            lines = head.decode("latin-1").split("\r\n")
            parsed = self._parse_head(lines)
            if parsed is None:
                return
            method, target, headers = parsed
            if method == "CONNECT":
                upstream_reader, upstream_writer = await self._open_connect(target, client_writer)
                await self._relay(client_reader, client_writer, upstream_reader, upstream_writer, "tunnel")
            else:
                upstream_reader, upstream_writer = await self._open_plain(
                    method, target, headers, lines, client_writer
                )
                await self._relay(
                    client_reader, client_writer, upstream_reader, upstream_writer, "http"
                )
        except ProxyError as exc:
            await self._reject(client_writer, str(exc))
        except (asyncio.CancelledError, ConnectionResetError, BrokenPipeError):
            raise
        except asyncio.TimeoutError:
            await self._reject(client_writer, "读取请求头超时")
        except Exception as exc:  # 单个连接出错不能影响整轮任务
            self.last_dial_error = str(exc)[:200]
            await self._reject(client_writer, f"代理内部错误：{exc}")
        finally:
            if upstream_writer is not None:
                try:
                    upstream_writer.close()
                except Exception:
                    pass

    @staticmethod
    async def _read_head(reader: asyncio.StreamReader) -> bytes:
        buf = b""
        while b"\r\n\r\n" not in buf and len(buf) < _MAX_HEAD:
            chunk = await reader.read(4096)
            if not chunk:
                break
            buf += chunk
        return buf

    @staticmethod
    def _parse_head(lines: list[str]) -> tuple[str, str, dict[str, str]] | None:
        """解析请求行与请求头；无法识别时返回 None。"""
        if not lines or not lines[0].strip():
            return None
        pieces = lines[0].split()
        if len(pieces) < 2:
            return None
        method = pieces[0].upper()
        target = pieces[1]
        headers: dict[str, str] = {}
        for line in lines[1:]:
            if not line or ":" not in line:
                continue
            key, _, value = line.partition(":")
            headers[key.strip().lower()] = value.strip()
        return method, target, headers

    def _split_host_port(self, target: str, default_port: int) -> tuple[str, int]:
        if target.startswith("["):  # IPv6 字面量
            literal, _, rest = target.partition("]")
            host = literal[1:]
            port = int(rest.lstrip(":")) if rest.lstrip(":").isdigit() else default_port
            return host, port
        host, sep, maybe_port = target.partition(":")
        if sep and maybe_port.isdigit():
            return host, int(maybe_port)
        return target, default_port

    async def _open_connect(self, target: str, client_writer: Any) -> tuple[Any, Any]:
        host, port = self._split_host_port(target, 443)
        upstream_reader, upstream_writer = await self._dial(host, port)
        client_writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
        await client_writer.drain()
        self.requests += 1
        self.tunnel_established = True
        self._capture_body = False  # 隧道里是 TLS 字节，不是可判读的正文
        # HTTPS 走隧道：源站的 HTTP 状态码在 TLS 里看不到，首包时间从隧道打通算起
        self._request_sent_at = time.perf_counter()
        return upstream_reader, upstream_writer

    async def _open_plain(
        self,
        method: str,
        target: str,
        headers: dict[str, str],
        lines: list[str],
        client_writer: Any,
    ) -> tuple[Any, Any]:
        req_scheme = ""
        if target.startswith("/"):
            raw_host = headers.get("host", "")
            if not raw_host:
                raise ProxyError("请求缺少 Host 头")
            host, port = self._split_host_port(raw_host, 80)
            req_scheme = "https" if port == 443 else "http"
            path = target
        else:
            parts = urlsplit(target)
            host = parts.hostname or ""
            port = parts.port or (443 if parts.scheme.lower() == "https" else 80)
            req_scheme = parts.scheme.lower() or ("https" if port == 443 else "http")
            path = parts.path or "/"
            if parts.query:
                path += "?" + parts.query
        if not host:
            raise ProxyError(f"无法确定目标主机：{target[:80]}")

        upstream_reader, upstream_writer = await self._dial(host, port)

        # 绝对形式改 origin-form，Host 头换成原始域名（虚拟主机 CDN 依赖它）
        literal = f"[{host}]" if ":" in host and not host.startswith("[") else host
        host_header = literal if port in (80, 443) else f"{literal}:{port}"
        rebuilt: list[str] = [f"{method} {path} HTTP/1.1"]
        for line in lines[1:]:
            if not line:
                continue
            key = line.split(":", 1)[0].strip().lower()
            if key in ("proxy-connection", "host"):
                continue
            rebuilt.append(line)
        rebuilt.append(f"Host: {host_header}")
        payload = ("\r\n".join(rebuilt) + "\r\n\r\n").encode("latin-1", "replace")
        upstream_writer.write(payload)
        await upstream_writer.drain()
        self._request_sent_at = time.perf_counter()
        self.requests += 1
        self.bytes_up += len(payload)

        # 这个请求真正打到哪个地址，后面判断「原始地址那条链」要用
        request_url = f"{req_scheme}://{host_header}{path}"
        # 还在原始地址的跳转链上：每一跳都把上一跳（302 自带的几十字节 HTML）丢掉，
        # 链子断掉之后再来的分片请求一律不记正文
        self._capture_body = self.http_status is None
        if self._capture_body:
            self.body_head = b""
        status_line = await asyncio.wait_for(upstream_reader.readline(), 15)
        code: int | None = None
        if status_line:
            text = status_line.decode("latin-1").strip()
            self.status_line = text
            pieces = text.split()
            if len(pieces) >= 2 and pieces[1].isdigit():
                code = int(pieces[1])
            client_writer.write(status_line)
        head = await self._forward_headers(upstream_reader, client_writer)
        if code is not None:
            self._note_response(code, status_line + head, request_url)
        return upstream_reader, upstream_writer

    def _note_response(self, code: int, head: bytes, request_url: str) -> None:
        """按「是不是原始地址那条链」分类记录响应。

        第一个请求（也就是被测地址本身）的跳转链上：3xx 记一跳，直到拿到非 3xx 为止，
        那时把真正取到内容的地址记成 final_url、把 Content-Type 记下来。
        这条链结束之后再来的一切（HLS 分片、探测用的二次请求）都不再改动原始地址的状态，
        只把 4xx/5xx 归到 segment_error，避免「第一个 TS 404」把整个频道判死。
        """
        headers: dict[str, str] = {}
        for line in head.decode("latin-1", "replace").split("\r\n")[1:]:
            if not line or ":" not in line:
                continue
            key, _, value = line.partition(":")
            headers[key.strip().lower()] = value.strip()

        self.origin_responded = True
        if self.http_status is None:
            if 300 <= code < 400:
                self.redirect_hops += 1
                location = headers.get("location", "")
                self._pending_location = self._absolute_url(location, request_url) if location else None
                return
            self.http_status = code
            self.final_url = self._pending_location or request_url
            self.content_type = headers.get("content-type", "")
            self._pending_location = None
            return

        # 原始地址已经有结论了，后面这些都是派生请求
        if 300 <= code < 400:
            return
        if not self._looks_like_playlist():
            # 裸 TS / 单文件流被 ffmpeg 二次打开（结构校验一遍、吞吐实测一遍），
            # 那不是 HLS 分片，别把它记成分片请求
            return
        self.segment_requests += 1
        if code < 400:
            self.segment_ok += 1
        elif self.segment_error is None:
            self.segment_error = code
            self.first_segment_error_path = request_url

    def _looks_like_playlist(self) -> bool:
        ctype = (self.content_type or "").lower()
        return "mpegurl" in ctype or self.body_kind == "hls"

    @staticmethod
    def _absolute_url(location: str, base: str) -> str:
        """Location 允许是相对路径，补成绝对地址好和后续请求比对。"""
        if "://" in location:
            return location
        parts = urlsplit(base)
        if location.startswith("/"):
            return f"{parts.scheme}://{parts.netloc}{location}"
        return f"{parts.scheme}://{parts.netloc}{parts.path.rsplit('/', 1)[0]}/{location}"

    async def _forward_headers(self, reader: asyncio.StreamReader, writer: Any) -> bytes:
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = await reader.read(4096)
            if not chunk:
                break
            buf += chunk
            if len(buf) > _MAX_HEAD:
                break
        if buf:
            received_at = time.monotonic()
            writer.write(buf)
            await writer.drain()
            self._note_window()
            self.bytes_down += len(buf)
            self.last_byte_at = received_at
            if self.first_byte_ms is None:
                base = self._request_sent_at if self._request_sent_at is not None else self.started_at
                self.first_byte_ms = round((time.perf_counter() - base) * 1000.0, 1)
            # 一次 read 很可能把正文的开头一起带回来了，切出来留作内容形态判据
            if self._capture_body:
                split = buf.find(b"\r\n\r\n")
                if split >= 0:
                    self._note_body(buf[split + 4:])
        return buf

    def _note_body(self, chunk: bytes) -> None:
        if self._capture_body and len(self.body_head) < _BODY_HEAD_LIMIT:
            self.body_head += chunk[:_BODY_HEAD_LIMIT - len(self.body_head)]

    async def _relay(
        self,
        client_reader: asyncio.StreamReader,
        client_writer: Any,
        upstream_reader: asyncio.StreamReader,
        upstream_writer: Any,
        mode: str,
    ) -> None:
        async def to_upstream() -> None:
            while True:
                chunk = await client_reader.read(_CHUNK)
                if not chunk:
                    break
                self.bytes_up += len(chunk)
                upstream_writer.write(chunk)
                await upstream_writer.drain()

        async def to_client() -> None:
            while True:
                chunk = await upstream_reader.read(_CHUNK)
                if not chunk:
                    break
                self._note_window()
                self.bytes_down += len(chunk)
                self.last_byte_at = time.monotonic()
                if mode == "http":
                    self._note_body(chunk)
                if self.first_byte_ms is None:
                    base = self._request_sent_at if self._request_sent_at is not None else self.started_at
                    self.first_byte_ms = round((time.perf_counter() - base) * 1000.0, 1)
                if mode == "tunnel":
                    self.tunnel_bytes += len(chunk)
                client_writer.write(chunk)
                await client_writer.drain()

        try:
            await asyncio.wait_for(
                asyncio.gather(to_upstream(), to_client(), return_exceptions=True),
                timeout=_RELAY_LIMIT_SECONDS,
            )
        finally:
            for writer in (upstream_writer, client_writer):
                try:
                    writer.close()
                except Exception:
                    pass

    @staticmethod
    async def _reject(client_writer: Any, reason: str) -> None:
        # 原因只写进代理自身的统计字段（last_dial_error），响应体留给 ffmpeg 处理
        resp = (
            b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n"
            b"Connection: close\r\n\r\n"
        )
        try:
            client_writer.write(resp)
            await client_writer.drain()
            client_writer.close()
        except Exception:
            pass


class ProxyContext:
    """async with ForcedProxy(...) as p 的封装，保证一定关闭。"""

    def __init__(self, **kwargs: Any) -> None:
        self.proxy = ForcedProxy(**kwargs)

    async def __aenter__(self) -> ForcedProxy:
        await self.proxy.start()
        return self.proxy

    async def __aexit__(self, *exc: Any) -> None:
        await self.proxy.stop()
