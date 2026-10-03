"""真正的 IPTV 播放流检测。

两阶段，全部通过强制协议族的本地代理走（见 netproxy.py）：

  阶段 1  FFprobe 结构校验：能不能连上、返回什么、能不能识别成 MPEG-TS/HLS、
          有没有 video/audio 流、编码是什么。
  阶段 2  FFmpeg 吞吐实测：`-c copy -f null -` 真实搬运一段时间的数据，
          由代理统计字节数算出下载速度、首包时间、连接耗时。

HTTP 200 只出现在阶段 1 的判据里作为「有响应」的证据，绝不单独判定可用：
返回 200 但内容不是流 → 解析失败/无视频流。

每个 URL 最多两个 FFprobe/FFmpeg 子进程（IPv4、IPv6 各一对），由 ProcessGroup
统一登记，超时或取消时立刻 terminate→kill，绝不留野进程。
"""

from __future__ import annotations

import asyncio
import json
import random
import re
import time
from typing import Any, Awaitable, Callable, Iterable
from urllib.parse import urljoin, urlsplit

from . import config, dnsinfo
from .netproxy import ForcedProxy, ProxyError
from .statuses import PASSING_STATUSES as _PASSING

# 失败状态的信息量排序：展示频道最终状态时取最有诊断价值的那个
_STATUS_PRIORITY = (
    "engine_missing",
    "http_error",
    "no_video",
    "no_audio",
    "parse_failed",
    "slow",
    "timeout",
    "connect_failed",
    "unsupported",
    "cancelled",
)

_HTTP_ERROR_RE = re.compile(r"HTTP error (\d{3})|returned (\d{3})|(\d{3}) Not Found", re.I)
_TIMEOUT_RE = re.compile(r"timed? ?out|Operation timed out|Input has ended|timeout", re.I)
_CONNECT_RE = re.compile(
    r"Connection refused|Connection reset|Network is unreachable|No route to host|"
    r"Failed to resolve name|Name or service not known|Cannot assign requested address|"
    r"Immediate error closing|Protocol not normalize",
    re.I,
)
_INVALID_DATA_RE = re.compile(r"Invalid data found when processing input", re.I)


class ProcessGroup:
    """登记/回收所有子进程，供「取消当前测速任务」使用。"""

    def __init__(self) -> None:
        self._procs: set[asyncio.subprocess.Process] = set()
        self.cancelled = False

    def add(self, proc: asyncio.subprocess.Process) -> None:
        self._procs.add(proc)

    def discard(self, proc: asyncio.subprocess.Process) -> None:
        self._procs.discard(proc)

    @property
    def running(self) -> int:
        return sum(1 for p in self._procs if p.returncode is None)

    def cancel(self) -> None:
        self.cancelled = True
        self.kill_all()

    def kill_all(self) -> None:
        for proc in list(self._procs):
            if proc.returncode is None:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
        self._procs.clear()


def _decode(raw: bytes | None) -> str:
    if not raw:
        return ""
    return raw.decode("utf-8", "replace")[-4000:]


async def _run_process(
    args: list[str], timeout: float, group: ProcessGroup
) -> tuple[int | None, str, str, float, bool]:
    """运行一个子进程，返回 (返回码, stdout, stderr, 耗时秒, 是否超时被杀)。"""
    started = time.monotonic()
    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            stdin=asyncio.subprocess.DEVNULL,
        )
    except (OSError, ValueError) as exc:
        return None, "", f"无法启动 {args[0]}：{exc}", 0.0, False
    group.add(proc)
    timed_out = False
    try:
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout)
        except asyncio.TimeoutError:
            timed_out = True
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            try:
                stdout, stderr = await asyncio.wait_for(proc.communicate(), 5)
            except (asyncio.TimeoutError, OSError):
                stdout, stderr = b"", b""
    except asyncio.CancelledError:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        group.discard(proc)
        raise
    finally:
        group.discard(proc)
    return proc.returncode, _decode(stdout), _decode(stderr), time.monotonic() - started, timed_out


