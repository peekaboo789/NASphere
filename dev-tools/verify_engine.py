"""本地验证：真实 FFprobe/FFmpeg + 本地假源，逐个状态核对。

用法（本机 python + 已下载 ffmpeg）：
  python dev-tools/verify_engine.py --ffmpeg D:/path/ffmpeg.exe --ffprobe D:/path/ffprobe.exe
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--ffprobe", default="ffprobe")
    parser.add_argument("--origin", default="http://127.0.0.1:8099")
    parser.add_argument("--min-speed", type=int, default=500, dest="min_speed")
    parser.add_argument("--timeout", type=int, default=8)
    parser.add_argument("--prefer", default="ipv4_only")
    parser.add_argument("--data", default=os.path.join(os.environ.get("TEMP", "/tmp"), "iptvdata"))
    args = parser.parse_args()

    os.environ["FFMPEG_PATH"] = args.ffmpeg
    os.environ["FFPROBE_PATH"] = args.ffprobe
    os.environ["DATA_DIR"] = args.data
    os.environ["PYTHONIOENCODING"] = "utf-8"

    from app import m3u_parser, statuses, tester

    cfg = {
        "source_urls": [f"{args.origin}/subscribe.m3u"],
        "update_interval_minutes": 30,
        "concurrency": 4,
        "timeout_seconds": args.timeout,
        "min_speed_kbps": args.min_speed,
        "min_success_count": 1,
        "ip_prefer": args.prefer,
        "user_agent": "IPTV-Verify/1.0",
    }
    print(f"[INFO] 配置 timeout={args.timeout}s min_speed={args.min_speed}KB/s prefer={args.prefer}", flush=True)

    report: list[tuple[str, str, str]] = []

    data, error, http_status = await tester.download_source(cfg, cfg["source_urls"][0])
    if data is None:
        print(f"[FAIL] 订阅下载失败：{error}", flush=True)
        return 1
    entries, warns = m3u_parser.parse(m3u_parser.decode_bytes(data))
    print(f"[INFO] 订阅下载成功 HTTP={http_status} 解析 {len(entries)} 条 warnings={len(warns)}", flush=True)

    group = tester.ProcessGroup()
    for entry in entries:
        result = await tester.test_channel(cfg, entry, group)
        winner = result.get("winner") or {}
        attempts = result.get("attempts") or [{}]
        last = attempts[-1]
        view = winner or last
        speed = view.get("speed_kbps")
        latency = view.get("first_packet_ms")
        line = (
            f"{entry['name']:<22} {result['status']:<14} {statuses.label(result['status']):<12} "
            f"speed={speed if speed is not None else '-'} "
            f"latency={latency if latency is not None else '-'} "
            f"v={bool(view.get('has_video'))} a={bool(view.get('has_audio'))} "
            f"codec={view.get('v_codec') or '-'}/{view.get('a_codec') or '-'} "
            f"reason={result['failure_reason'] or '-'}"
        )
        report.append((entry["url"], result["status"], line))
        print(line, flush=True)

    out = os.path.join(args.data, "verify_report.txt")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        for url, status, line in report:
            fh.write(f"{url}\t{status}\t{line}\n")
    print(f"[INFO] 报告已写入 {out}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
