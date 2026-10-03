"""检测工具缺失时的行为核对（纯本机、不联网、不进镜像）。

要证明的是：ffmpeg/ffprobe 跑不起来属于「系统没装好」，不能冒充「所有源都挂了」。
用法：python dev-tools/unit_engine_guard.py
"""

from __future__ import annotations

import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# 先指到临时目录再导入，免得单元脚本在仓库里建出一套运行时数据
os.environ["DATA_DIR"] = os.path.join(os.environ.get("TEMP", "."), "iptvengineguard")

from app import tester  # noqa: E402
from app.pipeline import Pipeline  # noqa: E402
from app.statuses import STATUS_LABELS  # noqa: E402

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, bool(ok), detail))


class StoreStub:
    """只够流水线读配置的假 store：这里根本不会跑到读配置那一步。"""

    def __init__(self, cfg: dict) -> None:
        self._cfg = cfg

    def get(self) -> dict:
        return self._cfg


async def main() -> int:
    # 1) 分类器：子进程压根没起来 → engine_missing，而不是「解析失败」
    status, reason = tester._classify_failure(
        timed_out=False,
        stderr="无法启动 ffprobe：[WinError 2] 系统找不到指定的文件。",
        proxy_status=None,
        dial_failures=0,
        origin_responded=False,
        rc=None,
    )
    check("子进程起不来记成「检测工具不可用」", status == "engine_missing", f"status={status}")
    check("原因里带上无法启动的那句原文", "无法启动" in reason, f"reason={reason}")

    # 负向控制：真正是源的问题时不许被归到工具缺失（否则这条分支会变成万能挡箭牌）
    s2, r2 = tester._classify_failure(
        timed_out=False,
        stderr="Invalid data found when processing input",
        proxy_status=200,
        dial_failures=0,
        origin_responded=True,
        rc=1,
    )
    check("内容不是流仍然记解析失败（没被工具分支抢走）", s2 == "parse_failed", f"status={s2} reason={r2}")
    s3, _r3 = tester._classify_failure(
        timed_out=False,
        stderr="HTTP error 404 not found",
        proxy_status=404,
        dial_failures=0,
        origin_responded=True,
        rc=1,
    )
    check("源站 404 仍然记 HTTP错误", s3 == "http_error", f"status={s3}")

    # 2) 标签齐备：新状态在页面/CSV 里要有中文名
    check("engine_missing 有中文标签", STATUS_LABELS.get("engine_missing") == "检测工具不可用",
          f"label={STATUS_LABELS.get('engine_missing')}")

    # 3) 流水线：工具不可用时根本不启动，避免 2000 条地址白测一遍
    cfg = {
        "source_urls": ["http://127.0.0.1:8099/subscribe.m3u"],
        "concurrency": 30,
        "timeout_seconds": 8,
        "min_speed_kbps": 500,
        "min_success_count": 1,
        "ip_prefer": "ipv4_only",
        "user_agent": "IPTV-Unit/1.0",
        "update_interval_minutes": 30,
    }
    pipeline = Pipeline(None, StoreStub(cfg))  # type: ignore[arg-type]
    check("默认状态里没有工具报错", pipeline.snapshot()["engine_error"] == "",
          f"engine_error={pipeline.snapshot()['engine_error']!r}")
    err = "ffprobe（/usr/bin/ffprobe）无法执行：找不到可执行文件"
    pipeline.set_engine_state(False, err)
    state = pipeline.snapshot()
    check("工具报错会出现在 /api/status 的状态里", state["engine_error"] == err, f"state={state['engine_error']}")
    started = await pipeline.start("manual")
    check("手动「立即更新」被挡下并说明原因", err in started, f"回执={started}")
    skipped = await pipeline.run_blocking("scheduled")
    check("定时任务同样跳过（不白测一轮）", skipped == err, f"回执={skipped}")
    check("挡下任务时没有留下运行中的状态", pipeline.snapshot()["running"] is False, "")

    # 4) 恢复可用之后必须重新放行（否则这条保护会把程序锁死）
    pipeline.set_engine_state(True, "")
    check("恢复后状态里的报错消失", pipeline.snapshot()["engine_error"] == "", "")

    ok_count = sum(1 for _n, o, _d in results if o)
    for name, ok, detail in results:
        print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f"  —— {detail}" if detail else ""))
    print("-" * 44)
    print(f"[RESULT] {ok_count}/{len(results)} 条通过")
    return 0 if ok_count == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
