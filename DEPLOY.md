# 部署手册（NASphere）

面向第一次把这套装上手的操作手册：按顺序做下来能跑起来，出问题时按后面的章节查。功能层面的说明看 `README.md`，这里只讲部署与运维。

- 版本：`package.json` 的 `version`（当前 `1.0.0`）。`deploy.sh` 里那个默认标签是单独写死的一行（`DEFAULT_TAG`），发新版时跟着改。
- 镜像：公开发布在 `ghcr.io/peekaboo789/nasphere`，标签同版本。部署路线一律 `docker pull`，**不在 NAS 上构建**。
- 运行时：单容器，`node:22-alpine`，零 npm 依赖，镜像里只有 `server/` 与 `public/`。
- 所有状态都在挂载出来的数据目录里，换镜像、重建容器都不丢配置。

目录：§0 前置条件 → §1 什么时候才需要源码 → §2 准备 `.env` → §3–§5 三条部署路线（一键脚本 / 手工 compose / 离线镜像包）→ §6 首启设置与验收 → §7 换端口换数据目录 → §8 升级 → §9 回滚 → §10 忘记密码与迁移备份 → §11 故障排查 → §12 安全边界 → §13 命令与路径速查。

## 0. 前置条件

| 需要 | 说明 |
| --- | --- |
| 一台能跑 Docker 的 NAS | 群晖 Container Manager / 绿联 UGOS / 威联通 Container Station，或任何有 `docker` 的 Linux 机器 |
| SSH 或图形终端 | SSH 最省事。只有网页图形界面也能装：在 DSM/UGOS 的 Compose 表单里照 §4 粘 `docker-compose.yml`，卷路径写成绝对路径，套件会自己从 `ghcr.io` 拉镜像；NAS 出不了网才需要 §5 的离线包（导入后按 §4 那两行重标成 compose 里的名字） |
| 能拉 `ghcr.io` | 三条路线里只有 §5 不需要联网拉镜像。§3 和 §4 都是 `docker pull ghcr.io/peekaboo789/nasphere:1.0.0`，不构建、不下源码，所以也不用管 `node:22-alpine` 那个基础镜像 |
| CPU 是 x86_64 或 aarch64 | `deploy.sh` 开头就判这个，其余架构直接退出。**注意 ghcr 上目前只有 `linux/amd64` 一份 manifest**，ARM64 机型在线拉会报 `no matching manifest for linux/arm64/v8`，走 §5 的 arm64 离线包（多架构镜像推上来之后这条限制就没了） |
| 端口没被占用 | 默认对外 `18086`（`deploy.sh --port` 或安装目录 `.env` 里 `HOST_PORT` 可改，手工 compose 就改 `docker-compose.yml` 的 `ports`），容器内固定监听 `18086`。`8080` 常被设备自带服务占用，所以默认值避开它；再冲突就换端口（见 §7） |

**先决定数据目录**，之后备份、迁移、排查都靠它：建议放有存储池的卷上，例如 `/volume1/docker/nasphere/data`。默认值是安装目录里的 `./data`。

## 1. 什么时候才需要源码

> 三条部署路线都不需要先把代码弄到 NAS 上：§3 只拉镜像，§4 只要那一个 yml，§5 要的是镜像包。这一节留给两种人——要自己出离线镜像包（§5 C-2，在电脑上做），和不走 Docker 直接 `node server/index.js` 跑起来改代码的（README「本地开发调试」）。

方式一（有 Git）：

```bash
cd /volume1/docker && git clone https://github.com/peekaboo789/NASphere.git nasphere
```

方式二（没有 Git / 不想装）：电脑上打包传上去。

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

源码目录里应该有：`Dockerfile`、`docker-compose.yml`、`deploy.sh`、`make-image.sh`、`make-image-offline.js`、`server/`、`public/`、`README.md`、`DEPLOY.md`、`.env.example`。

> ⚠️ 别把开发机上那份 `.demo-data/`、`.pre-clean-backup/`、`.env`、`_mock-docker.js` 拷到 NAS——里面有密码哈希、会话密钥和本机自测数据。

## 2. 准备 `.env`（可选）

> 没有 `.env` 也能装，默认值就是 §0 那张表里写的那些。这一节是给要换端口、换安装目录、换镜像仓库的人：`deploy.sh` 会读**安装目录**里那份 `.env`（`<安装目录>/.env`，不是执行命令时的当前目录）。手工 compose（§4）不读 `.env`，那个文件里镜像、端口、卷、`TZ` 全是写死的值。

