# IPTV Auto Tester

一个或几个固定的 IPTV/M3U/TXT 订阅地址 → 自动定时下载 → FFmpeg/FFprobe 真实测流 → 过滤失效地址 → 合并成一份稳定本地 M3U → 通过 HTTP 提供给播放器。

播放器永远只需要这一个地址，不管后台源怎么变：

```
http://192.168.8.99:9001/iptv.m3u
```

---

## 一、整体设计

```
                 ┌────────────────────────────────────────────┐
   定时器(5s tick)│  Scheduler                                  │
                 └───────────────┬────────────────────────────┘
                                 ▼
   ┌──────────────────── Pipeline（一轮更新，可取消）────────────────────┐
   │ ① 下载订阅源        逐个源 download_source()，最多 20 个，走代理拿状态码│
   │ ② 解析              m3u_parser.parse()  M3U/M3U8/TXT/裸 URL       │
   │ ③ 合并去重          url sha1 唯一键；跨源重复的地址只留一条，归属先拿到它│
   │                     的源；同名频道各源都留行，出片时才择优            │
   │ ④ 入库              db.sync_channels()  消失的频道只置 active=0    │
   │ ⑤ 并发测速          tester.test_channel()  ffprobe + ffmpeg 实测   │
   │ ⑥ 记录              results 表：IPv4/IPv6 各一行，含失败尝试        │
   │ ⑦ 过滤 + 生成       outputs.write_all()  同名频道留实测最快的一条，   │
   │                     5 个产物原子写入                               │
   └───────────────────────────────┬────────────────────────────────┘
                                   ▼
        /data/output/{iptv.m3u, iptv_all.m3u, iptv_ipv4.m3u, iptv_ipv6.m3u, results.csv}
                                   ▼
                 FastAPI：播放器匿名取列表 / 浏览器带密码看管理页
```

技术选型：Python 3.13 + FastAPI + asyncio + 标准库 sqlite3 + 镜像内自带 ffmpeg/ffprobe。宿主机不需要装 Python、Node 或 ffmpeg。

关键设计点：

1. **不用 HTTP 200 判定可用性。** 判定依据是 ffprobe 能否真的解析出媒体流、有没有视频流/音频流，以及 ffmpeg `-c copy` 拉一段时间后的实测吞吐。返回 200 的 HTML 页面会被判成 `parse_failed`。
2. **但也不让「某个 TS 分片 404」一票否决。** HLS 播放列表本身 200、内容确实是可识别的 m3u8，就按播放列表级结论判定可用性，个别分片取不到只记成「个别分片失败（不判死）」；只有播放列表列出的分片**一个都没取到**才算内容空了。
3. **每次测速都经过一个本地强制协议族代理。** 这样同一个域名可以分别按 IPv4、IPv6 各测一遍，也能拿到真实的连接耗时、首包耗时和下载字节数。
4. **「源有效」和「测试失败」分开记。** 每个地址都留下 `final_url / redirect_count / content_type / hls_valid / segment_test / playable / test_error`，看库就能分清是源站没给东西、还是给了但没能播。
5. **对外产物永远写订阅文件给的原始地址。** 源站 302 到带 `?tm=…&key=…` 临时签名的 CDN 时，检测跟着跳转走、最终地址记进数据库，但 `iptv.m3u` 里不会留下签名地址（那是有时效的，写进去过几天必挂）。
6. **失败不删数据。** 频道行只把 `active` 置 0，历史测速记录永久保留；某个源本轮下载失败时，它上次成功的频道原样留着，旧播放列表也不会被覆盖。
7. **子进程数量与 URL 总数无关。** 只有固定数量的 worker 协程，每个 worker 同一时刻只有一个 ffprobe/ffmpeg 在跑，超时立刻 kill。

---

## 二、目录结构

```
iptv-auto-tester/
├── docker-compose.yml           # 唯一需要改的是 .env
├── Dockerfile                   # python:3.13-slim + ffmpeg + 非 root 运行
├── requirements.txt             # fastapi / uvicorn（版本锁死，可复现构建）
├── .env.example                 # 复制成 .env：端口、时区、管理密码
├── .dockerignore                # dev-tools/、data/、tests/ 不进镜像
├── .gitignore  .gitattributes
├── README.md
├── data/                        # 挂载到容器 /data（配置、库、产物、日志都在这）
│   ├── .gitkeep
│   ├── output/.gitkeep
│   └── logs/.gitkeep
├── app/
│   ├── main.py                  # FastAPI 入口：鉴权中间件 + 播放器产物 + /api/*
│   ├── config.py                # /data/config.json 读写、字段校验、环境变量
│   ├── pipeline.py              # 一轮更新的 7 个阶段 + 进度状态 + 取消
│   ├── scheduler.py             # 定时调度（周期变更重锚定、换源立即开跑）
│   ├── tester.py                # ffprobe/ffmpeg 真实测速、判定、IPv4/IPv6 选路
│   ├── netproxy.py              # 强制协议族 HTTP/CONNECT 代理，顺带测连
│   ├── dnsinfo.py               # A/AAAA 解析 + TTL 缓存
│   ├── m3u_parser.py            # M3U/M3U8/TXT 解析，元数据原样保留
│   ├── outputs.py               # 生成 5 个产物（原子写入）
│   ├── db.py                    # SQLite：表结构、迁移、记录、统计、清理
│   ├── statuses.py              # 状态机机器码 + 中文标签
│   ├── logging_setup.py         # [INFO]/[OK]/[FAIL] 统一中文日志
│   └── static/
│       ├── index.html  app.js       # 首页：配置 + 状态 + 实时进度 + 日志
│       ├── channels.html  channels.js  # 频道列表：搜索/筛选/排序/历史
│       └── style.css
└── dev-tools/                   # 只用于本机验证，已在 .dockerignore 里排除
    ├── fake_origin_server.py    # 假源站（TS/HLS/404/涓流/假流/仅视频）
    ├── make_big_source.py       # 生成几千条 URL 的压测源
    ├── verify_engine.py         # 测速引擎判据
    ├── check_filters.py         # 过滤规则正/负向控制
    ├── check_source_formats.py  # M3U/M3U8/UTF-8 TXT/GBK TXT 覆盖
    ├── check_schedule.py        # 定时与触发时机
    ├── check_redirect_hls.py    # 跟随重定向 / HLS 分片 404 的端到端判据
    ├── check_multi_source.py    # 多源合并、坏源保留、跨源择优
    ├── unit_multi_source.py     # 合并与择优的纯函数判据
    ├── unit_engine_guard.py     # ffmpeg/ffprobe 缺失时的兜底
    ├── unit_player_compat.py    # 产物形状与 Content-Type 的播放器兼容判据
    ├── check_ship_open.py       # 出厂副本开箱检查（鉴权 + MIME + 空库形状）
    └── check_scale.py  check_concurrency_cap.py   # 规模与资源上限
```

---

## 三、docker-compose.yml

```yaml
services:
  iptv-auto-tester:
    build: .
    image: iptv-auto-tester:latest
    container_name: iptv-auto-tester
    restart: unless-stopped
    ports:
      - "${HOST_PORT:-9001}:9001"
    environment:
      TZ: ${TZ:-Asia/Shanghai}
      DATA_DIR: /data
      PORT: 9001
      ADMIN_USER: ${ADMIN_USER:-admin}
      ADMIN_PASSWORD: ${ADMIN_PASSWORD:-}
    volumes:
      - ./data:/data
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:9001/healthz"]
      interval: 60s
      timeout: 10s
      start_period: 30s
      retries: 3
```

要真测 IPv6 时把 `ports:` 段注释掉，换成 `network_mode: host`（详见第十节和第十四节）。

---

## 四、Dockerfile

基础镜像 `python:3.13-slim`，装 `ffmpeg`（含 ffprobe）、`ca-certificates`、`curl`（健康检查用）、`tzdata`；创建 uid=1000 的普通用户运行；只 `COPY app`，验证脚本和假源不进镜像。

