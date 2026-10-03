"""通过 HTTP 接口做最后一轮行为核对（只读 + 改配置，验证过滤阈值和 IPv6-only）。

用法：
  python dev-tools/check_filters.py --base http://127.0.0.1:9001 -u admin:test-pass
"""

from __future__ import annotations

import argparse
import base64
import json
import subprocess
import sys
import time


def call(method: str, base: str, token: str, path: str, body: dict | None = None) -> dict:
    cmd = ["curl", "-s", "-X", method, "-H", f"Authorization: Basic {token}"]
    if body is not None:
        cmd += ["-H", "Content-Type: application/json", "-d", json.dumps(body, ensure_ascii=False)]
    cmd.append(base + path)
    out = subprocess.run(cmd, capture_output=True).stdout.decode("utf-8", "replace")
    try:
        return json.loads(out)
    except ValueError:
        return {"raw": out[:300]}


def get_raw(base: str, path: str) -> str:
    return subprocess.run(["curl", "-s", base + path], capture_output=True).stdout.decode(
        "utf-8", "replace"
    )


def wait_idle(base: str, token: str, limit: int = 180) -> dict:
    deadline = time.time() + limit
    while time.time() < deadline:
        state = call("GET", base, token, "/api/status").get("state", {})
        if not state.get("running"):
            return state
        time.sleep(2)
    return {"timeout": True}


def trigger(base: str, token: str, path: str) -> dict:
    """确认任务真的启动了再返回；上一轮没结束时重试。"""
    wait_idle(base, token)
    resp: dict = {}
    for _ in range(30):
        resp = call("POST", base, token, path)
        if resp.get("ok"):
            time.sleep(0.5)  # 等 _begin() 清干净状态，别把上一轮的进度当这一轮
            return resp
        time.sleep(2)
    raise SystemExit(f"启动 {path} 失败：{resp}")


def count_entries(text: str) -> int:
    return sum(1 for line in text.splitlines() if line.startswith("#EXTINF"))


def save_config(base: str, token: str, patch: dict) -> dict:
    """保存并回读确认阈值真的生效。

    校验失败的字段会静默回退到默认值（min_success_count 超出范围时曾这样把负向控制
    变成“什么都没改”），所以只看 POST 的 ok 是不够的，必须把生效值读回来比对。
    """
    resp = call("POST", base, token, "/api/config", patch)
    if not resp.get("ok"):
        raise SystemExit(f"保存配置被拒绝：{resp}")
    got = call("GET", base, token, "/api/config")["config"]
    for key, want in patch.items():
        if got.get(key) != want:
            raise SystemExit(f"配置回读不一致：{key} 期望 {want}，实际 {got.get(key)}")
    return got


def max_success_count(base: str, token: str) -> int:
    """读当前可用频道里最大的 success_count（这一轮跑完还会 +1，所以留足余量）。"""
    listing = call("GET", base, token, "/api/channels?status=ok&limit=1000")
    counts = [int(x.get("success_count") or 0) for x in listing.get("items", [])]
    return max(counts) if counts else 0


