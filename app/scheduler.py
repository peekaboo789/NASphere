"""周期调度：按配置里的更新周期跑流水线。

- 每 5 秒醒一次，重新读配置，所以改周期立刻生效；
- 上一轮没跑完就跳过这一轮（绝不排队堆死 NAS）；
- 容器启动后立刻跑第一轮，避免刚部署完播放器拿到空列表。
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from .logging_setup import get_logger
from .pipeline import Pipeline, human

log = get_logger()

TICK_SECONDS = 5.0


class Scheduler:
    def __init__(self, pipeline: Pipeline, config_store: Any) -> None:
        self.pipeline = pipeline
        self.config_store = config_store
        self.next_due_at = 0.0
        self.task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    def reschedule_now(self, immediate: bool = False) -> None:
        """配置保存后调用。

        immediate=True（换了订阅地址）时立刻安排一轮全量更新；
        其它参数调整只按新的周期重新计时，不要动一下设置就重测几千个 URL。
        """
        now = time.monotonic()
        if immediate:
            self.next_due_at = now
            log.info("[INFO] 订阅地址已更换，下一轮更新立即开始")
            return
        cfg = self.config_store.get()
        interval = float(cfg["update_interval_minutes"]) * 60.0
        self.next_due_at = now + interval
        log.info(
            "[INFO] 下一次自动更新安排在 %s 后（周期 %d 分钟）",
            human(interval),
            int(cfg["update_interval_minutes"]),
        )

    def snapshot(self) -> dict[str, Any]:
        """给 Web 页面看的调度信息。"""
        now = time.monotonic()
        if self.next_due_at == float("inf"):
            return {"next_in_seconds": None, "waiting_for_source": True}
        return {
            "next_in_seconds": max(0.0, round(self.next_due_at - now, 1)),
            "waiting_for_source": False,
        }

    def stop(self) -> None:
        self._stop.set()

    async def run(self) -> None:
        cfg = self.config_store.get()
        if cfg["source_urls"]:
            log.info("[INFO] 调度器启动（%d 个订阅源），立即执行第一轮更新", len(cfg["source_urls"]))
            self.next_due_at = time.monotonic()
        else:
            log.warning("[WARN] 还没有配置订阅源地址，调度器等待页面里保存配置后再开始")
            self.next_due_at = float("inf")
        while not self._stop.is_set():
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=TICK_SECONDS)
                break
            except asyncio.TimeoutError:
                pass
            cfg = self.config_store.get()
            if not cfg["source_urls"]:
                self.next_due_at = float("inf")
                continue
            interval = float(cfg["update_interval_minutes"]) * 60.0
            if time.monotonic() < self.next_due_at:
                continue
            self.next_due_at = time.monotonic() + interval
            if self.pipeline.busy:
                log.warning("[WARN] 上一轮还没结束（预计还需 %s），本轮跳过",
                            human(self.pipeline.snapshot().get("eta_seconds")))
                continue
            log.info("[INFO] 定时任务触发，周期=%d分钟", int(cfg["update_interval_minutes"]))
            try:
                await self.pipeline.run_blocking(kind="scheduled")
            except asyncio.CancelledError:
                log.info("[INFO] 调度器收到停止信号，退出")
                return
            except Exception as exc:
                log.exception("[FAIL] 定时任务异常：%s", exc)
        log.info("[INFO] 调度器已停止")

    def start(self) -> None:
        self.task = asyncio.create_task(self.run())

    async def shutdown(self) -> None:
        self._stop.set()
        if self.task is not None:
            self.task.cancel()
            try:
                await self.task
            except (asyncio.CancelledError, Exception):
                pass
