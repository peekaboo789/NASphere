"""HTTP 服务：Web 管理页面 + 播放器用的 M3U/CSV 输出。

端口：容器内 9001（PORT 环境变量可改）。
鉴权：管理页面与 /api/* 走 Basic Auth（ADMIN_USER / ADMIN_PASSWORD）；
      /iptv.m3u 等播放列表与 results.csv 不鉴权，电视盒子、TiviMate 直接订阅。
"""

from __future__ import annotations

import asyncio
import hmac
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles

from . import config as config_module
from . import outputs, tester
from .config import ADMIN_PASSWORD, ADMIN_USER, DATA_DIR, MAX_SOURCES, OUTPUT_DIR, SERVER_PORT
from .db import Database
from .logging_setup import get_logger, setup_logging, tail_log
from .pipeline import Pipeline, ipv6_capability
from .scheduler import Scheduler
from .statuses import STATUS_LABELS

log = get_logger()

# 播放器访问这些路径不需要账号密码
OPEN_PATHS = {
    "/iptv.m3u",
    "/iptv_all.m3u",
    "/iptv_ipv4.m3u",
    "/iptv_ipv6.m3u",
    "/results.csv",
    "/healthz",
    "/favicon.ico",
}

MEDIA_TYPES = {
    # 播放列表用 text/plain 而不是 audio/x-mpegurl：飞牛影视等播放器按 MIME 决定
    # 「这是订阅文本还是一个视频」，给 audio/x-mpegurl 时它会把这个文件当视频去播放，
    # 结果就是订阅导入不了。text/plain 对普通播放器（TiviMate / Kodi / VLC）无影响。
    ".m3u": "text/plain; charset=utf-8",
    ".m3u8": "text/plain; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
}

db = Database()
store = config_module.store
pipeline = Pipeline(db, store)
scheduler = Scheduler(pipeline, store)


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging()
    log.info("[INFO] IPTV Auto Tester 启动，数据目录=%s，端口=%d", DATA_DIR, SERVER_PORT)
    capability = pipeline.ipv6
    if capability.get("available") is False:
        log.warning(
            "[WARN] 容器内没有可用的 IPv6 出口（%s），IPv6 检测会全部记为连接失败；"
            "需要 IPv6 时请使用 network_mode: host 或为 Docker 开启 IPv6",
            capability.get("detail"),
        )
    elif capability.get("available"):
        log.info("[INFO] 检测到 IPv6 出口：%s", capability.get("detail"))
    if not ADMIN_PASSWORD:
        log.warning("[WARN] 未设置 ADMIN_PASSWORD，管理页面当前为匿名可访问")
    else:
        log.info("[INFO] 管理页面已启用 Basic Auth，用户名=%s", ADMIN_USER)
    cfg = store.get()
    if cfg["source_urls"]:
        log.info("[INFO] 已配置 %d 个订阅源：%s", len(cfg["source_urls"]), "， ".join(cfg["source_urls"]))
    else:
        log.info("[INFO] 尚未配置订阅源地址，请打开 http://NAS_IP:%d/ 填写", SERVER_PORT)
    tools_ok, tools_error = await tester.check_tools()
    pipeline.set_engine_state(tools_ok, tools_error)
    if tools_ok:
        log.info(
            "[INFO] 检测工具就绪：ffprobe=%s，ffmpeg=%s",
            config_module.FFPROBE_PATH,
            config_module.FFMPEG_PATH,
        )
    else:
        log.error(
            "[ERROR] 检测工具不可用，测速不会启动，管理页会同样提示：%s（镜像里应当自带 "
            "ffmpeg 与 ffprobe，请检查这两个路径）",
            tools_error,
        )
    scheduler.start()
    try:
        yield
    finally:
        log.info("[INFO] 收到停止信号，正在结束正在进行的测速任务")
        scheduler.stop()
        await scheduler.shutdown()
        if pipeline.group is not None:
            pipeline.group.kill_all()
        if pipeline.busy:
            try:
                await asyncio.wait_for(pipeline.task, 10)
            except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
                pass
        db.close()
        log.info("[INFO] 已退出")


app = FastAPI(title="IPTV Auto Tester", docs_url=None, redoc_url=None, lifespan=lifespan)


# --------------------------------------------------------------------------
# 鉴权
# --------------------------------------------------------------------------
def _authorized(request: Request) -> bool:
    if not ADMIN_PASSWORD:
        return True
    header = request.headers.get("authorization", "")
    if not header.lower().startswith("basic "):
        return False
    import base64

    try:
        decoded = base64.b64decode(header.split(None, 1)[1]).decode("utf-8", "replace")
    except (ValueError, UnicodeError):
        return False
    user, _, password = decoded.partition(":")
    return hmac.compare_digest(user, ADMIN_USER) and hmac.compare_digest(password, ADMIN_PASSWORD)


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    path = request.url.path
    if path in OPEN_PATHS or path.startswith("/static/"):
        return await call_next(request)
    if _authorized(request):
        return await call_next(request)
    return HTMLResponse(
        "<h1>401</h1><p>需要账号密码访问 IPTV Auto Tester 管理页面。</p>",
        status_code=401,
        headers={"WWW-Authenticate": 'Basic realm="IPTV Auto Tester"'},
    )


