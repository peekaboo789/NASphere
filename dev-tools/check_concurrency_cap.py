"""并发上限的真实判据：同一份源，只改并发数，看系统里同时存活的 ffprobe/ffmpeg 峰值会不会跟着上限走。

期望：上限 5 时峰值 ≪ 上限 30 时峰值，且两者都 ≪ URL 总数。
若峰值只由 URL 数量决定（说明上限没生效），这两行的峰值会差不多大。

用法：
  python dev-tools/check_concurrency_cap.py --source http://127.0.0.1:8099/big.m3u \
      --caps 5,30 --out D:/tmp/ff/cap.txt
"""

from __future__ import annotations

import argparse
import base64
import json
import subprocess
import sys
import threading
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


class ChildCounter:
    """后台线程高频统计系统里 ffprobe/ffmpeg 的存活数，取峰值。"""

    def __init__(self) -> None:
        self.stop = threading.Event()
        self.peak = 0
        self.samples = 0
        self.thread = threading.Thread(target=self._loop, daemon=True)

    def _count(self) -> int:
        out = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq ffprobe.exe", "/NH", "/FO", "CSV", "/FI", "STATUS eq RUNNING"],
            capture_output=True,
        ).stdout.decode("utf-8", "replace")
        n = sum(1 for line in out.splitlines() if "ffprobe.exe" in line.lower())
        out2 = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq ffmpeg.exe", "/NH", "/FO", "CSV"],
            capture_output=True,
        ).stdout.decode("utf-8", "replace")
        n += sum(1 for line in out2.splitlines() if "ffmpeg.exe" in line.lower())
        return n

    def _loop(self) -> None:
        while not self.stop.is_set():
            n = self._count()
            self.peak = max(self.peak, n)
            self.samples += 1
            time.sleep(0.05)

    def __enter__(self) -> "ChildCounter":
        self.thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self.stop.set()
        self.thread.join(timeout=3)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:9001")
    parser.add_argument("--user", default="admin:test-pass")
    parser.add_argument("--source", default="http://127.0.0.1:8099/big.m3u")
    parser.add_argument("--caps", default="5,30")
    parser.add_argument("--out", default="D:/tmp/ff/cap.txt")
    args = parser.parse_args()
    token = base64.b64encode(args.user.encode()).decode()

    cfg = call("GET", args.base, token, "/api/config")["config"]
    lines: list[str] = [f"源={args.source}"]
    for cap_s in args.caps.split(","):
        cap = int(cap_s)
        for _ in range(90):
            if not call("GET", args.base, token, "/api/status")["state"].get("running"):
                break
            time.sleep(2)
        saved = call("POST", args.base, token, "/api/config", dict(cfg, source_urls=args.source, concurrency=cap))
        if not saved.get("ok"):
            print(json.dumps(saved, ensure_ascii=False))
            return 1
        t0 = time.time()
        with ChildCounter() as counter:
            seen_running = False
            while time.time() - t0 < 900:
                state = call("GET", args.base, token, "/api/status").get("state", {})
                if state.get("running"):
                    seen_running = True
                elif seen_running and (state.get("done") or 0) > 0:
                    break
                elif not seen_running and time.time() - t0 > 25:
                    # 源地址没变时保存配置不会自动开跑，这里手动点一次"立即测速"
                    call("POST", args.base, token, "/api/test")
                    t0 = time.time()
                time.sleep(1.0)
        run = call("GET", args.base, token, "/api/status").get("latest_run", {})
        lines.append(
            "并发上限=%-3d 本轮 total=%s tested=%s 耗时=%.1fs  峰值存活子进程=%d  采样%d次  进程占用比=%.2f"
            % (cap, run.get("total"), run.get("tested"), time.time() - t0, counter.peak, counter.samples,
               counter.peak / max(1, int(run.get("total") or 1)))
        )
        print(lines[-1], flush=True)

    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    print(f"written {args.out}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
