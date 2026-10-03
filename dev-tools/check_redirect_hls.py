"""重定向跟随 + 「源有效」与「测试失败」分开记 —— 端到端判据脚本（只在本机跑，不进镜像）。

它跑的是真实流水线：假源 → 下载订阅 → 入库 → 真 FFprobe/FFmpeg 测速 → 出产物 → 回读数据库，
然后逐条核对用户提出的四条要求：

  1. 产物里永远写订阅文件给的原始地址，绝不写成带临时签名的最终地址；
  2. 检测要跟随 302，并把 final_url / redirect_count / content_type 记下来；
  3. 单个 TS 分片 404 不能一票否决（播放列表 200 + 合法 HLS + 内容能播 就算可用）；
  4. 「源有效」和「测试失败」要分开：hls_valid / segment_test / playable / test_error 各自记录。

用法（假源要先起来）：
  python dev-tools/fake_origin_server.py --bind 127.0.0.1 --port 8099
  python dev-tools/check_redirect_hls.py \
      --ffmpeg D:/tmp/ff/x/ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe \
      --ffprobe D:/tmp/ff/x/ffmpeg-9.0.2-essentials_build/bin/ffprobe.exe
"""

from __future__ import annotations

import argparse
import asyncio
import os
import shutil
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

# 夹具里的地址：订阅文件给的原始 URL，产物里必须一字不差地还是它
ORIGINAL_URLS = {
    "REDIR.TS": "http://127.0.0.1:8099/redir/2/live/test.ts",
    "REDIR.HLS": "http://127.0.0.1:8099/redir/1/live/test.m3u8",
    "HLS.FIRST404": "http://127.0.0.1:8099/live/first404.m3u8",
    "HLS.ALLBAD": "http://127.0.0.1:8099/live/allmissing.m3u8",
    "BASE.TS": "http://127.0.0.1:8099/live/test.ts",
    "FAKE.HTML": "http://127.0.0.1:8099/live/fake.m3u8",
}
# 假源最后一跳加的临时签名参数，出现在产物里就算失败
SIGNATURE = "key=deadbeef01"


