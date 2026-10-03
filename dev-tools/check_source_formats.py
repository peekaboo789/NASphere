"""订阅格式覆盖检查：M3U / M3U8 / TXT / GBK-TXT 都能下载解析并测速。

用法：
  python dev-tools/check_source_formats.py --base http://127.0.0.1:9001 -u admin:test-pass
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


def wait_idle(base: str, token: str, limit: int = 180) -> dict:
    deadline = time.time() + limit
    while time.time() < deadline:
        state = call("GET", base, token, "/api/status").get("state", {})
        if not state.get("running"):
            return state
        time.sleep(2)
    return {"timeout": True}


def trigger(base: str, token: str, path: str = "/api/update") -> dict:
    """等空闲后启动任务；返回真正的启动回执，避免把上一轮的状态当成本轮。"""
    wait_idle(base, token)
    for _ in range(30):
        resp = call("POST", base, token, path)
        if resp.get("ok"):
            time.sleep(0.5)  # 让 _begin() 先把状态清干净
            return resp
        time.sleep(2)
    raise SystemExit(f"启动 {path} 失败：{resp}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:9001")
    parser.add_argument("--user", default="admin:test-pass")
    parser.add_argument("--origin", default="http://127.0.0.1:8099")
    parser.add_argument(
        "--sources",
        default="subscribe.txt,subscribe_gbk.txt,playlist.m3u8,subscribe.m3u",
        help="逗号分隔的订阅文件名，都在假源服务器的 www/ 下",
    )
    parser.add_argument("--out", default="D:/tmp/ff/formats.txt")
    args = parser.parse_args()
    token = base64.b64encode(args.user.encode()).decode()
    base, tok = args.base, token

    cfg = call("GET", base, tok, "/api/config")["config"]
    lines: list[str] = []
    for name in [x.strip() for x in args.sources.split(",") if x.strip()]:
        patch = dict(cfg, source_urls=f"{args.origin}/{name}", concurrency=8)
        call("POST", base, tok, "/api/config", patch)
        trigger(base, tok)
        state = wait_idle(base, tok)
        status = call("GET", base, tok, "/api/status")
        listed = call("GET", base, tok, "/api/channels?limit=200")
        lines.append(
            f"=== {name}：source_state={state.get('source_state')} "
            f"total={status['stats']['source_count']} 活跃频道={listed['total']} "
            f"有效={status['stats']['ok']} 失效={status['stats']['bad']}"
        )
        for item in listed["items"][:12]:
            lines.append(
                "    名字=%-18s 分组=%-10s tvg-id=%-9s 协议=%-5s 状态=%-13s 速度=%-8s 原因=%s"
                % (
                    item["name"],
                    item["group_title"] or "-",
                    item["tvg_id"] or "-",
                    item["protocol"] or "-",
                    item["status"],
                    str(item["speed_kbps"] or "-"),
                    (item["failure_reason"] or "-")[:36],
                )
            )
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    print(f"written {args.out}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