def max_speed_kbps(base: str, token: str) -> float:
    """读当前可用频道里最大的实测速度（KB/s），用来构造「比最快还快一点」的阈值。

    本地不限速的夹具会在 0.05 秒的采样下限里跑完，测出来是每文件字节数除以下限的封顶值
    （test.ts 约 11700KB/s），这是刻意的：整个文件一次读就到齐时，秒数没有统计意义。
    """
    listing = call("GET", base, token, "/api/channels?status=ok&limit=1000")
    speeds = [float(x.get("speed_kbps") or 0) for x in listing.get("items", [])]
    if not speeds or max(speeds) <= 0:
        raise SystemExit("库里没有带速度的可用频道，无法构造速度阈值控制")
    return max(speeds)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:9001")
    parser.add_argument("--user", default="admin:test-pass")
    parser.add_argument("--out", default="D:/tmp/ff/filters.txt")
    args = parser.parse_args()
    token = base64.b64encode(args.user.encode()).decode()

    lines: list[str] = []
    base, tok = args.base, token

    cfg = call("GET", base, tok, "/api/config")["config"]
    original = dict(cfg)
    lines.append(f"原始配置：min_success_count={cfg['min_success_count']} ip_prefer={cfg['ip_prefer']}")

    all_m3u = get_raw(base, "/iptv_all.m3u")
    lines.append(
        f"iptv_all.m3u：{count_entries(all_m3u)} 个频道（含失效），"
        f"里面有失败频道吗={'涓流' in all_m3u}"
    )
    lines.append(f"iptv_all.m3u 元数据样例：{[x for x in all_m3u.splitlines() if x.startswith('#EXTINF')][:1]}")

    # 1) 最小成功次数阈值：阈值必须按“当前库里最大的 success_count + 余量”来定，
    #    否则跑得久了成功次数早就超过固定值 5，这条负向控制会静默失效（曾经就踩过）。
    #    +2 是因为本轮跑完后头部频道还会再 +1，贴着 max+1 设阈值会被这一轮顶穿。
    max0 = max_success_count(base, tok)
    if max0 + 2 > 1000:
        raise SystemExit(f"success_count 已经到 {max0}，无法在合法范围内构造阈值控制")
    lines.append(f"当前可用频道的最大 success_count={max0}")

    threshold = max0 + 2
    patch = dict(cfg, min_success_count=threshold)
    save_config(base, tok, patch)
    trigger(base, tok, "/api/test")
    state = wait_idle(base, tok)
    ok_m3u = get_raw(base, "/iptv.m3u")
    lines.append(
        f"[阈值控制] min_success_count={threshold}（>最大成功次数 {max0}，已回读确认生效）后 "
        f"iptv.m3u 频道数={count_entries(ok_m3u)}（期望 0），本轮 stage={state.get('stage')} "
        f"done={state.get('done')}/{state.get('total')}"
    )
    # 边界：阈值正好等于本轮之后的最大成功次数时至少留一条，
    # 证明“清空”确实是阈值造成的，而不是别的 bug 让产物恒为空。
    max1 = max_success_count(base, tok)
    patch = dict(cfg, min_success_count=max1)
    save_config(base, tok, patch)
    trigger(base, tok, "/api/test")
    wait_idle(base, tok)
    ok_m3u = get_raw(base, "/iptv.m3u")
    lines.append(
        f"[阈值边界] min_success_count={max1}（=本轮之后的最大成功次数）后 iptv.m3u 频道数="
        f"{count_entries(ok_m3u)}（期望 ≥1）"
    )

    # 2) 最低速度阈值拉到「比实测最快的那条还高一点」：产物必须清空。
    #    这里以前写死 3000KB/s，注释的理由是「本地源实测只有 2.9MB/s」——那个数把
    #    ffmpeg 起进程的时间也算进了分母，测速口径一改就会假失效（阈值明明生效却留着频道），
    #    所以和上面的 success_count 一样改成从库里回读最大值再 +1，并补一条边界控制。
    peak = max_speed_kbps(base, tok)
    threshold_speed = int(peak) + 1
    patch = dict(cfg, min_success_count=1, min_speed_kbps=threshold_speed)
    save_config(base, tok, patch)
    trigger(base, tok, "/api/test")
    wait_idle(base, tok)
    ok_m3u = get_raw(base, "/iptv.m3u")
    lines.append(
        f"[阈值控制] min_speed_kbps={threshold_speed}（>实测最快 {peak:.0f}KB/s，已回读确认生效）后 "
        f"iptv.m3u 频道数={count_entries(ok_m3u)}（期望 0）"
    )
    # 边界：阈值退到最快那条的 90% 时至少要留一条，证明「清空」确实是阈值造成的。
    # 峰值只在第一轮之前取一次：清空轮跑完后所有频道都会被记成「速度不足」，
    # 那时候再按 status=ok 去读就什么都读不到了。
    boundary_speed = max(1, int(peak * 0.9))
    patch = dict(cfg, min_success_count=1, min_speed_kbps=boundary_speed)
    save_config(base, tok, patch)
    trigger(base, tok, "/api/test")
    wait_idle(base, tok)
    ok_m3u = get_raw(base, "/iptv.m3u")
    lines.append(
        f"[阈值边界] min_speed_kbps={boundary_speed}（<实测最快 {peak:.0f}KB/s）后 iptv.m3u 频道数="
        f"{count_entries(ok_m3u)}（期望 ≥1）"
    )

    # 3) 仅 IPv6：IPv4 源应判失败，IPv6 源应可用
    patch = dict(cfg, min_speed_kbps=500, ip_prefer="ipv6_only")
    call("POST", base, tok, "/api/config", patch)
    trigger(base, tok, "/api/update")
    wait_idle(base, tok)
    listed = call("GET", base, tok, "/api/channels?limit=500")["items"]
    by_status: dict[str, int] = {}
    for item in listed:
        by_status[item["status"]] = by_status.get(item["status"], 0) + 1
    v6ok = [i for i in listed if i["family"] == "ipv6" and i["status"] in ("ok", "audio_only")]
    v4bad = [i for i in listed if i["status"] == "connect_failed"]
    lines.append(
        f"[仅IPv6] 状态分布={by_status}；IPv6 可用={len(v6ok)}；"
        f"连接失败={len(v4bad)}（IPv4 源在 ipv6_only 下应当全军覆没）"
    )
    lines.append(f"[仅IPv6] 失败原因样例={ (v4bad[0]['failure_reason'] if v4bad else '-') }")
    lines.append(f"[仅IPv6] iptv_ipv4.m3u 频道数={count_entries(get_raw(base, '/iptv_ipv4.m3u'))}（期望 0）")
    lines.append(f"[仅IPv6] iptv_ipv6.m3u 频道数={count_entries(get_raw(base, '/iptv_ipv6.m3u'))}")

    # 4) 复原成自动选择并跑一轮，确认 IPv4/IPv6 都能拿到结果
    save_config(base, tok, dict(original, ip_prefer="auto"))
    trigger(base, tok, "/api/update")
    wait_idle(base, tok)
    stats = call("GET", base, tok, "/api/status")["stats"]
    lines.append(
        f"[复原 auto] 有效={stats['ok']} 失效={stats['bad']} "
        f"IPv4/IPv6 选用={stats['via_ipv4']}/{stats['via_ipv6']} "
        f"iptv.m3u 频道数={count_entries(get_raw(base, '/iptv.m3u'))}"
    )

    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    print(f"written {args.out}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