class Store:
    """流水线要的最小配置接口：和 app.config.ConfigStore.get() 同形。"""

    def __init__(self, cfg: dict) -> None:
        self._cfg = cfg

    def get(self) -> dict:
        return dict(self._cfg)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ffmpeg", default="D:/tmp/ff/x/ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe")
    parser.add_argument("--ffprobe", default="D:/tmp/ff/x/ffmpeg-9.0.2-essentials_build/bin/ffprobe.exe")
    parser.add_argument("--origin", default="http://127.0.0.1:8099")
    parser.add_argument("--data", default="D:/tmp/iptvredir")
    parser.add_argument("--out", default="D:/tmp/ff/redirect_hls.txt")
    args = parser.parse_args()

    # 干净库：判据只在「这一轮真的跑过」的前提下成立才有意义
    if os.path.isdir(args.data):
        shutil.rmtree(args.data, ignore_errors=True)
    os.environ["FFMPEG_PATH"] = args.ffmpeg
    os.environ["FFPROBE_PATH"] = args.ffprobe
    os.environ["DATA_DIR"] = args.data
    os.environ["PYTHONIOENCODING"] = "utf-8"
    for path in (args.ffmpeg, args.ffprobe):
        if not os.path.isfile(path):
            print(f"[FAIL] 找不到 {path}", flush=True)
            return 2

    from app import pipeline as pipeline_mod, statuses  # noqa: E402
    from app.db import Database  # noqa: E402

    cfg = {
        "source_urls": [f"{args.origin}/subscribe_c.m3u"],
        "update_interval_minutes": 30,
        "concurrency": 2,
        "timeout_seconds": 8,
        "min_speed_kbps": 500,
        "min_success_count": 1,
        "ip_prefer": "ipv4_only",
        "user_agent": "IPTV-RedirectCheck/1.0",
    }
    db = Database()
    pipe = pipeline_mod.Pipeline(db, Store(cfg))
    started = time.time()
    asyncio.run(pipe.run_blocking("manual", refresh_source=True))
    db.close()

    db = Database()
    rows = {r["tvg_id"]: r for r in db.query("SELECT * FROM channels")}
    results = db.query("SELECT * FROM results ORDER BY id")
    out_dir = os.path.join(args.data, "output")
    with open(os.path.join(out_dir, "iptv.m3u"), encoding="utf-8") as fh:
        iptv = fh.read()
    with open(os.path.join(out_dir, "results.csv"), encoding="utf-8", newline="") as fh:
        csv_rows = list(csv_reader(fh))

    checks: list[tuple[str, bool, str]] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        checks.append((name, bool(ok), detail))

    def row(tvg_id: str) -> dict:
        return rows.get(tvg_id, {})

    def url_lines(text: str) -> list[str]:
        return [ln.strip() for ln in text.splitlines() if ln.strip() and not ln.startswith("#")]

    # —— 要求 1：产物只写原始地址 ————————————————————————————————
    produced = set(url_lines(iptv))
    allowed = set(ORIGINAL_URLS.values())
    check(
        "iptv.m3u 里每个地址都是订阅文件给的原始地址",
        produced and produced <= allowed,
        f"产物 {len(produced)} 条，越界 {sorted(produced - allowed)}",
    )
    check("iptv.m3u 里没有临时签名参数", SIGNATURE not in iptv, "")
    check(
        "重定向频道的 url 列仍是原始地址",
        row("REDIR.TS").get("url") == ORIGINAL_URLS["REDIR.TS"],
        f"url={row('REDIR.TS').get('url')}",
    )

    # —— 要求 2：跟随重定向并记录最终地址 ————————————————
    redir = row("REDIR.TS")
    check("REDIR.TS 判定可用", redir.get("status") in statuses.PASSING_STATUSES,
          f"status={redir.get('status')} reason={redir.get('failure_reason')}")
    check("REDIR.TS 记录 HTTP 200", redir.get("http_status") == 200, f"http_status={redir.get('http_status')}")
    check("REDIR.TS 记录跳转 2 次", redir.get("redirect_count") == 2, f"redirect_count={redir.get('redirect_count')}")
    check(
        "REDIR.TS 的最终地址是被签名参数改写后的那个",
        SIGNATURE in str(redir.get("final_url") or ""),
        f"final_url={redir.get('final_url')}",
    )
    check("REDIR.TS 记录了内容类型", "video/mp2t" in str(redir.get("content_type") or ""),
          f"content_type={redir.get('content_type')}")
    rhls = row("REDIR.HLS")
    check("REDIR.HLS 跳转 1 次且判定可用",
          rhls.get("redirect_count") == 1 and rhls.get("status") in statuses.PASSING_STATUSES,
          f"redirect_count={rhls.get('redirect_count')} status={rhls.get('status')}")

    # —— 要求 3：单个分片 404 不一票否决 ——————————————————
    f404 = row("HLS.FIRST404")
    check("首片 404 的 HLS 仍然可用（没有被一票否决）",
          f404.get("status") in statuses.PASSING_STATUSES,
          f"status={f404.get('status')} reason={f404.get('failure_reason')}")
    check("首片 404 的频道出现在 iptv.m3u 里", ORIGINAL_URLS["HLS.FIRST404"] in produced,
          f"产物 {len(produced)} 条")
    check("首片 404 的分片验证记成 partial（确实见过 4xx，才可能得出这个值）",
          f404.get("segment_test") == "partial", f"segment_test={f404.get('segment_test')}")
    check("首片 404 的播放列表判定有效", f404.get("hls_valid") == 1, f"hls_valid={f404.get('hls_valid')}")

    # —— 要求 4：区分「源有效」和「测试失败」 ——————————————
    allbad = row("HLS.ALLBAD")
    check("分片全 404 判定失效", allbad.get("status") not in statuses.PASSING_STATUSES,
          f"status={allbad.get('status')}")
    check("分片全 404 的地址本身HTTP仍是 200（源有效）", allbad.get("http_status") == 200,
          f"http_status={allbad.get('http_status')}")
    check("分片全 404 的分片验证记成 failed", allbad.get("segment_test") == "failed",
          f"segment_test={allbad.get('segment_test')}")
    check("分片全 404 的 playable=0", allbad.get("playable") == 0, f"playable={allbad.get('playable')}")
    reason = str(allbad.get("failure_reason") or "")
    check("分片全 404 的原因说的是分片，不是「源站返回 HTTP 404」",
          "分片" in reason and "源站返回 HTTP 404" not in reason, f"reason={reason}")
    check("分片全 404 没进 iptv.m3u", ORIGINAL_URLS["HLS.ALLBAD"] not in produced, "")

    fake = row("FAKE.HTML")
    check("200 但内容是 HTML 的频道判定失效", fake.get("status") not in statuses.PASSING_STATUSES,
          f"status={fake.get('status')} reason={fake.get('failure_reason')}")
    check("200 但内容是 HTML 的播放列表判定无效", fake.get("hls_valid") == 0,
          f"hls_valid={fake.get('hls_valid')}（0=判定无效，NULL 才算没结论）")
    check("200 但内容是 HTML 的地址 HTTP 状态照实记 200", fake.get("http_status") == 200,
          f"http_status={fake.get('http_status')}")

    base = row("BASE.TS")
    check("直连裸 TS 基线可用", base.get("status") in statuses.PASSING_STATUSES,
          f"status={base.get('status')}")
    check("裸 TS 不参与 HLS 判定（hls_valid 留空而不是 0）", base.get("hls_valid") is None,
          f"hls_valid={base.get('hls_valid')!r}")
    check("裸 TS 没有派生分片请求", base.get("segment_test") == "none",
          f"segment_test={base.get('segment_test')}")
    check("裸 TS 的最终地址就是原始地址", base.get("final_url") == ORIGINAL_URLS["BASE.TS"],
          f"final_url={base.get('final_url')}")

    # —— 历史表也要带上这几列（每次尝试各一行） ————————
    with_final = [r for r in results if str(r.get("final_url") or "")]
    check("results 里逐条记录了 final_url", len(with_final) >= 5,
          f"{len(with_final)}/{len(results)} 行有最终地址")
    allbad_hist = [r for r in results if r.get("segment_test") == "failed"]
    check("results 里能查到分片全失败那一次", len(allbad_hist) >= 1,
          f"test_error={allbad_hist[0].get('test_error') if allbad_hist else '-'}")
    check("results 的 test_error 留了源站细节，不只是状态码",
          bool(allbad_hist) and bool(str(allbad_hist[0].get("test_error") or "")),
          f"test_error={str(allbad_hist[0].get('test_error') or '')[:120] if allbad_hist else '-'}")

    # —— CSV 产物有这几列 ————————————————————————————
    header = csv_rows[0] if csv_rows else []
    for col in ("最终地址", "跳转次数", "内容类型", "HLS播放列表", "分片验证", "可播放", "来自订阅源"):
        check(f"results.csv 有「{col}」列", col in header, f"表头 {len(header)} 列")
    check(
        "results.csv 里首片 404 那行写着「个别分片失败」",
        any(
            r[header.index("tvg-id")] == "HLS.FIRST404"
            and statuses.segment_label("partial") in r[header.index("分片验证")]
            for r in csv_rows[1:]
        ),
        "",
    )

    lines: list[str] = [
        f"# check_redirect_hls  {time.strftime('%Y-%m-%d %H:%M:%S')}",
        f"origin={args.origin} data={args.data} 流水线耗时={time.time() - started:.1f}s",
        f"频道数={len(rows)} 结果行={len(results)} iptv.m3u 地址数={len(produced)}",
        "",
        "## 逐频道实测记录（全部来自数据库）",
    ]
    for tvg_id in ("REDIR.TS", "REDIR.HLS", "HLS.FIRST404", "HLS.ALLBAD", "BASE.TS", "FAKE.HTML"):
        r = row(tvg_id)
        lines.append(
            f"{tvg_id:<12} status={r.get('status','-'):<12} http={r.get('http_status','-')} "
            f"跳={r.get('redirect_count','-')} hls={r.get('hls_valid','-')} "
            f"分片={r.get('segment_test','-')} playable={r.get('playable','-')} "
            f"speed={r.get('speed_kbps','-')} final={r.get('final_url','-')}"
        )
        lines.append(f"             content_type={r.get('content_type','-')} reason={r.get('failure_reason','-')}")
    lines.append("")
    lines.append("## iptv.m3u 里的地址")
    lines.extend(url_lines(iptv))
    lines.append("")
    lines.append("## 判据")
    passed = 0
    for name, ok, detail in checks:
        passed += 1 if ok else 0
        lines.append(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f"  —— {detail}" if detail else ""))
    lines.append("")
    lines.append(f"合计 {passed}/{len(checks)} 条通过")

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    print(f"written {args.out}  ({passed}/{len(checks)} passed)", flush=True)
    db.close()
    return 0 if passed == len(checks) else 1


def csv_reader(fh):
    import csv

    for row in csv.reader(fh):
        yield row


if __name__ == "__main__":
    sys.exit(main())