```dockerfile
FROM python:3.13-slim
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    DATA_DIR=/data \
    PORT=9001 \
    TZ=Asia/Shanghai
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl ffmpeg tzdata \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY requirements.txt /srv/requirements.txt
RUN pip install --no-cache-dir -r /srv/requirements.txt
COPY app /srv/app
RUN useradd --create-home --uid 1000 --shell /usr/sbin/nologin iptv \
    && mkdir -p /data/output /data/logs \
    && chown -R iptv:iptv /data /srv
USER iptv
EXPOSE 9001
HEALTHCHECK --interval=30s --timeout=8s --start-period=25s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" || exit 1
CMD ["sh", "-c", "exec python -m uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --log-level warning --timeout-graceful-shutdown 15"]
```

构建时镜像内就有 ffmpeg，**不需要宿主机安装任何东西**。

---

## 五、后端模块与接口

### 模块职责

| 文件 | 职责 |
|---|---|
| `app/main.py` | 鉴权中间件、5 个对外产物、`/api/*`、两个页面、lifespan 里体检 ffmpeg/ffprobe 并启动调度器 |
| `app/pipeline.py` | 一轮更新的编排（多源下载合并）、进度状态机、取消、异常时给 runs 行收尾 |
| `app/scheduler.py` | 5 秒 tick：到点且空闲才开跑；保存配置后决定「立即开跑」还是「只重锚下一次」 |
| `app/tester.py` | 单频道测速（结构分析 + 吞吐实测 + 重定向/HLS 判定 + IPv4/IPv6 选优）、订阅源下载、启动时的工具体检 |
| `app/netproxy.py` | 一次性本地代理，强制走指定协议族，记录连接耗时/首包/字节数、跳转链、内容类型、派生分片请求 |
| `app/m3u_parser.py` | 解析与去重 |
| `app/outputs.py` | 产物生成 |
| `app/db.py` | 存储、统计、清理、老库迁移 |
| `app/config.py` | 配置读写与校验、服务级环境变量 |
| `app/logging_setup.py` | 统一 `[INFO]/[OK]/[FAIL]/[WARN]` 中文日志（同时落 `/data/logs/app.log`） |

### 匿名接口（播放器用，不校验密码）

| 路径 | Content-Type | 内容 |
|---|---|---|
| `GET /iptv.m3u` | `text/plain; charset=utf-8` | 过滤后的稳定列表 |
| `GET /iptv_all.m3u` | 同上 | 全部频道（含失效），排查用 |
| `GET /iptv_ipv4.m3u` | 同上 | 仅 IPv4 胜出的频道 |
| `GET /iptv_ipv6.m3u` | 同上 | 仅 IPv6 胜出的频道 |
| `GET /results.csv` | `text/csv; charset=utf-8` | 带 BOM 的全字段明细 |
| `GET /healthz` | `application/json` | 存活探针，不查库 |

播放列表刻意用 `text/plain` 而不是 `audio/x-mpegurl`：飞牛影视这类按 MIME 判断的播放器拿到后者会把订阅文件当成「一个视频」去播放，而不是解析成频道列表（对 TiviMate / Kodi / VLC 无影响）。列表正文的形状也有硬要求，见第十二节末尾。

所有产物都带 `Cache-Control: no-cache, no-store, must-revalidate` 和 `X-IPTV-Generated: <mtime>`。第一轮还没跑完时返回**合法的空列表**并带 `X-IPTV-Status: not-ready`，而不是 404，免得播放器把地址标记为坏源。

### 需要密码的接口（`ADMIN_USER` / `ADMIN_PASSWORD`）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/` | 管理首页 |
| `GET` | `/channels` | 频道列表页 |
| `GET` | `/api/config` | 读配置 + 候选值 |
| `POST` | `/api/config` | 保存配置（校验失败返回中文 400） |
| `POST` | `/api/update` | 立即更新：下载源 + 解析 + 测速 + 生成 |
| `POST` | `/api/test` | 立即测速：只重测库里已有频道 |
| `POST` | `/api/cancel` | 取消当前任务（连带 kill 所有子进程） |
| `GET` | `/api/status` | 状态、进度、统计、每个订阅源这一轮的情况、调度器倒计时、产物列表；`state.engine_error` 非空表示检测工具不可用 |
| `GET` | `/api/channels` | 分页 + 搜索 + 分组 + 状态 + 排序 + 按订阅源筛选（`?source=<源地址>`，`__legacy__` 表示升级前的老数据） |
| `GET` | `/api/sources` | 每个订阅源的在册/可用频道数与当前配置的源列表 |
| `GET` | `/api/channels/{id}/history` | 单频道历次测速（含失败的尝试） |
| `GET` | `/api/groups` | 分组列表 |
| `GET` | `/api/logs` | 日志尾部 |

`ADMIN_PASSWORD` 留空即关闭门禁（只建议内网临时测试）。

---

## 六、前端页面

**首页 `/`**：订阅源地址（一行一个，最多 20 个）、更新周期（10/30/60/120/360/720/1440 分钟 + 自定义）、并发数（10/20/30/40/50/100）、超时时间、最低速度、最低成功次数、IPv4/IPv6 策略、User-Agent；按钮「保存配置 / 立即更新 / 立即测速 / 取消任务」；当前状态卡展示源更新时间、最后测速时间、URL 总数、有效、失效、成功率、IPv4/IPv6 分布、下一次自动更新倒计时；另有一张「本轮每个订阅源」的表：源地址、成功与否、解析多少条、合并后留多少条、库里在册多少条、耗时、失败原因（哪个源挂了、为什么挂一眼就能看出来）。检测工具不可用时页面顶部黄条直接写明是哪个二进制起不来。

运行中每 1.5 秒刷新一次进度行，格式与需求一致：

```
阶段：测速中  总数：260  已完成：30  成功：0  失败：30  进度：11.5%  速度：5.6 URLs/s  预计剩余：41秒  当前频道：压测涓流 020
```

**频道页 `/channels`**：搜索框、分组下拉、状态下拉（含中文标签）、订阅源下拉（按来源筛选）、9 种排序（名称/分组/成功率/速度/延迟/连败/最近测试/状态/URL）、升降序、每页条数、是否包含已消失频道；表格 17 列（频道、分组、状态、协议、IP、速度、首包、总耗时、HTTP、跳转、播放列表/分片、视频/音频、编码、成功/失败、成功率、最近测试、失败原因）；「跳转」列悬停给出原始地址、最终地址与内容类型，「播放列表/分片」列给出 `hls_valid` 与 `segment_test` 的中文；点行展开该频道历次测速明细（同样带跳转次数、分片验证和 ffmpeg 原始报错）。页面上也写明了：对外产物里永远只写订阅文件给的原始地址。

两个页面都用 `location.origin` 拼绝对地址发请求，避免有人把 `http://admin:pwd@nas:9001/` 存成书签时 fetch 直接报错。

---

## 七、SQLite 数据模型（`/data/database.db`）

WAL + `busy_timeout=30000` + 单写锁。

- `runs`：每轮任务一行（`kind`、开始/结束时间、total/tested/ok/failed、`cancelled`、`error`、`source_lines`、`elapsed_ms`）
- `results`：**每次测速的每个协议族一行**，失败的尝试同样入库（`run_id, channel_id, url, name, family, status, http_status, connect_ms, first_packet_ms, elapsed_ms, speed_kbps, has_video, has_audio, v_codec, a_codec, failure_reason, tested_at`，外加「地址本身给了什么」那一层：`final_url, redirect_count, content_type, hls_valid, segment_test, playable, test_error`；归属哪个订阅源由 `channel_id` 关联到 `channels.source_url`）
- `channels`：频道主表，元数据（`tvg_id/tvg_name/group_title/logo/attrs/extra_lines/duration`）+ 归属源（`source_url`，多源合并后每条地址都认得出是从哪个订阅源来的）+ 最新结果（`ipv4_addr/ipv6_addr/family/status/failure_reason/connect_ms/latency_ms/speed_kbps/elapsed_ms/http_status/has_video/has_audio/v_codec/a_codec/v_resolution/final_url/redirect_count/content_type/hls_valid/segment_test/playable`）+ 累计（`first_seen/last_seen/last_tested_at/last_ok_at/success_count/failure_count/consecutive_failures/active`）
- `meta`：几个标量——`last_source_update`（本轮订阅源真正下载成功的时间）、`last_source_count`（合并后在册地址数）、`last_tested_at`、`last_output_write`、`last_valid_count`。每个订阅源这一轮的成功与否、解析/保留/在册条数在 `/api/status` 的 `state.sources` 里，不落冗余表。

