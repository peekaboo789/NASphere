"""多源改造的单元判据：跨源择优 + 按源下线。

跑法（仓库根目录）：
    DATA_DIR=D:/tmp/ff/unit python dev-tools/unit_multi_source.py
判据全部打印实际数字，任何一条不符就 exit 1。
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("DATA_DIR", tempfile.mkdtemp(prefix="iptv-unit-"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import outputs  # noqa: E402
from app.db import Database  # noqa: E402

failures: list[str] = []


def check(name: str, got: object, want: object) -> None:
    ok = got == want
    print(f"{'[PASS]' if ok else '[FAIL]'} {name}: got={got!r} want={want!r}")
    if not ok:
        failures.append(name)


def entry(url: str, name: str, tvg_id: str = "") -> dict:
    from app import m3u_parser

    return {
        "url": url,
        "url_hash": m3u_parser.url_hash(url),
        "name": name,
        "tvg_id": tvg_id,
        "tvg_name": name,
        "group_title": "G",
        "logo": "",
        "duration": "-1",
        "attrs": {},
        "extra_lines": [],
        "protocol": "http",
    }


def mark(db: Database, url: str, *, speed: float, successes: int = 1, status: str = "ok") -> None:
    row = db.query_one("SELECT id FROM channels WHERE url=?", (url,))
    assert row, url
    db.record_test(
        None,
        int(row["id"]),
        [{"family": "ipv4", "status": status, "http_status": 200, "connect_ms": 12.0,
          "first_packet_ms": 30.0, "elapsed_ms": 3000.0, "speed_kbps": speed,
          "has_video": 1, "has_audio": 1, "v_codec": "h264", "a_codec": "aac"}],
        {"family": "ipv4", "status": status, "http_status": 200, "connect_ms": 12.0,
         "first_packet_ms": 30.0, "elapsed_ms": 3000.0, "speed_kbps": speed,
         "has_video": 1, "has_audio": 1, "v_codec": "h264", "a_codec": "aac"},
        {"url": url, "name": url, "status": status, "failure_reason": "", "error_detail": "",
         "ipv4_addr": "127.0.0.1", "ipv6_addr": None},
    )
    for _ in range(successes - 1):
        db.record_test(
            None, int(row["id"]), [], None,
            {"url": url, "name": url, "status": status, "failure_reason": "",
             "error_detail": "", "ipv4_addr": None, "ipv6_addr": None},
        )


A = "http://a.example.com/"
B = "http://b.example.com/"


def active_urls(db: Database) -> dict[str, str]:
    return {r["url"]: str(r["source_url"]) for r in db.active_channels()}


def main() -> int:
    db = Database(Path(os.environ["DATA_DIR"]) / "unit.sqlite3")

    # ---------- 第 1 轮：两个源都成功，B 里有一条和 A 重复 ----------
    e1 = [entry(A + "cctv1", "CCTV-1", "cctv1"), entry(A + "cctv2", "CCTV-2", "cctv2"),
          entry(A + "only_a", "只有A", "only_a")]
    e2 = [entry(B + "cctv1", "CCTV-1", "cctv1"), entry(A + "cctv1", "CCTV-1", "cctv1")]
    for e in e1:
        e["source_url"] = "SRC_A"
    for e in e2:
        e["source_url"] = "SRC_B"
    stats = db.sync_channels_from_source(e1 + e2)
    check("第1轮写入条数", stats["total"], 5)
    check("第1轮同批重复 URL 只留一条", len(active_urls(db)), 4)
    check("第1轮下线数", stats["removed"], 0)
    src = active_urls(db)
    check("重复 URL 归属第一个源", src[A + "cctv1"], "SRC_A")

    # A 的三个频道成功，B 独有的那条也成功
    mark(db, A + "cctv1", speed=800)
    mark(db, A + "cctv2", speed=900)
    mark(db, A + "only_a", speed=700)
    mark(db, B + "cctv1", speed=2000)

    # ---------- 坏源语义：第 2 轮只有 A 成功，且 A 少了 only_a ----------
    round2 = [entry(A + "cctv1", "CCTV-1", "cctv1"), entry(A + "cctv2", "CCTV-2 高清", "cctv2")]
    for e in round2:
        e["source_url"] = "SRC_A"
    stats = db.sync_channels_from_source(round2)
    src = active_urls(db)
    check("第2轮 A 消失的频道下线", A + "only_a" in src, False)
    check("第2轮 失败源 B 的频道保留", B + "cctv1" in src, True)
    check("第2轮 在册总数", len(src), 3)
    check("第2轮 下线数", stats["removed"], 1)
    check("第2轮 B 归属没被抢走", src[B + "cctv1"], "SRC_B")

    # ---------- 跨源择优：同 tvg-id 留最快 ----------
    cfg = {"min_speed_kbps": 0, "min_success_count": 1, "timeout_seconds": 8}
    rows = db.channels_for_output(cfg)
    check("过滤后可用行数", len(rows), 3)
    kept, dropped = outputs.collapse_fastest(rows)
    check("择优后条数", len(kept), 2)
    check("合并掉条数", dropped, 1)
    check("同 tvg-id 留下的是最快的那条",
          sorted(r["url"] for r in kept), sorted([B + "cctv1", A + "cctv2"]))

    # ---------- 没有 tvg-id 时按频道名配对 ----------
    named = [
        {"url": "u1", "tvg_id": "", "name": "湖南卫视", "speed_kbps": 100, "success_count": 3,
         "elapsed_ms": 3000},
        {"url": "u2", "tvg_id": "", "name": " 湖南卫视 ", "speed_kbps": 500, "success_count": 1,
         "elapsed_ms": 3000},
        {"url": "u3", "tvg_id": "", "name": "湖南卫视", "speed_kbps": 900, "success_count": 1,
         "elapsed_ms": 3000},
    ]
    kept2, dropped2 = outputs.collapse_fastest(named)
    check("同名（含空白差异）只留最快的一条", [r["url"] for r in kept2], ["u3"])
    check("三条同名合并掉两条", dropped2, 2)

    # ---------- 速度相同看成功次数；tvg-id 为空的行不参与合并 ----------
    tie = [
        {"url": "x1", "tvg_id": "same", "name": "n", "speed_kbps": 500, "success_count": 9,
         "elapsed_ms": 3000},
        {"url": "x2", "tvg_id": "same", "name": "n", "speed_kbps": 500, "success_count": 2,
         "elapsed_ms": 3000},
        {"url": "", "tvg_id": "", "name": "", "speed_kbps": 1, "success_count": 1,
         "elapsed_ms": 1},
        {"url": "", "tvg_id": "", "name": "", "speed_kbps": 1, "success_count": 1,
         "elapsed_ms": 1},
    ]
    kept3, dropped3 = outputs.collapse_fastest(tie)
    check("同速度按成功次数取胜", [r["url"] for r in kept3][:1], ["x1"])
    check("无 tvg-id 无名字的独立保留", dropped3, 1)

    # ---------- 按源汇总 + 按源筛选 ----------
    summary = {str(r["source_url"]): r for r in db.source_summary()}
    check("汇总 SRC_A 在册", summary["SRC_A"]["total"], 2)
    check("汇总 SRC_B 在册", summary["SRC_B"]["total"], 1)
    only_b = db.list_channels(source="SRC_B")
    check("按源筛选 total", only_b["total"], 1)
    check("按源筛选命中 URL", only_b["items"][0]["url"], B + "cctv1")
    legacy = db.list_channels(source="__legacy__")
    check("老数据筛选为空", legacy["total"], 0)

    # ---------- 删掉一个源 vs 一个源本轮挂了：两种下线语义要分开 ----------
    db.sync_channels_from_source(round2, ["SRC_A"])
    src = active_urls(db)
    check("从配置里删掉的源，频道下线", B + "cctv1" in src, False)
    check("删源后在册数", len(src), 2)
    db.sync_channels_from_source(round2, ["SRC_A", "SRC_B"])
    check("配置里还给 B 留着位置，但它本轮没数据时不会被硬拉回来",
          len(active_urls(db)), 2)
    db.sync_channels_from_source(e1 + e2, ["SRC_A", "SRC_B"])
    src = active_urls(db)
    check("源重新成功时频道回到在册", B + "cctv1" in src, True)
    check("恢复后在册数", len(src), 4)
    # 对照：B 还在配置里、只是这一轮没拿到数据 → 只下线 A 自己消失的那条，B 的不动
    db.sync_channels_from_source(round2, ["SRC_A", "SRC_B"])
    src = active_urls(db)
    check("本轮失败的源不会被删源逻辑波及", B + "cctv1" in src, True)
    check("对照后的在册数", len(src), 3)
    db.sync_channels_from_source(round2)
    check("不传 configured_urls 时行为一致（只收敛本轮成功的源）", len(active_urls(db)), 3)

    # ---------- 老库升级：真实的多源改造之前的表结构，走一遍启动迁移 ----------
    import sqlite3

    from app.db import _SCHEMA

    old_path = Path(os.environ["DATA_DIR"]) / "legacy.sqlite3"
    old_schema = "\n".join(line for line in _SCHEMA.splitlines() if "source_url" not in line)
    with sqlite3.connect(old_path) as lconn:
        lconn.executescript(old_schema)
        lconn.execute(
            "INSERT INTO channels(url_hash, name, url, source_index, first_seen, last_seen,"
            " status, active, speed_kbps, success_count)"
            " VALUES('oldhash', '老频道', ?, 0, 1, 1, 'ok', 1, 800, 1)",
            (A + "old",),
        )
        lconn.commit()

    legacy_db = Database(old_path)  # 构造时自动补齐 source_url 列
    cols = {r["name"] for r in legacy_db.query("PRAGMA table_info(channels)")}
    check("迁移补上了 source_url", "source_url" in cols, True)
    check("迁移后老行 source_url 为空串",
          legacy_db.query_one("SELECT source_url FROM channels WHERE url=?", (A + "old",))["source_url"],
          "")
    # 升级后配了新源并成功：老行不在新源里就该下线
    legacy_db.sync_channels_from_source(
        [dict(entry(A + "new", "新频道", "new"), source_url="SRC_A")]
    )
    check("升级后老频道按合并结果下线",
          legacy_db.query_one("SELECT active FROM channels WHERE url=?", (A + "old",))["active"], 0)
    # 一轮全失败（entries 为空）：什么都不动
    before = len(legacy_db.active_channels())
    legacy_db.sync_channels_from_source([])
    check("全源失败时不动在册数", len(legacy_db.active_channels()), before)
    legacy_db.close()
    db.close()

    print("-" * 60)
    if failures:
        print(f"[RESULT] 失败 {len(failures)} 项：{failures}")
        return 1
    print("[RESULT] 全部判据通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