def _http_status_from_text(text: str) -> int | None:
    match = _HTTP_ERROR_RE.search(text or "")
    if not match:
        return None
    for group in match.groups():
        if group and group.isdigit():
            return int(group)
    return None


def _streams_from_probe(stdout: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    try:
        data = json.loads(stdout or "{}")
    except ValueError:
        return [], {}
    streams = data.get("streams") or []
    fmt = data.get("format") or {}
    return [s for s in streams if isinstance(s, dict)], fmt


def _describe_streams(streams: Iterable[dict[str, Any]]) -> dict[str, Any]:
    info = {
        "has_video": False,
        "has_audio": False,
        "v_codec": "",
        "a_codec": "",
        "v_resolution": "",
        "stream_count": 0,
    }
    for stream in streams:
        kind = (stream.get("codec_type") or "").lower()
        codec = (stream.get("codec_name") or "").lower()
        info["stream_count"] += 1
        if kind == "video" and not info["has_video"]:
            info["has_video"] = True
            info["v_codec"] = codec
            width = stream.get("width") or 0
            height = stream.get("height") or 0
            if width and height:
                info["v_resolution"] = f"{width}x{height}"
        elif kind == "audio" and not info["has_audio"]:
            info["a_codec"] = codec
            info["has_audio"] = True
    return info


def _tail_lines(text: str, limit: int = 400) -> str:
    """从后往前按「整行」截取 FFprobe/FFmpeg 的输出。

    直接切尾部字符会把报错拦腰截断（曾经留下过 ", skipping" 这种看不出所以然的记录），
    按行截就能保证最后一条完整错误一定在。
    """
    kept: list[str] = []
    total = 0
    for line in reversed((text or "").splitlines()):
        if kept and total + len(line) > limit:
            break
        kept.append(line)
        total += len(line) + 1
    return "\n".join(reversed(kept)).strip()[:limit]


def _classify_failure(
    *,
    timed_out: bool,
    stderr: str,
    proxy_status: int | None,
    dial_failures: int,
    origin_responded: bool,
    rc: int | None,
    dial_error: str = "",
    segment_test: str = "none",
    segment_error: int | None = None,
    segment_requests: int = 0,
) -> tuple[str, str]:
    """把一次失败的探测归到一个明确的状态。"""
    # 检测工具本身起不来（镜像里没带 ffmpeg，或 FFMPEG_PATH/FFPROBE_PATH 配错）：
    # 这时每个频道都会变成「未能识别出任何流」，看着像所有源都挂了，必须单独给状态。
    if rc is None and "无法启动" in (stderr or ""):
        return "engine_missing", (stderr or "").strip().splitlines()[0][:160]
    # 源站从没回过响应头，而代理自己回了 502 —— 这是连接层失败，不是 HTTP 错误
    if dial_failures and not origin_responded:
        return "connect_failed", (dial_error or "无法与源站建立连接")[:160]
    status = proxy_status if origin_responded else None
    if status is not None and status >= 400:
        return "http_error", f"源站返回 HTTP {status}"
    # 被测地址自己是好的，stderr 里的错码得先分清是「源站报错」还是「某个分片没取到」
    code_from_stderr = _http_status_from_text(stderr) if origin_responded else None
    if code_from_stderr is not None and code_from_stderr >= 400:
        # 个别分片丢了是 HLS 直播的正常现象（切片边界、临时抖动），不扣 HTTP 错误的帽子
        if segment_test in ("partial", "ok"):
            pass
        elif segment_test == "failed":
            return "http_error", _segment_death_reason(segment_error, segment_requests)
        else:
            return "http_error", f"源站返回 HTTP {code_from_stderr}"
    # 播放列表 200、但列出来的分片一个都没取到：内容确实是空的，按「取不到流」处理，
    # 原因说清楚，不要写成「源站返回 HTTP 404」这种让人以为源挂了的说法
    if segment_test == "failed":
        return "http_error", _segment_death_reason(segment_error, segment_requests)
    if timed_out:
        return "timeout", "在超时时间内没有取到有效数据"
    if _CONNECT_RE.search(stderr or ""):
        tail = (stderr or "").strip().splitlines()[-1][:120] if stderr else ""
        return "connect_failed", tail or "连接失败"
    if _INVALID_DATA_RE.search(stderr or ""):
        return "parse_failed", "有响应但内容不是可识别的音视频流"
    if _TIMEOUT_RE.search(stderr or ""):
        tail = (stderr or "").strip().splitlines()[-1][:120] if stderr else ""
        return "timeout", tail or "超时"
    if rc not in (None, 0):
        tail = (stderr or "").strip().splitlines()[-1][:160] if stderr else f"ffprobe 退出码 {rc}"
        return "parse_failed", tail or "FFprobe 未能解析该地址"
    return "parse_failed", "未能识别出任何流"


def _segment_death_reason(segment_error: int | None, segment_requests: int) -> str:
    code = f" HTTP {segment_error}" if segment_error else ""
    return (
        f"播放列表本身能读，但里面 {segment_requests or '所有'} 个分片一个都没取到{code}，"
        "等于没有内容可播"
    )[:160]


def _hls_validity(url: str, proxy: ForcedProxy, format_name: str) -> bool | None:
    """这个地址是不是「播放器认得 HLS 播放列表」：是→True/False，非 HLS 地址→None。

    只看播放列表这一层（HTTP 状态 + 正文开头有没有 #EXTM3U + ffprobe 认出的容器名），
    分片取不取得到不在这里判，那属于 segment_test。
    """
    path = (urlsplit(url).path or "").lower()
    ctype = (proxy.content_type or "").lower()
    fmt = (format_name or "").lower()
    looks_hls = path.endswith(".m3u8") or "mpegurl" in ctype or "hls" in fmt
    if not looks_hls:
        return None
    if proxy.tunnel_established and not proxy.origin_responded:
        return None  # HTTPS 隧道里看不见状态码和正文，不下结论
    if proxy.body_kind == "html":
        return False  # 200 但给回来的是网页，播放器打不开
    status = proxy.http_status
    if status is None or status >= 400:
        return False
    if proxy.body_kind == "hls" or "hls" in fmt:
        return True
    return "mpegurl" in ctype


def _parse_hls_segments(playlist_text: str, base_url: str) -> list[str]:
    """从 M3U8 播放列表文本里提取分片 URL（只取 .ts/.m4s 媒体段）。"""
    segments: list[str] = []
    for line in playlist_text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        # 跳过嵌套播放列表（以 .m3u8 结尾的是子列表，不是媒体段）
        if line.lower().endswith(".m3u8"):
            continue
        if any(line.lower().endswith(ext) for ext in (".ts", ".m4s", ".mp4")):
            segments.append(urljoin(base_url, line))
    return segments


async def _probe_hls_segments(
    cfg: dict[str, Any],
    proxy_url: str,
    segment_urls: list[str],
    group: ProcessGroup,
    max_samples: int = 3,
) -> dict[str, Any]:
    """对 HLS 分片做采样 ffprobe，返回合并后的流信息。

    只要有一个分片有视频流就算「有视频」，避免第一个分片恰好无视频的误判。
    """
    merged_info: dict[str, Any] = {
        "has_video": False,
        "has_audio": False,
        "v_codec": "",
        "a_codec": "",
        "v_resolution": "",
        "stream_count": 0,
    }
    samples = segment_urls[:max_samples]
    for seg_url in samples:
        timeout_us = int(cfg["timeout_seconds"] * 1_000_000)
        probe_cmd = [
            config.FFPROBE_PATH,
            "-hide_banner",
            "-loglevel", "error",
            "-print_format", "json",
            "-show_streams",
            "-user_agent", cfg["user_agent"],
            "-http_proxy", proxy_url,
            "-rw_timeout", str(timeout_us),
            "-analyzeduration", str(config.ANALYZE_DURATION_US),
            "-probesize", str(config.PROBE_SIZE_BYTES),
            "-i", seg_url,
        ]
        rc, stdout, stderr, elapsed, timed_out = await _run_process(probe_cmd, float(cfg["timeout_seconds"]) + 1.0, group)
        if group.cancelled:
            break
        streams, fmt = _streams_from_probe(stdout)
        info = _describe_streams(streams)
        # 合并：只要有一个分片有视频/音频就算有
        if info["has_video"]:
            merged_info["has_video"] = True
            if not merged_info["v_codec"]:
                merged_info["v_codec"] = info["v_codec"]
            if not merged_info["v_resolution"]:
                merged_info["v_resolution"] = info["v_resolution"]
        if info["has_audio"]:
            merged_info["has_audio"] = True
            if not merged_info["a_codec"]:
                merged_info["a_codec"] = info["a_codec"]
        merged_info["stream_count"] += info["stream_count"]
    return merged_info


def _probe_args(cfg: dict[str, Any], proxy_url: str, url: str) -> list[str]:
    timeout_us = int(cfg["timeout_seconds"] * 1_000_000)
    return [
        config.FFPROBE_PATH,
        "-hide_banner",
        "-loglevel", "warning",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        "-user_agent", cfg["user_agent"],
        "-http_proxy", proxy_url,
        "-rw_timeout", str(timeout_us),
        "-analyzeduration", str(config.ANALYZE_DURATION_US),
        "-probesize", str(config.PROBE_SIZE_BYTES),
        "-i", url,
    ]


def _speed_args(cfg: dict[str, Any], proxy_url: str, url: str) -> list[str]:
    timeout_us = int(cfg["timeout_seconds"] * 1_000_000)
    return [
        config.FFMPEG_PATH,
        "-hide_banner",
        "-loglevel", "error",
        "-user_agent", cfg["user_agent"],
        "-http_proxy", proxy_url,
        "-rw_timeout", str(timeout_us),
        "-analyzeduration", str(config.ANALYZE_DURATION_US),
        "-probesize", str(config.PROBE_SIZE_BYTES),
        "-i", url,
        "-map", "0:v:0?",
        "-map", "0:a:0?",
        "-c", "copy",
        "-f", "null",
        "-",
    ]


async def _measure_throughput(
    cfg: dict[str, Any], url: str, proxy_url: str, proxy: ForcedProxy, group: ProcessGroup
) -> tuple[float, float, int]:
    """返回 (速度KB/s, 本次窗口秒数, 本次窗口字节数)。

    秒数是「源站真正在吐数据」的那一段：ffmpeg 起进程、建连、发请求都发生在第一个字节
    之前，把它们算进分母会把快源测成慢源（本地小文件尤其明显），跨源择优就会挑错那条。
    """
    window = float(min(config.SPEED_SAMPLE_SECONDS, cfg["timeout_seconds"]))
    proxy.open_speed_window(window)
    _rc, _out, _err, _elapsed, _timed_out = await _run_process(
        _speed_args(cfg, proxy_url, url), window + 1.0, group
    )
    delta, span = proxy.close_speed_window()
    if delta <= 0:
        return 0.0, 0.0, 0
    # 整个文件一次读就到了（本地夹具）时秒数会小到没有统计意义，给分母兜个下限
    seconds = max(span, config.MIN_SAMPLE_SPAN_SECONDS)
    return delta / 1024.0 / seconds, seconds, delta


async def test_one_family(
    cfg: dict[str, Any],
    url: str,
    family: str,
    ip: str,
    group: ProcessGroup,
    resolver: Callable[..., Awaitable[tuple[list[str], list[str]]]] = dnsinfo.resolve,
) -> dict[str, Any]:
    """在指定协议族（指定 IP）上完成一次完整的两阶段检测。"""
    attempt: dict[str, Any] = {
        "family": family,
        "ip": ip,
        "status": "pending",
        "http_status": None,
        "connect_ms": None,
        "first_packet_ms": None,
        "elapsed_ms": None,
        "speed_kbps": None,
        "bytes_probed": 0,
        "has_video": False,
        "has_audio": False,
        "v_codec": "",
        "a_codec": "",
        "v_resolution": "",
        "format_name": "",
        "failure_reason": "",
        "error_detail": "",
        # 「源有效」和「测试失败」要分开记：下面这几个字段描述地址本身给了什么，
        # 和最后能不能播（playable）是两件事
        "final_url": "",
        "redirect_count": 0,
        "content_type": "",
        "hls_valid": None,
        "segment_test": "none",
        "playable": False,
        "test_error": "",
    }
    parts = urlsplit(url)
    host = parts.hostname or ""
    origin_host = host
    # 强制协议族 = 由代理按 ip 拨号；URL 本身保留域名，SNI/Host 才不会坏
    proxy = ForcedProxy(
        family=family,
        target_ip=ip,
        origin_host=origin_host,
        connect_timeout=max(2.0, min(cfg["timeout_seconds"], 6.0)),
        resolver=resolver,
    )
    try:
        await proxy.start()
    except OSError as exc:
        attempt["status"] = "connect_failed"
        attempt["failure_reason"] = f"本地代理启动失败：{exc}"
        return attempt

    wall = float(cfg["timeout_seconds"]) + 1.0
    try:
        proxy_url = proxy.proxy_url
        started = time.monotonic()

        # —— HLS 播放列表级检测：先解析播放列表，采样分片 ffprobe ——
        is_hls = (url.lower().endswith(".m3u8") or
                  "mpegurl" in (proxy.content_type or "").lower())
        hls_segment_info: dict[str, Any] | None = None
        if is_hls:
            # 用 urllib 通过代理获取完整播放列表（代理只负责协议族强制，不拦截这个 GET）
            import urllib.request
            req = urllib.request.Request(url)
            req.add_header("User-Agent", cfg["user_agent"])
            req.set_proxy(proxy_url.replace("http://", ""), "http")
            try:
                resp = urllib.request.urlopen(req, timeout=float(cfg["timeout_seconds"]))
                playlist_text = resp.read(65536).decode("utf-8", errors="replace")
                segments = _parse_hls_segments(playlist_text, url)
                if len(segments) >= 2:
                    random.shuffle(segments)
                    hls_segment_info = await _probe_hls_segments(
                        cfg, proxy_url, segments, group, max_samples=3
                    )
            except Exception:
                pass  # 播放列表拿不到就跳过，回退到单 URL 检测

        rc, stdout, stderr, elapsed, timed_out = await _run_process(
            _probe_args(cfg, proxy_url, url), wall, group
        )
        if group.cancelled:
            attempt["status"] = "cancelled"
            attempt["failure_reason"] = "任务已取消"
            return attempt
        streams, fmt = _streams_from_probe(stdout)
        info = _describe_streams(streams)

        # —— HLS 分片采样结果合并：只要有一个分片有视频就算「有视频」——
        if hls_segment_info and not info["has_video"] and hls_segment_info["has_video"]:
            info["has_video"] = True
            info["v_codec"] = hls_segment_info["v_codec"] or info["v_codec"]
            info["v_resolution"] = hls_segment_info["v_resolution"] or info["v_resolution"]
            info["stream_count"] += hls_segment_info["stream_count"]

        attempt.update(info)
        attempt["format_name"] = str(fmt.get("format_name") or "")
        stderr_code = _http_status_from_text(stderr)
        attempt["http_status"] = proxy.http_status or (stderr_code if proxy.saw_origin else None)
        attempt["connect_ms"] = proxy.connect_ms
        attempt["first_packet_ms"] = proxy.first_byte_ms
        attempt["bytes_probed"] = proxy.bytes_down
        attempt["elapsed_ms"] = round(elapsed * 1000.0, 1)
        error_detail = (stderr or "").strip()

        if info["stream_count"] == 0:
            status, reason = _classify_failure(
                timed_out=timed_out,
                stderr=error_detail,
                proxy_status=attempt["http_status"],
                dial_failures=proxy.dial_failures,
                origin_responded=proxy.saw_origin,
                rc=rc,
                dial_error=proxy.last_dial_error,
                segment_test=proxy.segment_test,
                segment_error=proxy.segment_error,
                segment_requests=proxy.segment_requests,
            )
            attempt["status"] = status
            attempt["failure_reason"] = reason
            attempt["error_detail"] = _tail_lines(error_detail)
            return attempt

        if not info["has_video"] and not info["has_audio"]:
            attempt["status"] = "no_video"
            attempt["failure_reason"] = "FFprobe 解析出了流，但里面没有视频流（也没有音频流）"
            attempt["error_detail"] = _tail_lines(error_detail)
            return attempt

        # 结构有效，进入吞吐实测
        speed, seconds, delta = await _measure_throughput(cfg, url, proxy_url, proxy, group)
        attempt["speed_kbps"] = round(speed, 1)
        attempt["bytes_down"] = delta
        attempt["sample_seconds"] = round(seconds, 2)
        attempt["elapsed_ms"] = round((time.monotonic() - started) * 1000.0, 1)
        if group.cancelled:
            attempt["status"] = "cancelled"
            attempt["failure_reason"] = "任务已取消"
            return attempt

        min_speed = float(cfg["min_speed_kbps"])
        if delta <= 0:
            attempt["status"] = "timeout"
            attempt["failure_reason"] = "结构能解析，但采样窗口内源站没有再送出任何数据"
            return attempt
        if speed < min_speed:
            attempt["status"] = "slow"
            attempt["failure_reason"] = f"实测速度 {speed:.0f} KB/s 低于阈值 {min_speed:.0f} KB/s"
            return attempt
        if not info["has_video"]:
            attempt["status"] = "audio_only"
            attempt["failure_reason"] = ""
            return attempt
        if not info["has_audio"]:
            attempt["status"] = "no_audio"
            attempt["failure_reason"] = "有视频流但没有音频流"
            return attempt
        attempt["status"] = "ok"
        return attempt
    except ProxyError as exc:
        attempt["status"] = "connect_failed"
        attempt["failure_reason"] = str(exc)
        return attempt
    except asyncio.CancelledError:
        attempt["status"] = "cancelled"
        attempt["failure_reason"] = "任务已取消"
        raise
    finally:
        # 所有返回路径都在这里补齐「地址本身给了什么」这一层记录：
        # 跳转链、最终地址、内容类型、播放列表是否有效、分片验证结果
        attempt["redirect_count"] = proxy.redirect_hops
        attempt["final_url"] = proxy.final_url
        attempt["content_type"] = proxy.content_type
        attempt["segment_test"] = proxy.segment_test
        attempt["hls_valid"] = _hls_validity(url, proxy, str(attempt.get("format_name") or ""))
        attempt["playable"] = bool(attempt.get("status") in _PASSING)
        attempt["test_error"] = attempt.get("error_detail") or attempt.get("failure_reason") or ""
        await proxy.stop()


def _pick_winner(passed: list[dict[str, Any]]) -> dict[str, Any]:
    """两个协议族都可用时择优：速度优先，速度接近时看延迟。"""
    best = max(passed, key=lambda a: (float(a.get("speed_kbps") or 0),))
    fastest = float(best.get("speed_kbps") or 0)
    close = [a for a in passed if float(a.get("speed_kbps") or 0) >= fastest * 0.95]
    return min(close, key=lambda a: float(a.get("connect_ms") or 1e9) + float(a.get("first_packet_ms") or 1e9))


async def test_channel(
    cfg: dict[str, Any], channel: dict[str, Any], group: ProcessGroup
) -> dict[str, Any]:
    """对一个频道（URL）完成整轮检测，返回 attempts / winner / 最终状态。"""
    url = channel["url"]
    parts = urlsplit(url)
    scheme = (parts.scheme or "").lower()
    host = parts.hostname or ""
    result: dict[str, Any] = {
        "channel_id": channel.get("id"),
        "name": channel.get("name"),
        "url": url,
        "attempts": [],
        "winner": None,
        "status": "parse_failed",
        "failure_reason": "",
        "ipv4_addr": None,
        "ipv6_addr": None,
    }

    if scheme not in ("http", "https"):
        result["status"] = "unsupported"
        result["failure_reason"] = f"暂不检测 {scheme or '未知'} 协议（只支持 http/https 流）"
        return result

    v4, v6 = await dnsinfo.resolve(host, parts.port or (443 if scheme == "https" else 80))
    result["ipv4_addr"] = v4[0] if v4 else None
    result["ipv6_addr"] = v6[0] if v6 else None
    if not v4 and not v6:
        result["status"] = "connect_failed"
        result["failure_reason"] = f"域名 {host} 既没有 IPv4 也没有 IPv6 记录"
        return result

    families = dnsinfo.candidate_families(cfg["ip_prefer"], v4, v6)
    if not families:
        result["status"] = "connect_failed"
        result["failure_reason"] = f"{cfg['ip_prefer']} 策略下 {host} 没有可用地址"
        return result

    attempts: list[dict[str, Any]] = []
    passed: list[dict[str, Any]] = []
    for candidate in families:
        attempt = await test_one_family(cfg, url, candidate["family"], candidate["ip"], group)
        attempts.append(attempt)
        if attempt["status"] in ("ok", "audio_only"):
            passed.append(attempt)
            if dnsinfo.short_circuit_after_first_ok(cfg["ip_prefer"]):
                break
        if group.cancelled:
            break

    result["attempts"] = attempts
    if passed:
        winner = _pick_winner(passed)
        result["winner"] = winner
        result["status"] = winner["status"]
        result["failure_reason"] = ""
        return result

    if group.cancelled:
        result["status"] = "cancelled"
        result["failure_reason"] = "任务已取消"
        return result

    # 全部失败：挑一个最有诊断价值的状态
    statuses = [a["status"] for a in attempts if a["status"] != "cancelled"]
    ordered = sorted(statuses, key=lambda s: _STATUS_PRIORITY.index(s) if s in _STATUS_PRIORITY else 99)
    chosen = ordered[0] if ordered else "parse_failed"
    detail = next((a for a in attempts if a["status"] == chosen), attempts[-1])
    result["status"] = chosen
    result["failure_reason"] = detail.get("failure_reason") or "检测未通过"
    result["elapsed_ms"] = detail.get("elapsed_ms")
    result["error_detail"] = detail.get("error_detail", "")
    return result


_MAX_SOURCE_BYTES = 40 * 1024 * 1024


def _http_get_via_proxy(url: str, proxy_url: str, user_agent: str, timeout: float) -> tuple[int, bytes]:
    """在普通线程里跑的订阅文件下载：经本地代理，HTTPS 仍由 urllib 直接做 TLS，
    SNI 与证书校验都不受影响（代理只搬运字节）。
    """
    import urllib.error
    import urllib.request

    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url})
    )
    request = urllib.request.Request(url, headers={"User-Agent": user_agent})
    try:
        with opener.open(request, timeout=timeout) as response:
            status = int(getattr(response, "status", 200) or 200)
            data = response.read(_MAX_SOURCE_BYTES)
            return status, data
    except urllib.error.HTTPError as exc:
        return int(exc.code or 0), exc.read(_MAX_SOURCE_BYTES) if exc.fp else b""
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        reason = getattr(exc, "reason", exc)
        raise ProxyError(f"下载失败：{reason}") from exc