```bash
mkdir -p /volume1/docker/NASphere && cd /volume1/docker/NASphere
# 从仓库里取 .env.example 太重的话，直接手写这几行也行
vi .env
chmod 600 .env
```

最少改这几行（其余留默认即可）：

```bash
HOST_PORT=18086                 # 对外端口，容器内固定监听 18086
DATA_DIR=/volume1/docker/nasphere/data   # 数据目录，留空就是 <安装目录>/data
# TAG=1.1.0                     # 镜像标签，默认 1.0.0
# IMAGE=ghcr.io/peekaboo789/nasphere   # 用自己的 fork 或内网仓库就改它
```

账号密码**不在这个文件里配**：`deploy.sh` 不注入 `NAV_USER` / `NAV_PASSWORD`，首启就是镜像内置的 `admin` / `admin123`，装完登录去「设置 → 安全」改掉（§6、§12）。真要在首次启动前定死密码，只有 §13 那条 `docker run -e` 的路线。

其余变量、默认值与含义见 README 的「环境变量 → deploy.sh」。生效顺序是**命令行 > 环境变量 > `.env` > 默认值**。

## 3. 路线 A：一键脚本（推荐）

### A-1 全新 NAS，直接从 GitHub 装

```bash
curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/peekaboo789/NASphere/main/deploy.sh | bash
```

装到 `./dat`，也就是你执行这条命令时所在目录下的 `dat/`。要换目录或换端口得走 `bash -s --`——管道执行时 stdin 已经被脚本占着，参数直接跟在 `| bash` 后面是传不进去的：

```bash
curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/peekaboo789/NASphere/main/deploy.sh | \
  bash -s -- --root /volume1/docker/NASphere --port 9000
```

装完那个目录里只有两样东西：`docker-compose.yml`（每次部署由脚本按本次参数重写）和 `data/`。脚本自己不往那儿落副本，下次升级重跑这条命令就行。

模式是脚本自己判的：脚本所在目录（管道执行时就是你执行命令的那个目录）里能看到 `Dockerfile` + `server/index.js`，或者已经躺着一份本脚本生成的 `docker-compose.yml`，就当就地部署、不再新建 `dat/`。

权限方面注意一件事：安装要往 `./dat`（或 `--root` 指的目录）写文件，而 `curl | bash` 把 stdin 占住了，`sudo` 真要密码是输不进去的。所以要么整个用 root 跑（`curl … | sudo bash`），要么 `--root` 指一个你有写权限的目录，要么给当前用户配免密 sudo。Docker 那一侧不同：当前用户不在 `docker` 组时脚本会自己在 `docker` 命令前面加 sudo。

### A-2 本机已经有安装目录

```bash
cd /volume1/docker/NASphere
chmod +x deploy.sh        # 只有你自己把脚本拷进去时才需要
./deploy.sh --dry-run     # 先看要执行什么，不动任何东西
./deploy.sh               # 真跑
```

### 输出对照

脚本的流程是**检测架构 → 准备目录 → 生成 docker-compose.yml → 拉镜像 → `docker compose up -d` → 探活**，跑起来会看到这些行，含义依次是：