成功率、平均速度、平均延迟、最近成功时间、连续失败次数都由这几张表现算，不额外存冗余字段。新增列走 `PRAGMA table_info` 差异比较 + `ALTER TABLE`，老库直接升级、不清空。

`results` 表默认保留 30 天 / 30 万行（`prune_results()`），`channels` 永不清理。

---

## 八、订阅源解析（`app/m3u_parser.py`）

支持：

1. 标准 M3U/M3U8：`#EXTINF:-1 tvg-id="…" tvg-name="…" tvg-logo="…" group-title="…",名称`，`#KODIPROP`、`#EXTVLCOPT`、`#EXTHTTP` 等播放必需的指令原样写回；`#EXTGRP` 会被读进 `group-title`（源没有 `group-title` 时也不丢分组），但**不会**再作为单独一行写回 `#EXTINF` 与地址之间——见第十二节末尾的形状要求；
2. TXT：`名称,URL`、`名称#URL`、`名称#!/组名/URL`、`名称#<group>组</group>#URL` 等运营商常见写法；
3. 裸 URL 列表：一行一个地址，频道名取 URL 末段。

编码依次尝试 `utf-8-sig / utf-8 / gbk / gb18030 / big5 / latin-1`，GBK 中文频道名实测能正常解出。去重按播放地址 sha1，重复项只留第一条并在日志里提示第几行被忽略。解析器不会因为某几行坏就整源失败，坏行计入「忽略 N 行」。

---

## 九、测速引擎（真实 FFmpeg，不是 curl 200）

单个协议族一次测速分两步：

```bash
# ① 结构分析：有没有音视频流、编码、分辨率、是否可识别为流
ffprobe -hide_banner -loglevel warning -print_format json -show_format -show_streams \
        -user_agent "<UA>" -http_proxy http://127.0.0.1:<临时端口> \
        -rw_timeout <超时*1e6> -analyzeduration 2000000 -probesize 1000000 -i "<url>"

# ② 吞吐实测：真实拉 3 秒（不超过配置的超时），统计字节数
ffmpeg -hide_banner -loglevel error -user_agent "<UA>" -http_proxy http://127.0.0.1:<端口> \
       -rw_timeout … -analyzeduration … -probesize … -i "<url>" \
       -map 0:v:0? -map 0:a:0? -c copy -f null -
```

判定顺序（先出结果先定级）：

| 状态码 | 中文 | 触发条件 |
|---|---|---|
| `engine_missing` | 检测工具不可用 | ffprobe/ffmpeg 压根起不来（镜像缺二进制或路径配错）。这属于系统没装好，不能冒充「所有源都挂了」，容器启动时就会体检并在管理页顶部提示，同时挡下手动/定时任务 |
| `unsupported` | 协议不支持 | 非 http/https（`rtp://`、组播等） |
| `connect_failed` | 连接失败 | DNS/TCP 连不上，附系统错误原文 |
| `http_error` | HTTP 错误 | 代理观测到 4xx/5xx |
| `timeout` | 超时 | 墙钟到 `timeout_seconds`，进程立刻 kill |
| `parse_failed` | 解析失败 | 有响应但 ffprobe 认不出媒体流（200 的 HTML 就在这里被拦下） |
| `no_video` | 无视频流 | 只有音频 |
| `no_audio` | 无音频流 | 只有视频（速度等实测值仍会记录） |
| `audio_only` | 可用(仅音频) | 电台类，判定为可用 |
| `slow` | 速度过慢 | 实测 KB/s 低于阈值 |
| `ok` | 可用 | 结构 + 音视频 + 速度都过 |

进入 `iptv.m3u` 的只有 `ok` 与 `audio_only`。

**重定向：跟着跳，但对外不改写。** 运营商源站经常 302 到另一个 CDN，最后一跳还挂上 `?tm=<时间戳>&key=<签名>` 这类临时参数。检测必须跟着跳转走（否则真实状态码、内容类型都拿不到），但结果分两处记：跳转链的终点写进 `final_url`、跳了几次写进 `redirect_count`、最后一次的 `Content-Type` 写进 `content_type`；而 `iptv.m3u` / `iptv_all.m3u` / `results.csv` 里永远是订阅文件给的那个原始地址。签名参数是有时效的，把它写进播放列表就等于埋一颗几天后必炸的雷。

**HLS：播放列表说了算，分片实测只是增强检测。** 代理会把「原始地址那条链定论之后的派生请求」单独数出来（分片、二次打开都算），结论写进 `segment_test`：

| `segment_test` | 中文 | 对可用性的影响 |
|---|---|---|
| `none` | 无分片请求 | 裸 TS / 单文件流本来就没有派生请求，不参与这项判断 |
| `ok` | 分片全部可读 | 正常 |
| `partial` | 个别分片失败（不判死） | 直播切片边界、临时抖动是常态，频道照常可用，stderr 里的分片 4xx 不会再被算成「源站返回 404」 |
| `failed` | 分片全部失败 | 播放列表列出的分片一个都没取到，判 `http_error`，原因写成「播放列表本身能读，但里面 N 个分片一个都没取到 HTTP 404，等于没有内容可播」 |
| `unknown` | HTTPS 隧道内不可见 | 见下面的已知边界 |

同一层还有 `hls_valid`：1=拿到的确实是可识别的 HLS 播放列表，0=名义上是 m3u8 但内容不是（比如 200 返回一段 HTML），NULL=没做这个判断（裸 TS、或 HTTPS 隧道里看不见）。这样看库就能把「源有效」和「测试失败」分开：地址 200、`hls_valid=1`、`segment_test=partial`、`playable=1` 是健康频道；`http_status=200` 而 `playable=0` 才是真出问题。

**速度是「源站真正在吐数据」那一段的平均值。** 分母从代理观察到第一个字节起算，到最后一个字节（或到采样窗口上限）为止，ffmpeg 起进程、建连、发请求的时间不计入。否则一个 0.3 秒就能下完的快源会被 0.5 秒的进程启动拖成「慢」，跨源择优会挑到更慢的那条。整个文件在一次读取里到齐时（本地夹具），分母兜一个 0.05 秒的下限，避免报出没有统计意义的数字。

每次测速都单独开一个只监听 `127.0.0.1` 的临时端口代理（`app/netproxy.py`）：普通 HTTP 把绝对形式请求改写成 origin-form 但保留原 `Host`，HTTPS 走 CONNECT 隧道，因此 ffmpeg 侧的 SNI 和证书校验完全正常。代理顺带产出真实的连接耗时、首包耗时和字节数——速度不是估的，是「代理字节窗口 ÷ 传输区间」。

**HTTPS 的已知边界：** CONNECT 隧道里的内层 HTTP 响应代理看不见，所以 https 地址的 `final_url/content_type/redirect_count` 会是空的，`segment_test` 记 `unknown`，`hls_valid` 留 NULL，状态码从 ffmpeg 的 stderr 里取。可用性判定照常（ffprobe/ffmpeg 的结论仍然是真的），只是「地址本身给了什么」那一层在 https 上信息少一些。

---

## 十、IPv4 / IPv6 双测与选路

`ip_prefer` 五种策略，默认「自动选择」：

- `auto`：IPv4、IPv6 各测一遍；都通过就取「更快/首包更早」的那个，只有一边通过就用那一边；
- `ipv4_preferred` / `ipv6_preferred`：先测偏好的一族，通过就不再测另一族，否则回退；
- `ipv4_only` / `ipv6_only`：只测一族，另一族的地址直接判 `connect_failed`，失败原因写清「ipv6_only 策略下 x.x.x.x 没有可用地址」。

两个地址分别在 `channels.ipv4_addr` / `ipv6_addr` 里留着，产物里 `iptv_ipv4.m3u` 与 `iptv_ipv6.m3u` 按胜出族拆分。容器启动时会探测 `/proc/net/if_inet6`，没有 IPv6 出口就打 `[WARN]` 日志提醒改用 host 网络。

---

## 十一、定时与触发（`app/scheduler.py`）