# --------------------------------------------------------------------------
# 播放列表 / CSV 输出
# --------------------------------------------------------------------------
def _serve_file(name: str, fallback_comment: str) -> Response:
    path = OUTPUT_DIR / name
    suffix = Path(name).suffix.lower()
    media_type = MEDIA_TYPES.get(suffix, "application/octet-stream")
    if not path.exists():
        # 播放器只需要一个永远可用的固定地址：还没有成功跑过第一轮时给一个合法的空列表
        body = f"#EXTM3U\n# {fallback_comment}\n"
        if suffix == ".csv":
            body = "\ufeff" + ",".join(outputs.CSV_FIELDS) + "\r\n"
        return Response(content=body.encode("utf-8"), media_type=media_type, status_code=200,
                        headers={"X-IPTV-Status": "not-ready", "Cache-Control": "no-store"})
    return FileResponseLike(path, media_type).build()


class FileResponseLike:
    """自己拼 Response：保证 Content-Type、Content-Length 和 no-cache 都对播放器友好。"""

    def __init__(self, path: Path, media_type: str) -> None:
        self.path = path
        self.media_type = media_type

    def build(self) -> Response:
        try:
            content = self.path.read_bytes()
        except OSError as exc:
            log.error("[FAIL] 读取 %s 失败：%s", self.path, exc)
            return PlainTextResponse("输出文件读取失败", status_code=500)
        return Response(
            content=content,
            media_type=self.media_type,
            headers={
                "Content-Length": str(len(content)),
                "Cache-Control": "no-cache, no-store, must-revalidate",
                "Accept-Ranges": "none",
                "X-IPTV-Generated": str(int(self.path.stat().st_mtime)),
            },
        )


@app.get("/iptv.m3u")
async def playlist_main() -> Response:
    return _serve_file("iptv.m3u", "还没有完成第一次成功的更新，播放器暂时拿不到频道")


@app.get("/iptv_all.m3u")
async def playlist_all() -> Response:
    return _serve_file("iptv_all.m3u", "还没有完成第一次成功的更新")


@app.get("/iptv_ipv4.m3u")
async def playlist_ipv4() -> Response:
    return _serve_file("iptv_ipv4.m3u", "还没有 IPv4 可用频道")


@app.get("/iptv_ipv6.m3u")
async def playlist_ipv6() -> Response:
    return _serve_file("iptv_ipv6.m3u", "还没有 IPv6 可用频道")


@app.get("/results.csv")
async def results_csv() -> Response:
    return _serve_file("results.csv", "还没有测速记录")


@app.get("/healthz")
async def healthz() -> JSONResponse:
    return JSONResponse(
        {
            "ok": True,
            "time": int(time.time()),
            "running": pipeline.busy,
            "ffmpeg": config_module.FFMPEG_PATH,
            "ffprobe": config_module.FFPROBE_PATH,
        }
    )


# --------------------------------------------------------------------------
# 管理 API
# --------------------------------------------------------------------------
@app.get("/api/config")
async def api_config() -> JSONResponse:
    return JSONResponse(
        {
            "config": store.get(),
            "presets": {
                "intervals": config_module.INTERVAL_PRESETS,
                "concurrency": config_module.CONCURRENCY_PRESETS,
                "ip_prefer": [
                    {"value": key, "label": label}
                    for key, label in config_module.IP_PREFER_LABELS.items()
                ],
            },
            "auth_enabled": bool(ADMIN_PASSWORD),
            "data_dir": str(DATA_DIR),
            "port": SERVER_PORT,
        }
    )


