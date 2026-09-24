# 部署手册（NASphere）

面向第一次把这套装上手的操作手册：按顺序做下来能跑起来，出问题时按后面的章节查。功能层面的说明看 `README.md`，这里只讲部署与运维。

- 版本：`package.json` 的 `version`（当前 `1.0.0`），`deploy.sh` 默认拿它当镜像标签。
- 运行时：单容器，`node:22-alpine`，零 npm 依赖，镜像里只有 `server/` 与 `public/`。
- 所有状态都在挂载出来的数据目录里，换镜像、重建容器都不丢配置。

目录：§0 前置条件 → §1 拿代码 → §2 准备 `.env` → §3–§5 三条部署路线（一键脚本 / 手工 compose / 离线镜像包）→ §6 首启设置与验收 → §7 换端口换数据目录 → §8 升级 → §9 回滚 → §10 忘记密码与迁移备份 → §11 故障排查 → §12 安全边界 → §13 命令与路径速查。

## 0. 前置条件

| 需要 | 说明 |
| --- | --- |
| 一台能跑 Docker 的 NAS | 群晖 Container Manager / 绿联 UGOS / 威联通 Container Station，或任何有 `docker` 的 Linux 机器 |
| SSH 或图形终端 | SSH 最省事。只有网页图形界面也能装：在 DSM/UGOS 的 Compose 表单里照 §4 的参数粘 `docker-compose.yml`，卷路径写成绝对路径（细节见 README 的群晖 / 绿联 / 威联通章节） |
| 首次构建能上网 | 要拉一次 `node:22-alpine`（约 50MB）。NAS 拉不动就用路线 C 的离线镜像包（电脑上没 Docker 也能出，见 §5 C-2） |
| 端口没被占用 | 默认对外 `8080`。威联通自带服务常占 `8080`，冲突就换（见 §7） |

**先决定数据目录**，之后备份、迁移、排查都靠它：建议放有存储池的卷上，例如 `/volume1/docker/nasphere/data`。默认值是项目里的 `./data`。

## 1. 拿代码

方式一（有 Git）：

```bash
cd /volume1/docker && git clone <你的仓库地址> nasphere
```

方式二（没有 Git / 不想在 NAS 上装）：电脑上打包传上去。

```bash
# 电脑上：仓库文件之外的一律不传（数据、镜像包、本机自测残留、明文密码）
tar --exclude='.git' --exclude='data' --exclude='dist' --exclude='.env' \
    --exclude='.demo-*' --exclude='.pre-clean-backup' --exclude='.sunpanel-import' \
    --exclude='_mock-docker.js' --exclude='.DS_Store' \
    -czf nasphere.tar.gz .
# 传完在 NAS 上解包前，先确认包里没有 data/ 和 .env：
tar -tzf nasphere.tar.gz | grep -E '^\./data|^\./\.env' || echo '干净'
scp nasphere.tar.gz 你@NAS:/volume1/docker/
# NAS 上
mkdir -p /volume1/docker/nasphere && tar -xzf /volume1/docker/nasphere.tar.gz -C /volume1/docker/nasphere
```

传完在 NAS 的项目目录里应该能看到：`Dockerfile`、`docker-compose.yml`、`deploy.sh`、`make-image.sh`、`server/`、`public/`、`README.md`、`DEPLOY.md`、`.env.example`。

> ⚠️ 别把开发机上那份 `.demo-data/`、`.pre-clean-backup/`、`.env`、`_mock-docker.js` 拷到 NAS——里面有密码哈希、会话密钥和本机自测数据。真要带上凭据，就在 NAS 上按 §2 重新生成一份 `.env`。

## 2. 准备 `.env`

```bash
cd /volume1/docker/nasphere
cp .env.example .env
chmod 600 .env
vi .env
```

最少改这两行（其余留默认即可）：

```bash
NAV_USER=admin                       # 登录账号，之后可在「设置 → 安全」里改
NAV_PASSWORD=换成你自己的强密码       # 只在首次启动（data/auth.json 不存在时）生效
```

其余变量、默认值与含义见 README 的「配置项（环境变量）」一节。`.env` 里是明文密码，权限收紧到 `600`，`docker compose` 与 `deploy.sh` 都会读它。

## 3. 路线 A：一键脚本（推荐）

```bash
chmod +x deploy.sh make-image.sh
./deploy.sh --dry-run      # 先看要执行什么，不动任何东西
./deploy.sh                # 真跑
```

