"""生成压测用的大订阅文件（只在 dev-tools 里用，不进镜像）。

用法：
  python dev-tools/make_big_source.py --out dev-tools/www/big.m3u
"""

from __future__ import annotations

import argparse
import os
import sys

V4 = "http://127.0.0.1:8099"
V6 = "http://[::1]:8100"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "www", "big.m3u"))
    parser.add_argument("--good", type=int, default=150)
    parser.add_argument("--http404", type=int, default=30)
    parser.add_argument("--slow", type=int, default=30)
    parser.add_argument("--notstream", type=int, default=30)
    parser.add_argument("--ipv6", type=int, default=20)
    parser.add_argument("--duplicates", type=int, default=40)
    args = parser.parse_args()

    lines = ["#EXTM3U"]
    idx = 0

    def add(name: str, group: str, url: str) -> None:
        nonlocal idx
        idx += 1
        lines.append(
            f'#EXTINF:-1 tvg-id="BIG.{idx}" tvg-name="{name}" '
            f'group-title="{group}",{name}'
        )
        lines.append(url)

    for i in range(args.good):
        add(f"压测好源 {i + 1:03d}", "压测-可用", f"{V4}/live/test.ts?n={i}")
    for i in range(args.http404):
        add(f"压测四十不惑 {i + 1:03d}", "压测-HTTP错误", f"{V4}/live/missing.ts?n={i}")
    for i in range(args.slow):
        add(f"压测涓流 {i + 1:03d}", "压测-速度", f"{V4}/live/slow.ts?n={i}")
    for i in range(args.notstream):
        add(f"压测假流 {i + 1:03d}", "压测-解析", f"{V4}/live/fake.m3u8?n={i}")
    for i in range(args.ipv6):
        add(f"压测IPv6 {i + 1:03d}", "压测-IPv6", f"{V6}/live/test.ts?n=v6-{i}")
    # 重复地址：和前面 good 的 URL 完全相同，只是名字不同，应该被去重
    for i in range(min(args.duplicates, args.good)):
        add(f"压测重复项 {i + 1:03d}", "压测-去重", f"{V4}/live/test.ts?n={i}")

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(lines) + "\n")

    unique = len({line for line in lines if line.startswith("http")})
    print(f"写入 {args.out}：{idx} 行 EXTINF，去重后应有 {unique} 个唯一 URL", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
