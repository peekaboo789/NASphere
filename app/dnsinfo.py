"""DNS 解析：拿到目标域名的 IPv4 / IPv6 地址列表，带 TTL 缓存。"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
import time
from typing import Any

_CACHE: dict[str, tuple[float, list[str], list[str]]] = {}
_CACHE_TTL = 600.0
_CACHE_MAX = 2048


def _classify(addr: str) -> str:
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return ""
    return "ipv6" if ip.version == 6 else "ipv4"


async def resolve(host: str, port: int = 80) -> tuple[list[str], list[str]]:
    """返回 (ipv4列表, ipv6列表)。解析失败返回 ([], [])。"""
    now = time.monotonic()
    cached = _CACHE.get(host)
    if cached and cached[0] > now:
        return cached[1], cached[2]

    loop = asyncio.get_running_loop()
    v4: list[str] = []
    v6: list[str] = []
    try:
        infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except (socket.gaierror, OSError, UnicodeError):
        infos = []

    for info in infos:
        addr = str(info[4][0])
        kind = _classify(addr)
        if kind == "ipv4" and addr not in v4:
            v4.append(addr)
        elif kind == "ipv6" and addr not in v6:
            v6.append(addr.split("%")[0])

    if len(_CACHE) > _CACHE_MAX:
        _CACHE.clear()
    _CACHE[host] = (now + _CACHE_TTL, v4, v6)
    return v4, v6


def clear_cache() -> None:
    _CACHE.clear()


def candidate_families(prefer: str, v4: list[str], v6: list[str]) -> list[dict[str, Any]]:
    """按 IPv4/IPv6 策略决定要实际测哪些协议族，以及每个协议族用哪个地址。

    返回 [{"family": "ipv4", "ip": "1.2.3.4"}, ...]，顺序即尝试顺序。
    """
    out: list[dict[str, Any]] = []
    if prefer == "ipv4_only":
        if v4:
            out.append({"family": "ipv4", "ip": v4[0]})
        return out
    if prefer == "ipv6_only":
        if v6:
            out.append({"family": "ipv6", "ip": v6[0]})
        return out
    if prefer == "ipv4_preferred":
        if v4:
            out.append({"family": "ipv4", "ip": v4[0]})
        if v6:
            out.append({"family": "ipv6", "ip": v6[0]})
        return out
    if prefer == "ipv6_preferred":
        if v6:
            out.append({"family": "ipv6", "ip": v6[0]})
        if v4:
            out.append({"family": "ipv4", "ip": v4[0]})
        return out
    # auto：两个协议族都实测，之后按速度/延迟择优
    if v4:
        out.append({"family": "ipv4", "ip": v4[0]})
    if v6:
        out.append({"family": "ipv6", "ip": v6[0]})
    return out


def short_circuit_after_first_ok(prefer: str) -> bool:
    """优先模式下第一个可用即结束；auto 模式需要两个协议族都测才好择优。"""
    return prefer in ("ipv4_preferred", "ipv6_preferred", "ipv4_only", "ipv6_only")
