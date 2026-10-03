"""日志：控制台 + /data/logs/app.log 轮转文件。

日志文案统一带 [INFO]/[OK]/[FAIL]/[WARN] 前缀，方便在 Docker 日志里 grep。
"""

from __future__ import annotations

import logging
import sys
from logging.handlers import RotatingFileHandler

from .config import LOG_DIR, ensure_dirs

_FORMAT = "%(asctime)s %(message)s"
_DATEFMT = "%Y-%m-%d %H:%M:%S"
_configured = False

# 自定义级别：日志里直接出现 [OK] / [FAIL]，与需求里的样例格式一致
LEVEL_OK = 25
LEVEL_FAIL = 35
logging.addLevelName(LEVEL_OK, "OK")
logging.addLevelName(LEVEL_FAIL, "FAIL")


def log_ok(message: str, *args: object) -> None:
    """[OK] 级日志，用法和 log.info 一样支持 %s 占位符。"""
    get_logger().log(LEVEL_OK, f"[OK] {message}", *args)


def log_fail(message: str, *args: object) -> None:
    get_logger().log(LEVEL_FAIL, f"[FAIL] {message}", *args)


class _StdoutEncodingFilter(logging.Filter):
    """Windows 控制台默认 GBK，中文日志不能因为编码问题丢行。"""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            record.getMessage().encode(sys.stderr.encoding or "utf-8")
        except UnicodeEncodeError:
            record.msg = record.getMessage().encode(
                sys.stderr.encoding or "ascii", "replace"
            ).decode(sys.stderr.encoding or "ascii", "replace")
            record.args = ()
        return True


class _LevelTagFilter(logging.Filter):
    """uvicorn 自带的日志没有 [TAG] 前缀，补上之后整套日志格式统一。"""

    def filter(self, record: logging.LogRecord) -> bool:
        text = record.getMessage()
        if not text.startswith("["):
            record.msg = f"[{record.levelname}] {text}"
            record.args = ()
        return True


def setup_logging() -> logging.Logger:
    global _configured
    logger = logging.getLogger("iptv")
    if _configured:
        return logger

    ensure_dirs()
    logger.setLevel(logging.INFO)
    logger.propagate = False
    formatter = logging.Formatter(_FORMAT, datefmt=_DATEFMT)

    file_handler = RotatingFileHandler(
        LOG_DIR / "app.log", maxBytes=5 * 1024 * 1024, backupCount=5, encoding="utf-8"
    )
    file_handler.setFormatter(formatter)
    logger.addHandler(file_handler)

    stream = logging.StreamHandler(sys.stdout)
    stream.setFormatter(formatter)
    stream.addFilter(_StdoutEncodingFilter())
    logger.addHandler(stream)

    # uvicorn 的访问日志太吵，只保留错误；错误行补上 [LEVEL] 前缀，格式统一
    for noisy in ("uvicorn.access", "uvicorn.error"):
        target = logging.getLogger(noisy)
        target.handlers = logger.handlers
        target.propagate = False
        target.addFilter(_LevelTagFilter())
        if noisy == "uvicorn.access":
            target.setLevel(logging.WARNING)

    _configured = True
    return logger


def get_logger() -> logging.Logger:
    return logging.getLogger("iptv")


def tail_log(lines: int = 200) -> list[str]:
    """读取日志文件尾部，供 Web 页面展示。"""
    path = LOG_DIR / "app.log"
    if not path.exists():
        return []
    try:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            data = fh.readlines()
    except OSError:
        return []
    return [line.rstrip("\n") for line in data[-max(1, min(lines, 2000)) :]]