async def download_source(cfg: dict[str, Any], url: str) -> tuple[bytes | None, str, int | None]:
    """下载一个订阅文件，按 IPv4/IPv6 策略逐个试。

    返回 (内容, 错误说明, HTTP状态)。失败时内容为 None —— 调用方必须保留上一次成功的列表。
    多源场景下每个源单独调用，一个源挂了不影响其它源的下载结果。
    """
    url = (url or "").strip()
    parts = urlsplit(url)
    host = parts.hostname or ""
    scheme = (parts.scheme or "").lower()
    if not host or scheme not in ("http", "https"):
        return None, "源地址不合法（必须是 http/https 的完整地址）", None
    v4, v6 = await dnsinfo.resolve(host, parts.port or (443 if scheme == "https" else 80))
    families = dnsinfo.candidate_families(cfg["ip_prefer"], v4, v6) or [
        {"family": "ipv4", "ip": host}
    ]
    last_error = ""
    last_status: int | None = None
    for candidate in families:
        proxy = ForcedProxy(
            family=candidate["family"],
            target_ip=candidate["ip"],
            origin_host=host,
            connect_timeout=8.0,
            resolver=dnsinfo.resolve,
        )
        try:
            await proxy.start()
        except OSError as exc:
            last_error = f"本地代理启动失败：{exc}"
            continue
        try:
            status, data = await asyncio.to_thread(
                _http_get_via_proxy,
                url,
                proxy.proxy_url,
                cfg["user_agent"],
                float(cfg["timeout_seconds"]) + 20.0,
            )
            last_status = status or proxy.http_status
            if status and status >= 400:
                last_error = f"源站返回 HTTP {status}"
                continue
            if not data:
                last_error = "订阅文件为空"
                continue
            return data, "", last_status
        except ProxyError as exc:
            last_error = str(exc) or proxy.last_dial_error
        except asyncio.CancelledError:
            raise
        finally:
            await proxy.stop()
    return None, last_error or "下载订阅文件失败", last_status


