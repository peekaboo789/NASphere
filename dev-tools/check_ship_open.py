"""出厂副本一开箱就要满足的东西：鉴权、MIME、空库形状。全部写成可核对的断言。"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

BASE = "http://127.0.0.1:9001"
USER = "admin:test-pass"
ARTIFACTS = ["/iptv.m3u", "/iptv_all.m3u", "/iptv_ipv4.m3u", "/iptv_ipv6.m3u", "/results.csv"]

checks: list[tuple[str, bool, str]] = []


def add(name: str, ok: bool, detail: str = "") -> None:
    checks.append((name, bool(ok), detail))


def status(path: str, user: str | None = None) -> tuple[int, dict[str, str], str]:
    cmd = ["curl", "-s", "-D", "-", "-o", "-"]
    if user:
        cmd += ["-u", user]
    cmd.append(BASE + path)
    out = subprocess.run(cmd, capture_output=True).stdout
    text = out.decode("utf-8", "replace").replace("\r\n", "\n")
    head, _, body = text.partition("\n\n")
    lines = head.split("\n")
    code = int(lines[0].split(" ")[1]) if len(lines) > 1 and lines[0].startswith("HTTP") else 0
    headers = {}
    for ln in lines[1:]:
        if ":" in ln:
            k, _, v = ln.partition(":")
            headers[k.strip().lower()] = v.strip()
    return code, headers, body


def main() -> int:
    global BASE, USER
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--base", default="http://127.0.0.1:9001")
    ap.add_argument("--user", default="admin:test-pass", help="ADMIN_USER:ADMIN_PASSWORD")
    ap.add_argument("--out", default="D:/tmp/ship_open.txt")
    args = ap.parse_args()
    BASE = args.base
    USER = args.user

    # —— 鉴权：管理页与 API 要密码，产物与探针不要 ——
    code, _, _ = status("/healthz")
    add("/healthz 匿名 200", code == 200, f"code={code}")
    code, _, _ = status("/")
    add("/ 无密码 401", code == 401, f"code={code}")
    code, _, _ = status("/", USER)
    add(f"/ 带密码 200（{USER}）", code == 200, f"code={code}")
    code, _, _ = status("/", "admin:wrong")
    add("/ 错密码 401", code == 401, f"code={code}")
    code, _, _ = status("/api/status")
    add("/api/status 匿名 401", code == 401, f"code={code}")
    code, _, _ = status("/api/status", USER)
    add("/api/status 带密码 200", code == 200, f"code={code}")

    # —— 产物：匿名可取 + text/plain ——
    for path in ARTIFACTS:
        code, hd, _ = status(path)
        want = "text/csv; charset=utf-8" if path.endswith(".csv") else "text/plain; charset=utf-8"
        add(
            f"{path} 匿名 200 且 Content-Type={want}",
            code == 200 and hd.get("content-type") == want,
            f"code={code} content-type={hd.get('content-type')}",
        )
    code, hd, empty = status("/iptv.m3u")
    add("空库时 /iptv.m3u 带 x-iptv-status: not-ready", hd.get("x-iptv-status") == "not-ready",
        f"x-iptv-status={hd.get('x-iptv-status')}")
    add("空库时 /iptv.m3u 是合法空列表", "#EXTM3U" in empty and "#EXTINF" not in empty,
        f"正文 {len(empty.splitlines())} 行")

    # —— 状态接口：等配置、无引擎错误、没有历史产物 ——
    code, _, body = status("/api/status", USER)
    st = json.loads(body) if code == 200 else {}
    add("scheduler.waiting_for_source=true", st["scheduler"]["waiting_for_source"] is True,
        json.dumps(st["scheduler"], ensure_ascii=False))
    add("state.engine_error 为空（工具就绪）", st["state"].get("engine_error") == "",
        repr(st["state"].get("engine_error")))
    outs = st.get("outputs") or []
    add("output/ 里一个产物都没有", bool(outs) and all(not o.get("exists") for o in outs),
        json.dumps(outs, ensure_ascii=False))

    bad = [c for c in checks if not c[1]]
    lines = [f"# 出厂副本开箱检查 {BASE}（{time.strftime('%F %T')}）"]
    for name, ok, detail in checks:
        lines.append(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f"  —— {detail}" if detail else ""))
    lines.append("")
    lines.append(f"合计 {len(checks) - len(bad)}/{len(checks)} 条通过")
    Path(args.out).write_text("\n".join(lines), encoding="utf-8")
    print(f"written {args.out}  ({len(checks) - len(bad)}/{len(checks)} passed)")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
