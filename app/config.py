"""应用配置：/data/config.json 读写 + 环境变量 + 校验。

机器可读的配置字段保持稳定；Web 页面只暴露用户真正需要改的项。
"""

from __future__ import annotations

import copy
import json
import os
import re
import threading
from pathlib import Path
from typing import Any

# --------------------------------------------------------------------------
# 路径：容器内 DATA_DIR=/data，本机开发时用环境变量指向本地目录
# --------------------------------------------------------------------------
DATA_DIR = Path(os.environ.get("DATA_DIR") or (Path.cwd() / "data")).resolve()
OUTPUT_DIR = DATA_DIR / "output"
LOG_DIR = DATA_DIR / "logs"
CONFIG_PATH = DATA_DIR / "config.json"
DB_PATH = DATA_DIR / "database.db"


def ensure_dirs() -> None:
    for p in (DATA_DIR, OUTPUT_DIR, LOG_DIR):
        p.mkdir(parents=True, exist_ok=True)


# --------------------------------------------------------------------------
# 服务级配置（只来自环境变量，属于部署参数，不在 Web 页面上改）
# --------------------------------------------------------------------------
SERVER_PORT = int(os.environ.get("PORT", "9001"))
ADMIN_USER = os.environ.get("ADMIN_USER", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
FFMPEG_PATH = os.environ.get("FFMPEG_PATH", "ffmpeg")
FFPROBE_PATH = os.environ.get("FFPROBE_PATH", "ffprobe")

# --------------------------------------------------------------------------
# 用户配置默认值
# --------------------------------------------------------------------------
DEFAULT_CONFIG: dict[str, Any] = {
    "source_urls": [],
    "update_interval_minutes": 30,
    "concurrency": 30,
    "timeout_seconds": 8,
    "min_speed_kbps": 500,
    "min_success_count": 1,
    "ip_prefer": "auto",
    "user_agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "skip_failed_sources": False,  # 是否跳过失败的源，只测成功的 + 新源
}

# 页面上给出的周期候选（分钟），“自定义”允许任意 1..1440
INTERVAL_PRESETS = [10, 30, 60, 120, 360, 720, 1440]
CONCURRENCY_PRESETS = [10, 20, 30, 40, 50, 100]
IP_PREFER_MODES = ("auto", "ipv4_preferred", "ipv6_preferred", "ipv4_only", "ipv6_only")
IP_PREFER_LABELS = {
    "auto": "自动选择",
    "ipv4_preferred": "IPv4优先",
    "ipv6_preferred": "IPv6优先",
    "ipv4_only": "仅IPv4",
    "ipv6_only": "仅IPv6",
}

# 订阅源数量上限：再多就只是把同一批地址反复下载，反而拖长每一轮的时间
MAX_SOURCES = 20

# 测速采样窗口：结构校验通过后，再用这么长的时间实测吞吐（秒）
SPEED_SAMPLE_SECONDS = 3.0
# 吞吐采样的最小分母：整个文件在一次读取里就到齐时，实测秒数会小到没有统计意义，
# 用一个下限把速度封顶，避免报出几十 GB/s 这种没法比较的数字。
MIN_SAMPLE_SPAN_SECONDS = 0.05
# 单次 ffprobe 允许下载的最大字节数，用来限制探测阶段的带宽占用
PROBE_SIZE_BYTES = 1_000_000
# ffprobe 分析时长上限（微秒）
ANALYZE_DURATION_US = 2_000_000

_URL_RE = re.compile(r"^https?://[^\s]+$", re.I)


def _clamp(value: int | float, low: int | float, high: int | float) -> int | float:
    return max(low, min(high, value))


def _as_int(raw: Any, fallback: int, low: int, high: int, errors: list[str], label: str) -> int:
    try:
        num = int(float(str(raw).strip()))
    except (TypeError, ValueError):
        errors.append(f"{label} 必须是数字")
        return fallback
    if num < low or num > high:
        errors.append(f"{label} 超出允许范围（{low}~{high}）")
        return fallback
    return num


def _clean_source_urls(raw: dict[str, Any], errors: list[str]) -> list[str]:
    """把页面上的多行文本 / 列表 / 老版单源字段统一成去重后的地址列表。

    老 config.json 里只有一个 source_url，升级时直接并进列表，不让用户重填一次。
    """
    value = raw.get("source_urls", None)
    if isinstance(value, str):
        items = value.splitlines()
    elif isinstance(value, (list, tuple)):
        items = [str(x) for x in value]
    else:
        items = []

    legacy = str(raw.get("source_url", "") or "").strip()
    # 老配置里 source_urls 是空列表（DEFAULT 合并进来的），这时要认 source_url，
    # 否则升级后第一次读配置就会把用户原来填的源当成没填。
    if not any(str(x).strip() for x in items) and legacy:
        items = [legacy]

    cleaned: list[str] = []
    seen: set[str] = set()
    for item in items:
        one = str(item or "").strip().strip('"').strip("'")
        if not one:
            continue
        if not _URL_RE.match(one):
            errors.append(f"源地址必须是 http:// 或 https:// 开头的完整地址：{one[:80]}")
            continue
        if one in seen:
            continue
        seen.add(one)
        cleaned.append(one)

    if not cleaned and not errors:
        errors.append("至少要填一个订阅源地址（多个可以一行一个）")
    if len(cleaned) > MAX_SOURCES:
        errors.append(f"订阅源最多 {MAX_SOURCES} 个，当前 {len(cleaned)} 个")
    return cleaned


def validate(raw: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """返回 (清洗后的配置, 错误信息列表)。错误项回退到旧值或默认值。"""
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    errors: list[str] = []

    cfg["source_urls"] = _clean_source_urls(raw, errors)

    cfg["update_interval_minutes"] = _as_int(
        raw.get("update_interval_minutes"),
        DEFAULT_CONFIG["update_interval_minutes"],
        1,
        1440,
        errors,
        "更新周期（分钟）",
    )
    cfg["concurrency"] = _as_int(
        raw.get("concurrency"), DEFAULT_CONFIG["concurrency"], 1, 200, errors, "并发数"
    )
    cfg["timeout_seconds"] = _as_int(
        raw.get("timeout_seconds"), DEFAULT_CONFIG["timeout_seconds"], 3, 120, errors, "超时时间（秒）"
    )
    cfg["min_speed_kbps"] = _as_int(
        raw.get("min_speed_kbps"), DEFAULT_CONFIG["min_speed_kbps"], 0, 100_000, errors, "最低速度（KB/s）"
    )
    cfg["min_success_count"] = _as_int(
        raw.get("min_success_count"), DEFAULT_CONFIG["min_success_count"], 1, 1000, errors, "最小成功次数"
    )

    prefer = str(raw.get("ip_prefer", "auto") or "auto").strip().lower()
    if prefer not in IP_PREFER_MODES:
        errors.append("IPv4/IPv6 策略取值不合法")
        prefer = "auto"
    cfg["ip_prefer"] = prefer

    ua = str(raw.get("user_agent", "") or "").strip()
    cfg["user_agent"] = ua or DEFAULT_CONFIG["user_agent"]

    # 跳过失败源：布尔值，默认 False
    skip_failed = raw.get("skip_failed_sources")
    if skip_failed is None:
        cfg["skip_failed_sources"] = DEFAULT_CONFIG["skip_failed_sources"]
    else:
        cfg["skip_failed_sources"] = bool(skip_failed)

    return cfg, errors


class ConfigStore:
    """线程安全的配置读写。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._data: dict[str, Any] = copy.deepcopy(DEFAULT_CONFIG)
        self.load()

    def load(self) -> None:
        ensure_dirs()
        if CONFIG_PATH.exists():
            try:
                with CONFIG_PATH.open("r", encoding="utf-8") as fh:
                    on_disk = json.load(fh)
                if isinstance(on_disk, dict):
                    merged = {**DEFAULT_CONFIG, **on_disk}
                    cleaned, _ = validate(merged)
                    # 首次启动时源地址为空是正常状态，不要把提示当成错误
                    self._data = cleaned
            except (OSError, ValueError) as exc:
                print(f"[WARN] 读取 {CONFIG_PATH} 失败：{exc}，使用默认配置")
        else:
            self.save()

    def save(self) -> None:
        with self._lock:
            ensure_dirs()
            tmp = CONFIG_PATH.with_suffix(".json.tmp")
            with tmp.open("w", encoding="utf-8", newline="\n") as fh:
                json.dump(self._data, fh, ensure_ascii=False, indent=2)
            os.replace(tmp, CONFIG_PATH)

    def get(self) -> dict[str, Any]:
        with self._lock:
            return copy.deepcopy(self._data)

    def update(self, patch: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
        """整体校验后落盘；有错误时保留原配置。"""
        current = self.get()
        candidate = {**current, **patch}
        cleaned, errors = validate(candidate)
        if errors:
            return current, errors
        with self._lock:
            self._data = cleaned
        self.save()
        return cleaned, []

    def replace(self, cfg: dict[str, Any]) -> None:
        with self._lock:
            self._data = {**DEFAULT_CONFIG, **cfg}
        self.save()


store = ConfigStore()


def get_config() -> dict[str, Any]:
    return store.get()


def concurrency_limited(cfg: dict[str, Any]) -> int:
    """并发数最终还要受 CPU 上限约束，避免 NAS 上开太多 ffmpeg 进程。"""
    cpu_budget = max(4, (os.cpu_count() or 4) * 6)
    return int(_clamp(cfg["concurrency"], 1, min(200, cpu_budget)))
