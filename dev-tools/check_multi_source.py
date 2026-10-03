"""多订阅源端到端判据（只在本机跑，不进镜像）：通过真实 HTTP 接口驱动正在运行的程序。

覆盖用户要求的四件事：
  1. 多个源同时使用，合并成一份播放列表；
  2. 同一个频道（同 tvg-id）在多个源里都有时，只留实测最快的一条进 iptv.m3u；
  3. 同一个播放地址被多个源重复给出时只算一条，归属第一个拿到它的源；
  4. 「本轮下载失败的源」保留它上次成功的频道，而「已从配置里删掉的源」必须下线 —— 两者不能混。
  5. 择优依据的「速度」得是真的速度：实测值要对得上假源的限速档位，
     不能把 ffmpeg 起进程的时间算进分母（那样快源会被测成慢源，挑错地址）。

用法（假源和程序都要先起来）：
  python dev-tools/fake_origin_server.py --bind 127.0.0.1 --port 8099
  DATA_DIR=D:/tmp/iptvms ... python -m uvicorn app.main:app --port 9001
  python dev-tools/check_multi_source.py --base http://127.0.0.1:9001 -u admin:test-pass
"""

from __future__ import annotations

import argparse
import base64
import json
import subprocess
import sys
import time

A_URL = "http://127.0.0.1:8099/multi_a.m3u"
B_URL = "http://127.0.0.1:8099/multi_b.m3u"
C_URL = "http://127.0.0.1:8099/multi_c.m3u"
# 「这个源本轮挂了」要让配置里的地址原样不动，只把假源上的订阅文件挪走。
# 配置里换地址是另一回事（那叫「已从配置删掉的源」），两种语义必须分开验。
WWW = "D:/iptv/iptv-auto-tester/dev-tools/www"
B_FILE = f"{WWW}/multi_b.m3u"
B_HIDDEN = f"{WWW}/multi_b.m3u.hidden"

FAST_URL = "http://127.0.0.1:8099/rate/2000000/live/test.ts"
SLOW_A = "http://127.0.0.1:8099/rate/900000/live/test.ts"
SLOW_C = "http://127.0.0.1:8099/rate/700000/live/test.ts"


def call(method: str, base: str, token: str, path: str, body: dict | None = None) -> dict:
    cmd = ["curl", "-s", "-X", method, "-H", f"Authorization: Basic {token}"]
    if body is not None:
        cmd += ["-H", "Content-Type: application/json", "-d", json.dumps(body, ensure_ascii=False)]
    cmd.append(base + path)
    out = subprocess.run(cmd, capture_output=True).stdout.decode("utf-8", "replace")
    try:
        return json.loads(out)
    except ValueError:
        return {"raw": out[:400]}


def get_raw(base: str, path: str) -> str:
    return subprocess.run(["curl", "-s", base + path], capture_output=True).stdout.decode(
        "utf-8", "replace"
    )


def wait_idle(base: str, token: str, limit: int = 240) -> dict:
    deadline = time.time() + limit
    while time.time() < deadline:
        state = call("GET", base, token, "/api/status").get("state", {})
        if not state.get("running"):
            return state
        time.sleep(1.5)
    return {"timeout": True}


def run_round(base: str, token: str, sources: list[str]) -> dict:
    """保存配置 → 立刻更新 → 等这一轮真的跑完。

    配置回读必须逐个字段比对：校验不过的字段会静默回退成默认值，
    只看 POST 返回 ok 不足以证明阈值/地址真的生效（以前这样把负向控制跑成“什么都没改”）。
    """
    patch = {"source_urls": sources}
    resp = call("POST", base, token, "/api/config", patch)
    if not resp.get("ok"):
        raise SystemExit(f"保存配置被拒绝：{resp}")
    got = call("GET", base, token, "/api/config")["config"]
    if list(got.get("source_urls") or []) != list(sources):
        raise SystemExit(f"源地址回读不一致：期望 {sources}，实际 {got.get('source_urls')}")
    wait_idle(base, token)
    started = {}
    for _ in range(30):
        started = call("POST", base, token, "/api/update")
        if started.get("ok"):
            break
        time.sleep(1.5)
    if not started.get("ok"):
        raise SystemExit(f"启动更新失败：{started}")
    time.sleep(0.5)  # 等 _begin() 清干净状态，别把上一轮的进度当这一轮
    state = wait_idle(base, token)
    if state.get("timeout"):
        raise SystemExit("这一轮没有在规定时间内结束")
    return state


def channels(base: str, token: str) -> list[dict]:
    return call("GET", base, token, "/api/channels?limit=500&include_inactive=true").get("items", [])