脚本按 `docker compose`（v2）→ `docker-compose`（v1）→ 裸 `docker run` 依次挑可用的一种。跑起来会看到这些行，含义依次是：

| 输出 | 含义 |
| --- | --- |
| `当前用户不在 docker 组，后续命令都带 sudo` | 会自动加 sudo，可能提示输密码，属正常 |
| `镜像 local/nasphere:1.0.0 ｜容器 nasphere｜端口 8080→8080｜数据 /volume1/docker/nasphere/data` | 生效的参数（`.env` 提供默认值，命令行参数优先；数据目录已转成绝对路径） |
| `部署方式：docker compose` / `部署方式：docker run（没检测到 compose）` | 实际选用的那条路 |
| `没有已有配置，跳过备份` 或 `已备份 config.json / auth.json → …/.deploy-backup/<时间戳>` | 升级前的配置快照，默认留最近 5 份 |
| `当前镜像 abcdef123456 已记下，探活失败会自动回滚到它` | 回滚锚点，同时另打一个 `local/nasphere:rollback` 标签（§9） |
| `从 dist/…tar.gz 加载镜像` → `镜像包里的 X 已重标为 local/nasphere:1.0.0` | 仅 `--tar`；名字/标签不一致时自动 retag |
| `构建镜像（首次要拉 node:22-alpine，约 1–2 分钟）` | 首次慢，之后有层缓存 |
| `! 找不到 Docker 套接字 /var/run/docker.sock，这次不挂它：容器组件会显示「Docker 不可用」，其余功能照常` | 这台机器上找不到套接字，跳过挂载——容器组件就没数据，需要的话按 §11 处理 |
| `启动容器` → `等待服务就绪（最多 40s）` → `✓ 部署完成：http://192.168.x.x:8080` | 探活打的是免登录的 `/api/health` |
| `! 这次是首次启动，登录账号/密码已初始化成 .env 里的 NAV_USER / NAV_PASSWORD（没设则为 admin / admin123），登录后立刻改掉` | 只在 `data/auth.json` 不存在时出现，登录后去「设置 → 安全」改（§6） |

`--dry-run` 只打印将要执行的命令（`NAV_PASSWORD` 会被打成 `***`）就结束，不构建、不备份、不起容器。

常用变体：

```bash
./deploy.sh --port 9000
./deploy.sh --data-dir /volume1/docker/nasphere/data
./deploy.sh --tag 1.1.0
./deploy.sh --tar dist/nasphere-1.1.0.tar.gz
```

失败时脚本自己收尾：打印容器最后 20 行日志，并把旧镜像重新拉起（回滚成功也算失败，退出码 1，方便外层脚本判断）。数据不受影响，配置还在 `data/`。

## 4. 路线 B：手工 Docker Compose

```bash
cd /volume1/docker/nasphere
docker compose config          # 先确认 YAML 与 .env 插值都能解析，不启动
docker compose up -d --build
docker compose ps              # STATUS 应为 Up (healthy)
docker compose logs --tail 30
```

浏览器打开 `http://<NAS-IP>:8080`。不想在 NAS 上构建（已有镜像）就把 `--build` 去掉。

## 5. 路线 C：NAS 没网 / 拉不动基础镜像

### C-1 电脑上有 Docker

```bash
# 任何有 Docker 的电脑上
./make-image.sh                       # → dist/nasphere-1.0.0.tar.gz 和 .sha256
ssh 你@NAS 'mkdir -p /volume1/docker/nasphere/dist'
scp dist/nasphere-1.0.0.tar.gz* 你@NAS:/volume1/docker/nasphere/dist/

# NAS 上
cd /volume1/docker/nasphere
sha256sum -c dist/nasphere-1.0.0.tar.gz.sha256
./deploy.sh --tar dist/nasphere-1.0.0.tar.gz
```

### C-2 电脑上也没有 Docker（只要装了 Node）

`make-image-offline.js` 自己去镜像仓库匿名拉 `node:22-alpine` 的层、逐层核对官方 diff_id，再把本项目代码拼成同一套 `docker load` 认识的包——全程不调用 docker 命令。

```bash
node make-image-offline.js                    # 默认 amd64 + arm64 各出一份
node make-image-offline.js --arch arm64       # 只要 ARM 那份（群晖多数机型是 arm64/v8）
node make-image-offline.js --help
```

