"""更新流水线：下载源 → 解析 → 去重 → 并发测速 → 记录 → 过滤 → 生成 M3U。

设计要点：
- 同一时刻只允许一个任务在跑；周期任务发现上一轮还没结束就跳过，不排队堆死。
- 支持多个订阅源：并发下载、按源解析，同一个播放地址跨源只算一条（归第一个拿到它的源）。
- 下载失败时绝不清空上一次成功的列表；单个源失败只影响它自己，它上次成功的频道继续留在列表里。
- 生成 iptv.m3u 时，同一个频道（同 tvg-id，没有 tvg-id 就同名）跨源只保留实测最快的一条。
- 测速顺序：新频道 / 上次失败的频道 先测，这样即使中途取消，高风险源也已经刷新过。
- 内存控制：频道从数据库按页取，结果按批写库，进度只存计数器，不在内存里堆结果。
- 取消：置位取消标志 + 立刻 kill 所有 FFmpeg/FFprobe 子进程。
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from . import m3u_parser, outputs, statuses, tester
from .config import OUTPUT_DIR, concurrency_limited
from .db import Database
from .logging_setup import get_logger, log_fail, log_ok

log = get_logger()

# 每处理这么多个频道就刷新一次数据库里的进度行
_PROGRESS_EVERY = 10

# 同时下载几个订阅源。订阅文件通常几百 KB，4 路足够让一轮更新不拖沓，
# 又不至于源站抽风时把带宽和连接全部吃掉。
_SOURCE_DOWNLOAD_CONCURRENCY = 4


def human(seconds: float | None) -> str:
    if seconds is None or seconds < 0 or seconds > 86400 * 3:
        return "-"
    seconds = int(seconds)
    if seconds < 60:
        return f"{seconds}秒"
    if seconds < 3600:
        return f"{seconds // 60}分{seconds % 60:02d}秒"
    return f"{seconds // 3600}小时{(seconds % 3600) // 60:02d}分"


def ipv6_capability() -> dict[str, Any]:
    """容器里有没有 IPv6 出口，直接决定 IPv6 测速是不是有意义。"""
    info: dict[str, Any] = {"checked": False, "available": None, "detail": ""}
    try:
        import os
        import socket

        if not socket.has_ipv6:
            info.update(checked=True, available=False, detail="Python 编译时未启用 IPv6")
            return info
        path = "/proc/net/if_inet6"
        if os.path.exists(path):
            with open(path, "r", encoding="ascii", errors="replace") as fh:
                lines = [ln.split() for ln in fh if ln.strip()]
            # 排除回环(::1)，看是否存在真实链路的 IPv6 地址
            global_scope = [parts for parts in lines if len(parts) >= 6 and parts[5] != "lo"]
            info.update(
                checked=True,
                available=bool(global_scope),
                detail=", ".join(p[5] for p in global_scope) if global_scope else "仅有回环地址",
            )
            return info
        # 非 Linux（本机开发）用回环连通性粗略判断
        sock = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
        sock.settimeout(0.5)
        try:
            sock.connect(("::1", 53))
            info.update(checked=True, available=True, detail="IPv6 回环可连通")
        except OSError:
            info.update(checked=True, available=False, detail="无法建立 IPv6 连接")
        finally:
            sock.close()
    except (OSError, ValueError) as exc:
        info.update(checked=True, available=False, detail=str(exc)[:120])
    return info


class Pipeline:
    def __init__(self, db: Database, config_store: Any) -> None:
        self.db = db
        self.config_store = config_store
        self.task: asyncio.Task | None = None
        self.group: tester.ProcessGroup | None = None
        self.state: dict[str, Any] = self._blank_state()
        self.ipv6 = ipv6_capability()
        # 启动时体检出来的检测工具问题（ffmpeg/ffprobe 跑不起来），空串表示正常。
        # 工具缺失时每个频道都会变成「解析失败」，看着像源全挂了，所以要在最前面拦住。
        self.engine_error = ""
        # 本轮各订阅源的下载/解析明细。测速结束后还要拿它再发布一次源状态，
        # 因为「每个源有多少条可用」只有测完才准 —— 不重发的话，第一轮（空库起步）
        # 跑完，首页那张表里每个源的「可用」会一直停在测速之前读到的 0。
        self.last_source_results: list[dict[str, Any]] = []

    # ------------------------------------------------------------------
    @staticmethod
    def _blank_state() -> dict[str, Any]:
        return {
            "running": False,
            "kind": "",
            "cancel_requested": False,
            "started_at": None,
            "finished_at": None,
            "stage": "",
            "total": 0,
            "done": 0,
            "ok": 0,
            "failed": 0,
            "rate_per_second": 0.0,
            "eta_seconds": None,
            "current": "",
            "last_error": "",
            "source_state": "",
            "total_from_source": None,
            "sources": [],
            "merged_duplicates": 0,
            "outputs": {},
            "run_id": None,
            "run_finalized": False,
        }

    @property
    def busy(self) -> bool:
        return self.task is not None and not self.task.done()

    def set_engine_state(self, ok: bool, error: str) -> None:
        """启动体检结论写进状态：工具不可用时页面和接口都要能说清原因。"""
        self.engine_error = "" if ok else (error or "检测工具不可用")

    def snapshot(self) -> dict[str, Any]:
        state = dict(self.state)
        if state["running"] and state["started_at"]:
            elapsed = time.monotonic() - state["started_at"]
            done = state["done"]
            state["rate_per_second"] = round(done / elapsed, 2) if elapsed > 1 and done else 0.0
            remaining = state["total"] - done
            state["eta_seconds"] = (
                round(remaining / state["rate_per_second"], 1)
                if state["rate_per_second"] > 0.01 and remaining > 0
                else None
            )
            state["progress"] = round(done / state["total"] * 100.0, 1) if state["total"] else 0.0
        else:
            state["progress"] = 100.0 if state["finished_at"] else 0.0
        state.pop("started_at", None)
        state["started_at_epoch"] = self.state.get("started_at_epoch")
        state["engine_error"] = self.engine_error
        return state

    # ------------------------------------------------------------------
    def _begin(self, kind: str) -> None:
        self.group = tester.ProcessGroup()
        self.state = self._blank_state()
        self.state.update(
            running=True,
            kind=kind,
            started_at=time.monotonic(),
            started_at_epoch=int(time.time()),
            stage="准备中",
        )

    async def run_blocking(self, kind: str = "scheduled", refresh_source: bool = True) -> str:
        """供调度器直接 await 的一轮完整任务；已有任务在跑就跳过本轮。"""
        if self.busy:
            log.warning("[WARN] 上一轮任务还没结束，跳过本轮")
            return "已有任务正在执行"
        if self.engine_error:
            log.error("[ERROR] 检测工具不可用，本轮跳过：%s", self.engine_error)
            return self.engine_error
        self._begin(kind)
        self.task = asyncio.current_task()
        await self._execute(refresh_source)
        return ""

    async def start(self, kind: str = "manual", refresh_source: bool = True) -> str:
        """从 HTTP 接口触发：后台起任务，立刻返回（空字符串表示已启动）。"""
        if self.busy:
            return "已有任务正在执行"
        if self.engine_error:
            return f"检测工具不可用：{self.engine_error}"
        cfg = self.config_store.get()
        if not cfg["source_urls"]:
            return "还没有配置订阅源地址，请先在页面上填写"
        self._begin(kind)
        self.task = asyncio.create_task(self._execute(refresh_source))
        return ""

    async def cancel(self) -> str:
        if not self.busy:
            return "当前没有正在执行的任务"
        log.info("[WARN] 收到取消请求，正在终止测速任务")
        self.state["cancel_requested"] = True
        if self.group is not None:
            self.group.cancel()
        if self.task is not None:
            self.task.cancel()
        return ""

    # ------------------------------------------------------------------
    async def _execute(self, refresh_source: bool) -> None:
        cfg = self.config_store.get()
        started = time.time()
        try:
            total_from_source: int | None = None
            if refresh_source:
                total_from_source = await self._refresh_source(cfg)
                if total_from_source is None:
                    log.warning(
                        "[WARN] 本轮所有订阅源都没拿到数据，继续使用上一次成功的列表频道"
                        "（不删除旧播放列表）"
                    )
            else:
                await self._publish_sources([])
            await self._test_all(cfg)
            # 测速真正结束了，「每个源有多少条可用」这时候才有意义：拿本轮的下载明细
            # 再发一次源状态，页面和 /api/status 才会显示刚测出来的数字。
            await self._publish_sources(self.last_source_results)
            await self._write_outputs(cfg)
            log.info("[INFO] 本轮任务结束，耗时 %s", human(time.time() - started))
        except asyncio.CancelledError:
            log.info("[WARN] 任务已取消")
            self.state.update(cancel_requested=True, finished_at=time.time())
            self._finalize_run(cancelled=True)
            await self._safe_write_outputs(cfg)
            raise
        except Exception as exc:  # 单轮失败不能拖垮调度器
            log.exception("[FAIL] 任务异常终止：%s", exc)
            self.state["last_error"] = str(exc)[:300]
            self._finalize_run(cancelled=self.state["cancel_requested"])
            await self._safe_write_outputs(cfg)
        finally:
            if self.group is not None:
                self.group.kill_all()
            self._finalize_run(cancelled=self.state["cancel_requested"])
            self.state["running"] = False
            self.state["stage"] = "已取消" if self.state["cancel_requested"] else "空闲"
            self.state["finished_at"] = time.time()
            self.task = None

    async def _refresh_source(self, cfg: dict[str, Any]) -> int | None:
        """逐个下载配置里的订阅源，合并去重后入库。

        返回合并后的地址数量；一个源都没成功时返回 None（调用方保留上一次成功的列表）。
        单个源失败只影响它自己：它的旧频道留在库里继续出片，其它源照常更新。
        """
        urls = [str(u).strip() for u in cfg["source_urls"] if str(u).strip()]
        self.state["stage"] = "下载订阅源"
        self.state["sources"] = []
        self.last_source_results = []
        if not urls:
            self.state["last_error"] = "还没有配置订阅源地址"
            self.state["source_state"] = "未配置源"
            log.warning("[WARN] 没有配置任何订阅源地址，跳过下载")
            return None

        log.info("[INFO] 开始更新 IPTV 源，共 %d 个地址", len(urls))
        sem = asyncio.Semaphore(min(_SOURCE_DOWNLOAD_CONCURRENCY, len(urls)))
        results = await asyncio.gather(
            *(self._fetch_source(cfg, url, index, len(urls), sem)
              for index, url in enumerate(urls, start=1))
        )
        self.last_source_results = list(results)

        # 合并：同一个播放地址（url_hash 相同）只算一条，归第一个拿到它的源
        merged: list[dict[str, Any]] = []
        seen: set[str] = set()
        cross_source_dupes = 0
        for res in results:
            kept_here = 0
            for entry in res["entries"]:
                if entry["url_hash"] in seen:
                    cross_source_dupes += 1
                    continue
                seen.add(entry["url_hash"])
                entry["source_url"] = res["url"]
                merged.append(entry)
                kept_here += 1
            res["kept"] = kept_here

        ok_count = sum(1 for r in results if r["ok"])
        for res in results:
            if res["ok"]:
                log.info(
                    "[INFO] 源 %d/%d 成功：%s（HTTP=%s，%.1f KB，解析 %d 个地址，本源内重复已忽略）",
                    res["index"], len(urls), res["url"], res["http_status"] or 200,
                    res["bytes"] / 1024.0, res["lines"],
                )
                for note in res["warnings"][:3]:
                    log.info("[INFO] 解析提示：%s", note)
            else:
                log.error(
                    "[FAIL] 源 %d/%d 失败：%s（%s）—— 保留该源上次成功的频道",
                    res["index"], len(urls), res["url"], res["error"],
                )

        if not merged:
            detail = "；".join(
                f"{r['index']}. {r['error'] or '无可用地址'}" for r in results if not r["ok"]
            )
            self.state["last_error"] = (detail or "订阅源解析结果为空")[:300]
            self.state["source_state"] = f"失败：{ok_count}/{len(urls)} 个源可用"
            log.error("[FAIL] 本轮没有任何订阅源拿到播放地址：%s", detail or "解析为空")
            # 库里旧频道一个都没动，状态页照样按源显示它们各自还留着多少条
            await self._publish_sources(results)
            return None

        if cross_source_dupes:
            log.info(
                "[INFO] 跨源去重：%d 个播放地址在多个源里重复出现，只保留第一个源的那条",
                cross_source_dupes,
            )

        stats = await asyncio.to_thread(
            self.db.sync_channels_from_source, merged, urls
        )
        log.info(
            "[INFO] 数据库更新：新增 %d，更新 %d，成功源里已下线 %d（失败的源不动，保留上次成功的频道）",
            stats["inserted"],
            stats["updated"],
            stats["removed"],
        )

        # 把每个源当前在册的频道数一并回填给状态页
        await self._publish_sources(results)

        now = int(time.time())
        await asyncio.to_thread(self.db.set_meta, "last_source_update", now)
        await asyncio.to_thread(self.db.set_meta, "last_source_count", len(merged))
        if ok_count == len(urls):
            self.state["source_state"] = f"成功，{len(urls)} 个源共 {len(merged)} 个地址"
            self.state["last_error"] = ""
        else:
            self.state["source_state"] = (
                f"部分成功，{ok_count}/{len(urls)} 个源可用，共 {len(merged)} 个地址"
            )
            first_error = next((r["error"] for r in results if not r["ok"]), "")
            self.state["last_error"] = first_error[:300]
        self.state["total_from_source"] = len(merged)
        return len(merged)

    async def _publish_sources(self, results: list[dict[str, Any]]) -> None:
        """把「每个订阅源这一轮怎么样 + 库里还留着它多少频道」一次性写进状态。

        整表建好再赋值，避免 /api/status 正在序列化时被我改到一半。
        """
        rows = await asyncio.to_thread(self.db.source_summary)
        summary = {str(r["source_url"] or ""): r for r in rows}
        configured = [
            str(u).strip() for u in self.config_store.get()["source_urls"] if str(u).strip()
        ]
        items: list[dict[str, Any]] = []

        if results:
            for res in results:
                row = summary.get(res["url"]) or {}
                items.append(
                    {
                        "index": res["index"],
                        "url": res["url"],
                        "fetched": True,
                        "ok": res["ok"],
                        "error": res["error"],
                        "http_status": res["http_status"],
                        "size_kb": round(res["bytes"] / 1024.0, 1),
                        "seconds": res["seconds"],
                        "lines": res["lines"],
                        "kept": res["kept"],
                        "channels": int(row.get("total") or 0),
                        "channels_ok": int(row.get("ok") or 0),
                    }
                )
        else:
            # 只测速不下载源的那一轮：源状态沿用库里的归属统计
            for index, url in enumerate(configured, start=1):
                row = summary.get(url) or {}
                total = int(row.get("total") or 0)
                items.append(
                    {
                        "index": index,
                        "url": url,
                        "fetched": False,
                        "ok": None,
                        "error": "",
                        "http_status": None,
                        "size_kb": 0.0,
                        "seconds": 0.0,
                        "lines": total,
                        "kept": total,
                        "channels": total,
                        "channels_ok": int(row.get("ok") or 0),
                    }
                )

        # 已经不配了、但库里还留着频道的地址（含升级前的老数据），单独一行说明，别让数字凭空消失
        orphans = [
            (url, row) for url, row in summary.items() if url not in configured
        ]
        if orphans:
            items.append(
                {
                    "index": len(configured) + 1,
                    "url": "（已不在配置里的地址 / 升级前的老数据）",
                    "fetched": False,
                    "ok": None,
                    "error": "",
                    "http_status": None,
                    "size_kb": 0.0,
                    "seconds": 0.0,
                    "lines": sum(int(r["total"]) for _, r in orphans),
                    "kept": sum(int(r["total"]) for _, r in orphans),
                    "channels": sum(int(r["total"]) for _, r in orphans),
                    "channels_ok": sum(int(r["ok"] or 0) for _, r in orphans),
                }
            )

        self.state["sources"] = items

    async def _fetch_source(
        self,
        cfg: dict[str, Any],
        url: str,
        index: int,
        total: int,
        sem: asyncio.Semaphore,
    ) -> dict[str, Any]:
        """下载并解析单个订阅源；任何异常都吞掉，只体现为这一条结果失败。"""
        res: dict[str, Any] = {
            "index": index,
            "url": url,
            "ok": False,
            "error": "",
            "http_status": None,
            "bytes": 0,
            "lines": 0,
            "kept": 0,
            "warnings": [],
            "seconds": 0.0,
            "entries": [],
        }
        started = time.time()
        try:
            async with sem:
                log.info("[INFO] 正在下载源 %d/%d：%s", index, total, url)
                data, error, http_status = await tester.download_source(cfg, url)
            res["http_status"] = http_status
            if data is None:
                res["error"] = error or "下载订阅文件失败"
                return res
            res["bytes"] = len(data)
            entries, warnings = await asyncio.to_thread(self._parse_bytes, data)
            res["lines"] = len(entries)
            res["warnings"] = list(warnings[:5])
            if not entries:
                res["error"] = "解析结果为空（格式不支持或内容为空）"
                return res
            res["ok"] = True
            res["entries"] = entries
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # 一个源出错不能拖垮整轮
            res["error"] = f"处理异常：{exc}"[:160]
            log.exception("[FAIL] 源 %d/%d 处理异常：%s", index, total, exc)
        finally:
            res["seconds"] = round(time.time() - started, 1)
        return res

    @staticmethod
    def _parse_bytes(data: bytes) -> tuple[list[dict[str, Any]], list[str]]:
        """解码 + 解析（CPU 活，放线程里跑，别卡住事件循环）。"""
        return m3u_parser.parse(m3u_parser.decode_bytes(data))


    # ------------------------------------------------------------------
    def _finalize_run(self, cancelled: bool = False) -> None:
        """给 runs 行收尾：取消或异常结束也要留下结束时间、实测数量和取消标记。

        这里故意用同步调用：CancelledError 已经发生后再 await 可能被二次取消，
        而这条 UPDATE 只有一两毫秒，阻塞事件循环可以接受。
        """
        run_id = self.state.get("run_id")
        if run_id is None or self.state.get("run_finalized"):
            return
        self.state["run_finalized"] = True
        try:
            self.db.finish_run(
                run_id,
                tested=int(self.state.get("done") or 0),
                ok=int(self.state.get("ok") or 0),
                failed=int(self.state.get("failed") or 0),
                total=int(self.state.get("total") or 0),
                cancelled=cancelled,
                error=self.state.get("last_error") or None,
                source_lines=self.state.get("total_from_source"),
            )
        except Exception as exc:  # 收尾失败不该影响主流程
            log.warning("[WARN] 写入运行记录失败：%s", exc)

    async def _test_all(self, cfg: dict[str, Any]) -> None:
        assert self.group is not None
        self.state["stage"] = "测速中"
        channels = await asyncio.to_thread(
            self.db.pending_test_channels, cfg.get("skip_failed_sources", False)
        )
        total = len(channels)
        if total == 0:
            log.warning("[WARN] 数据库里没有待测频道，跳过测速")
            self.state.update(total=0, done=0)
            return
        limit = concurrency_limited(cfg)
        skip_msg = "（已跳过失败源）" if cfg.get("skip_failed_sources") else ""
        log.info("[INFO] 开始测速%s，并发数=%d，超时=%ds，最低速度=%dKB/s", skip_msg, limit, cfg["timeout_seconds"], cfg["min_speed_kbps"])
        run_id = await asyncio.to_thread(self.db.create_run, self.state["kind"])
        self.state["run_id"] = run_id
        await asyncio.to_thread(self.db.update_run_progress, run_id, total=total)

        queue: asyncio.Queue = asyncio.Queue()
        for channel in channels:
            queue.put_nowait(channel)
        self.state.update(total=total, done=0, ok=0, failed=0)
        counters = {"done": 0, "ok": 0, "failed": 0}

        async def worker() -> None:
            while True:
                if self.state["cancel_requested"]:
                    return
                try:
                    channel = queue.get_nowait()
                except asyncio.QueueEmpty:
                    return
                self.state["current"] = channel["name"]
                try:
                    result = await tester.test_channel(cfg, channel, self.group)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # 一个 URL 出错不影响整个任务
                    log.exception("[FAIL] %s 检测过程异常：%s", channel["name"], exc)
                    result = {
                        "channel_id": channel["id"],
                        "name": channel["name"],
                        "url": channel["url"],
                        "attempts": [],
                        "winner": None,
                        "status": "parse_failed",
                        "failure_reason": f"检测过程异常：{exc}"[:160],
                        "ipv4_addr": None,
                        "ipv6_addr": None,
                    }
                if result["status"] == "cancelled":
                    return
                await self._record(run_id, channel, result, counters)

        workers = [asyncio.create_task(worker()) for _ in range(limit)]
        try:
            await asyncio.gather(*workers, return_exceptions=True)
        finally:
            for w in workers:
                if not w.done():
                    w.cancel()
            await asyncio.gather(*workers, return_exceptions=True)

        tested = counters["done"]
        log.info("[INFO] 测试完成：%d", tested)
        log.info("[INFO] 有效：%d", counters["ok"])
        log.info("[INFO] 失败：%d", counters["failed"])
        self.state.update(done=tested, ok=counters["ok"], failed=counters["failed"])
        self.state["run_finalized"] = True
        await asyncio.to_thread(
            self.db.finish_run,
            run_id,
            tested=tested,
            ok=counters["ok"],
            failed=counters["failed"],
            total=total,
            cancelled=self.state["cancel_requested"],
            error=self.state["last_error"] or None,
            source_lines=self.state.get("total_from_source"),
        )
        pruned = await asyncio.to_thread(self.db.prune_results)
        if pruned:
            log.info("[INFO] 清理过期测速历史 %d 行", pruned)

    async def _record(
        self,
        run_id: int,
        channel: dict[str, Any],
        result: dict[str, Any],
        counters: dict[str, int],
    ) -> None:
        winner = result.get("winner")
        passing = result["status"] in statuses.PASSING_STATUSES
        counters["done"] += 1
        if passing:
            counters["ok"] += 1
            view = winner or {}
            log_ok(
                "%s",
                tester.format_ok_line(channel["name"], view),
            )
        else:
            counters["failed"] += 1
            log_fail(
                "%s %s：%s%s",
                channel["name"],
                statuses.label(result["status"]),
                result["failure_reason"] or "-",
                "" if len(result.get("attempts") or []) < 2 else f" [{tester.summarize(result['attempts'])}]",
            )
        await asyncio.to_thread(
            self.db.record_test, run_id, channel["id"], result.get("attempts") or [], winner, result
        )
        self.state.update(done=counters["done"], ok=counters["ok"], failed=counters["failed"])
        if counters["done"] % _PROGRESS_EVERY == 0:
            await asyncio.to_thread(
                self.db.update_run_progress,
                run_id,
                tested=counters["done"],
                ok=counters["ok"],
                failed=counters["failed"],
            )

    async def _write_outputs(self, cfg: dict[str, Any]) -> None:
        self.state["stage"] = "生成播放列表"
        rows_ok = await asyncio.to_thread(self.db.channels_for_output, cfg)
        rows_all = await asyncio.to_thread(self.db.all_active_for_output)
        # 多个源里同一个频道（同 tvg-id，缺 tvg-id 时同名）只留实测最快的一条，
        # 落选的那些仍然完整留在 iptv_all.m3u 和 results.csv 里。
        merged, collapsed = await asyncio.to_thread(outputs.collapse_fastest, rows_ok)
        files = await asyncio.to_thread(outputs.write_outputs, merged, rows_all, OUTPUT_DIR)
        await asyncio.to_thread(self.db.set_meta, "last_output_write", int(time.time()))
        await asyncio.to_thread(self.db.set_meta, "last_tested_at", int(time.time()))
        await asyncio.to_thread(self.db.set_meta, "last_valid_count", len(merged))
        if collapsed:
            log.info("[INFO] 跨源合并：%d 个频道在多个源里重复，已只保留速度最快的一条", collapsed)
        log.info(
            "[INFO] 已生成 %s（%d 个频道），iptv_all.m3u（%d 个），iptv_ipv4.m3u（%d 个），"
            "iptv_ipv6.m3u（%d 个），results.csv",
            OUTPUT_DIR / "iptv.m3u",
            files["iptv.m3u"],
            files["iptv_all.m3u"],
            files["iptv_ipv4.m3u"],
            files["iptv_ipv6.m3u"],
        )
        self.state["outputs"] = files
        self.state["merged_duplicates"] = collapsed

    async def _safe_write_outputs(self, cfg: dict[str, Any]) -> None:
        try:
            await self._write_outputs(cfg)
        except Exception as exc:
            log.exception("[FAIL] 生成播放列表失败：%s", exc)