- 5 秒 tick 重新读配置，改周期不用重启容器；
- 到点且当前空闲才开跑；正在跑就跳过这一 tick，不排队叠跑；
- 容器启动后先跑第一轮（前提是源地址非空；为空时 `/api/status` 里 `scheduler.waiting_for_source=true`，日志写「还没有配置订阅源地址，调度器等待页面里保存配置后再开始」，页面状态卡提示等待填写）；
- **保存配置时只有「源地址变了」才立刻开跑**；只调速度/超时/周期不会触发整轮重测，只把下一次自动更新时间重新锚定到「现在 + 周期」，日志里会写明「下一次自动更新安排在 X 后」；
- 「立即更新」「立即测速」随时可点，任务进行中按钮禁用，可点「取消任务」；取消会停掉所有 worker 并 kill 子进程，实测从请求到 worker 退出在 3 秒以内（两次实测：一次在请求后 2.6 秒的采样点上确认已停，一次那一轮 `runs` 行 `elapsed_ms=1000`），`runs` 行仍会正确收尾（`cancelled=1`、实测数量、结束时间、`source_lines`）。
- 每一轮的待测顺序是「新频道/从未成功 → 上次失败 → 上次成功」（`db.pending_test_channels`）。这样半途取消时先被刷新的都是高风险地址，代价是取消那一轮里「上次能播」的那批可能还没轮到重测，产物仍旧沿用上次的结果。

---

## 十二、产物生成规则（`app/outputs.py`）

进入 `iptv.m3u` 的条件：`active=1` 且状态为 `ok`/`audio_only` 且 `success_count >= min_success_count` 且实测速度 `>= min_speed_kbps`。

**多个订阅源同时用（最多 20 个）时的合并规则：**

1. 同一个播放地址出现在好几个源里，库里只留一条，归属**第一个拿到它的源**（`channels.source_url`），日志和状态里会计入「跨源重复 N 条」；
2. 同一个频道名/`tvg-id` 在不同源里各有不同地址时，库里各源都留一条（便于回看每个源的质量），出片时只写**实测最快的那条**进 `iptv.m3u`，落选的仍然在 `iptv_all.m3u` 里；
3. **源本轮下载失败** ≠ **源从配置里删掉**：前者保留它上次成功的频道和快地址（页面显示「部分成功，2/3 个源可用」并写清失败原因，比如「源站返回 HTTP 404」），后者它的所有频道立刻下线、不再出现在任何产物里。这两条语义在 `check_multi_source.py` 里是分开验证的。

顺序按源文件里的 `source_index` 保持原样，元数据原样写回（`tvg-id`、`tvg-name`、`tvg-logo`、`group-title`、`#KODIPROP`、`#EXTVLCOPT`）。`#EXTGRP` 只在解析阶段读进 `group-title`，**出片时不再单独输出这一行** —— 分组信息已经在 `#EXTINF` 里，而飞牛影视、LunaTV 一类严格的解析器只把 `#EXTINF` 紧接的下一行当播放地址，中间多插一行会把整个频道丢掉。#EXTINF 与地址之间只允许出现播放必需的 `#EXTVLCOPT:http-user-agent` / `:http-referrer`、`#EXTHTTP`、`#KODIPROP`。全部产物用 `.tmp` + `os.replace` 原子写入，播放器不会读到半截文件。**产物里的地址一律是订阅文件给的原始地址**，不会是被重定向后的带签名地址。

**下载源失败时不生成、不删除任何旧产物**，日志：

```
[FAIL] 下载订阅源失败：源站返回 HTTP 404
[WARN] 源更新失败，继续使用上一次成功的列表数据（不删除旧播放列表）
```

---

## 十三、配置项

| 页面字段 | JSON 键 | 默认 | 说明 |
|---|---|---|---|
| 源地址 | `source_urls` | 空（必填，数组） | 一行一个 http/https 完整地址，最多 20 个，重复地址自动去重；出厂默认是空，因此不可能带任何演示数据 |
| 更新周期 | `update_interval_minutes` | 30 | 1–1440 |
| 并发数 | `concurrency` | 30 | 1–100，钳制 |
| 超时时间 | `timeout_seconds` | 8 | 3–60 |
| 最低速度 | `min_speed_kbps` | 500 | KB/s |
| 最低成功次数 | `min_success_count` | 1 | 1–1000；累计成功次数达标才进列表 |
| IP 策略 | `ip_prefer` | auto | 见第十节 |
| User-Agent | `user_agent` | Chrome UA | 部分运营商会挑 UA |

服务级参数只走环境变量：`DATA_DIR`、`PORT`、`ADMIN_USER`、`ADMIN_PASSWORD`、`FFMPEG_PATH`、`FFPROBE_PATH`。

---

## 十四、部署（群晖 / 通用 Linux）

```bash
# 1. 拿到代码
git clone <你的仓库地址> /vol2/1000/dockers/iptv-auto-tester
cd /vol2/1000/dockers/iptv-auto-tester

# 2. 准备配置与持久目录
cp .env.example .env      # 改 HOST_PORT、ADMIN_PASSWORD
mkdir -p data/output data/logs
#   容器内以 uid=1000 运行，宿主机目录要能写：
sudo chown -R 1000:1000 ./data

# 3. 构建并启动
docker compose up -d --build

# 4. 看日志 / 健康状态
docker compose logs -f
docker inspect --format='{{.State.Health.Status}}' iptv-auto-tester
```

打开 `http://192.168.8.99:9001/`，填订阅地址 → 「保存配置」，第一轮会自动开始。之后播放器一律使用：

```
http://192.168.8.99:9001/iptv.m3u
```

如果 `chown` 不方便执行，可在 `docker-compose.yml` 里加 `user: "0:0"`（用 root 跑，代价是容器内权限变大）。

### 用压缩包部署（不经过 git）

发布包是 `iptv-auto-tester-<日期>.zip`（同内容另存一份 `.tar.gz`），解开就是一个 `iptv-auto-tester/` 目录：

```bash
# 上传到 NAS 后
cd /vol2/1000/dockers
unzip iptv-auto-tester-20261001.zip     # 或 tar -xzf iptv-auto-tester-20261001.tar.gz
cd iptv-auto-tester
sha256sum -c <把发布说明里的 SHA256 粘过来>   # 可选：核对完整性
cp .env.example .env && sudo chown -R 1000:1000 ./data
docker compose up -d --build
```

包里含全部源码、`Dockerfile`、`docker-compose.yml`、`.env.example`、三个 `data/**/.gitkeep` 占位，以及 `dev-tools/`（本机复跑判据用的假源与脚本，`.dockerignore` 已排除它们，不会进镜像）。包里**不含** `.env`（真实密码）、`__pycache__` 和任何运行数据。

### 需要测 IPv6 时

把 compose 里的 `ports:` 整段注释掉，改成：

```yaml
    network_mode: host
```

并确认 `docker compose down && docker compose up -d` 后日志里没有那条 IPv6 `[WARN]`。

---

## 十五、常用运维

```bash
docker compose restart                 # 只重启，不动数据
docker compose pull && docker compose up -d --build   # 升级
docker compose down                    # 停止（数据都在 ./data，不会丢）
du -sh data/database.db data/logs      # 体积
sqlite3 data/database.db 'select status,count(*) from channels group by status;'
```

备份只需要备份 `data/config.json` 和 `data/database.db`；产物可随库重建。

---

## 十六、本机验证记录（实测数据，非估算）

由于本机没有 Docker，验证方式是：以与容器 `CMD` 完全相同的命令行启动 `python -m uvicorn app.main:app`，用 `dev-tools/fake_origin_server.py` 提供本地假源（IPv4 `127.0.0.1:8099`、IPv6 `[::1]:8100`），媒体文件是本机 ffmpeg 生成的 h264/aac TS 与 HLS 切片。限速档 `/rate/<字节每秒>/…` 由源站强制执行，所以「实测速度」这类判据是对着一个已知真值核对的，不是自证。

下面每一行都对应一份落盘的实跑输出。最近一次改动（产物改成飞牛影视兼容的形状 + `.m3u` 按 `text/plain` 下发）之后，全部判据脚本在同一台机器、同一套假源上重跑过：`check_redirect_hls.py` 37/37、`check_multi_source.py` 33/33、`unit_player_compat.py` 26/26、`unit_engine_guard.py` 11/11、`unit_multi_source.py` 34 条 `[PASS]`。改动之前那一轮的结论也一并留着，因为它们重跑后数字相同。