| 输出 | 含义 |
| --- | --- |
| `检测到 CPU 架构：AMD64（x86_64）` / `ARM64（aarch64）` | 架构判定。其余架构直接 `✕ 不支持的 CPU 架构：…` 退出 |
| `安装目录：…` / `已创建安装目录：…` | 装到哪儿。默认 `./dat`，`--root` 或 `INSTALL_ROOT` 可改 |
| `就地部署：…` + `（脚本旁边就是 NASphere 项目目录）`（或 `（脚本旁边已经有本脚本生成的 docker-compose.yml）`） | 判定成就地部署，不会再建 `dat/` |
| `读取 …/.env` | 安装目录里有 `.env` 才打印 |
| `! …/.env 不会被读取，.env 要放在 <安装目录>/.env 才生效` | 你把 `.env` 留在了执行命令的目录里，而安装目录是别处。搬过去或加 `--root` |
| `当前用户不在 docker 组，后续 Docker 命令将使用 sudo` | 后续 `docker` 命令自动加 sudo，可能提示输密码，属正常（管道执行输不了密码，见上面的权限说明） |
| `镜像：ghcr.io/peekaboo789/nasphere:1.0.0` / `取镜像方式：docker pull（本机不需要源码，也不构建）` / `容器：compose 项目 nasphere → 容器名 nasphere-nasphere-1` / `端口：18086 → 容器内 18086` / `数据：…/data` / `时区：Asia/Shanghai` | 生效的参数，优先级是**命令行 > 环境变量 > `.env` > 默认值**；数据目录已转成绝对路径 |
| `首次启动：账号 admin、密码 admin123（镜像内置默认值）` | 部署前 `data/auth.json` 不存在时才打印（取样在容器启动之前，不会被服务端补写文件盖掉） |
| `! 目录里那份 compose 不是本脚本生成的，已备份到 …/docker-compose.yml.backup-<时间戳>` | 目录里那份 yml 是你手写/从仓库拷来的，覆盖前先留一份。脚本自己生成的那份如果参数没变就只打印 `docker-compose.yml 与本次参数一致，未改动` |
| `已生成 …/docker-compose.yml` 或 `docker-compose.yml 与本次参数一致，未改动` | compose 每次按本次参数重写，所以 `--port`、`--data-dir` 不会像以前那样被写死的 yml 吞掉 |
| `没有已有配置，跳过备份` 或 `配置已备份到：<数据目录>/.deploy-backup/<时间戳>` | 升级前的 config/auth 快照，默认留最近 5 份（`KEEP_BACKUPS` 可调） |
| `已记录旧版本镜像：sha256:abcdef1234` | 回滚锚点，同时另打一个 `<IMAGE>:rollback` 标签（§9）。首次部署没有这一行 |
| `加载离线 Docker 镜像：…` → `已把包内镜像 local/nasphere:1.0.0 重标为 ghcr.io/peekaboo789/nasphere:1.0.0` | 仅 `--tar`：包里的名字与目标标签不一致时自动重标，走这条就不会去拉 ghcr |
| `! 找不到 Docker Socket：/var/run/docker.sock` + `! NASphere Docker 管理功能将不可用（compose 里那行挂载已经省掉，其余功能照常）` | 宿主机上找不到套接字，跳过挂载——容器组件就没数据，需要的话按 §11 处理 |
| `拉取 NASphere 镜像：…` | 就是 `docker pull`。失败时按架构给不同提示（ARM64 见上表架构那行），然后 `✕ 镜像没弄到手，部署到此为止；data/ 没有被改动` |
| `启动 NASphere` → `Container nasphere-nasphere-1  Started` → `等待 NASphere 服务启动（最多 40s）` → `NASphere 安装/更新完成 ✓` + `访问地址：` / `  http://192.168.x.x:18086` | 起容器走的是 `docker compose up -d`；探活打的是免登录的 `/api/health`；最多等 `HEALTH_WAIT` 秒 |
| `首次启动，登录账号：` + `用户名：admin` + `密码　：admin123` + `这是镜像内置的默认密码，公开仓库上人人可查。` + `! 请立刻记下…登录后立刻去「设置 → 安全」把账号和密码一起改掉。` | 首启凭据提示（§6、§12）。挂了 `docker.sock` 时中间还多一行提醒：页面账号等于能启停宿主机上的容器 |

`--dry-run` 只打印将要执行的动作（`mkdir`、生成的 compose 全文、`docker pull`、`docker compose up -d` 那几条）就结束，不落盘、不备份、不起容器，末尾是 `✓ dry-run 完成，没有修改任何内容`。

常用变体：

```bash
./deploy.sh --port 9000
./deploy.sh --data-dir /volume1/docker/nasphere/data
./deploy.sh --tag 1.1.0
./deploy.sh --tar dist/nasphere-1.1.0-linux-amd64.tar.gz
./deploy.sh --root /volume1/docker/NASphere   # 安装目录，默认 ./dat
./deploy.sh --uninstall     # 停掉本项目的容器、删掉 NASphere 镜像，data/ 一个字节都不动
```

失败时脚本自己收尾：先打印容器状态与最后 30 行日志，再把升级前在用的镜像重新拉起（回滚成功也算失败，退出码 1，方便外层脚本判断）。数据不受影响，配置还在 `data/`。

## 4. 路线 B：手工 Docker Compose

`docker-compose.yml` 只描述「用哪个镜像、开哪个端口、挂哪两个卷、`TZ` 是什么」，不内嵌 Dockerfile，也不读 `.env`。镜像就放在 GitHub Packages 上（`ghcr.io/peekaboo789/nasphere`，public），`up` 的时候 compose 自己拉——所以这条路线 NAS 上**只要有这一个 yml**，源码、`Dockerfile` 都不落机，也不用 build：

