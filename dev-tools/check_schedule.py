"""调度行为核对：调阈值不重测、换源地址立刻重测、周期改动立刻生效。

用法：
  python dev-tools/check_schedule.py --base http://127.0.0.1:9001 -u admin:test-pass
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


def running(base: str, token: str) -> bool:
    return bool(call("GET", base, token, "/api/status").get("state", {}).get("running"))


def wait_running(base: str, token: str, limit: float) -> bool:
    deadline = time.time() + limit
    while time.time() < deadline:
        if running(base, token):
            return True
        time.sleep(1)
    return False


def wait_idle(base: str, token: str, limit: int = 240) -> None:
    deadline = time.time() + limit
    while time.time() < deadline and running(base, token):
        time.sleep(2)


def source_update_ts(base: str, token: str) -> int:
    """stats.last_source_update 只有在「下载+解析成功」那一轮才会推进，用它当判据。"""
    return int(call("GET", base, token, "/api/status").get("stats", {}).get("last_source_update") or 0)


def wait_new_cycle(base: str, token: str, before: int, limit: float = 40) -> bool:
    """等到出现一轮新的成功更新（或直接看到任务在跑）。"""
    deadline = time.time() + limit
    while time.time() < deadline:
        if running(base, token) or source_update_ts(base, token) > before:
            return True
        time.sleep(1)
    return False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:9001")
    parser.add_argument("--user", default="admin:test-pass")
    parser.add_argument("--source", default="http://127.0.0.1:8099/subscribe.m3u")
    parser.add_argument("--other", default="http://127.0.0.1:8099/playlist.m3u8")
    parser.add_argument("--out", default="D:/tmp/ff/schedule.txt")
    args = parser.parse_args()
    token = base64.b64encode(args.user.encode()).decode()
    base, tok = args.base, token

    lines: list[str] = []
    wait_idle(base, tok)
    cfg = call("GET", base, tok, "/api/config")["config"]

    # 0) 先把源地址挪到 B，好让下面「换到 A」是一次真正的变更
    call("POST", base, tok, "/api/config", dict(cfg, source_urls=args.other))
    wait_running(base, tok, 20)
    wait_idle(base, tok)

    # 1) 换订阅地址：应当 15 秒内自动开跑（不用点「立即更新」）
    before = source_update_ts(base, tok)
    call("POST", base, tok, "/api/config", dict(cfg, source_urls=args.source))
    started = wait_new_cycle(base, tok, before, 20)
    lines.append(f"[换源地址A] 保存后 20 秒内自动开跑：{started}（期望 True）")
    wait_idle(base, tok)
    state = call("GET", base, tok, "/api/status")["state"]
    lines.append(f"[换源地址A] 本轮结果：{state.get('source_state')} stage={state.get('stage')}")
    cfg = call("GET", base, tok, "/api/config")["config"]

    # 2) 只调阈值：不该重测，只重排下一次自动更新
    before = source_update_ts(base, tok)
    call("POST", base, tok, "/api/config", dict(cfg, min_speed_kbps=600))
    started = wait_new_cycle(base, tok, before, 12)
    status = call("GET", base, tok, "/api/status")
    lines.append(
        f"[只调最低速度] 是否误触发重测：{started}（期望 False）；"
        f"下次自动更新还剩 {status['scheduler']['next_in_seconds']} 秒（周期 {cfg['update_interval_minutes']} 分钟）"
    )

    # 3) 改周期：下一次自动更新要按新周期重排
    call("POST", base, tok, "/api/config", dict(cfg, min_speed_kbps=500, update_interval_minutes=10))
    status = call("GET", base, tok, "/api/status")
    lines.append(
        f"[改周期为10分钟] 下次自动更新={status['scheduler']['next_in_seconds']} 秒（期望接近 600）"
    )

    # 4) 手动「立即更新」仍然可用
    resp = call("POST", base, tok, "/api/update")
    started = wait_running(base, tok, 8)
    lines.append(f"[立即更新按钮] 回执={resp.get('message')} 任务在跑={started}")
    wait_idle(base, tok)

    # 5) 再换一次地址（另一个格式），确认「换地址=马上重测」不是一次性巧合
    before = source_update_ts(base, tok)
    call("POST", base, tok, "/api/config", dict(cfg, source_urls=args.other, update_interval_minutes=30))
    started = wait_new_cycle(base, tok, before, 20)
    lines.append(f"[换源地址B] 保存后 20 秒内自动开跑：{started}（期望 True）")
    wait_idle(base, tok)
    status = call("GET", base, tok, "/api/status")
    lines.append(
        f"[换源地址B] 解析结果={status['state'].get('source_state')} "
        f"下次自动更新={status['scheduler']['next_in_seconds']} 秒"
    )

    # 6) 收尾：恢复 A 源 + 30 分钟周期
    final = call("GET", base, tok, "/api/config")["config"]
    call("POST", base, tok, "/api/config", dict(final, source_urls=args.source, update_interval_minutes=30, min_speed_kbps=500))
    wait_idle(base, tok)
    status = call("GET", base, tok, "/api/status")
    lines.append(
        f"[恢复] 源={status['config']['source_urls']} 周期=30分钟 "
        f"下次自动更新={status['scheduler']['next_in_seconds']} 秒"
    )

    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    print(f"written {args.out}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