| 验证项 | 实测结果 |
|---|---|
| 鉴权矩阵 | `/healthz` 匿名 200；`/` 无密码 401、带密码 200、错密码 401；`/api/status` 匿名 401、带密码 200；`/iptv.m3u` 匿名 200 且 **`content-type: text/plain; charset=utf-8`**（不再是 `audio/x-mpegurl`，见第九节末尾），就绪时带 `x-iptv-generated`，空库时带 `x-iptv-status: not-ready`；`/results.csv` 为 `text/csv; charset=utf-8`；`iptv_all/iptv_ipv4/iptv_ipv6` 三个产物同为 `text/plain`（改完代码后又用 curl 复跑了一遍） |
| 状态覆盖（本轮真实出现过的 9 种） | `ok`（裸 TS 11730.4 KB/s、HLS 11023.5、重定向之后、IPv6 回环）、`audio_only`（仅音频流 1860.4）、`slow`（52.6，原因「实测速度 53 KB/s 低于阈值 500 KB/s」）、`no_audio`（14047.4，速度照样记录）、`parse_failed`（返回 200 的 HTML）、`http_error`（404）、`connect_failed`（`[WinError 1225]`、以及「ipv6_only 策略下 127.0.0.1 没有可用地址」）、`unsupported`（`rtp://`）、`engine_missing`（把 `FFPROBE_PATH` 指到不存在的路径）。`timeout` 本机没有可控夹具、只在公网真实源上出现过（下面那行，145 个地址里 15 条）；`no_video` 到本轮结束**一次都没出现过**，只有分类代码 |
| 重定向与 HLS（`check_redirect_hls.py`，37/37） | 跳 2 次的 TS：`http_status=200 redirect_count=2 final_url=…?tm=…&key=deadbeef01 content_type=video/mp2t`，而库里 `url` 与产物里都是原始地址 `/redir/2/live/test.ts`；首片 404 的 HLS：`status=ok hls_valid=1 segment_test=partial playable=1`，没有被一票否决；分片全 404：`http_status=200 segment_test=failed playable=0 status=http_error`，原因写的是「播放列表本身能读，但里面 3 个分片一个都没取到 HTTP 404」；200 但是 HTML：`parse_failed hls_valid=0 http_status=200`；裸 TS：`hls_valid=NULL segment_test=none`（没结论就留空，不当成无效） |
| 多源合并（`check_multi_source.py`，33/33） | 三个源解析 3/4/2 条 → 合并后库里 8 个地址（跨源重复 2 条只算一条，归第一个拿到它的源）；`iptv.m3u`=5，同名的 `MS.SHARED` 只留实测最快的源B那条，落选的两条仍在 `iptv_all.m3u`（8 条）里；每个源那一行的「可用」=3/2/2，且与 `/api/sources` 一致（全新库里测速之前这个数必然是 0，所以这条能证明源状态确实是测完之后才发布的）；源B 换成 404 → `source_state=部分成功，2/3 个源可用，共 5 个地址`，B 的 3 条频道全部在册且上次成功的快地址还留在 `iptv.m3u`；从配置删掉 B → B 的 3 条全部下线、`iptv.m3u`=4，同名频道改留 A/C 里最快那条；再加回来 → 3 条全部在册、`iptv.m3u`=5 |
| 测速分母（只看源站真正吐数据的区间） | 三档源站强制限速 vs 本服务实测：`2000000B/s`→2190 KB/s、`900000B/s`→899 KB/s、`700000B/s`→762 KB/s，全部落在档位值 ±30% 内，且实测排序 B>A>C 与档位排序一致。改动前那条 2 MB/s 的源只测出 800 KB/s，因为 ffmpeg 的启动时间被算进了分母 |
| 检测工具不可用（`unit_engine_guard.py`，11/11 + 真实实例） | `FFPROBE_PATH` 指到不存在的路径：启动日志 `[ERROR] 检测工具不可用，本轮跳过：ffprobe（…）无法执行：找不到可执行文件`；`/api/update` 回 `{"ok":false,"message":"检测工具不可用：…"}` 而不是白跑一轮；首页横幅变成 `note warn` 并写出原因；分类器把这类探测记成 `engine_missing`，负向控制是「内容不是流」仍为 `parse_failed`、「源站 404」仍为 `http_error`；恢复路径后 `state.engine_error` 变回空串 |
| 规模 2000 URL | `total=2000 tested=2000 ok=1600 failed=400 耗时=78.7s 实测吞吐=25.4 URL/s`（并发 30）；产物 `iptv.m3u` 228,389 B、`iptv_all.m3u` 289,259 B、`iptv_ipv4.m3u` 214,891 B、`iptv_ipv6.m3u` 13,595 B、`results.csv` 762,617 B；进度采样到 `done=2000`；服务进程峰值 RSS = 212 MB，全程 58–184 MB。（这一轮峰值同时存活子进程数到 33，比配置并发多 3 —— 采样瞬间有子进程已经出结果但还没退完；并发本身由下面那行专门判据约束） |
| 子进程上限只跟配置走 | 同一份 260 URL 源：并发上限 5 → 高频采样 342 次，峰值存活子进程 5、耗时 53.0s；并发上限 30 → 采样 257 次，峰值 30、耗时 14.7s。进程/URL 比 0.02→0.12，说明上限生效，数量不随 URL 总数增长。 |
| 元数据与 CSV | `iptv_all.m3u` 里 `tvg-id/tvg-name/tvg-logo/group-title` 原样，例如 `#EXTINF:-1 tvg-id="LOCAL.TS" tvg-name="本地TS直连" tvg-logo="http://logo/ts.png" group-title="本地测试",本地TS直连`；`#EXTINF` 之后紧跟播放地址（2000 频道那轮的 `iptv_all.m3u` 共 4003 行，`#EXTGRP` 出现 0 次）；`results.csv` 表头 37 列（含「最终地址/跳转次数/内容类型/HLS播放列表/分片验证/可播放/来自订阅源」，以及分辨率 `640x360`） |
| 播放器兼容（`unit_player_compat.py`，26/26） | 三段都跑过：① 离线直接调 `app.outputs` 生成，验「首行裸 `#EXTM3U`、`#EXTINF` 之后紧跟地址、分组只在 `group-title`、源里的 `#EXTGRP` 会被折进 `group-title` 不丢信息」，并带三条**注入违规的负向控制**（把老行为 `#EXTGRP:<组>` 插回地址前、夹一条 `#EXT-X-SESSION-DATA`、`#EXTINF` 后不跟地址）全部变红；② 拿真实公网列表（18 频道）解析后重渲染，18 条地址一条不丢、顺序不变、分组仍在；③ 对着正在跑的服务取五个产物，`Content-Type` 逐个核对（四个 `.m3u` 全是 `text/plain; charset=utf-8`，`.csv` 仍是 `text/csv`），正文形状逐行核 |
| 同一套判据打在改动前的部署上（负向对照） | 对着用户那台还在跑旧版产物的 NAS（`http://192.168.8.99:9001`）跑同一条判据：**15/22，7 条红**，红的正是这两件事 —— `content-type: audio/x-mpegurl`，以及每一条频道 `#EXTINF` 与地址之间夹着自己的 `#EXTGRP:General`／`#EXTGRP:News`…（旧版给每个频道都插一行）。也就是说这两处确实是产物自己造成的，不是播放器挑剔 |
| 公网真实源的一轮（145 个地址） | 从上面那台 NAS 取回 `results.csv`（64,232 B）核对状态分布：`connect_failed 43`、`http_error 35`、`slow 25`、`ok 18`、`timeout 15`、`parse_failed 9`，`iptv.m3u` 里就是那 18 条（4,780 B）。`timeout` 第一次在真实环境里出现（本机夹具造不出来，见「未能覆盖」）。顺带印证了过滤确实在做事：飞牛影视页面里留下的那两条，一条「CCTV-10 (720p)」当前测得 255.4 KB/s，低于 500 KB/s 阈值被记成 `slow`、`可播放=否`，本轮已经不在 `iptv.m3u` 里；另一条「CCTV-17 (1080p)」在库里叫「CCTV-17 HD (1080p)」（`ok`，552.4 KB/s）。名字对不上说明影视那边读的是更早一轮的列表快照 |
| 去重 | 单源内 300 行 EXTINF（含 40 条重复地址）→ 260 唯一 URL；跨源重复的同一地址也只留一条 |
| IPv6 真实通过 | `ip_prefer=ipv6_only` 下 subscribe.m3u 十条：`IPv6回环直连 ok speed=11730.4 latency=1.3ms h264/aac`，同时 7 条 IPv4 地址全部 `connect_failed`、1 条 `rtp` 为 `unsupported`（正向 + 负向同时成立）；2000 URL 那轮里 100 条 `[::1]:8100` 频道全部通过，`iptv_ipv6.m3u` 15,595 B |
| 过滤规则（正向 + 注入违规的负向控制） | 阈值都由「当前实测极值 + 1」算出并**保存后回读确认生效**：`success_count` 最大 16 → `min_success_count=18` 后 `iptv.m3u` 0 频道，边界 `=17` → 2 频道；实测最快 11730 KB/s → `min_speed_kbps=11731` 后 0 频道，边界 `=10557` → 2 频道；`ip_prefer=ipv6_only` → 状态分布 `{'connect_failed': 9, 'unsupported': 1}`、`iptv_ipv4.m3u` 0；复原 `auto` → 有效 3、失效 7、`iptv.m3u` 3 |
| 坏源不覆盖好列表 | 单源换成 404 后 `iptv.m3u` 频道数不变，日志出现「本轮所有订阅源都没拿到数据，继续使用上一次成功的列表频道（不删除旧播放列表）」；多源下的同一行为见上面「多源合并」行 |
| 失败不删除 | 换源后旧 10 个频道 `active=0` 保留全部历史，`first_seen` 不变，库内总行数 270 |
| 持久化 | 杀掉进程再按同样命令行拉起：`config.json`、`database.db`、`output/` 五个产物的**大小和 mtime 逐一相同**（`iptv.m3u` 676 B / `iptv_all.m3u` 1,527 B / `iptv_ipv4.m3u` 534 B / `iptv_ipv6.m3u` 237 B / `results.csv` 4,172 B，五个 mtime 全是同一秒 1790856406，说明重启本身没重写文件），`/iptv.m3u` 匿名 200 立刻可取且仍是 `text/plain`；重启后 `scheduler.next_in_seconds=0.0` —— 第十一节说的「启动后先跑第一轮」，不是倒计时失效 |
| 取消 | 取消延迟两次实测：260 URL 那轮一次在「请求后 2.6s 的采样点」确认已停（`stage=已取消`），一次 `runs` 行整行 `elapsed_ms=1000`（30 条已测完 + 取消 + 收尾都在这一秒内），也就是几秒内一定停。规模那轮（2000 URL）跑到 230 条时取消：`stage=已取消`，`runs` 行 `cancelled=1 tested=230 total=2000 source_lines=2000 elapsed_ms=8000` —— 那 8 秒是这一轮从下载到收尾的**总时长**，不是等待取消的时间。产物确实按当时结果重生成：`output/` 五个文件的 mtime 与该 `runs` 行的 `finished_at` 落在同一秒（03:13:47），`results.csv` 也从上一轮完整跑完的 761,914 B 变成这一轮的 761,855 B。这一轮 `tested=230` 里 `ok=0` 不是 bug——待测队列按「新频道/从未成功 → 上次失败 → 上次成功」排序，排在最前面的正是那 200 条 404 夹具和 30 条限速源 |
| 触发时机 | 换源地址 → 20 秒内自动开跑（两次都成立）；只调最低速度 → 不误触发重测；改周期 → 倒计时重锚为 600.0s；「立即更新」→ 回执「已开始：下载源 + 解析 + 测速 + 生成」 |
| 出厂产物空库首启 | 换全新空目录（`D:/tmp/fnship2`）启动，用 `dev-tools/check_ship_open.py` 一次核 16 条：`config.json`/`database.db` 自动建，`output/` 里**一个文件都没有**（`outputs` 五项 `exists=false`，不会有残留演示数据），`/iptv.m3u` 返回 200 空列表（正文就 2 行：`#EXTM3U` 与 `# 还没有完成第一次成功的更新，播放器暂时拿不到频道`，没有 `#EXTINF`）并带 `x-iptv-status: not-ready`，`/` 与 `/api/status` 未授权 401、带密码 200、错密码 401，五个产物匿名可取且 Content-Type 逐个对（四个 `text/plain; charset=utf-8` + `text/csv; charset=utf-8`），`/api/status` 里 `scheduler.waiting_for_source=true`、`state.engine_error=""`；启动日志依次给出「尚未配置订阅源地址」「检测工具就绪：ffprobe=…，ffmpeg=…」；填入 `subscribe.m3u`（10 行、含 1 条重复地址）保存后自动跑完第一轮，产出 5 个文件、`iptv.m3u` 4 个频道（676 B，`#EXTGRP` 出现 0 次）、`iptv_all.m3u` 10 条（1,527 B）、`results.csv` 4,172 B（11 行） |
| 多格式 | M3U(10)、M3U8 订阅(3)、UTF-8 TXT(6，重复行去重)、GBK TXT(2，中文名正确解出) |
| 交付包本身再跑一遍 | 从出厂副本（`D:/tmp/pkg/iptv-auto-tester`，也就是包内那 66 个文件）指向全新数据目录起服务，跑三套判据：`check_ship_open.py` **16/16**（鉴权 + 五个产物 MIME + 空库形状 + `waiting_for_source`，与「出厂产物空库首启」那一行是同一次跑出来的）、`check_multi_source.py` **33/33**（档位锚点 2198/846/762 KB/s，`iptv.m3u` 里 `MS.SHARED` 留的是 `rate/2000000/live/test.ts` 即源B 那条，`merged_duplicates=2`，三个源的「可用」=3/2/2 且与 `/api/sources` 一致）、`unit_player_compat.py` **26/26**（对着这个副本取五个产物，MIME 与正文形状逐条核）。也就是说包里的 `outputs.py`/`main.py` 与本机判据跑的是同一份代码。 <br> 补一条踩过的坑：第一遍在同一个副本上跑 `check_multi_source.py` 只得到 32/33，红的是「删掉源B 后同名频道改留 A/C 里最快那条」—— 那一刻库里 A 是 1028 KB/s、C 是 776 KB/s，`iptv.m3u` 里却写着 C。原因是我为了让持久化判据成立刚重启过这个实例，而重启会立刻开跑第一轮，这一轮和脚本自己触发的轮次撞在一起，产物是被中间那一轮重写的。换全新数据目录、调度器安静时重跑就是 33/33，最终产物里确实是 A。速度类判据必须在独占的假源站 + 空档期上跑，这条已经写进上面的复跑说明。 |
| 日志格式 | `[OK] 本地TS直连 IPv4 1ms 11.5MB/s h264/aac`、`[OK] IPv6回环直连 IPv6 0ms 11.5MB/s h264/aac`、`[OK] 本地广播仅音频 IPv4 1ms 1.8MB/s -/aac`、`[FAIL] 四十不惑 HTTP错误：源站返回 HTTP 404`、`[FAIL] 只有视频没有音频 无音频流：有视频流但没有音频流` |
| 页面 | 浏览器实跑：进度行实时刷新、运行中按钮禁用、取消生效；频道页 260 行/3 页、搜索「涓流」得 30、按速度排序、点行展开三轮历史；检测工具坏掉时横幅变黄并写出具体是哪个工具 |