```bash
mkdir -p /volume1/docker/nasphere && cd /volume1/docker/nasphere
# 把仓库里的 docker-compose.yml 放进来（网页上复制粘贴也行）
docker compose config          # 先确认 YAML 没问题，不启动
docker compose up -d           # 本地没有这个镜像就去 ghcr 拉
docker compose ps              # STATUS 应为 Up (healthy)
docker compose logs --tail 30
```

浏览器打开 `http://<NAS-IP>:18086`。

> yml 里没写 `container_name`，所以容器叫 `<compose 项目名>-nasphere-1`（项目名默认取目录名）。多台机器测试不会被「容器名已存在」顶住；要看是哪台就用 `docker compose ps`，别按名字找。

NAS 到 `ghcr.io` 不通（没网、或被墙）就走 §5 的离线包。包里的名字是 `local/nasphere:1.0.0`，和 compose 写的那个不同名，`load` 完补一步重标，之后 compose 见本地已有同名镜像就不会再去拉：

```bash
docker load -i nasphere-1.0.0-linux-amd64.tar.gz
docker tag local/nasphere:1.0.0 ghcr.io/peekaboo789/nasphere:1.0.0
docker compose up -d
```

> ⚠️ ghcr 上目前只有 `linux/amd64` 一份 manifest（没有多架构索引）。ARM 机型（群晖多数是 `arm64/v8`）走在线那条会报 `no matching manifest for linux/arm64/v8`，请用 §5 的 **arm64** 离线包 + 上面那两行 `docker load` / `docker tag`。

要改端口、数据目录或镜像版本，就直接改 `docker-compose.yml` 里那三行写死的值（`image`、`ports` 冒号左边、`volumes` 冒号左边），再 `docker compose up -d`。首启密码这条路线给不进去，容器会用镜像内置的 `admin123`，登录后立刻去「设置 → 安全」改（§6、§12）。

> 这条路和 §3 是二选一：现在两边撞的是**端口**（都默认占宿主机 `18086`，后起的那个报 `port is already allocated`），不再是容器名。切换前先停掉另一边——`deploy.sh` 起的那台用 `cd <安装目录> && docker compose down`，手工那台用 `docker compose down`。`data/` 都不动。

## 5. 路线 C：NAS 没网 / 拉不动镜像

### C-1 电脑上有 Docker

```bash
# 任何有 Docker 的电脑上
./make-image.sh                       # → dist/nasphere-1.0.0.tar.gz 和 .sha256
ssh 你@NAS 'mkdir -p /volume1/docker/NASphere/dist'
scp dist/nasphere-1.0.0.tar.gz* 你@NAS:/volume1/docker/NASphere/dist/

# NAS 上，在安装目录里
cd /volume1/docker/NASphere
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

产物是 `dist/nasphere-<tag>-linux-<arch>.tar.gz`（每份约 58MB）加同名 `.sha256`；脚本末尾会自动把包整个解开做结构自校验，不通过就不产出。NAS 上按 `uname -m` 挑对应那份（`x86_64` → amd64，`aarch64` → arm64），后面的步骤与 C-1 一样：`sha256sum -c` 再 `./deploy.sh --tar`。**ARM 机型只能走这条**，因为 ghcr 上现在只推了 amd64。

不想让脚本插手的话，`docker load -i` 那份包再走 §4 的手工路线就行——但包里的 `RepoTags` 是 `local/nasphere:<版本>`，与 `docker-compose.yml` 里写死的 `ghcr.io/peekaboo789/nasphere:<版本>` 不同名，`up` 之前得先照 §4 那两行 `docker tag` 重标一次。`./deploy.sh --tar` 不用你做这一步，它按包里的 `RepoTags` 自动重标。

基础层缓存留在 `.image-cache/`（约 450MB，重出包就不用重新下载），删掉即重新拉；它已经在 `.dockerignore` 里，不会跟着进构建上下文。

## 6. 首次启动要做的事（干净版）

初始配置**没有任何分组、链接和容器组件**，所以登录后的主页只有搜索框、时钟、天气条和底部署名——没有卡片、没有左侧导航、没有右缘滚动条，主页上那一层容器组件也整层不出现。

1. **改掉账号与密码**：设置（按 `,`）→ 安全。三条路线首启都是镜像内置的 `admin` / `admin123`（`deploy.sh` 不再随机生成密码，也不读 `.env` 里的凭据），这是公开仓库上人人可查的默认值，而且容器默认挂着 `docker.sock`——**装完第一件事就是登进去把账号和密码一起改掉**。改过一次之后 `data/auth.json` 就是唯一凭据来源，之后重装、升级、换镜像都不会把它换回去。想连这一步都省掉，只有 §13 那条 `docker run -e NAV_PASSWORD=…` 的路线。
2. **建第一个分组**：设置 → 数据 → 分组概览 →「＋ 新建分组」。**不用开编辑模式**。
3. **加应用**：设置 → 编辑应用 →「＋ 新建应用」。名称必填，外网网址和内网网址**至少填一条**（只填一条时，两种取址模式都用这一条，卡片照样能点；两条都没填才会变灰）；内网就是家里那台机器的地址，如 `http://192.168.1.100:5000`。图标选「站点 favicon」留空即可，取不到会回退首字母。**还没有分组时这颗按钮会提示你先去建组**。
4. **容器组件**：设置 → 应用矩阵 →「容器一览」，这台 NAS 上的容器整列摊开，点一个就往主页上加一张组件（已经挂过的标着「已在页面上」，点它去编辑那张），一张组件对一个容器；新加的落在最下面那张的下方，**想摆到别处就回主页长按那张组件约半秒再拖**，摆到任意坐标、互相叠放都行。启停和重启同样在主页那张组件上**右键**。看不到列表或显示「Docker 不可用」→ 检查 `docker.sock` 有没有挂进来（§11 排查表）。
5. 可选：外观（壁纸、字号、行距）、搜索引擎、天气城市、便签与待办开关。

