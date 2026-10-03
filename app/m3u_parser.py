"""M3U / M3U8 / TXT 订阅解析。

目标：解析出频道元数据 + 播放地址，并原样保留元数据，生成列表时不丢信息。

支持的输入形态：
1. 标准 M3U/M3U8
   #EXTM3U
   #EXTINF:-1 tvg-id="CCTV1" tvg-name="CCTV-1" tvg-logo="http://x/1.png" group-title="央视",CCTV-1
   https://example.com/live/cctv1.m3u8
   #EXTGRP / #EXTVLCOPT / #EXTKODIPROP / #KODIPROP / #EXTHTTP 等指令原样保留
2. TXT（运营商常见格式）
   CCTV-1,http://example.com/1.m3u8
   CCTV-1#!/http://example.com/1.m3u8
   CCTV-1#http://example.com/1.m3u8
3. 逐行只有 URL 的裸列表（用 URL 尾巴当频道名）
"""

from __future__ import annotations

import hashlib
import re
from urllib.parse import unquote, urlsplit

# 播放地址支持的协议；不是这些协议的行会被当作注释丢弃
_STREAM_SCHEMES = ("http://", "https://", "rtmp://", "rtsp://", "udp://", "rtp://", "srt://")

# 需要原样保留、并写回输出的扩展指令前缀
_PRESERVED_DIRECTIVES = (
    "#EXTGRP",
    "#EXTVLCOPT",
    "#EXTKODIPROP",
    "#KODIPROP",
    "#EXTHTTP",
    "#EXTBINOCON",
    "#EXT-X-Playlist",
    "#EXT-X-SESSION-DATA",
)

_ATTR_RE = re.compile(r'([A-Za-z][A-Za-z0-9_-]*)="([^"]*)"')
# 名字取最后一个逗号之后的内容，属性值里的逗号不会被切错
_EXTINF_RE = re.compile(r"^#EXTINF\s*:\s*(?P<head>.*?),(?P<name>[^,]*)$", re.I | re.S)
_EXTINF_NO_COMMA_RE = re.compile(r"^#EXTINF\s*:\s*(?P<head>.*)$", re.I | re.S)
_SCHEME_RE = re.compile(r"(?:https?|rtmp|rtsp|udp|rtp|srt)://", re.I)


def normalize_url(url: str) -> str:
    """去重键用的规范化地址：仅去空白，大小写/查询串保持原样（IPTV 的 token 区分大小写）。"""
    return url.strip()


def url_hash(url: str) -> str:
    return hashlib.sha1(normalize_url(url).encode("utf-8", "ignore")).hexdigest()


def detect_protocol(url: str) -> str:
    try:
        return urlsplit(url).scheme.lower()
    except ValueError:
        return ""


def _looks_like_url(token: str) -> bool:
    token = token.strip()
    return any(token.lower().startswith(s) for s in _STREAM_SCHEMES)


def _fallback_name(url: str) -> str:
    """没有频道名时，用路径尾巴（去掉扩展名）当名字。"""
    path = urlsplit(url).path
    tail = unquote(path.rstrip("/").rsplit("/", 1)[-1])
    tail = re.sub(r"\.(m3u8|ts|mp4|flv|mkv|mpd|sdp)$", "", tail, flags=re.I)
    return tail or url[:40]


def _parse_attrs(raw: str) -> dict[str, str]:
    return {k.lower(): v for k, v in _ATTR_RE.findall(raw)}


def decode_bytes(data: bytes) -> str:
    """订阅地址可能是 UTF-8 也可能是 GBK，逐个尝试。"""
    for enc in ("utf-8-sig", "utf-8", "gbk", "gb18030", "big5", "latin-1"):
        try:
            return data.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return data.decode("utf-8", "replace")


def _clean_name(name: str) -> str:
    return name.strip().strip("\ufeff").strip()