**未能覆盖的项（诚实说明）**：

1. 本机没有 Docker，因此 `docker compose up -d --build` 与镜像内 `apt-get install ffmpeg` 未真实跑过。compose YAML 已用 PyYAML 解析校验，Dockerfile 内容按 python:3.13-slim 的既有包名编写；
2. 公网真实 IPTV 源没有被写进验收判据（外部地址存活不可控），速度/状态类判据全部来自本地可控假源 + 负向注入；不过确实拿用户那台在跑的 NAS 上的一轮公网结果做了抽样核对（145 个地址，状态分布见上表），并用它当负向对照 —— 旧产物在那台机器上是 15/22 红，红的两条正是 MIME 和 `#EXTGRP`；
3. `https://` 源站没有真实跑过。CONNECT 隧道里看不到内层 HTTP 响应，那一条路径的字段形状（`final_url`/`content_type`/`redirect_count` 为空、`hls_valid=NULL`、`segment_test=unknown`）只有代码保证，边界写进第九节；
4. `timeout` 没有可控夹具，只在公网那一轮出现过（15 条），它的分类路径没有对着已知真值核过；`no_video` 至今一次都没出现，只有分类代码；
5. 群晖 DSM 上 `network_mode: host` 与 9001 端口的实际占用没有验证环境。
6. **飞牛影视那一侧的导入行为没法在本机证明**。我能改的是自己吐出去的字节（MIME、`#EXTINF` 与地址之间不夹行、`.m3u` 后缀），依据是同类面向飞牛的项目公开记录的两处修复 + 对旧产物的判据复跑；影视App 拿到新产物会不会把 18 条全认出来，必须在 NAS 上删掉直播源重新添加才知道。它也可能额外去探每条流（那就跟格式无关了），本机无法区分这两种情况。