产物是 `dist/nasphere-<tag>-linux-<arch>.tar.gz`（每份约 58MB）加同名 `.sha256`；脚本末尾会自动把包整个解开做结构自校验，不通过就不产出。NAS 上按 `uname -m` 挑对应那份（`x86_64` → amd64，`aarch64` → arm64），后面的步骤与 C-1 一样：`sha256sum -c` 再 `./deploy.sh --tar`。

基础层缓存留在 `.image-cache/`（约 450MB，重出包就不用重新下载），删掉即重新拉；它已经在 `.dockerignore` 里，不会跟着进构建上下文。

包里镜像名与目标标签不一致时，脚本会自动 `docker tag` 成要用的那个名字。

## 6. 首次启动要做的事（干净版）

初始配置**没有任何分组、链接和容器组件**，所以登录后的主页只有搜索框、时钟、天气条和底部署名——没有卡片、没有左侧导航、没有右缘滚动条，主页上那一层容器组件也整层不出现。

1. **确认账号与密码**：设置（按 `,`）→ 安全。§2 里设过 `NAV_PASSWORD` 的，首启密码就是它、不会提示；没设则是 `admin123`，容器日志会打警告、每次打开页面也会弹提示，账号还是默认的 `admin` 时「安全」那一栏同样标出来——首启后就把这两个改掉。改过一次之后 `data/auth.json` 就是唯一凭据来源，`.env` 里的变量不再起作用（§10）。
2. **建第一个分组**：设置 → 数据 → 分组概览 →「＋ 新建分组」。**不用开编辑模式**。
3. **加应用**：设置 → 编辑应用 →「＋ 新建应用」。名称必填，外网网址和内网网址**至少填一条**（只填一条时，切到另一种取址模式下这张卡会变灰、点了不跳转）；内网就是家里那台机器的地址，如 `http://192.168.1.100:5000`。图标选「站点 favicon」留空即可，取不到会回退首字母。**还没有分组时这颗按钮会提示你先去建组**。
4. **容器组件**：设置 → 应用矩阵 →「容器一览」，这台 NAS 上的容器整列摊开，点一个就往主页上加一张组件（已经挂过的标着「已在页面上」，点它去编辑那张），一张组件对一个容器；新加的落在最下面那张的下方，**想摆到别处就回主页长按那张组件约半秒再拖**，摆到任意坐标、互相叠放都行。启停和重启同样在主页那张组件上**右键**。看不到列表或显示「Docker 不可用」→ 检查 `docker.sock` 有没有挂进来（§11 排查表）。
5. 可选：外观（壁纸、字号、行距）、搜索引擎、天气城市、便签与待办开关。

### 验收清单

| 检查 | 怎么看 |
| --- | --- |
| 服务活着 | `curl -s http://127.0.0.1:8080/api/health` → `{"ok":true,...}` |
| 容器健康 | `docker inspect -f '{{.State.Health.Status}}' nasphere` → `healthy`（healthcheck 每 60s 一次，刚起来那 1 分多钟显示 `starting` 是正常的） |
| 登录门禁生效 | 无痕窗口打开首页应只见到登录页，看不到分组内容；`curl -i http://127.0.0.1:8080/api/config` 应为 401 |
| 配置落盘 | 在页面上改一次外观，约 0.7 秒后 `data/config.json` 的改动就写在磁盘上了（服务端合并后再落一次规范化的结果） |
| 上传可用 | 设置里上传一张图标，`data/uploads/` 出现随机命名的图片文件（支持 png/jpeg/gif/webp/avif/svg，单张 ≤5MB，整个请求受 `MAX_BODY` 约束） |
| 容器组件 | 挂了套接字时「容器一览」能列出容器，组件上显示 CPU/内存/上下行，右键能启停；长按组件能拖到主页任意位置，松手后 `docker.items` 里那张的 `x` / `y` 就变了 |
| 内网 / 外网 | 右上角房子/地球按钮切换后，卡片取的是对应那条网址 |
| 自动同步 | 另一台设备改完配置，本机约 20 秒内（或重新获得焦点时）弹「配置已更新」 |

## 7. 换端口 / 换数据目录（改了要重来一遍）

```bash
# 只改宿主机端口，容器内固定 8080
./deploy.sh --port 9000                     # 或 .env 里写 HOST_PORT=9000 后重跑

# 换数据目录：先把旧数据整个搬过去，再指新路径（务必先 down，别在容器跑着的时候拷）
docker compose down
cp -a data /volume2/docker/nasphere-data
./deploy.sh --data-dir /volume2/docker/nasphere-data
```

