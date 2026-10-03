#!/usr/bin/env python3
"""播放器兼容判据：产物 M3U 的「形状」与对外 Content-Type。

为什么要有这个脚本：飞牛影视（fnOS 影视）这类播放器对订阅列表有两道硬要求，
任何一道不满足就会「导入成功但只认出几个频道」——

1. 响应必须是文本类型。以 `audio/x-mpegurl` 下发时，飞牛会把这个文件当成
   「一个视频」去播放，而不是当订阅文本解析；
2. `#EXTINF` 之后必须紧跟播放地址。中间多一行标签（我们以前无条件加的
   `#EXTGRP:`，以及只含缓冲提示的 `#EXTVLCOPT:network-caching`）时，
   部分版本只认「紧接的下一行」，整个频道会被丢掉。

本脚本分两段：

* 离线段（不需要网络、不需要 ffmpeg）：直接调 `app.outputs` 生成列表，逐条核对形状，
  并且**必须**在注入违规的坏列表上报红（负向控制，证明判据不是永远绿的）；
* 在线段（给 `--base` 时）：对真实运行中的实例核对 `/iptv.m3u` 等产物的
  `Content-Type`，并把线上拿到的列表正文再过一遍同一个形状检查。

用法：
    python dev-tools/unit_player_compat.py                      # 只跑离线段
    python dev-tools/unit_player_compat.py --base http://127.0.0.1:9001
    python dev-tools/unit_player_compat.py --from-file live_iptv.m3u   # 再加真实列表重渲染
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import outputs  # noqa: E402

# 允许出现在 #EXTINF 与播放地址之间的行：只有播放必需的指令
PLAYBACK_DIRECTIVES = ("#EXTVLCOPT", "#EXTHTTP", "#KODIPROP", "#EXTKODIPROP")


def _row(**over):
    """一条最小可用的 channels 记录（字段名与 db 列一致）。"""
    row = {
        "url": "http://127.0.0.1:8099/live/test.ts",
        "name": "本地TS直连",
        "tvg_id": "LOCAL.TS",
        "tvg_name": "本地TS直连",
        "group_title": "本地测试",
        "logo": "http://logo/ts.png",
        "duration": "-1",
        "attrs": {},
        "extra_lines": [],
    }
    row.update(over)
    return row


def check_shape(text: str, expected_urls: list[str] | None = None) -> list[str]:
    """检查一份 M3U 正文的「形状」，返回违规说明列表（空列表 = 全部合规）。

    `expected_urls` 给定时额外核对地址列表与输入完全一致（离线段用）；
    在线段拿不到「输入」，传 None 跳过这条，避免变成永远成立的空判据。
    """
    bad: list[str] = []
    lines = text.splitlines()
    if not lines or lines[0].strip() != "#EXTM3U":
        bad.append(f"首行不是裸的 #EXTM3U（实际 {lines[0] if lines else '<空文件>'!r}）")

    urls: list[str] = []
    for i, line in enumerate(lines):
        if not line.startswith("#EXTINF"):
            continue
        j = i + 1
        between: list[str] = []
        while j < len(lines) and lines[j].startswith("#"):
            between.append(lines[j])
            j += 1
        for b in between:
            up = b.upper()
            if up.startswith("#EXTGRP"):
                bad.append(f"第 {j} 行前 #EXTINF 与地址之间出现了 {b!r}")
            elif not up.startswith(PLAYBACK_DIRECTIVES):
                bad.append(f"第 {j} 行前夹了非播放必需的指令 {b!r}")
        if j >= len(lines):
            bad.append(f"第 {i + 1} 行的 #EXTINF 后面没有地址")
            continue
        url = lines[j].strip()
        if not url or url.startswith("#"):
            bad.append(f"第 {i + 2} 行 #EXTINF 之后第一行不是地址：{url!r}")
            continue
        urls.append(url)
        if "," not in line.split(":", 1)[-1]:
            bad.append(f"#EXTINF 缺少「,...频道名」部分：{line[:60]}")
        if not line.split(",", 1)[-1].strip():
            bad.append(f"#EXTINF 的频道名是空的：{line[:60]}")
    if expected_urls is not None and urls != expected_urls:
        bad.append(f"地址顺序/数量与输入不一致：{len(urls)} vs {len(expected_urls)}")
    return bad


def offline_checks() -> tuple[list[tuple[str, bool, str]], str]:
    results: list[tuple[str, bool, str]] = []

    def add(name: str, ok: bool, detail: str = "") -> None:
        results.append((name, bool(ok), detail))

    rows = [
        _row(),
        _row(url="http://127.0.0.1:8099/hls/test.m3u8", name="HLS频道",
             tvg_id="LOCAL.HLS", group_title=""),
        _row(url="https://example.com/x.m3u8", name="需要请求头的频道",
             tvg_id="LOCAL.UA", group_title="需要鉴权",
             extra_lines=["#EXTVLCOPT:http-user-agent=Mozilla/5.0",
                          "#EXTVLCOPT:http-referrer=https://example.com",
                          "#KODIPROP:inputstream=inputstream.adaptive"]),
    ]
    text = outputs.build_m3u(rows, "可用频道")
    urls = [r["url"] for r in rows]
    violations = check_shape(text, urls)
    add("生成的列表形状合规（#EXTINF 之后紧跟地址）", not violations, "; ".join(violations))
    add("首行是裸 #EXTM3U", text.splitlines()[0] == "#EXTM3U", text.splitlines()[0])
    add("不再输出 #EXTGRP", "#EXTGRP" not in text, f"出现次数 {text.count('#EXTGRP')}")
    add("group-title 仍在 #EXTINF 里",
        'group-title="本地测试"' in text and 'group-title="需要鉴权"' in text, "")
    add("播放必需的 #EXTVLCOPT / #KODIPROP 仍保留",
        "#EXTVLCOPT:http-user-agent=Mozilla/5.0" in text
        and "#EXTVLCOPT:http-referrer=https://example.com" in text
        and "#KODIPROP:inputstream=inputstream.adaptive" in text, "")
    add("没有分组名的频道也不会被塞进多余标签",
        all(not l.startswith("#EXTGRP") for l in text.splitlines()), "")

    # —— 源文件只用 #EXTGRP 表达分组时，分组信息必须还在 ——
    from app import m3u_parser
    src = (
        "#EXTM3U\n"
        "#EXTINF:-1 tvg-id=\"GRP.ONLY\",只有EXTGRP的频道\n"
        "#EXTGRP:地方台\n"
        "http://127.0.0.1:8099/live/test.ts\n"
    )
    entries, _warn = m3u_parser.parse(src)
    got_group = entries[0]["group_title"] if entries else ""
    add("源里的 #EXTGRP 会被折进 group-title（信息不丢）",
        got_group == "地方台", f"group_title={got_group!r}")
    re_rendered = outputs.build_m3u(
        [_row(url=entries[0]["url"], name=entries[0]["name"], tvg_id=entries[0]["tvg_id"],
              group_title=entries[0]["group_title"], extra_lines=entries[0]["extra_lines"])],
        "可用频道")
    add("重渲染后 #EXTINF 与地址之间不再有任何标签行",
        not check_shape(re_rendered, [entries[0]["url"]]),
        "; ".join(check_shape(re_rendered, [entries[0]["url"]])))

    # —— 负向控制 1：把老行为（我们自己在地址前插 #EXTGRP）注入回去，判据必须变红 ——
    old_style = "\n".join(
        [
            "#EXTM3U",
            '#EXTINF:-1 tvg-id="LOCAL.TS" tvg-name="本地TS直连" tvg-logo="http://logo/ts.png"'
            ' group-title="本地测试",本地TS直连',
            "#EXTGRP:本地测试",
            "http://127.0.0.1:8099/live/test.ts",
        ]
    ) + "\n"
    caught = check_shape(old_style, ["http://127.0.0.1:8099/live/test.ts"])
    add("负向控制：#EXTINF 与地址之间插 #EXTGRP 会被判红", bool(caught), "; ".join(caught))

    # —— 负向控制 2：非播放必需的指令夹在中间也要判红 ——
    bad2 = check_shape(
        "#EXTM3U\n#EXTINF:-1 group-title=\"x\",甲\n#EXT-X-SESSION-DATA:data=\"a\"\n"
        "http://a/1.m3u8\n",
        ["http://a/1.m3u8"],
    )
    add("负向控制：夹非播放必需指令会被判红", bool(bad2), "; ".join(bad2))

    # —— 负向控制 3：地址被漏掉（EXTINF 后面直接下一条 EXTINF）也要判红 ——
    bad3 = check_shape("#EXTM3U\n#EXTINF:-1 group-title=\"x\",甲\n#EXTINF:-1 group-title=\"x\",乙\nhttp://b/2.m3u8\n",
                       ["http://b/2.m3u8"])
    add("负向控制：#EXTINF 后面没有地址会被判红", bool(bad3), "; ".join(bad3))

    # —— 负向控制 4：Content-Type 口径 ——
    from app import main as app_main
    add(".m3u 对外以 text/plain 下发（飞牛按 MIME 判断是不是订阅文本）",
        app_main.MEDIA_TYPES[".m3u"].startswith("text/plain"),
        f"MEDIA_TYPES['.m3u']={app_main.MEDIA_TYPES['.m3u']}")
    add(".csv 仍然是 text/csv",
        app_main.MEDIA_TYPES[".csv"].startswith("text/csv"),
        app_main.MEDIA_TYPES[".csv"])
    return results, text


def online_checks(base: str) -> list[tuple[str, bool, str]]:
    results: list[tuple[str, bool, str]] = []

    def add(name: str, ok: bool, detail: str = "") -> None:
        results.append((name, bool(ok), detail))

    for path in ("/iptv.m3u", "/iptv_all.m3u", "/iptv_ipv4.m3u", "/iptv_ipv6.m3u"):
        try:
            with urllib.request.urlopen(base.rstrip("/") + path, timeout=10) as r:
                ctype = (r.headers.get("content-type") or "").lower()
                body = r.read().decode("utf-8", "ignore")
        except Exception as exc:  # noqa: BLE001
            add(f"{path} 可取回", False, f"{type(exc).__name__}: {exc}")
            continue
        add(f"{path} 的 Content-Type 是 text/plain",
            ctype.startswith("text/plain"), f"content-type={ctype}")
        violations = check_shape(body)
        # 线上正文只核对「#EXTINF 与地址之间没有多余标签」这一类，
        # 空列表（还没有跑过第一轮）时没有 #EXTINF，视为通过。
        strict = [v for v in violations if "EXTINF" in v or "指令" in v]
        add(f"{path} 正文里 #EXTINF 与地址之间没有多余标签",
            not strict, "; ".join(strict) or f"{len(body.splitlines())} 行正文")

    try:
        with urllib.request.urlopen(base.rstrip("/") + "/results.csv", timeout=10) as r:
            ctype = (r.headers.get("content-type") or "").lower()
    except Exception as exc:  # noqa: BLE001
        ctype = f"取回失败 {exc}"
    add("/results.csv 的 Content-Type 仍是 text/csv",
        ctype.startswith("text/csv"), ctype)
    return results


def real_list_checks(path: str) -> list[tuple[str, bool, str]]:
    """拿一份真实订阅列表（例如线上下发的 /iptv.m3u）过一遍解析 + 重渲染。

    离线段的样例是自己构造的，条目少；这条判据用真实数据（几十个频道、带
    `;` 的多分组、名字里有方括号和撇号）验证重渲染后的形状与「一条都不丢」。
    """
    from app import m3u_parser

    results: list[tuple[str, bool, str]] = []

    def add(name: str, ok: bool, detail: str = "") -> None:
        results.append((name, bool(ok), detail))

    text = Path(path).read_text(encoding="utf-8", errors="ignore")
    entries, _warn = m3u_parser.parse(text)
    add(f"真实列表能解析出频道（{path}）", bool(entries), f"{len(entries)} 条")
    rows = [
        {
            "url": e["url"], "name": e["name"], "tvg_id": e["tvg_id"],
            "tvg_name": e["tvg_name"], "group_title": e["group_title"],
            "logo": e["logo"], "duration": e["duration"], "attrs": e["attrs"],
            "extra_lines": e["extra_lines"],
        }
        for e in entries
    ]
    rendered = outputs.build_m3u(rows, "真实列表重渲染")
    violations = check_shape(rendered, [e["url"] for e in entries])
    add("真实列表重渲染后 #EXTINF 与地址之间没有多余标签",
        not violations, "; ".join(violations[:3]) or f"{len(entries)} 条全部紧跟地址")
    add("重渲染一条地址都不丢、顺序不变",
        len([l for l in rendered.splitlines() if l.startswith("#EXTINF")]) == len(entries),
        f"EXTINF {sum(1 for l in rendered.splitlines() if l.startswith('#EXTINF'))} / 解析 {len(entries)}")
    add("重渲染后分组信息仍在（group-title）",
        all((not e["group_title"]) or f'group-title="{e["group_title"]}"' in rendered or
            f'group-title="{e["group_title"].replace(chr(34), chr(39))}"' in rendered
            for e in entries),
        f"有分组的频道 {sum(1 for e in entries if e['group_title'])} 条")
    return results


def main() -> int:
    ap = argparse.ArgumentParser(description="产物 M3U 的播放器兼容判据")
    ap.add_argument("--base", default="", help="运行中的实例地址，如 http://127.0.0.1:9001；不给则只跑离线段")
    ap.add_argument("--from-file", default="", help="一份真实 M3U 列表（线上产物或订阅文件），跑重渲染判据")
    ap.add_argument("--out", default="", help="把报告另存为 UTF-8 文件")
    args = ap.parse_args()

    results, sample = offline_checks()
    lines = ["# unit_player_compat"]
    lines.append("")
    lines.append("## 离线段：直接调 app.outputs 生成")
    lines.append("")
    lines.append("生成的样例（前 12 行）：")
    lines.extend("    " + l for l in sample.splitlines()[:12])

    if args.from_file:
        lines.append("")
        lines.append(f"## 真实列表段：{args.from_file}")
        results += real_list_checks(args.from_file)

    if args.base:
        lines.append("")
        lines.append(f"## 在线段：{args.base}")
        results += online_checks(args.base)

    passed = 0
    for name, ok, detail in results:
        passed += 1 if ok else 0
        lines.append("")
        lines.append(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f"  —— {detail}" if detail else ""))

    lines.append("")
    lines.append(f"## 合计 {passed}/{len(results)} 条通过")
    report = "\n".join(lines)
    if args.out:
        Path(args.out).write_text(report, encoding="utf-8")
    try:
        print(report)
    except UnicodeEncodeError:
        print(report.encode("gbk", "replace").decode("gbk"))
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