async def check_tools() -> tuple[bool, str]:
    """启动体检：确认 ffmpeg / ffprobe 真的能执行。

    只看文件在不在不够——镜像里少装一个、FFMPEG_PATH 指错、二进制和架构不匹配，
    都会让每一个频道变成「解析失败」，看起来像所有源都挂了，其实是检测工具没跑起来。
    各执行一次 -version，不到半秒，能把「工具问题」和「源问题」彻底分开。
    """
    group = ProcessGroup()
    problems: list[str] = []
    for path, kind in ((config.FFPROBE_PATH, "ffprobe"), (config.FFMPEG_PATH, "ffmpeg")):
        rc, _out, err, _elapsed, timed_out = await _run_process([path, "-version"], 10.0, group)
        tail = (err or "").strip().splitlines()
        last = tail[-1] if tail else ""
        # _run_process 已经把「无法启动 <路径>：」写在前面了，这里别再重复一遍路径
        detail = last.split("：", 1)[1] if last.startswith("无法启动 ") and "：" in last else last
        if rc is None:
            problems.append(f"{kind}（{path}）无法执行：{detail or '找不到可执行文件'}")
        elif timed_out:
            problems.append(f"{kind}（{path}）执行超时")
        elif rc != 0:
            problems.append(f"{kind}（{path}）退出码 {rc}：{detail[:120]}")
    return (not problems), "；".join(problems)


def format_ok_line(channel_name: str, attempt: dict[str, Any]) -> str:
    """[OK] CCTV-5 IPv4 82ms 8.6MB/s h264/aac  这样的日志行。"""
    speed = float(attempt.get("speed_kbps") or 0) / 1024.0
    family = {"ipv4": "IPv4", "ipv6": "IPv6"}.get(str(attempt.get("family") or ""), "-")
    return (
        f"{channel_name} {family} "
        f"{int(attempt.get('first_packet_ms') or 0)}ms {speed:.1f}MB/s "
        f"{attempt.get('v_codec') or '-'}/{attempt.get('a_codec') or '-'}"
    )


def summarize(attempts: list[dict[str, Any]]) -> str:
    return " | ".join(
        f"{a['family']}:{a['status']}"
        + (f"({a['failure_reason']})" if a.get("failure_reason") else "")
        for a in attempts
    )


def status_label(status: str) -> str:
    from . import statuses as S

    return S.label(status)