@app.post("/api/config")
async def api_save_config(request: Request) -> JSONResponse:
    try:
        payload = await request.json()
    except ValueError:
        return JSONResponse({"ok": False, "errors": ["请求体不是合法的 JSON"]}, status_code=400)
    if not isinstance(payload, dict):
        return JSONResponse({"ok": False, "errors": ["请求体必须是对象"]}, status_code=400)
    previous_sources = store.get()["source_urls"]
    saved, errors = store.update(payload)
    if errors:
        log.warning("[WARN] 配置保存被拒绝：%s", "；".join(errors))
        return JSONResponse({"ok": False, "errors": errors, "config": saved}, status_code=400)
    log.info(
        "[INFO] 配置已保存：源=%d 个（%s）周期=%d分钟 并发=%d 超时=%ds 最低速度=%dKB/s 策略=%s",
        len(saved["source_urls"]), "， ".join(saved["source_urls"]),
        saved["update_interval_minutes"], saved["concurrency"],
        saved["timeout_seconds"], saved["min_speed_kbps"], saved["ip_prefer"],
    )
    # 只有换了订阅地址列表才马上重测；调阈值、调并发只重排下一次自动更新
    scheduler.reschedule_now(
        immediate=bool(saved["source_urls"]) and saved["source_urls"] != previous_sources
    )

    return JSONResponse({"ok": True, "config": saved, "next_run_in_seconds": scheduler.snapshot()["next_in_seconds"]})


@app.post("/api/update")
async def api_update() -> JSONResponse:
    error = await pipeline.start(kind="manual", refresh_source=True)
    return JSONResponse({"ok": not error, "message": error or "已开始：下载源 + 解析 + 测速 + 生成"})


@app.post("/api/test")
async def api_test() -> JSONResponse:
    error = await pipeline.start(kind="test_only", refresh_source=False)
    return JSONResponse({"ok": not error, "message": error or "已开始：只测速（不重新下载源）"})


@app.post("/api/cancel")
async def api_cancel() -> JSONResponse:
    error = await pipeline.cancel()
    return JSONResponse({"ok": not error, "message": error or "已请求取消"})


@app.get("/api/status")
async def api_status() -> JSONResponse:
    state = pipeline.snapshot()
    stats = db.stats()
    run = db.latest_run()
    return JSONResponse(
        {
            "state": state,
            "stats": {**stats, "source_count": db.get_int_meta("last_source_count")},
            "config": store.get(),
            "latest_run": run,
            "scheduler": scheduler.snapshot(),
            "runs": db.recent_runs(8),
            "ipv6": ipv6_capability(),
            "status_labels": STATUS_LABELS,
            "outputs": _output_info(),
        }
    )


def _output_info() -> list[dict[str, Any]]:
    items = []
    for name in ("iptv.m3u", "iptv_all.m3u", "iptv_ipv4.m3u", "iptv_ipv6.m3u", "results.csv"):
        path = OUTPUT_DIR / name
        exists = path.exists()
        items.append(
            {
                "name": name,
                "exists": exists,
                "size": path.stat().st_size if exists else 0,
                "mtime": int(path.stat().st_mtime) if exists else None,
            }
        )
    return items


@app.get("/api/channels")
async def api_channels(
    q: str = Query("", description="按频道名/URL 搜索"),
    group: str = Query(""),
    status: str = Query("", description="ok / bad / 具体状态码"),
    source: str = Query("", description="按订阅源筛选；__legacy__ = 升级前的老数据"),
    sort: str = Query("name"),
    direction: str = Query("asc"),
    page: int = Query(1, ge=1),
    limit: int = Query(100, ge=1, le=1000),
    include_inactive: bool = Query(False),
) -> JSONResponse:
    data = db.list_channels(
        q=q,
        group=group,
        status=status,
        source=source,
        sort=sort,
        direction=direction,
        only_active=not include_inactive,
        page=page,
        limit=limit,
    )
    return JSONResponse(data)


@app.get("/api/sources")
async def api_sources() -> JSONResponse:
    """每个订阅源的在册频道数，供状态页/频道页按来源展示与筛选。"""
    return JSONResponse(
        {
            "sources": db.source_summary(),
            "configured": store.get()["source_urls"],
            "max_sources": MAX_SOURCES,
        }
    )


@app.get("/api/channels/{channel_id}/history")
async def api_channel_history(channel_id: int, limit: int = Query(30, ge=1, le=200)) -> JSONResponse:
    return JSONResponse({"history": db.channel_history(channel_id, limit)})


@app.get("/api/groups")
async def api_groups() -> JSONResponse:
    return JSONResponse({"groups": db.groups()})


@app.get("/api/logs")
async def api_logs(lines: int = Query(200, ge=1, le=2000)) -> JSONResponse:
    return JSONResponse({"lines": tail_log(lines)})


app.mount("/static", StaticFiles(directory=str(Path(__file__).parent / "static")), name="static")


@app.get("/", response_class=HTMLResponse)
async def index() -> HTMLResponse:
    return _page("index.html")


@app.get("/channels", response_class=HTMLResponse)
async def channels_page() -> HTMLResponse:
    return _page("channels.html")


def _page(name: str) -> HTMLResponse:
    path = Path(__file__).parent / "static" / name
    if not path.exists():
        return HTMLResponse("<h1>页面文件缺失</h1>", status_code=500)
    return HTMLResponse(path.read_text(encoding="utf-8"), headers={"Cache-Control": "no-store"})