def parse(text: str) -> tuple[list[dict], list[str]]:
    """解析订阅内容。

    返回 (entries, warnings)；entries 每项包含
      url / url_hash / name / tvg_id / tvg_name / group_title / logo /
      attrs / extra_lines / protocol
    """
    entries: list[dict] = []
    warnings: list[str] = []
    seen_hashes: set[str] = set()

    pending_attrs: dict[str, str] = {}
    pending_name = ""
    pending_extras: list[str] = []
    pending_duration = "-1"
    line_no = 0

    def flush(url: str) -> None:
        nonlocal pending_attrs, pending_name, pending_extras
        h = url_hash(url)
        if h in seen_hashes:
            warnings.append(f"第 {line_no} 行：URL 重复，已忽略")
            return
        seen_hashes.add(h)
        name = _clean_name(pending_name) or _fallback_name(url)
        logo = pending_attrs.get("tvg-logo") or pending_attrs.get("logo") or ""
        group = pending_attrs.get("group-title") or pending_attrs.get("group") or ""
        if not group and pending_extras:
            for extra in pending_extras:
                if extra.lower().startswith("#extgrp"):
                    group = extra.split(":", 1)[-1].strip()
                    break
        entries.append(
            {
                "url": normalize_url(url),
                "url_hash": h,
                "name": name,
                "tvg_id": pending_attrs.get("tvg-id") or "",
                "tvg_name": pending_attrs.get("tvg-name") or "",
                "group_title": group,
                "logo": logo,
                "duration": pending_duration or "-1",
                "attrs": dict(pending_attrs),
                "extra_lines": list(pending_extras),
                "protocol": detect_protocol(url),
            }
        )
        pending_attrs = {}
        pending_name = ""
        pending_extras = []

    for raw_line in text.splitlines():
        line_no += 1
        line = raw_line.strip().strip("\ufeff")
        if not line:
            continue

        if line.lower().startswith("#extinf"):
            match = _EXTINF_RE.match(line)
            if match:
                head = match.group("head") or ""
                name_part = (match.group("name") or "").strip()
            else:
                fallback = _EXTINF_NO_COMMA_RE.match(line)
                if not fallback:
                    warnings.append(f"第 {line_no} 行：#EXTINF 格式无法识别")
                    continue
                head = fallback.group("head") or ""
                name_part = ""
            pending_attrs = _parse_attrs(head)
            residual = re.sub(r'\s*[A-Za-z][A-Za-z0-9_-]*="[^"]*"', " ", head).strip()
            tokens = residual.split(None, 1)
            pending_duration = (tokens[0] if tokens else "-1") or "-1"
            inline_name = tokens[1] if len(tokens) > 1 else ""
            pending_name = _clean_name(name_part or inline_name)
            continue

        if any(line.upper().startswith(d.upper()) for d in _PRESERVED_DIRECTIVES):
            pending_extras.append(line)
            continue

        if line.startswith("#"):
            # 未知注释（#EXTM3U、#EXT-X-*、说明文字）忽略，输出时统一重写头部
            continue

        if _looks_like_url(line):
            flush(line)
            continue

        # TXT / 变体格式：名字与地址写成 "CCTV-1,http://..." 或 "CCTV-1#!/http://..."
        marker = _SCHEME_RE.search(line)
        if marker and marker.start() > 0:
            label = line[: marker.start()].rstrip("#!/, \t")
            url_part = normalize_url(line[marker.start() :])
            if _looks_like_url(url_part):
                group_from_label = ""
                if "," in label:
                    head, tail = label.rsplit(",", 1)
                    group_from_label, label = _clean_name(head), _clean_name(tail)
                pending_name = _clean_name(label) or _fallback_name(url_part)
                if group_from_label:
                    pending_attrs = {**pending_attrs, "group-title": group_from_label}
                flush(url_part)
                continue

        warnings.append(f"第 {line_no} 行：不是可识别的播放地址，已跳过：{line[:60]}")

    if pending_attrs or pending_name or pending_extras:
        warnings.append("文件末尾存在没有配到播放地址的 #EXTINF，已忽略")
    return entries, warnings