走路线 B 手工 compose 的话，改 `.env` 里的 `HOST_PORT` / `DATA_DIR` 再 `docker compose up -d`，效果相同。改完记得同步反向代理里的目标端口。

## 8. 升级

1. 更新项目文件（`git pull`，或重新传 tar 包，或直接替换 `dist/*.tar.gz`）。
2. `./deploy.sh --tag <新版本>`（`--tag` 与 `package.json` 的 version 不一致时以你写的为准）。
3. 配置在 `data/`，换镜像不动它；升级前脚本已把 `config.json`、`auth.json` 存进 `data/.deploy-backup/`。

> **从旧名 `nas-nav` 升上来的这一趟多做一步**：改名后镜像是 `local/nasphere`、容器是 `nasphere`，脚本起的是新容器，旧 `nas-nav` 还占着 8080 端口会直接把新容器顶失败。先 `docker rm -f nas-nav`（只删容器，`data/` 里的配置、账号、上传的图一个都不动，除非你 `.env` 里把 `DATA_DIR` 指到容器里去了），再 `./deploy.sh`。手上是旧名字的离线包（`nas-nav-*.tar.gz`）也不碍事，`deploy.sh --tar` 会按包里的 `RepoTags` 自动重标。

## 9. 回滚

- **自动**：升级后探活失败，脚本自己把旧镜像拉回去，并在结尾用退出码 1 告诉你失败了。
- **手动**：脚本每次都会把当时的在用镜像额外打个 `local/nasphere:rollback` 标签，所以

  ```bash
  docker tag local/nasphere:rollback local/nasphere:1.0.0
  IMAGE=local/nasphere TAG=1.0.0 docker compose up -d --no-build
  ```

- 只想退数据不退镜像：停容器，把 `data/.deploy-backup/<时间戳>/` 里的 `config.json` / `auth.json` 拷回 `data/`，再起容器。

## 10. 忘记密码 / 迁移 / 备份

**忘记账号或密码**（`auth.json` 是唯一的凭据来源）：

```bash
docker compose down
rm data/auth.json
NAV_USER='新账号' NAV_PASSWORD='新密码' docker compose up -d   # 起来后可以把这两个变量删掉
```

**备份**：整目录拷 `data/` 即可（`config.json`、`auth.json`、`.secret`、`uploads/`）。页面里也有「设置 → 数据 → 导出配置 JSON」，但那只导配置，**不含 `uploads/` 里的图片**——换机器时两边都要带走，否则上传过的图标和壁纸会失效。

**迁移到新机器**：新机器上装好 Docker → 拷 `data/` 过去 → 项目文件放好 → `./deploy.sh --data-dir <新路径>`。`.secret`（会话签名密钥）跟着一起走，所有设备就不会被强制重新登录。

**清空重来**：登录后「设置 → 数据 → 清空为初始配置」（不可撤销，先导出备份）；或停容器删掉 `data/config.json`，起来时会自动生成干净的那份。

## 11. 故障排查

| 现象 | 先查 | 处置 |
| --- | --- | --- |
| `这台机器上没有 docker` | 脚本要求 PATH 里有 docker | 用 Docker 图形套件里的 Compose/项目功能照 §4 的参数起；或按 README「本地开发调试」直接跑 `node server/index.js` |
| `连不上 docker 守护进程` | Docker / Container Manager 没启动；当前用户不在 docker 组 | 启动套件，或 `sudo ./deploy.sh`（脚本自己也会试 sudo） |
| 探活失败、已自动回滚 | `docker logs --tail 50 nasphere`；`data/config.json` 是否被手改坏 | JSON 语法错服务仍会用默认配置起来且不覆盖你的文件，修好语法再刷新；端口被占看下一条 |
| 端口没起来 / `Address already in use` | 宿主上 `8080` 被占（威联通常见） | `./deploy.sh --port 9000` |
| `docker.sock: connect version mismatch` 或组件全显示「Docker 不可用」 | 套接字没挂进来、路径不是 `/var/run/docker.sock`、或版本过旧 | `.env` 里改 `DOCKER_SOCK` 后重跑；不需要这能力就把 `docker-compose.yml` 里那行 `- ${DOCKER_SOCK…}:…` 注释掉（`DOCKER_HOST` 留着无害，只会显示不可用） |
| 上传图标 / 壁纸失败 | 反向代理的 `client_max_body_size`；容器 `MAX_BODY`（默认 8MB） | 反代放宽到同值以上，必要时 `.env` 里 `MAX_BODY=…` 后重跑 |
| 登录一直提示「尝试次数过多，请 1 分钟后再试」 | 每 IP 8 次/分钟的限流；限流只看 TCP 对端地址，不读 `X-Forwarded-For` | 等一分钟即可（重启容器会清空计数）。套了反向代理时所有访客共用同一个计数桶，家里人一起用容易互相牵连——这种场景优先直连端口或走 VPN |
| 天气芯片不更新 | 是**浏览器**要访问 `api.open-meteo.com`，不是 NAS | 换网络或关掉天气开关 |
| 必应每日壁纸拿不到 | 由 NAS 端代理并缓存 10 分钟，需要 NAS 能出网 | NAS 不能出网就改用图片链接或上传 |
| 图标全是首字母方块 | favicon 服务（默认 `icon.horse`）取不到 | 设置 → 小组件里改「favicon 服务模板」（可用 `https://www.google.com/s2/favicons?sz=128&domain={domain}`），或给单个应用手填 Emoji / 图片 |
| 反代后样式错乱 / 打不开子路径 `/nav/` | 静态资源与 API 都走根路径 | 整段转发到站点根（Nginx `location / { proxy_pass http://127.0.0.1:8080/; }`），别只匹配前缀 |
| 非 root 起不来（`EACCES`） | 数据目录属主不对 | `chown -R 1000:1000 data`，再放开 `docker-compose.yml` 里注释的 `user: "1000:1000"` |