### 验收清单

| 检查 | 怎么看 |
| --- | --- |
| 服务活着 | `curl -s http://127.0.0.1:18086/api/health` → `{"ok":true,...}` |
| 容器健康 | `docker inspect -f '{{.State.Health.Status}}' nasphere-nasphere-1` → `healthy`（healthcheck 每 60s 一次，刚起来那 1 分多钟显示 `starting` 是正常的；不确定容器叫什么就 `docker compose ps`） |
| 登录门禁生效 | 无痕窗口打开首页应只见到登录页，看不到分组内容；`curl -i http://127.0.0.1:18086/api/config` 应为 401 |
| 配置落盘 | 在页面上改一次外观，约 0.7 秒后 `data/config.json` 的改动就写在磁盘上了（服务端合并后再落一次规范化的结果） |
| 上传可用 | 设置里上传一张图标，`data/uploads/` 出现随机命名的图片文件（支持 png/jpeg/gif/webp/avif/svg/ico，单张 ≤5MB，整个请求受 `MAX_BODY` 约束） |
| 容器组件 | 挂了套接字时「容器一览」能列出容器，组件上显示 CPU/内存/上下行，右键能启停；长按组件能拖到主页任意位置，松手后 `docker.items` 里那张的 `x` / `y` 就变了 |
| 内网 / 外网 | 右上角房子/地球按钮切换后，卡片取的是对应那条网址 |
| 自动同步 | 另一台设备改完配置，本机约 20 秒内（或重新获得焦点时）弹「配置已更新」 |

## 7. 换端口 / 换数据目录（改了要重来一遍）

```bash
# 只改宿主机端口（默认 18086），容器内固定监听 18086
./deploy.sh --port 9000                     # 或安装目录 .env 里写 HOST_PORT=9000 后重跑

# 换数据目录：先把旧数据整个搬过去，再指新路径（务必先停容器，别在跑着的时候拷）
docker compose down                         # 在安装目录里
cp -a data /volume2/docker/nasphere-data
./deploy.sh --data-dir /volume2/docker/nasphere-data
```

改完记得同步反向代理里的目标端口。数据目录那一位是宿主机侧的绝对路径，容器内固定挂到 `/app/data`（镜像里 `ENV DATA_DIR=/app/data`），指错点就等于换了一份空配置——账号、壁纸看起来全没了，其实老数据还在原目录里。

走路线 B 手工 compose 的话，改的是 `docker-compose.yml` 本身：`ports` 冒号左边那一位，和 `volumes` 第一行冒号左边的宿主目录，再 `docker compose up -d`。

## 8. 升级

**一键脚本**：在安装目录里 `./deploy.sh --tag <新版本>`，或者重跑 §3 那条 `curl … | bash`——它认得这个目录（旁边就有脚本生成的 compose），`data/` 原样留下，`.env` 也只读不写。脚本会先把在用的镜像记成回滚锚点、把 `config.json`、`auth.json` 存进 `data/.deploy-backup/`，再 pull 新标签、`docker compose up -d`、探活。