**这一轮验证顺带修掉的问题**：

1. **测速分母把 ffmpeg 的启动时间算了进去**。原来的做法是在调用子进程前后掐表，进程冷启动那零点几秒进了分母，一条 0.3 秒就能下完的快源会被算成「慢」，跨源择优就会挑到更慢的那条——现在分母只取代理上「源站真正开始吐字节到最后一个字节」这段窗口（`open_speed_window` / `close_speed_window`），并用三档源站强制限速做锚点。旧的 `ForcedProxy.snapshot()` 因此没人用了，一并删掉；
2. **假源站的限速不准**（只影响开发验证）：`/rate/2000000/` 档每片 `sleep` 一次，实际只跑出 800 KB/s，导致第 1 条修完之后判据仍然对不上。改成绝对期限式节流后，档位与实测才真能互相印证；
3. **ffmpeg/ffprobe 不可执行时，整库被误判成「解析失败/速度过慢」**，看起来像所有源都死了。这一轮我就是这样把 8 条频道全测成 `parse_failed` 的：`elapsed_ms=0`、速度 0。现在启动时跑一次 `check_tools()`，工具坏了就 `engine_missing` + 状态字段 + 首页横幅 + 拒绝开跑，不会再伪装成源站问题；
4. `results.csv` 的「连接耗时ms」和「首包延迟ms」两列内容重复 —— `channels` 表当时没存连接耗时。补了 `connect_ms` 列（老库走 `PRAGMA table_info` 差异自动迁移），实测两列现在分别是 0.3/0.6、7.4/0.5、0.7/7.2 等不同数值；
5. `[OK]` 日志里协议族写成大写 `IPV4`，与需求示例 `IPv4` 不一致，已改；
6. `min_success_count` 的合法上限原本只有 100，跑久了的库（成功次数 30+）无法构造出「一定过滤掉全部」的负向控制：超出范围的取值会被校验静默回退成默认 1，控制看起来跑了其实没生效。上限放宽到 1000，并给 `dev-tools/check_filters.py` 加了保存后回读比对（`save_config()`），阈值不生效就直接报错退出而不是给个假通过；
7. `check_filters.py` 里最低速度的负向控制原本硬编码 `min_speed_kbps=3000`，在本地夹具上（裸 TS 实测 11730 KB/s）永远过滤不掉任何东西，等于恒假判据。现在先读一遍当前最快实测速度，控制取 `极值+1`、边界取 `极值×0.9`；
8. **源状态表里每个源的「可用」频道数滞后一整轮**：`state.sources` 是在测速之前发布的（`_refresh_source` 里），第一轮从空库起步时每个源都显示 0 可用，要等下一轮才跳到真实数字。现在测速结束后会拿本轮的下载明细再发布一次（`_execute` 里 `_publish_sources(self.last_source_results)`），并给 `check_multi_source.py` 加了这条判据 —— 全新库里测之前的值必然是 0，所以「>0 与 `/api/sources` 相等」这个判据不会恒真。
9. **产物形状对严格解析器不友好（飞牛影视只认出两条频道）**。两件事，都是我们自己造成的：① `.m3u` 按 `audio/x-mpegurl` 下发，飞牛按 MIME 判断「这是订阅文本还是一个视频」，于是把订阅文件当成一个视频去播；② 每个频道都在 `#EXTINF` 与地址之间插一行 `#EXTGRP:<组>`，而这类解析器只把 `#EXTINF` 紧接的下一行当播放地址，中间多一行就整个频道丢掉。现在 `.m3u`/`.m3u8` 统一 `text/plain; charset=utf-8`，`#EXTGRP` 不再输出（分组只在 `group-title`，解析时源里的 `#EXTGRP` 会被折进这个字段，信息不丢），`#EXTINF` 与地址之间只留播放必需的 `#EXTVLCOPT` UA/Referer、`#EXTHTTP`、`#KODIPROP`。这两条由 `unit_player_compat.py` 钉住，三条注入违规的负向控制保证判据不是恒绿。

**一次差点被骗的经历（关于验证环境本身）**：修完第 8 条后第一次跑 `check_multi_source.py` 是 32/33，失败的是「最快的那条又回到 `iptv.m3u`」——库里源B（2 MB/s 档）实测只有 816 KB/s，比源A（900 KB/s 档）的 1028 KB/s 还低。原因不在被测代码：当时我同时挂着 4 个服务实例（9001/9002/9004/9005）都在打同一个假源站，限速档被互相挤掉了。停掉多余实例、换新库重跑就是 33/33，档位锚点也回到 `880 / 2190 / 762 KB/s`。也就是说这类「速度」判据只在安静的开发机上成立，别把并发压着的数字当真；上面引用的所有速度都来自独占假源站的那几轮。

### 自己复跑验证

```bash
# 0) 装依赖（本机验证用，容器内不需要）：pip install -r requirements.txt
#    本机 ffmpeg 不在 PATH 上时，把路径导出来（容器内 apt 装好了，不需要这一步）
export FFMPEG_PATH=/path/to/ffmpeg FFPROBE_PATH=/path/to/ffprobe
# 1) 起两个假源站（IPv4 + IPv6）
python dev-tools/fake_origin_server.py --bind 127.0.0.1 --port 8099 &
python dev-tools/fake_origin_server.py --bind ::1 --port 8100 &
# 2) 起服务（命令行与容器 CMD 一致，DATA_DIR 指到一个空目录即可）
DATA_DIR=./data ADMIN_USER=admin ADMIN_PASSWORD=test-pass \
  python -m uvicorn app.main:app --host 127.0.0.1 --port 9001 &
# 3) 生成压测源（默认假源已经带了 subscribe.m3u / big.m3u / multi_*.m3u / redir 等夹具）
python dev-tools/make_big_source.py --out dev-tools/www/stress.m3u \
       --good 1500 --http404 200 --slow 100 --notstream 100 --ipv6 100 --duplicates 0
# 4) 各项判据（--user 与 ADMIN_PASSWORD 对齐，--out 自己指定；报告都是 UTF-8 落盘）
#    注意：一次只挂一个服务实例。多个实例同时打同一个假源站会把限速档挤偏，
#    速度类判据（档位锚点、跨源择优）就不再可信。
python dev-tools/check_scale.py           --user admin:test-pass --out scale.txt
python dev-tools/check_concurrency_cap.py --user admin:test-pass --caps 5,30 --out cap.txt
python dev-tools/check_filters.py         --user admin:test-pass --out filters.txt
python dev-tools/check_source_formats.py  --user admin:test-pass --out formats.txt
python dev-tools/check_schedule.py        --user admin:test-pass --out schedule.txt
python dev-tools/check_multi_source.py    --user admin:test-pass --out multi_source.txt   # 33 条
python dev-tools/check_ship_open.py       --user admin:test-pass --out ship_open.txt    # 16 条，出厂副本开箱：鉴权 + 五个产物 MIME + 空库形状（要在还没配源的新数据目录上跑）
python dev-tools/check_redirect_hls.py    --ffmpeg $FFMPEG_PATH --ffprobe $FFPROBE_PATH \
                                          --out redirect_hls.txt                          # 37 条，进程内跑，不用起服务
python dev-tools/unit_multi_source.py                                                   # 合并/择优的纯函数判据
python dev-tools/unit_engine_guard.py > engine_guard.txt                                # 11 条，工具缺失兜底（只往 stdout 打，Windows 下重定向出来是 GBK，用 iconv 转一下再读）
python dev-tools/unit_player_compat.py --base http://127.0.0.1:9001 \
                                         --from-file dev-tools/www/subscribe.m3u \
                                         --out player_compat.txt                          # 26 条，播放器兼容形状 + Content-Type（--base 要服务在跑；只给 --from-file 也能跑离线+真实列表两段）
python dev-tools/verify_engine.py --ffmpeg $FFMPEG_PATH --ffprobe $FFPROBE_PATH \
                                  --origin http://127.0.0.1:8099 --prefer ipv4_only
# 想看 IPv6 那条链路：--prefer ipv6_only，此时除 ::1 夹具外全部应记 connect_failed
```

