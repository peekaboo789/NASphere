"""测速状态的机器码与中文标签。"""

from __future__ import annotations

from typing import Any

STATUS_LABELS: dict[str, str] = {
    "pending": "未测试",
    "ok": "可用",
    "audio_only": "可用(仅音频)",
    "connect_failed": "连接失败",
    "http_error": "HTTP错误",
    "timeout": "超时",
    "no_video": "无视频流",
    "no_audio": "无音频流",
    "parse_failed": "解析失败",
    "slow": "速度过慢",
    "unsupported": "协议不支持",
    # 不是源的问题，是本机/容器里 ffmpeg 这套工具跑不起来
    "engine_missing": "检测工具不可用",
}

# 进入最终播放列表的状态
PASSING_STATUSES = ("ok", "audio_only")

# 「地址本身给了什么」这一层的展示文案：和上面的测速状态是两回事
SEGMENT_LABELS: dict[str, str] = {
    "": "未测试",
    "none": "无分片请求",
    "ok": "分片全部可读",
    "partial": "个别分片失败（不判死）",
    "failed": "分片全部失败",
    "unknown": "HTTPS 隧道内不可见",
}


def segment_label(value: str | None) -> str:
    return SEGMENT_LABELS.get(value or "", value or "未测试")


def tri_label(value: Any) -> str:
    """三态布尔的中文：1/True→是、0/False→否、None→未知。"""
    if value is None:
        return "未知"
    return "是" if value else "否"


def label(status: str | None) -> str:
    return STATUS_LABELS.get(status or "pending", status or "未测试")