> 不写 `--tag` 就是重跑当前默认标签（`1.0.0`）。ghcr 上同一个标签被重推过时，这次 pull 会拉回新的那份；想让升级有确定的落点，就给每个版本一个新标签。

**手工 compose**：NAS 上连项目文件都不用换，把 `docker-compose.yml` 里 `image` 的标签改成新版本，再 `docker compose up -d`（compose 见本地没有这个标签会自己去 ghcr 拉）。ghcr 上标签没变但镜像重推过，就先 `docker compose pull` 再 up。

**离线包**：`./deploy.sh --tar <新包>`，走 C-1/C-2 重出一份即可，NAS 全程不联网。

> **从旧名 `nas-nav` 升上来的这一趟多做一步**：改名后镜像叫 `nasphere`、旧容器叫 `nas-nav`，旧容器还占着端口会把新容器顶失败（旧版默认对外 `8080`，新版默认 `18086`，只有你手动把两者撞到同一个端口上才会冲突）。先 `docker rm -f nas-nav`（只删容器，`data/` 里的配置、账号、上传的图一个都不动），再 `./deploy.sh`。手上是旧名字的离线包（`nas-nav-*.tar.gz`）也不碍事，`deploy.sh --tar` 会按包里的 `RepoTags` 自动重标。

## 9. 回滚

- **自动**：升级后探活失败，脚本自己把旧镜像重新指到 compose 里那个标签上、再 `docker compose up -d` 拉回旧版，并在结尾用退出码 1 告诉你失败了（回滚成功也算失败）。
- **手动**：脚本每次都会把当时的在用镜像额外打个 `<IMAGE>:rollback` 标签（默认就是 `ghcr.io/peekaboo789/nasphere:rollback`），所以

  ```bash
  cd <安装目录>
  docker compose down
  docker tag ghcr.io/peekaboo789/nasphere:rollback ghcr.io/peekaboo789/nasphere:1.0.0
  docker compose up -d
  ```

  > 别再直接跑 `./deploy.sh`：它开头就 `docker pull`，会把刚退回去的本地镜像又换成 ghcr 上那份。要跑就配 `--tar`（那条跳过 pull）。

- 只想退数据不退镜像：停容器，把 `data/.deploy-backup/<时间戳>/` 里的 `config.json` / `auth.json` 拷回 `data/`，再起容器。

## 10. 忘记密码 / 迁移 / 备份

**忘记账号或密码**（`auth.json` 是唯一的凭据来源）：删掉它，下一次启动就会用镜像内置的 `admin` / `admin123` 重新初始化，登进去再改。

```bash
cd <安装目录>
docker compose down
rm data/auth.json
docker compose up -d        # 或 ./deploy.sh
```

> 想用别的账号名/密码直接登进去改（设置 → 安全）。服务端确实认 `NAV_USER` / `NAV_PASSWORD`，但 `deploy.sh` 和仓库那份 compose 都不注入它们，要带就只能手工 `docker run -e`（§13）或在生成的 compose 里自己加 `environment` 那两行。

**备份**：整目录拷 `data/` 即可（`config.json`、`auth.json`、`.secret`、`uploads/`）。页面里也有「设置 → 数据 → 导出配置 JSON」，但那只导配置，**不含 `uploads/` 里的图片**——换机器时两边都要带走，否则上传过的图标和壁纸会失效。

**迁移到新机器**：新机器上装好 Docker → 拷 `data/` 到安装目录（或 `--data-dir <新路径>`）→ `./deploy.sh`（拉不动镜像就 `--tar`）。`.secret`（会话签名密钥）跟着一起走，所有设备就不会被强制重新登录。

**清空重来**：登录后「设置 → 数据 → 清空为初始配置」（不可撤销，先导出备份）；或停容器删掉 `data/config.json`，起来时会自动生成干净的那份。

## 11. 故障排查