`check_redirect_hls.py` / `unit_engine_guard.py` 里写死了开发机上的临时路径与 ffmpeg 位置（`D:/tmp/...`），换机器跑请用上面的显式参数覆盖；`unit_engine_guard.py` 没有命令行参数，报告就是它的标准输出。

`dev-tools/` 已在 `.dockerignore` 里排除，`app/` 里也 grep 不到任何假源地址或合成数据 —— 出厂配置 `source_urls` 默认为空列表，第一次启动不填源就只能拿到空列表。假源站本身还有个已知缺陷：`/live/` 那一支只按后缀（`.ts` / `.m3u8` / `hls_*`）放行，没有校验路径段，`/live/../../x.ts` 这类请求能跳出 `dev-tools/www/`——它只在开发机上监听 127.0.0.1，不进镜像，不影响交付物。

---

## 十七、常见问题

**页面打不开 / 401**：确认 `.env` 里 `ADMIN_PASSWORD`，`/iptv.m3u` 这类产物地址不需要密码。

**首页状态卡出现「检测工具不可用」**：镜像里的 ffmpeg 那套没能执行（不是频道坏了）。此时测速根本不会开跑，`/api/update` 直接回 `检测工具不可用：…`，频道也不会被误判成失效。正常镜像不会出现这一条，因为 Dockerfile 里 `apt-get install ffmpeg` 装了 `/usr/bin/ffmpeg` 与 `/usr/bin/ffprobe`；只有手工改过 `FFMPEG_PATH`/`FFPROBE_PATH`，或者在容器外裸跑 `python -m uvicorn` 而没装 ffmpeg 时才会碰到。容器内确认：`docker compose exec iptv ffprobe -version`。

**列表是空的**：先看首页状态卡。`X-IPTV-Status: not-ready` 说明第一轮还没跑完；跑了但为 0 就去频道页按状态筛，多数是「速度过慢」（把最低速度调低）或「解析失败」（源本身是网页跳转）。

**浏览器能打开 `http://NAS_IP:9001/iptv.m3u`，播放器却提示「无法连接到直播源服务器」**：这两件事其实走的是两条完全不同的链路——浏览器打开的是本服务的文件，播放器要自己去连列表里每一条源站地址。按下面顺序分层排查：

1. **先分清是「列表空」还是「频道连不上」**。浏览器里另开 `http://NAS_IP:9001/iptv_all.m3u`（未过滤的完整列表，匿名可取）：如果它也是几行甚至空，问题在过滤阈值，不在播放器；如果它有几十上百条，而 `iptv.m3u` 只有几条，播放器又偏偏只订阅了 `iptv.m3u`，那就是阈值把能播的也滤掉了（播放器面对空列表常报「无法连接」）。首页把「最低速度」调到 100 KB/s、「成功次数」保持 1，等一轮跑完再试。
2. **频道地址是 IPv6，而盒子没有 IPv6 出口**。列表里出现 `http://[240x::...]:8080/...` 这种地址时，只有出口带 IPv6 的设备播得动。改用 `http://NAS_IP:9001/iptv_ipv4.m3u` 订阅，并在配置里把 IP 策略设成「仅 IPv4」后重测一轮。
3. **源站要求特定 UA / Referer / 鉴权**。检测用的是配置项 `user_agent`（出厂默认是一个常见的 Chrome 桌面 UA）。测速通过不代表播放器通过：有的源站按 UA 白名单放行，盒子发出去的 `User-Agent` 与本服务不同就会拿到 403 或跳转页。把盒子实际的 UA 抄进 `user_agent` 再重测一轮；跑完后仍然只出现在 `/iptv_all.m3u`、进不了 `/iptv.m3u` 的，说明这些地址对播放器确实不友好。
4. **产物里保留的是原始地址，临时签名会过期**（第九节）。有些源的 `?tm=...&key=...` 只有几十分钟寿命。这类地址检测当时是通的，过一会儿播放器再连就 403——现象正是「刚加进去能看，第二天全连不上」。把更新周期缩短（例如 30 分钟），让每轮重新从源里取最新地址；这一条没有别的解法，因为把带签名的地址写死进产物更糟。
5. **网络可达性差异**。浏览器所在机器能到 NAS，不等于盒子能到：跨 VLAN、交换机 ACL、NAS 防火墙放行了电脑但没放行盒子 MAC/IP 都会这样。在盒子的同网段另找一台设备执行 `curl -sv http://NAS_IP:9001/iptv.m3u -o /dev/null` 验证；端口只监听在 Docker bridge 上时，用 `network_mode: host` 或确认端口映射到了 `0.0.0.0`。
6. **播放器的缓存与分组行为**。多数盒子会缓存整份列表，改完配置请让它重新拉取（或删掉重建）。频道全部挂在同一个 `group-title` 下、或一次载入上千条时，部分播放器会表现为「加载失败」而实际上是解析慢——先用 `/iptv_ipv4.m3u` 这类小一点的产物确认能力，再回到 `/iptv.m3u`。

判据很简单：**`iptv_all.m3u` 能播、`iptv.m3u` 不能播** → 阈值或择优把频道滤掉了；**两个都不能播** → 播放器到 NAS 的链路或列表里地址的协议族问题（第 2、5 条）；**换个播放器能播** → 第 3、6 条。

**飞牛影视导入后只认出几条频道**（其他 fnOS 系播放器同理）：先分清是「格式没吃到」还是「本来就只有这几条」。

1. 对着产物做一次两条命令就能定性：`curl -D - -o x.m3u http://NAS_IP:9001/iptv.m3u`，看返回头 `content-type` 是不是 `text/plain; charset=utf-8`，再看文件里每个 `#EXTINF` 的**下一行**是不是就直接是 `http…` 地址。这两条其中一条不满足，就是旧版产物（`audio/x-mpegurl`、或者 `#EXTINF` 与地址之间夹了 `#EXTGRP:`），重新部署本包即可；两条都满足，格式就没有问题，跳到第 3 步。
2. 订阅地址必须带 `.m3u` 后缀（影视按后缀判断这是不是播放列表），`http://NAS_IP:9001/iptv.m3u` 这种写法是对的，不要去掉后缀或加查询串。
3. **改完必须删掉直播源重新添加**。影视存的是导入那一刻的列表快照，界面里那几条频道跟当前 `iptv.m3u` 对不上（甚至频道名都对不上，比如库里已经叫「CCTV-17 HD (1080p)」而它还显示「CCTV-17 (1080p)」）就说明它读的是旧快照。
4. 重新添加后条数仍然比 `/iptv.m3u` 的 `# name=… channels=N` 少 → 差异不在格式，在阈值：那批地址被 `slow`/`timeout` 挡住了，用 `/iptv_all.m3u` 对比一下就能看出来，然后按上面第 1 条调低「最低速度」。
5. **Web 端（浏览器里）播放跨域直播源要点开官方说的 KNAS 浏览器插件**，那是播放链路的事，跟「导入能不能识别频道」是两件独立的事——装了插件也不会让旧格式列表被识别，反之不装插件也不影响导入。

**IPv6 频道全部「连接失败」**：Docker 默认 bridge 网络没有 IPv6 出口，改 `network_mode: host`（第十四节），启动日志里的 `[WARN]` 也会提示这一点。

**容器重启后数据没了**：说明 `./data:/data` 没挂上，或者宿主机目录权限不属于 uid 1000。`docker inspect` 看 Mounts，`chown -R 1000:1000 ./data` 修权限。

**测速很慢**：`并发数` 提到 50/100，或把 `超时时间` 从 8s 降到 5s。吞吐实测窗口取「3 秒与超时时间的较小值」，所以单条频道的理论下限就是这几秒，总耗时的下限大约是「URL 数 ÷ 并发数 × 窗口」。

**想临时看未过滤的完整列表**：用 `/iptv_all.m3u`（匿名可取），排查完再让播放器回到 `/iptv.m3u`。