## 12. 安全边界（部署时请确认一次）

- **挂了 `docker.sock` 就等于把宿主机 root 交给这个容器**（能起一个挂载宿主 `/` 的容器）。这是 Docker 自身的权限模型，不是页面开关能收窄的：主页账号只给可信的人，**不要把它直接暴露到公网**。不需要容器启停就别挂套接字。
- 服务本身只放行「配置里点名过的容器」，动作只有启动 / 停止 / 重启；`rm`、`exec` 连接口都没有。
- 未内置 HTTPS。公网入口请放反向代理（Nginx / Caddy / Traefik）后做 TLS，并强烈建议再套一层认证（Cloudflare Access / Tailscale / 群晖反向代理认证）。
- 未登录能拿到的只有页面外壳（`/`、`/css`、`/js`）、`/api/health` 和登录接口；配置数据与上传图片一律 401（例外见 §13 表格）。所以门禁的全部价值就是那一道登录，公网直挂前请自行评估。
- 密码只以 scrypt 哈希存 `data/auth.json`（`0600`），永不下发；`data/` 整个目录建议 `700`。
- 单实例设计，无并发冲突处理：两个人同时编辑会互相覆盖。

## 13. 速查

```bash
# 状态与日志
docker compose ps ; docker compose logs -f --tail 50
docker inspect -f '{{.State.Health.Status}}' nasphere

# 只重启（换配置不重建镜像）
docker compose restart

# 彻底重来（数据保留！只是删容器）
docker compose down ; ./deploy.sh

# 看容器实际拿到的关键变量
docker exec nasphere env | grep -E 'PORT|DATA_DIR|DOCKER_HOST|MAX_BODY'

# 探活与门禁
curl -s http://127.0.0.1:8080/api/health                                # {"ok":true,...}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/api/config   # 未登录应为 401
```

| 路径 / 位置 | 用途 |
| --- | --- |
| `data/config.json` | 全部页面配置（可手改，服务端会补全并原子写回） |
| `data/auth.json` | 账号 + 密码 scrypt 哈希（`0600`） |
| `data/.secret` | 会话签名密钥（`0600`），迁移时带走 |
| `data/uploads/` | 上传的图标与壁纸；未被引用的会被自动回收 |
| `data/.deploy-backup/` | 每次 `deploy.sh` 前的配置快照 |
| `/api/health` | 免登录探活，部署脚本打的就是它 |
| `/`、`/css`、`/js` | 页面外壳与静态资源，公开可取（里面不含任何配置数据，分组/壁纸要登录后经 `/api/config` 才拿得到） |
| `/api/config`、`/media/*` | 未登录一律 401。唯一例外：登录页当前当背景用的那张壁纸（否则登录页自己就没图），详见 README 的登录背景说明 |

CSP（`Content-Security-Policy`）只挂在 `/api/config` 的响应上，命令行 `curl http://127.0.0.1:8080/` 是看不到的；要确认就在浏览器 DevTools 的 Network 里看登录后那条 `GET /api/config`。