| 现象 | 先查 | 处置 |
| --- | --- | --- |
| `这台机器上没有 docker` | 脚本要求 PATH 里有 docker | 用 Docker 图形套件里的 Compose/项目功能：先弄出 `ghcr.io/peekaboo789/nasphere:1.0.0` 这个镜像（§5 的离线包导入 + §4 那两行重标），再把 §4 那份 `docker-compose.yml` 贴进项目起起来；卷路径写绝对路径。或按 README「本地开发调试」直接跑 `node server/index.js` |
| `连不上 docker 守护进程` | Docker / Container Manager 没启动；当前用户不在 docker 组 | 启动套件，或 `sudo ./deploy.sh`（脚本自己也会试 sudo） |
| 一键安装报「没有权限写 …，也用不了免密 sudo」 | 目标目录的父级当前用户写不进去，而 `curl \| bash` 占住了 stdin，sudo 弹密码也输不了 | 整条命令用 root 跑（`curl … \| sudo bash`），或 `bash -s -- --root <你有权限的目录>`，或给当前用户配免密 sudo |
| `拉取失败：ghcr.io/…`（AMD64 机器） | 这台机器到 `ghcr.io` 不通 | 换台机器 `docker save` 成离线包传上去，`./deploy.sh --tar <包>`；或者整套走 §4 的手工路线 |
| `no matching manifest for linux/arm64/v8` | ghcr 上这个标签只有 amd64 那份 manifest | 用 §5 C-2 的 **arm64** 离线包 `./deploy.sh --tar`（脚本自动重标，不需要源码也不需要 build）。等仓库推了多架构之后这条在线就能拉 |
| `✕ 不支持的 CPU 架构：…` | 机器既不是 x86_64 也不是 aarch64 | 脚本只测过这两种。照 §4 手工起 compose 试试（先确认那个镜像能在这台机器上跑起来） |
| 探活失败、已自动回滚 | `cd <安装目录> && docker compose logs --tail 50`；`data/config.json` 是否被手改坏 | JSON 语法错服务仍会用默认配置起来且不覆盖你的文件，修好语法再刷新；端口被占看下一条 |
| 端口没起来 / `Address already in use` | 宿主上 `18086` 被占（`ss -tlnp \| grep 18086`），或者另一条路线的容器还在跑 | `./deploy.sh --port 9000`，或 `.env` 里写 `HOST_PORT=9000`；两边同时在跑就 `docker compose down` 掉另一边 |
| `docker.sock: connect version mismatch` 或组件全显示「Docker 不可用」 | 套接字没挂进来、路径不是 `/var/run/docker.sock`、或版本过旧 | `deploy.sh` 路线：安装目录 `.env` 里改 `DOCKER_SOCK` 后重跑（脚本会把它一起写进 compose 的 `DOCKER_HOST`）。手工 compose 路线：改 `docker-compose.yml` 里那行 `- /var/run/docker.sock:/var/run/docker.sock`（左右两边保持同一个宿主机路径最省事）。不需要这能力就把那行注释掉，其余功能照常 |
| 上传图标 / 壁纸失败 | 反向代理的 `client_max_body_size`；容器 `MAX_BODY`（默认 8MB） | 反代放宽到同值以上；`MAX_BODY` 要改就 `docker run -e MAX_BODY=…`（compose 里加 `environment`）后重起 |
| 登录一直提示「尝试次数过多，请 1 分钟后再试」 | 每 IP 8 次/分钟的限流；限流只看 TCP 对端地址，不读 `X-Forwarded-For` | 等一分钟即可（重启容器会清空计数）。套了反向代理时所有访客共用同一个计数桶，家里人一起用容易互相牵连——这种场景优先直连端口或走 VPN |
| 天气芯片不更新 | 是**浏览器**要访问 `api.open-meteo.com`，不是 NAS | 换网络或关掉天气开关 |
| 必应每日壁纸拿不到 | 由 NAS 端代理并缓存 10 分钟，需要 NAS 能出网 | NAS 不能出网就改用图片链接或上传 |
| 图标全是首字母方块 | favicon 服务（默认 `icon.horse`）取不到 | 设置 → 小组件里改「favicon 服务模板」（可用 `https://www.google.com/s2/favicons?sz=128&domain={domain}`），或给单个应用手填 Emoji / 图片 |
| 反代后样式错乱 / 打不开子路径 `/nav/` | 静态资源与 API 都走根路径 | 整段转发到站点根（Nginx `location / { proxy_pass http://127.0.0.1:18086/; }`），别只匹配前缀 |
| 非 root 起不来（`EACCES`） | 数据目录属主和容器运行用户不匹配。两条路线起的容器都是 root，compose 里也没写 `user:`，所以这条只在你自己加过运行用户时才会撞上 | `chown -R 1000:1000 data`，或者去掉自己加的那个 `user:` |
| 登录后主页空空的 | 是正常状态：首启配置里没有分组 | 按 §6 建第一个分组 |

## 12. 安全边界（部署时请确认一次）

