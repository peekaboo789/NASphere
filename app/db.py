"""SQLite 持久层：频道表、测速历史表、任务表、元数据表。

- WAL 模式，支持「一边测速写入、一边 Web 查询」。
- 失败的 URL 只做状态标记，永不删除，历史计数与结果行全部保留。
- 所有写操作通过一把锁串行化，读操作走同一个连接（SQLite 读开销很小）。
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from contextlib import contextmanager
from typing import Any, Iterable, Iterator

from .config import DB_PATH, ensure_dirs

# 判定为「可用」的状态集合：纯音频（广播）频道同样算可用
OK_STATUSES = ("ok", "audio_only")


def _tri(value: Any) -> int | None:
    """三态布尔落库：True→1、False→0、未知→NULL。

    「不知道」和「不合法」必须能区分开 —— 例如 HTTPS 走 CONNECT 隧道时，
    代理看不见源站的 HTTP 状态码和正文，播放列表是否有效就只能留空。
    """
    if value is None:
        return None
    return 1 if value else 0

_SCHEMA = """
CREATE TABLE IF NOT EXISTS channels (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    url_hash            TEXT NOT NULL UNIQUE,
    name                TEXT NOT NULL DEFAULT '',
    tvg_id              TEXT,
    tvg_name            TEXT,
    group_title         TEXT,
    logo                TEXT,
    url                 TEXT NOT NULL,
    attrs               TEXT NOT NULL DEFAULT '{}',
    extra_lines         TEXT NOT NULL DEFAULT '[]',
    duration            TEXT NOT NULL DEFAULT '-1',
    protocol            TEXT,
    source_index        INTEGER NOT NULL DEFAULT 0,
    source_url          TEXT NOT NULL DEFAULT '',
    ipv4_addr           TEXT,
    ipv6_addr           TEXT,
    family              TEXT,
    status              TEXT NOT NULL DEFAULT 'pending',
    failure_reason      TEXT,
    connect_ms          REAL,
    latency_ms          REAL,
    speed_kbps          REAL,
    elapsed_ms          REAL,
    http_status         INTEGER,
    final_url           TEXT NOT NULL DEFAULT '',
    redirect_count      INTEGER,
    content_type        TEXT NOT NULL DEFAULT '',
    hls_valid           INTEGER,
    segment_test        TEXT NOT NULL DEFAULT '',
    playable            INTEGER,
    has_video           INTEGER,
    has_audio           INTEGER,
    v_codec             TEXT,
    a_codec             TEXT,
    v_resolution        TEXT,
    first_seen          INTEGER NOT NULL,
    last_seen           INTEGER NOT NULL,
    last_tested_at      INTEGER,
    last_ok_at          INTEGER,
    success_count       INTEGER NOT NULL DEFAULT 0,
    failure_count       INTEGER NOT NULL DEFAULT 0,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    last_error          TEXT,
    active              INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_channels_group ON channels(group_title);
CREATE INDEX IF NOT EXISTS idx_channels_status ON channels(status);
CREATE INDEX IF NOT EXISTS idx_channels_active ON channels(active);

CREATE TABLE IF NOT EXISTS results (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id          INTEGER,
    channel_id      INTEGER,
    url             TEXT NOT NULL,
    name            TEXT,
    family          TEXT,
    status          TEXT,
    http_status     INTEGER,
    final_url       TEXT NOT NULL DEFAULT '',
    redirect_count  INTEGER,
    content_type    TEXT NOT NULL DEFAULT '',
    hls_valid       INTEGER,
    segment_test    TEXT NOT NULL DEFAULT '',
    playable        INTEGER,
    test_error      TEXT,
    connect_ms      REAL,
    first_packet_ms REAL,
    elapsed_ms      REAL,
    speed_kbps      REAL,
    has_video       INTEGER,
    has_audio       INTEGER,
    v_codec         TEXT,
    a_codec         TEXT,
    failure_reason  TEXT,
    tested_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_results_channel ON results(channel_id, tested_at);
CREATE INDEX IF NOT EXISTS idx_results_run ON results(run_id);

CREATE TABLE IF NOT EXISTS runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    kind          TEXT NOT NULL,
    started_at    INTEGER NOT NULL,
    finished_at   INTEGER,
    total         INTEGER NOT NULL DEFAULT 0,
    tested        INTEGER NOT NULL DEFAULT 0,
    ok            INTEGER NOT NULL DEFAULT 0,
    failed        INTEGER NOT NULL DEFAULT 0,
    cancelled     INTEGER NOT NULL DEFAULT 0,
    error         TEXT,
    source_lines  INTEGER,
    elapsed_ms    REAL
);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);
"""

class Database:
    def __init__(self, path: Any = None) -> None:
        ensure_dirs()
        self.path = str(path or DB_PATH)
        self._lock = threading.Lock()
        self.conn = sqlite3.connect(self.path, check_same_thread=False, timeout=30)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self.conn.execute("PRAGMA busy_timeout=30000")
        self.conn.execute("PRAGMA foreign_keys=ON")
        with self._lock:
            self.conn.executescript(_SCHEMA)
            self.conn.commit()
        self._migrate()
        with self._lock:
            # 老库的 source_url 列是 _migrate 才补上的，索引必须建在它后面
            self.conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_channels_source ON channels(source_url)"
            )
            self.conn.commit()

    def _migrate(self) -> None:
        """老数据文件升级：补齐新增列，不重建表、不清空历史。"""

        def columns(table: str) -> set[str]:
            return {row["name"] for row in self.query(f"PRAGMA table_info({table})")}

        wanted: dict[str, dict[str, str]] = {
            "channels": {
                "duration": "TEXT NOT NULL DEFAULT '-1'",
                "v_resolution": "TEXT",
                "last_error": "TEXT",
                "connect_ms": "REAL",
                # 多源：频道归属哪个订阅地址；老数据先记成空串，表示升级前的单源频道
                "source_url": "TEXT NOT NULL DEFAULT ''",
                # 重定向与 HLS：地址本身给回来的东西，和「最后能不能播」分开记
                "final_url": "TEXT NOT NULL DEFAULT ''",
                "redirect_count": "INTEGER",
                "content_type": "TEXT NOT NULL DEFAULT ''",
                "hls_valid": "INTEGER",
                "segment_test": "TEXT NOT NULL DEFAULT ''",
                "playable": "INTEGER",
            },
            "results": {
                "final_url": "TEXT NOT NULL DEFAULT ''",
                "redirect_count": "INTEGER",
                "content_type": "TEXT NOT NULL DEFAULT ''",
                "hls_valid": "INTEGER",
                "segment_test": "TEXT NOT NULL DEFAULT ''",
                "playable": "INTEGER",
                "test_error": "TEXT",
            },
        }
        for table, cols in wanted.items():
            existing = columns(table)
            with self._tx() as conn:
                for column, ddl in cols.items():
                    if column not in existing:
                        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")

    # -- 基础工具 ---------------------------------------------------------
    @contextmanager
    def _tx(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            try:
                yield self.conn
                self.conn.commit()
            except Exception:
                self.conn.rollback()
                raise

    def close(self) -> None:
        with self._lock:
            self.conn.close()

    def query(self, sql: str, params: Iterable[Any] = ()) -> list[dict[str, Any]]:
        with self._lock:
            cur = self.conn.execute(sql, tuple(params))
            return [dict(row) for row in cur.fetchall()]

    def query_one(self, sql: str, params: Iterable[Any] = ()) -> dict[str, Any] | None:
        rows = self.query(sql, params)
        return rows[0] if rows else None

    # -- meta ------------------------------------------------------------
    def set_meta(self, key: str, value: Any) -> None:
        with self._tx() as conn:
            conn.execute(
                "INSERT INTO meta(key, value) VALUES(?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, "" if value is None else str(value)),
            )

    def get_meta(self, key: str, default: str = "") -> str:
        row = self.query_one("SELECT value FROM meta WHERE key=?", (key,))
        if not row or row["value"] is None:
            return default
        return row["value"]

    def get_int_meta(self, key: str, default: int = 0) -> int:
        raw = self.get_meta(key, "")
        try:
            return int(float(raw))
        except (TypeError, ValueError):
            return default

    # -- runs -------------------------------------------------------------
    def create_run(self, kind: str) -> int:
        with self._tx() as conn:
            cur = conn.execute(
                "INSERT INTO runs(kind, started_at) VALUES(?, ?)", (kind, int(time.time()))
            )
            return int(cur.lastrowid or 0)

    def update_run_progress(self, run_id: int, **fields: Any) -> None:
        allowed = {"total", "tested", "ok", "failed", "source_lines"}
        cols = {k: v for k, v in fields.items() if k in allowed}
        if not cols:
            return
        sets = ", ".join(f"{k}=?" for k in cols)
        with self._tx() as conn:
            conn.execute(f"UPDATE runs SET {sets} WHERE id=?", (*cols.values(), run_id))

    def finish_run(
        self,
        run_id: int,
        *,
        tested: int,
        ok: int,
        failed: int,
        total: int,
        cancelled: bool = False,
        error: str | None = None,
        source_lines: int | None = None,
    ) -> None:
        now = int(time.time())
        started = self.query_one("SELECT started_at FROM runs WHERE id=?", (run_id,))
        elapsed_ms = (now - int(started["started_at"])) * 1000.0 if started else None
        with self._tx() as conn:
            conn.execute(
                "UPDATE runs SET finished_at=?, tested=?, ok=?, failed=?, total=?, "
                "cancelled=?, error=?, source_lines=?, elapsed_ms=? WHERE id=?",
                (
                    now,
                    tested,
                    ok,
                    failed,
                    total,
                    1 if cancelled else 0,
                    error,
                    source_lines,
                    elapsed_ms,
                    run_id,
                ),
            )
            conn.execute("DELETE FROM runs WHERE id NOT IN (SELECT id FROM runs ORDER BY id DESC LIMIT 200)")

    def latest_run(self) -> dict[str, Any] | None:
        return self.query_one("SELECT * FROM runs ORDER BY id DESC LIMIT 1")

    def recent_runs(self, limit: int = 10) -> list[dict[str, Any]]:
        return self.query(
            "SELECT * FROM runs ORDER BY id DESC LIMIT ?", (max(1, min(limit, 50)),)
        )

    # -- 频道 --------------------------------------------------------------
    def sync_channels_from_source(
        self,
        entries: list[dict[str, Any]],
        configured_urls: list[str] | None = None,
    ) -> dict[str, int]:
        """把解析好的频道写入 channels：新频道建行，已有频道只更新元数据。

        entries 每项要带 source_url（这一条来自哪个订阅地址）。
        下线规则是按源来的，三种情况要分开：
          1. 本轮成功的源 —— 只下线「属于本源、且本源这次没有」的频道；
          2. 本轮失败的源 —— 根本不出现在 entries 里，它上次成功的频道全部保留；
          3. 已从配置里删掉的源（configured_urls 不含它）—— 它的频道下线。
        一个源都没成功（entries 为空）时什么都不动，等下一轮。

        返回 {"inserted": n, "updated": m, "total": t, "removed": k}
        """
        now = int(time.time())
        inserted = updated = 0
        meta_columns = (
            "name",
            "tvg_id",
            "tvg_name",
            "group_title",
            "logo",
            "url",
            "attrs",
            "extra_lines",
            "duration",
            "protocol",
            "source_index",
            "source_url",
        )
        insert_columns = meta_columns + (
            "url_hash",
            "first_seen",
            "last_seen",
            "active",
            "status",
        )
        insert_sql = "INSERT INTO channels(%s) VALUES(%s)" % (
            ", ".join(insert_columns),
            ", ".join("?" * len(insert_columns)),
        )
        update_sql = "UPDATE channels SET %s, last_seen=?, active=1 WHERE url_hash=?" % ", ".join(
            f"{col}=?" for col in meta_columns
        )
        with self._tx() as conn:
            # 本轮「源 -> 地址」关系临时表。用临时表而不是 NOT IN(?,?,?...)，
            # 一是 10000 个地址会撞 SQLite 变量上限，二是按源收敛需要 JOIN。
            conn.execute("DROP TABLE IF EXISTS temp.sync_seen")
            conn.execute("DROP TABLE IF EXISTS temp.sync_keep")
            conn.execute(
                "CREATE TEMP TABLE sync_seen ("
                "  url_hash TEXT NOT NULL,"
                "  src_url  TEXT NOT NULL DEFAULT ''"
                ")"
            )
            conn.execute(
                "CREATE TEMP TABLE sync_keep (src_url TEXT NOT NULL PRIMARY KEY)"
            )
            seen_rows: list[tuple[str, str]] = []
            batch_seen: set[str] = set()
            for idx, e in enumerate(entries):
                src_url = str(e.get("source_url") or "")
                # 同一批里出现两次同一个 url_hash 时，第一个源说了算：
                # 流水线已经按 url_hash 做过跨源去重，这里再兜一道，
                # 免得调用方漏掉去重就让后一个源把频道的归属抢走。
                if e["url_hash"] in batch_seen:
                    continue
                batch_seen.add(e["url_hash"])
                meta = (
                    e["name"],
                    e.get("tvg_id") or "",
                    e.get("tvg_name") or "",
                    e.get("group_title") or "",
                    e.get("logo") or "",
                    e["url"],
                    json.dumps(e.get("attrs") or {}, ensure_ascii=False),
                    json.dumps(e.get("extra_lines") or [], ensure_ascii=False),
                    str(e.get("duration") or "-1"),
                    e.get("protocol") or "",
                    idx,
                    src_url,
                )
                existing = conn.execute(
                    "SELECT id FROM channels WHERE url_hash=?", (e["url_hash"],)
                ).fetchone()
                if existing is None:
                    conn.execute(insert_sql, meta + (e["url_hash"], now, now, 1, "pending"))
                    inserted += 1
                else:
                    conn.execute(update_sql, meta + (now, e["url_hash"]))
                    updated += 1
                seen_rows.append((e["url_hash"], src_url))
            conn.executemany("INSERT INTO sync_seen(url_hash, src_url) VALUES(?, ?)", seen_rows)
            conn.execute("CREATE INDEX IF NOT EXISTS sync_seen_src ON sync_seen(src_url, url_hash)")

            removed = 0
            # 1) 本轮成功的源：只下线「属于本源、且本源这次没有」的频道
            cur = conn.execute(
                "UPDATE channels SET active=0"
                " WHERE active=1 AND source_url IN (SELECT src_url FROM sync_seen)"
                "   AND source_url <> ''"
                "   AND NOT EXISTS (SELECT 1 FROM sync_seen s"
                "                    WHERE s.src_url = channels.source_url"
                "                      AND s.url_hash = channels.url_hash)"
            )
            removed += int(cur.rowcount or 0)
            # 2) 升级前留下的老频道（source_url 为空）：按本轮全部源的合并结果收敛。
            #    只要有任何一个源成功，就把不再出现的旧行下线；下一轮它们就会带上真实源地址。
            # 3) 已经从配置里删掉的源：它的频道没有下次机会了，一并下线。
            #    注意和「本轮下载失败的源」区分开 —— 那种情况源还在配置里，
            #    下一轮可能恢复，频道必须保留（见上面第 1 条只处理本轮成功的源）。
            if seen_rows and configured_urls is not None:
                conn.executemany(
                    "INSERT INTO temp.sync_keep(src_url) VALUES(?)",
                    [(str(u),) for u in set(configured_urls)],
                )
                cur = conn.execute(
                    "UPDATE channels SET active=0 WHERE active=1 AND source_url <> ''"
                    "  AND source_url NOT IN (SELECT src_url FROM temp.sync_keep)"
                )
                removed += int(cur.rowcount or 0)
                cur = conn.execute(
                    "UPDATE channels SET active=0"
                    " WHERE active=1 AND source_url = ''"
                    "   AND url_hash NOT IN (SELECT url_hash FROM sync_seen)"
                )
                removed += int(cur.rowcount or 0)
            elif seen_rows:
                cur = conn.execute(
                    "UPDATE channels SET active=0"
                    " WHERE active=1 AND source_url = ''"
                    "   AND url_hash NOT IN (SELECT url_hash FROM sync_seen)"
                )
                removed += int(cur.rowcount or 0)
            conn.execute("DROP TABLE IF EXISTS temp.sync_seen")
        return {
            "inserted": inserted,
            "updated": updated,
            "total": len(entries),
            "removed": removed,
        }

    def source_summary(self) -> list[dict[str, Any]]:
        """按订阅源统计当前在册频道数，给状态页和频道页的「按来源筛选」用。"""
        return self.query(
            "SELECT COALESCE(source_url,'') AS source_url, COUNT(*) AS total,"
            " SUM(CASE WHEN status IN (?,?) THEN 1 ELSE 0 END) AS ok"
            " FROM channels WHERE active=1 GROUP BY COALESCE(source_url,'')"
            " ORDER BY MIN(source_index) ASC",
            OK_STATUSES,
        )

    def active_channels(self) -> list[dict[str, Any]]:
        return self.query(
            "SELECT * FROM channels WHERE active=1 ORDER BY source_index ASC"
        )

    def active_channel_count(self) -> int:
        row = self.query_one("SELECT COUNT(*) AS c FROM channels WHERE active=1")
        return int(row["c"]) if row else 0

    def record_test(self, run_id: int | None, channel_id: int, attempts: list[dict[str, Any]],
                    winner: dict[str, Any] | None, final: dict[str, Any]) -> None:
        """写入本次测速：每个协议族一条结果行，频道行按最终结果累计计数。"""
        now = int(time.time())
        is_ok = final["status"] in OK_STATUSES
        with self._tx() as conn:
            for a in attempts:
                conn.execute(
                    "INSERT INTO results(run_id, channel_id, url, name, family, status,"
                    " http_status, final_url, redirect_count, content_type, hls_valid,"
                    " segment_test, playable, test_error,"
                    " connect_ms, first_packet_ms, elapsed_ms, speed_kbps,"
                    " has_video, has_audio, v_codec, a_codec, failure_reason, tested_at)"
                    " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        run_id,
                        channel_id,
                        final.get("url", ""),
                        final.get("name", ""),
                        a.get("family"),
                        a.get("status"),
                        a.get("http_status"),
                        a.get("final_url") or "",
                        a.get("redirect_count"),
                        a.get("content_type") or "",
                        _tri(a.get("hls_valid")),
                        a.get("segment_test") or "",
                        1 if a.get("playable") else 0,
                        a.get("test_error") or "",
                        a.get("connect_ms"),
                        a.get("first_packet_ms"),
                        a.get("elapsed_ms"),
                        a.get("speed_kbps"),
                        1 if a.get("has_video") else 0,
                        1 if a.get("has_audio") else 0,
                        a.get("v_codec"),
                        a.get("a_codec"),
                        a.get("failure_reason"),
                        now,
                    ),
                )
            sets = {
                "status": final["status"],
                "failure_reason": final.get("failure_reason"),
                "last_tested_at": now,
                "last_error": final.get("error_detail"),
                "ipv4_addr": final.get("ipv4_addr"),
                "ipv6_addr": final.get("ipv6_addr"),
            }
            # 失败时频道行没有 winner，但仍然要把实测到的细节留在频道行上
            # （HTTP 状态码、实测速度、编码），否则页面上只能看到一片 “-”。
            fallback: dict[str, Any] = {}
            if winner is None and attempts:
                same_family_status = [
                    a for a in attempts if a.get("status") == final.get("status")
                ]
                pool = same_family_status or list(attempts)
                fallback = max(
                    pool,
                    key=lambda a: (
                        1 if a.get("http_status") else 0,
                        float(a.get("speed_kbps") or 0),
                        float(a.get("elapsed_ms") or 0),
                    ),
                )
            if winner is not None:
                sets.update(
                    {
                        "family": winner.get("family"),
                        "connect_ms": winner.get("connect_ms"),
                        "latency_ms": winner.get("first_packet_ms"),
                        "speed_kbps": winner.get("speed_kbps"),
                        "elapsed_ms": winner.get("elapsed_ms"),
                        "http_status": winner.get("http_status"),
                        "has_video": 1 if winner.get("has_video") else 0,
                        "has_audio": 1 if winner.get("has_audio") else 0,
                        "v_codec": winner.get("v_codec"),
                        "a_codec": winner.get("a_codec"),
                        "v_resolution": winner.get("v_resolution"),
                    }
                )
            else:
                sets.update(
                    {
                        "family": fallback.get("family"),
                        "connect_ms": fallback.get("connect_ms"),
                        "latency_ms": fallback.get("first_packet_ms"),
                        "speed_kbps": fallback.get("speed_kbps"),
                        "elapsed_ms": fallback.get("elapsed_ms") or final.get("elapsed_ms"),
                        "http_status": fallback.get("http_status"),
                        "has_video": 1 if fallback.get("has_video") else 0,
                        "has_audio": 1 if fallback.get("has_audio") else 0,
                        "v_codec": fallback.get("v_codec"),
                        "a_codec": fallback.get("a_codec"),
                    }
                )
            # 地址本身给回来的东西（跳转链、最终地址、内容类型、HLS 校验、分片验证）
            # 和「这次测速到底过没过」是两层信息，都要留在频道行上，
            # 这样「源有效」和「测试失败」在页面上才分得开。
            detail = winner if winner is not None else fallback
            sets.update(
                {
                    "final_url": detail.get("final_url") or "",
                    "redirect_count": detail.get("redirect_count"),
                    "content_type": detail.get("content_type") or "",
                    "hls_valid": _tri(detail.get("hls_valid")),
                    "segment_test": detail.get("segment_test") or "",
                    "playable": 1 if is_ok else 0,
                }
            )
            if is_ok:
                conn.execute(
                    "UPDATE channels SET success_count=success_count+1, consecutive_failures=0,"
                    " last_ok_at=? WHERE id=?",
                    (now, channel_id),
                )
            else:
                conn.execute(
                    "UPDATE channels SET failure_count=failure_count+1,"
                    " consecutive_failures=consecutive_failures+1 WHERE id=?",
                    (channel_id,),
                )
            cols = ", ".join(f"{k}=?" for k in sets)
            conn.execute(
                f"UPDATE channels SET {cols} WHERE id=?", (*sets.values(), channel_id)
            )

    def pending_test_channels(self) -> list[dict[str, Any]]:
        """待测顺序：新频道/从未成功 → 上次失败 → 上次成功，保证半途取消也能刷新高风险源。"""
        rows = self.active_channels()

        def rank(row: dict[str, Any]) -> tuple[int, int]:
            if row["status"] in OK_STATUSES:
                return (2, int(row["id"]))
            if int(row["success_count"]) == 0:
                return (0, int(row["id"]))
            return (1, int(row["id"]))

        return sorted(rows, key=rank)

    # -- 查询 / 统计 --------------------------------------------------------
    # (排序键, 默认方向, 排序表达式)；方向只在这里拼装，避免拼接出错
    _LIST_SORTS: dict[str, tuple[str, str]] = {
        "name": ("c.name COLLATE NOCASE", "asc"),
        "success": (
            "CAST(c.success_count AS REAL) / MAX(1, c.success_count + c.failure_count)",
            "desc",
        ),
        "speed": ("COALESCE(c.speed_kbps, -1)", "desc"),
        "latency": ("COALESCE(c.latency_ms, 1e12)", "asc"),
        "status": ("c.status COLLATE NOCASE", "asc"),
        "group": ("c.group_title COLLATE NOCASE", "asc"),
        "tested": ("COALESCE(c.last_tested_at, 0)", "desc"),
        "failures": ("c.consecutive_failures", "desc"),
        "url": ("c.url COLLATE NOCASE", "asc"),
    }

    def list_channels(
        self,
        *,
        q: str = "",
        group: str = "",
        status: str = "",
        source: str = "",
        sort: str = "name",
        direction: str = "asc",
        only_active: bool = True,
        page: int = 1,
        limit: int = 100,
    ) -> dict[str, Any]:
        where = []
        params: list[Any] = []
        if q:
            where.append("(c.name LIKE ? OR c.url LIKE ? OR c.tvg_name LIKE ? OR c.tvg_id LIKE ?)")
            like = f"%{q}%"
            params += [like, like, like, like]
        if group:
            where.append("c.group_title = ?")
            params.append(group)
        if source:
            # "__legacy__" 是页面上「升级前的老数据」这一项
            if source == "__legacy__":
                where.append("COALESCE(c.source_url,'') = ''")
            else:
                where.append("c.source_url = ?")
                params.append(source)
        if status == "ok":
            where.append(f"c.status IN ({','.join('?' * len(OK_STATUSES))})")
            params += list(OK_STATUSES)
        elif status == "bad":
            excluded = (*OK_STATUSES, "pending")
            where.append(f"c.status NOT IN ({','.join('?' * len(excluded))})")
            params += list(excluded)
        elif status:
            where.append("c.status = ?")
            params.append(status)
        if only_active:
            where.append("c.active = 1")

        expr, default_direction = self._LIST_SORTS.get(sort, self._LIST_SORTS["name"])
        direction = (direction or default_direction).lower()
        if direction not in ("asc", "desc"):
            direction = default_direction
        order = f"{expr} {direction.upper()}"
        where_sql = ("WHERE " + " AND ".join(where)) if where else ""
        limit = max(1, min(int(limit), 1000))
        page = max(1, int(page))
        offset = (page - 1) * limit

        total_row = self.query_one(
            f"SELECT COUNT(*) AS c FROM channels c {where_sql}", params
        )
        rows = self.query(
            f"""SELECT c.*,
                       CAST(c.success_count AS REAL) / MAX(1, c.success_count + c.failure_count)
                       AS success_rate
                  FROM channels c {where_sql}
                 ORDER BY {order}, c.id ASC
                 LIMIT ? OFFSET ?""",
            params + [limit, offset],
        )
        return {
            "total": int(total_row["c"]) if total_row else 0,
            "page": page,
            "limit": limit,
            "items": rows,
        }

    def channel_history(self, channel_id: int, limit: int = 30) -> list[dict[str, Any]]:
        return self.query(
            "SELECT * FROM results WHERE channel_id=? ORDER BY id DESC LIMIT ?",
            (channel_id, max(1, min(limit, 200))),
        )

    def groups(self) -> list[dict[str, Any]]:
        return self.query(
            "SELECT COALESCE(group_title,'') AS group_title, COUNT(*) AS total,"
            " SUM(CASE WHEN status IN (?,?) THEN 1 ELSE 0 END) AS ok"
            " FROM channels WHERE active=1 GROUP BY COALESCE(group_title,'')"
            " ORDER BY total DESC",
            OK_STATUSES,
        )

    def stats(self) -> dict[str, Any]:
        row = self.query_one(
            """SELECT
                 SUM(CASE WHEN active=1 THEN 1 ELSE 0 END) AS total,
                 SUM(CASE WHEN active=1 AND status IN ('ok','audio_only') THEN 1 ELSE 0 END) AS ok,
                 SUM(CASE WHEN active=1 AND status NOT IN ('ok','audio_only','pending') THEN 1 ELSE 0 END) AS bad,
                 SUM(CASE WHEN active=1 AND status='pending' THEN 1 ELSE 0 END) AS pending,
                 SUM(CASE WHEN active=1 AND family='ipv4' THEN 1 ELSE 0 END) AS via_ipv4,
                 SUM(CASE WHEN active=1 AND family='ipv6' THEN 1 ELSE 0 END) AS via_ipv6,
                 AVG(CASE WHEN status IN ('ok','audio_only') THEN NULLIF(speed_kbps,0) END) AS avg_speed,
                 AVG(CASE WHEN status IN ('ok','audio_only') THEN latency_ms END) AS avg_latency
               FROM channels"""
        )
        data = dict(row or {})
        for key in ("total", "ok", "bad", "pending", "via_ipv4", "via_ipv6"):
            data[key] = int(data.get(key) or 0)
        total = data["total"] or 0
        data["success_rate"] = round(data["ok"] / total * 100, 1) if total else 0.0
        data["avg_speed"] = round(float(data.get("avg_speed") or 0), 1)
        data["avg_latency"] = round(float(data.get("avg_latency") or 0), 1)
        data["last_tested_at"] = self.get_int_meta("last_tested_at")
        data["last_source_update"] = self.get_int_meta("last_source_update")
        data["last_output_write"] = self.get_int_meta("last_output_write")
        return data

    def channels_for_output(self, cfg: dict[str, Any]) -> list[dict[str, Any]]:
        """按过滤规则取「可以进最终播放列表」的频道。

        排除只有音频的频道（status='audio_only'），即使它被判定为「可用」。
        """
        rows = self.query(
            "SELECT * FROM channels WHERE active=1 AND status=? "
            "AND speed_kbps >= ? AND success_count >= ? "
            "AND (elapsed_ms IS NULL OR elapsed_ms <= ?) "
            "ORDER BY source_index ASC",
            (
                "ok",  # 只保留真正有视频的频道
                float(cfg["min_speed_kbps"]),
                int(cfg["min_success_count"]),
                float(cfg["timeout_seconds"]) * 1000,
            ),
        )
        return rows

    def all_active_for_output(self) -> list[dict[str, Any]]:
        return self.query("SELECT * FROM channels WHERE active=1 ORDER BY source_index ASC")

    def prune_results(self, keep_days: int = 30, keep_rows: int = 300_000) -> int:
        cutoff = int(time.time()) - keep_days * 86400
        with self._tx() as conn:
            cur1 = conn.execute("DELETE FROM results WHERE tested_at < ?", (cutoff,))
            row = conn.execute("SELECT MIN(id) AS m, MAX(id) AS x FROM results").fetchone()
            cur2 = None
            if row and row["m"] is not None and row["x"] is not None:
                floor_id = int(row["x"]) - keep_rows
                if floor_id > int(row["m"]):
                    cur2 = conn.execute("DELETE FROM results WHERE id <= ?", (floor_id,))
        removed = int(cur1.rowcount or 0)
        if cur2 is not None:
            removed += int(cur2.rowcount or 0)
        return removed