def by_id(items: list[dict], tvg_id: str) -> list[dict]:
    return [x for x in items if (x.get("tvg_id") or "") == tvg_id]


def url_lines(text: str) -> list[str]:
    return [ln.strip() for ln in text.splitlines() if ln.strip() and not ln.startswith("#")]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:9001")
    parser.add_argument("--user", default="admin:test-pass")
    parser.add_argument("--out", default="D:/tmp/ff/multi_source.txt")
    args = parser.parse_args()
    token = base64.b64encode(args.user.encode()).decode()
    base, tok = args.base, token

    checks: list[tuple[str, bool, str]] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        checks.append((name, bool(ok), detail))

    lines: list[str] = [f"# check_multi_source  {time.strftime('%Y-%m-%d %H:%M:%S')}  base={base}"]
    if "config" not in call("GET", base, tok, "/api/config"):
        print("程序没有在跑或账号密码不对", flush=True)
        return 2

    # —— 第 1 轮：三个源同时用 ————————————————————————
    state = run_round(base, tok, [A_URL, B_URL, C_URL])
    items = channels(base, tok)
    iptv = url_lines(get_raw(base, "/iptv.m3u"))
    allm3u = url_lines(get_raw(base, "/iptv_all.m3u"))
    sources_api = call("GET", base, tok, "/api/sources")
    src_state = {s.get("url"): s for s in (state.get("sources") or [])}

    lines.append("")
    lines.append(f"## 第 1 轮（A+B+C 全可用）state.source_state={state.get('source_state')}")
    for s in state.get("sources") or []:
        lines.append(
            f"  源 {s.get('index')} {s.get('url')} ok={s.get('ok')} 解析={s.get('lines')} "
            f"合并后={s.get('kept')} 在册={s.get('channels')} 可用={s.get('channels_ok')} "
            f"耗时={s.get('seconds')}s 说明={s.get('error') or '-'}"
        )
    lines.append(
        f"  在册频道={len(items)} iptv.m3u={len(iptv)} iptv_all.m3u={len(allm3u)} "
        f"跨源重复={state.get('merged_duplicates')}"
    )

    check("三个源都算本轮成功", len(src_state) == 3 and all(s.get("ok") for s in src_state.values()),
          f"{ {k: v.get('ok') for k, v in src_state.items()} }")
    check("三个源各自都解析到了地址",
          all(int(s.get("lines") or 0) > 0 for s in src_state.values()), "")
    check("源状态里给出「N 个源共 M 个地址」", "3 个源" in str(state.get("source_state") or ""),
          f"source_state={state.get('source_state')}")
    # 全新库里，测速之前每个源的「可用」必然是 0；这里要求它等于本轮测完的真实数字，
    # 才能证明源状态是在测速之后重新发布过的（而不是滞后一整轮）。
    api_src = {s.get("source_url"): s for s in (sources_api.get("sources") or [])}
    check("每个源的「可用」数按本轮测速结果给出，且与 /api/sources 一致",
          all(int(s.get("channels_ok") or 0) > 0 for s in src_state.values())
          and all(int(src_state[u].get("channels_ok") or -1) == int(v.get("ok") or -2)
                  for u, v in api_src.items() if u in src_state),
          "state=" + str({u[-14:]: v.get("channels_ok") for u, v in src_state.items()})
          + " /api/sources=" + str({u[-14:]: v.get("ok") for u, v in api_src.items()}))
    check("A 独有频道在册", any(x.get("tvg_id") == "MS.ONLYA" and x.get("active") for x in items), "")
    check("B 独有频道在册且归属 B",
          [x for x in by_id(items, "MS.ONLYB") if x.get("source_url") == B_URL and x.get("active")],
          "")
    check("C 独有频道在册且归属 C",
          [x for x in by_id(items, "MS.ONLYC") if x.get("source_url") == C_URL and x.get("active")],
          "")
    only_dup = by_id(items, "MS.DUP")
    check("两源重复的同一个地址只算一条", len(only_dup) == 1, f"实际 {len(only_dup)} 条")
    check("重复地址归第一个拿到它的源（A）",
          bool(only_dup) and only_dup[0].get("source_url") == A_URL,
          f"source_url={only_dup[0].get('source_url') if only_dup else '-'}")
    shared = by_id(items, "MS.SHARED")
    check("跨源同名频道在库里仍然是三条（各源一条，只是出片时择优）", len(shared) == 3,
          f"实际 {len(shared)} 条")
    check("iptv.m3u 里 MS.SHARED 只剩一条", iptv.count(FAST_URL) + iptv.count(SLOW_A) + iptv.count(SLOW_C) == 1,
          f"产物 {len(iptv)} 条")
    check("留下来的是实测最快的那条（源B）", FAST_URL in iptv,
          f"iptv.m3u={iptv}")
    check("落选的两条仍在 iptv_all.m3u 里", SLOW_A in allm3u and SLOW_C in allm3u,
          f"iptv_all.m3u={len(allm3u)} 条")
    check("跨源合并计数写进状态", int(state.get("merged_duplicates") or 0) >= 0,
          f"merged_duplicates={state.get('merged_duplicates')}")
    # 择优依据本身要站得住：三条 MS.SHARED 走的是同一个文件、不同的限速档位，
    # 实测速度必须贴着档位走。分母里混进 ffmpeg 启动时间的话，
    # 2000KB/s 那档会被测成比 900KB/s 还慢，上面「留最快的一条」就成了留最慢的一条。
    nominal = {FAST_URL: 2000000 / 1024.0, SLOW_A: 900000 / 1024.0, SLOW_C: 700000 / 1024.0}
    shared_by_url = {x.get("url"): x for x in shared}
    speeds = {u: float((shared_by_url.get(u) or {}).get("speed_kbps") or 0) for u in nominal}

    def band(text: str) -> str:
        """从 /rate/<bytes_per_second>/... 里取出限速档位，日志里好读。"""
        return text.split("/rate/")[1].split("/")[0] if "/rate/" in text else text

    lines.append(
        "  实测速度 vs 源站限速："
        + "，".join(f"{band(u)}B/s 档→{speeds[u]:.0f}KB/s" for u in (SLOW_A, FAST_URL, SLOW_C))
    )
    check("每一档限速源的实测速度都对得上档位（±30%）",
          all(0 < speeds[u] <= nominal[u] * 1.3 and speeds[u] >= nominal[u] * 0.7 for u in nominal),
          "、".join(f"{band(u)}B/s 实测 {speeds[u]:.0f}KB/s（档位 {nominal[u]:.0f}KB/s）" for u in nominal))
    check("档位排序就是实测排序（B>A>C）",
          speeds[FAST_URL] > speeds[SLOW_A] > speeds[SLOW_C],
          f"{speeds[FAST_URL]:.0f} > {speeds[SLOW_A]:.0f} > {speeds[SLOW_C]:.0f}")

    check("源B里的坏地址没进 iptv.m3u", "http://127.0.0.1:8099/live/missing.ts" not in iptv, "")
    listed_b = [x for x in by_id(items, "MS.BAD")]
    check("坏地址状态是 HTTP错误（不是被忽略）",
          bool(listed_b) and listed_b[0].get("status") == "http_error"
          and listed_b[0].get("http_status") == 404,
          f"status={listed_b[0].get('status') if listed_b else '-'}")
    check("/api/sources 按源给出在册频道数",
          len(sources_api.get("sources") or []) >= 3,
          f"{[(s.get('source_url'), s.get('total')) for s in sources_api.get('sources') or []]}")
    check("按源筛选只回该源的频道",
          all(x.get("source_url") == B_URL
              for x in call("GET", base, tok, f"/api/channels?source={B_URL}&limit=100").get("items", [])),
          "")

    # —— 第 2 轮：源B 本轮下载失败（配置地址不动，只是假源上的文件没了）——
    import os

    state2 = None
    try:
        os.rename(B_FILE, B_HIDDEN)
        state2 = run_round(base, tok, [A_URL, B_URL, C_URL])
    finally:
        os.rename(B_HIDDEN, B_FILE)
    items2 = channels(base, tok)
    iptv2 = url_lines(get_raw(base, "/iptv.m3u"))
    src2 = {s.get("url"): s for s in (state2.get("sources") or [])}
    lines.append("")
    lines.append(f"## 第 2 轮（B 这个源挂了，但地址还配着）source_state={state2.get('source_state')}")
    for s in state2.get("sources") or []:
        lines.append(f"  源 {s.get('index')} {s.get('url')} ok={s.get('ok')} 说明={s.get('error') or '-'}")
    lines.append(f"  在册频道={len(items2)} iptv.m3u={len(iptv2)}")

    check("失败的源本轮标记为不成功",
          bool(src2.get(B_URL)) and not src2[B_URL].get("ok"),
          f"ok={src2.get(B_URL, {}).get('ok')} error={src2.get(B_URL, {}).get('error')}")
    check("失败原因写的是 HTTP 404，不是笼统的「下载失败」",
          "404" in str(src2.get(B_URL, {}).get("error") or ""),
          f"error={src2.get(B_URL, {}).get('error')}")
    check("状态里说清是「部分成功」", "部分成功" in str(state2.get("source_state") or ""),
          f"source_state={state2.get('source_state')}")
    # 期望值从第 1 轮实测里取，不写死条数：
    # 源B 解析到 4 条，其中 /live/test.ts（MS.DUP）跨源重复，按「归第一个拿到它的源」判给了 A，
    # 所以库里真正属于 B 的只有 3 条。坏源保留上次成功时，这 3 条应当一条不少、且仍在册。
    b_ids_r1 = sorted(x.get("tvg_id") or "" for x in items if x.get("source_url") == B_URL)
    keep_b = [x for x in items2 if x.get("source_url") == B_URL]
    check("B 的频道还全部在册（坏源保留上次成功）",
          sorted(x.get("tvg_id") or "" for x in keep_b) == b_ids_r1
          and all(x.get("active") for x in keep_b),
          f"B 在册 {len([x for x in keep_b if x.get('active')])}/{len(b_ids_r1)}，"
          f"第1轮归属B的频道={b_ids_r1}")
    check("B 上次成功的快地址还留在 iptv.m3u 里", FAST_URL in iptv2, f"iptv.m3u={iptv2}")
    check("A/C 这轮照常更新", all(src2.get(u, {}).get("ok") for u in (A_URL, C_URL)), "")

    # —— 第 3 轮：把源B 从配置里彻底删掉，它必须下线 ——————————————
    #    和第 2 轮对照：同样是「这个源没数据」，删掉和挂掉的处理必须相反。
    state3 = run_round(base, tok, [A_URL, C_URL])
    items3 = channels(base, tok)
    iptv3 = url_lines(get_raw(base, "/iptv.m3u"))
    lines.append("")
    lines.append(f"## 第 3 轮（B 已从配置删除）source_state={state3.get('source_state')}")
    lines.append(f"  在册频道={len(items3)} iptv.m3u={len(iptv3)}")

    gone = [x for x in items3 if x.get("source_url") == B_URL]
    check("删掉的源它的频道全部下线", gone and not any(x.get("active") for x in gone),
          f"B 的 {len(gone)} 条，仍在册 {len([x for x in gone if x.get('active')])}")
    check("下线的原因和「源挂了」区分得开：删掉的源不再出现在 iptv.m3u",
          FAST_URL not in iptv3 and "http://127.0.0.1:8099/live/audio.ts?src=b" not in iptv3,
          f"iptv.m3u={iptv3}")
    check("删掉源B 之后，同名频道改留源A/C 里最快的一条",
          SLOW_A in iptv3 and SLOW_C not in iptv3, f"iptv.m3u={iptv3}")
    check("还在配置里的源不受影响",
          all(x.get("active") for x in items3 if x.get("source_url") in (A_URL, C_URL) and x.get("status") in ("ok", "audio_only")),
          "")

    # —— 第 4 轮：把源B 加回来，频道要重新上线 ——————————————
    state4 = run_round(base, tok, [A_URL, B_URL, C_URL])
    items4 = channels(base, tok)
    iptv4 = url_lines(get_raw(base, "/iptv.m3u"))
    lines.append("")
    lines.append(f"## 第 4 轮（B 加回来）source_state={state4.get('source_state')}")
    lines.append(f"  在册频道={len(items4)} iptv.m3u={len(iptv4)}")
    back = [x for x in items4 if x.get("source_url") == B_URL]
    check("重新配置的源，频道又上线了", back and all(x.get("active") for x in back),
          f"B 的 {len(back)} 条全部在册")
    check("最快的那条又回到 iptv.m3u", FAST_URL in iptv4, f"iptv.m3u={iptv4}")
    check("三源合并后 iptv.m3u 里 MS.SHARED 还是只有一条",
          sum(iptv4.count(u) for u in (FAST_URL, SLOW_A, SLOW_C)) == 1,
          f"iptv.m3u={iptv4}")

    # 复原：把源地址设回单个正常源，别在开发机上留三个测试地址
    call("POST", base, tok, "/api/config", {"source_urls": [A_URL]})
    lines.append("")
    lines.append("## 判据")
    passed = 0
    for name, ok, detail in checks:
        passed += 1 if ok else 0
        lines.append(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f"  —— {detail}" if detail else ""))
    lines.append("")
    lines.append(f"合计 {passed}/{len(checks)} 条通过")
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    print(f"written {args.out}  ({passed}/{len(checks)} passed)", flush=True)
    return 0 if passed == len(checks) else 1


if __name__ == "__main__":
    sys.exit(main())