- **挂了 `docker.sock` 就等于把宿主机 root 交给这个容器**（能起一个挂载宿主 `/` 的容器）。这是 Docker 自身的权限模型，不是页面开关能收窄的：主页账号只给可信的人，**不要把它直接暴露到公网**。不需要容器启停就别挂套接字（`deploy.sh` 只在宿主机真有那个套接字时才挂；不想给就在 compose 里删掉那两行）。
- 服务本身只放行「配置里点名过的容器」，动作只有启动 / 停止 / 重启；`rm`、`exec` 连接口都没有。
- 未内置 HTTPS。公网入口请放反向代理（Nginx / Caddy / Traefik）后做 TLS，并强烈建议再套一层认证（Cloudflare Access / Tailscale / 群晖反向代理认证）。
- 未登录能拿到的只有页面外壳（`/`、`/css`、`/js`）、`/api/health` 和登录接口；配置数据与上传图片一律 401（例外见 §13 表格）。所以门禁的全部价值就是那一道登录，公网直挂前请自行评估。
- **三条部署路线的首启密码都是镜像内置的 `admin` / `admin123`**（`deploy.sh` 以前那套随机初始密码已经去掉了——脚本不再有源码和本机 build，密码也没地方写进 `.env`）。也就是说「装完立刻改密码」从建议变成了必须做的一步，尤其是还挂着 `docker.sock` 的时候。想在首次启动前就定死密码，只有 §13 的 `docker run -e NAV_PASSWORD=…` 那条路。
- 密码只以 scrypt 哈希存 `data/auth.json`（`0600`），永不下发；`data/` 整个目录建议 `700`。
- 单实例设计，无并发冲突处理：两个人同时编辑会互相覆盖。

## 13. 速查

```bash
# 状态与日志（两条路线都是 compose 起的，容器名是 <项目名>-nasphere-1）
cd <安装目录> && docker compose ps
docker compose logs -f --tail 50
docker inspect -f '{{.State.Health.Status}}' nasphere-nasphere-1

# 只重启（换配置不重建镜像）
docker restart nasphere-nasphere-1

# 彻底重来（数据保留！只是删容器）
docker compose down ; ./deploy.sh

# 看容器实际拿到的关键变量
docker exec nasphere-nasphere-1 env | grep -E 'PORT|DATA_DIR|DOCKER_HOST|TZ'

# 不用 Docker 直接跑（开发/救急）：默认密码同样是 admin / admin123
node server/index.js

# 唯一能在首启前定死密码的路线
docker pull ghcr.io/peekaboo789/nasphere:1.0.0
docker run -d --name nasphere-manual --restart unless-stopped \
  -p 18086:18086 \
  -e NAV_USER='admin' -e NAV_PASSWORD='你自己的强密码' \
  -v "$(pwd)/data:/app/data" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  ghcr.io/peekaboo789/nasphere:1.0.0

# 探活与门禁
curl -s http://127.0.0.1:18086/api/health                                # {"ok":true,...}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18086/api/config   # 未登录应为 401
```

| 路径 / 位置 | 用途 |
| --- | --- |
| `<安装目录>/docker-compose.yml` | `deploy.sh` 每次按参数重写的那份；目录里如果躺着你手写的版本，覆盖前先备份成 `.backup-<时间戳>` |
| `data/config.json` | 全部页面配置（可手改，服务端会补全并原子写回） |
| `data/auth.json` | 账号 + 密码 scrypt 哈希（`0600`）；删掉它就回到内置的 `admin` / `admin123` |
| `data/.secret` | 会话签名密钥（`0600`），迁移时带走 |
| `data/uploads/` | 上传的图标与壁纸；未被引用的会被自动回收 |
| `data/.deploy-backup/` | 每次 `deploy.sh` 前的配置快照 |
| `<安装目录>/.env` | 只给 `deploy.sh` 读（镜像、端口、目录、超时这些），手工 compose 不读它，里面也不再配密码 |
| `/api/health` | 免登录探活，部署脚本打的就是它 |
| `/`、`/css`、`/js` | 页面外壳与静态资源，公开可取（里面不含任何配置数据，分组/壁纸要登录后经 `/api/config` 才拿得到） |
| `/api/config`、`/media/*` | 未登录一律 401。唯一例外：登录页当前当背景用的那张壁纸（否则登录页自己就没图），详见 README 的登录背景说明 |

CSP（`Content-Security-Policy`）只挂在 `/api/config` 的响应上，命令行 `curl http://127.0.0.1:18086/` 是看不到的；要确认就在浏览器 DevTools 的 Network 里看登录后那条 `GET /api/config`。
