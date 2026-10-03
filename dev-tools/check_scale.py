"""规模与资源上限压测：几千个 URL 时并发子进程数、内存、进度和产物体积。

只在开发机上跑（不进镜像）。需要 dev-tools/fake_origin_server.py 已在 8099/8100 上，
并且先用 dev-tools/make_big_source.py 生成 --out dev-tools/www/stress.m3u 的大列表。

用法：
  python dev-tools/check_scale.py --base http://127.0.0.1:9001 -u admin:test-pass \
      --source http://127.0.0.1:8099/stress.m3u --concurrency 30
"""

from __future__ import annotations

import argparse
import base64
import json
import subprocess
import sys
import time


def call(method: str, base: str, token: str, path: str, body: dict | None = None) -> dict:
    cmd = ["curl", "-s", "-X", method, "-H", f"Authorization: Basic {token}"]
    if body is not None:
        cmd += ["-H", "Content-Type: application/json", "-d", json.dumps(body, ensure_ascii=False)]
    cmd.append(base + path)
    out = subprocess.run(cmd, capture_output=True).stdout.decode("utf-8", "replace")
    try:
        return json.loads(out)
    except ValueError:
        return {"raw": out[:300]}


def listener_pid(port: int) -> str:
    out = subprocess.run(["netstat", "-ano"], capture_output=True).stdout.decode("utf-8", "replace")
    for line in out.splitlines():
        if f":{port} " in line and "LISTENING" in line:
            return line.split()[-1]
    return ""


def count_processes(image: str) -> int:
    out = subprocess.run(
        ["tasklist", "/FI", f"IMAGENAME eq {image}", "/NH", "/FO", "CSV"],
        capture_output=True,
    ).stdout.decode("utf-8", "replace")
    return sum(1 for line in out.splitlines() if f'"{image}"' in line.lower() or image.lower() in line.lower())


def working_set_mb(pid: str) -> float:
    if not pid:
        return 0.0
    out = subprocess.run(
        ["tasklist", "/FI", f"PID eq {pid}", "/NH", "/FO", "CSV"],
        capture_output=True,
    ).stdout.decode("utf-8", "replace")
    for line in out.splitlines():
        parts = line.strip('"').split('","')
        if len(parts) >= 5:
            digits = "".join(ch for ch in parts[-1] if ch.isdigit())
            return int(digits or 0) / 1024.0
    return 0.0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:9001")
    parser.add_argument("--user", default="admin:test-pass")
    parser.add_argument("--port", type=int, default=9001)
    parser.add_argument("--source", default="http://127.0.0.1:8099/stress.m3u")
    parser.add_argument("--concurrency", type=int, default=30)
    parser.add_argument("--out", default="D:/tmp/ff/scale.txt")
    args = parser.parse_args()
    token = base64.b64encode(args.user.encode()).decode()
    base, tok = args.base, token

    cfg = call("GET", base, tok, "/api/config")["config"]
    lines: list[str] = []

    # 先等上一轮彻底结束，再改源地址（改源地址会自动开跑一轮，这正是要测的那一轮）
    for _ in range(60):
        if not call("GET", base, tok, "/api/status")["state"].get("running"):
            break
        time.sleep(2)

    patch = dict(cfg, source_urls=args.source, concurrency=args.concurrency, update_interval_minutes=30)
    saved = call("POST", base, tok, "/api/config", patch)
    if not saved.get("ok"):
        print(json.dumps(saved, ensure_ascii=False))
        return 1
    pid = listener_pid(args.port)
    lines.append(f"服务进程 PID={pid}，源={args.source}，配置并发={args.concurrency}")

    t0 = time.time()
    peak_children = 0
    peak_rss = 0.0
    max_done = 0
    samples: list[str] = []
    seen_running = False
    while time.time() - t0 < 1800:
        state = call("GET", base, tok, "/api/status").get("state", {})
        if state.get("running"):
            seen_running = True
        children = count_processes("ffprobe.exe") + count_processes("ffmpeg.exe")
        rss = working_set_mb(pid)
        peak_children = max(peak_children, children)
        peak_rss = max(peak_rss, rss)
        max_done = max(max_done, int(state.get("done") or 0))
        if int(time.time() - t0) % 10 < 2:
            samples.append(
                "  t+%3ds done=%s/%s ok=%s fail=%s 子进程=%d RSS=%.0fMB"
                % (
                    int(time.time() - t0),
                    state.get("done"),
                    state.get("total"),
                    state.get("ok"),
                    state.get("failed"),
                    children,
                    rss,
                )
            )
        if not state.get("running"):
            if seen_running and (state.get("done") or 0) > 0:
                break
            if time.time() - t0 > 60:
                lines.append("60 秒内没等到任务，异常退出")
                break
        time.sleep(1.5)
    elapsed = time.time() - t0

    status = call("GET", base, tok, "/api/status")
    stats = status["stats"]
    run = status["latest_run"]
    lines.append(
        "本轮：total=%s tested=%s ok=%s failed=%s 耗时=%.1fs 实测吞吐=%.1f URL/s"
        % (run.get("total"), run.get("tested"), run.get("ok"), run.get("failed"), elapsed,
           (run.get("tested") or 0) / max(1.0, elapsed))
    )
    lines.append(f"峰值：同时存活的 ffprobe/ffmpeg 子进程={peak_children}（配置并发={args.concurrency}），服务进程峰值 RSS={peak_rss:.0f} MB")
    lines.append(
        f"数据库：URL 总数={stats['total']} 有效={stats['ok']} 失效={stats['bad']} "
        f"IPv4/IPv6={stats['via_ipv4']}/{stats['via_ipv6']} 成功率={stats['success_rate']}%"
    )
    lines.append("产物：" + json.dumps(status["outputs"], ensure_ascii=False))
    lines.append(f"进度采样最多到 done={max_done}")
    lines.extend(samples[-14:])

    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    print(f"written {args.out}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
