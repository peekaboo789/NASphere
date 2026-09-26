<div align="center">

<img src="public/img/logo.png" alt="NASphere" width="180">

# NASphere

**自托管 NAS 主页 / 导航面板**

自定义图标与壁纸 · 多引擎搜索 · 分组卡片拖拽 · Docker 容器组件 · 账号密码门禁 · 手机浏览器适配

**零外部依赖：后端仅使用 Node.js 标准库，前端使用原生 HTML / CSS / JavaScript。**

无需 `npm install`，无需前端构建，无需数据库。

所有配置、账号信息和上传图片均保存在 NAS 本地，不依赖第三方账号或云服务。

**作者：peekaboo789（蜂巢 @accarry）**

</div>

---

## ✨ 亮点

* **一条命令安装**

  * 支持 GitHub 一键安装
  * 默认使用 GitHub 加速地址获取脚本
  * 自动检测架构、生成 compose、拉取 GHCR 镜像、启动容器、健康检查
  * 不需要源码，也不在本机 build 镜像
  * 升级与重装不覆盖 `data/`
  * 部署失败自动回滚
* **零构建依赖**

  * 不需要 `npm install`
  * 不需要 Node.js 构建前端
  * Docker 镜像直接运行 Node.js
* **一屏式 NAS 服务门户**

  * 搜索
  * 时钟
  * 天气
  * 分组应用
  * Docker 容器状态
  * 便签
  * 待办
* **高度自定义**

  * 图标
  * 壁纸
  * 搜索引擎
  * 字体
  * 图标尺寸
  * 卡片间距
  * 内外网地址
* **Docker 容器组件**

  * CPU
  * 内存
  * 上 / 下行速度
  * 运行状态
  * 启动 / 停止 / 重启
  * 自由拖动和调整尺寸
* **NAS 资源组件**

  * 内存使用率
  * CPU 占用与负载
  * 上 / 下行速率
  * 显卡占用
  * 每个存储卷各自的容量与使用率
  * 物理硬盘型号与容量
  * 自定义读数：勾哪几行就画哪几行
  * 只读数字，不读文件内容
* **数据完全本地化**

  * `data/` 即完整运行数据
  * 配置可以直接编辑
  * 支持导出 / 导入
  * 支持自动备份
* **手机直接使用**

  * 不需要单独的移动端页面
  * 自动适配触摸设备和窄屏
* **深色优先**

  * 默认深色界面
  * 内置 10 套渐变壁纸
  * 支持图片、上传、必应每日壁纸

---

# 🚀 快速开始

## 方式一：一条命令安装

如果 NAS 可以访问 GitHub，推荐直接执行：

```bash
curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/peekaboo789/NASphere/main/deploy.sh | bash
```

脚本会自动：

```text
检测 CPU 架构
      ↓
准备安装目录
      ↓
生成 docker-compose.yml
      ↓
拉取 GHCR 镜像
      ↓
docker compose up -d
      ↓
健康检查
      ↓
输出访问地址
```

不需要源码，也不在本机 build 镜像——镜像是公开发布在 `ghcr.io/peekaboo789/nasphere` 上的，脚本只负责 `docker pull`。

默认：

```text
安装目录：./dat
镜像：ghcr.io/peekaboo789/nasphere:1.0.4
compose 项目名：nasphere（容器叫 nasphere-nasphere-1）
宿主端口：18086
数据目录：./data（就在安装目录里）
```

`./dat` 是相对执行命令时所在的目录，想装别处就加 `--root`。

换安装目录或端口（管道执行必须带 `bash -s --` 才传得进参数）：

```bash
curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/peekaboo789/NASphere/main/deploy.sh | \
  bash -s -- --root /volume1/docker/NASphere --port 9000
```

首次启动的账号密码是镜像内置的 `admin` / `admin123`，装完立刻登录去「设置 → 安全」改掉（这个容器还挂着 `docker.sock`，页面账号等于能启停宿主机上的容器）。

同一个目录再执行一次就是原地升级：`data/` 原样保留，壁纸、图标、配置、账号都不会丢；compose 文件每次由脚本重写。

安装完成后访问：

```text
http://<NAS-IP>:18086
```

例如：

```text
http://192.168.8.99:18086
```

> `ghcr.io` 上目前只发布了 `linux/amd64`。ARM 机型（群晖多数是 `arm64/v8`）这条命令会在拉镜像那一步报 `no matching manifest`，请改用下面的离线镜像方式。

---

## 方式二：本机已经有安装目录

`cd` 进上次装好的目录直接跑就是升级：

```bash
cd ./dat

chmod +x deploy.sh

./deploy.sh
```

脚本旁边就是本脚本生成的 `docker-compose.yml`（或者整个 NASphere 项目目录）时走就地部署，不会再下载任何东西。

部署脚本会自动：

1. 检测 CPU 架构（`x86_64` / `aarch64`，其余直接退出）
2. 检查 Docker
3. 备份 `data/config.json`
4. 备份 `data/auth.json`
5. 生成 `docker-compose.yml`
6. 从 GHCR 拉镜像
7. `docker compose up -d`
8. 检查 `/api/health`
9. 启动失败自动回滚旧镜像

---

# 🔄 更新 NASphere

在安装目录里执行：

```bash
./deploy.sh --tag 1.1.0
```

脚本会 pull 那个标签的镜像、用同一个 `data/` 重新起容器。不写 `--tag` 就重跑当前默认标签（`1.0.4`），ghcr 上同名标签被重推过时它会拉回新的那份。

一键安装过的那条命令也可以直接重跑。

脚本会 pull 那个标签的镜像、用同一个 `data/` 重新起容器。不写 `--tag` 就重跑当前默认标签（`1.0.0`），ghcr 上同名标签被重推过时它会拉回新的那份。

一键安装过的那条命令也可以直接重跑。

项目数据默认保存在：

```text
./data
```

升级只换镜像，数据目录里的这些东西一个字节都不动：

```text
config.json
auth.json
uploads/
```

安装目录里那份 `.env` 也只被脚本读取、不会被改写。

因此正常升级不会影响已经设置好的主页，登录账号密码也不变。

---

# 🔐 首次登录

首次启动的凭据是镜像内置的默认值：

```text
用户名：admin
密码　：admin123
```

这是公开仓库上人人可查的默认密码，而且默认部署还会把 `docker.sock` 挂进容器（页面账号等于能启停宿主机上的容器）。**第一次登录后请立即进入：**

```text
设置 → 安全
```

修改账号和密码。改过一次之后 `data/auth.json` 就是唯一的凭据来源，之后重装、升级都不会把它换回去。

服务端另有两个环境变量 `NAV_USER` / `NAV_PASSWORD`，只在 `data/auth.json` 不存在时用于初始化；`deploy.sh` 不注入它们，需要时用 `docker run -e` 或 compose 的 `environment` 自己带上。

> 注意：`auth.json` 已经存在时，这两个变量不会再改动现有账号密码。

---

# 📦 Docker Compose

仓库里的 `docker-compose.yml` 是写死值的最小版本（镜像、端口、卷、`TZ` 都不做 `${}` 插值，也不读 `.env`）。`./deploy.sh` 不用它——脚本会在安装目录里生成一份自己的。

只用这一个文件也能装：镜像公开发布在 GitHub Container Registry，本机不需要源码、不需要 Dockerfile。

```bash
docker compose up -d
```

镜像本地没有时 compose 自己拉 `ghcr.io/peekaboo789/nasphere:1.0.4`，拉下来直接起容器。

默认访问：

```text
http://<NAS-IP>:18086
```

`docker-compose.yml` 里 `image`、端口、卷都是写死的值，不做 `.env` 插值。

改端口就直接改 `ports` 冒号左边那一位（容器内固定 `18086`，右边不要动）：

```text
- "9000:18086"
```

然后重新 up：

```bash
docker compose up -d
```

访问：

```text
http://<NAS-IP>:9000
```

升级版本时把 `image` 的标签一起改（同一个标签的内容变了就先 `docker compose pull`）。

`ghcr.io` 拉不动的机器改用离线镜像包：`docker load` 完之后补一个同名标签再起 compose——

```bash
docker load -i nasphere-1.0.4-linux-amd64.tar.gz
docker tag local/nasphere:1.0.4 ghcr.io/peekaboo789/nasphere:1.0.4
docker compose up -d
```

`ghcr.io` 上目前只发布了 linux/amd64 一份 manifest，ARM 机型（群晖多数是 arm64/v8）在线拉会报 `no matching manifest for linux/arm64/v8`——按 `uname -m` 挑 `linux-arm64` 那份离线包，上面那两行 `docker load` / `docker tag` 照做即可。多架构镜像推上来之后这条限制就没了。

这条路线和 `./deploy.sh` 二选一：两边都对外占 `18086`，后起的那个会报 `port is already allocated`（`deploy.sh` 在安装目录里生成的是它自己那份 compose）。切换前先停掉另一边——脚本起的容器现在叫 `nasphere-nasphere-1`，用 `cd ./dat && docker compose down` 收尾。

---

# 🐳 Docker Run

先拉镜像（想自己从源码 build 就换成 `docker build -t ghcr.io/peekaboo789/nasphere:1.0.4 .`）：

```bash
docker pull ghcr.io/peekaboo789/nasphere:1.0.4
```

然后：

```bash
docker run -d \
  --name nasphere \
  --restart unless-stopped \
  -p 18086:18086 \
  -e NAV_USER='admin' \
  -e NAV_PASSWORD='你自己的密码' \
  -v "$(pwd)/data:/app/data" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  ghcr.io/peekaboo789/nasphere:1.0.4
```

`-e NAV_PASSWORD` 只在 `data/auth.json` 还不存在时生效，是唯一能在首次启动前定下非默认密码的口子——compose 和 `deploy.sh` 那两条路线都不带它。

其中：

```text
18086:18086
```

表示：

```text
NAS 宿主机 18086 → NASphere 容器 18086
```

容器内部固定监听 `18086`（镜像里 `ENV PORT=18086`），冒号右边那一位不要跟着改。

数据卷那一位同理：镜像里 `ENV DATA_DIR=/app/data`，宿主机目录挂到 `/app/data` 才会被读到。

主页要逐卷列出用量时，`deploy.sh` 会自己探这台 NAS 的存储池、给每一卷写一行只读挂载；手工 `docker run` 就自己加一行（口径见下面 📊 NAS 资源组件）：

```text
-v /volume2:/host/volume2:ro
```

---

# 📦 离线部署

NAS 到 `ghcr.io` 不通（或者机型是 ARM，那边暂时只有 amd64 那份 manifest）时，在另一台机器上做出镜像包传过去：

```bash
./make-image.sh
```

生成：

```text
dist/nasphere-<版本>.tar.gz
dist/nasphere-<版本>.sha256
```

电脑上连 Docker 都没有就用 `node make-image-offline.js`，它自己去镜像仓库匿名拉基础层拼包，amd64 / arm64 各出一份。

将镜像包传到 NAS 后：

```bash
./deploy.sh --tar dist/nasphere-1.0.4-linux-amd64.tar.gz
```

脚本会：

```text
加载镜像
 ↓
按包里的 RepoTags 重新标记成 compose 要用的那个名字
 ↓
备份 data
 ↓
生成 docker-compose.yml
 ↓
docker compose up -d
 ↓
健康检查
```

`--tar` 这条完全跳过了 `docker pull`，所以 ARM 机型就用它（包挑 `linux-arm64` 那份），名字对不上脚本自动 `docker tag`。

---

# ✨ 功能

## 🔎 搜索

内置：

* 百度
* Google
* Bing
* DuckDuckGo
* 搜狗

支持：

* 增加自定义搜索引擎
* 删除搜索引擎
* `{query}` 参数
* 输入网址直接访问
* 浏览器记住当前搜索引擎

例如：

```text
https://www.google.com/search?q={query}
```

---

# 🖼️ 图标

支持五种图标来源：

* Emoji
* 网站 favicon
* 图片 URL
* 上传图片
* 首字母

上传支持 png / jpeg / gif / webp / avif / svg / ico，单张不超过 5MB。

favicon 获取失败时自动使用首字母。

网址应用默认不绘制传统卡片边框：

> 图标就是视觉主体。

分组面板负责提供整体玻璃层次，避免主页被大量小卡片切割。

---

# 🎨 外观

支持：

* 深色
* 浅色
* 自动
* 自定义强调色
* 图标大小
* 字体大小
* 卡片行距
* 图标左右布局
* 壁纸
* 壁纸模糊
* 壁纸压暗
* 壁纸填充方式

内置渐变：

```text
midnight
graphite
dusk
aurora
ocean
forest
sunset
grape
slate
paper
```

默认：

```text
主题：dark
强调色：#7c8cff
壁纸：midnight
```

---

# 🖼️ 壁纸

支持：

* 内置渐变
* 图片 URL
* 上传到 NAS
* 必应每日壁纸
* 无壁纸

支持：

```text
cover
stretch
contain
```

以及：

```text
模糊 0–30px
压暗 0–90%
```

登录页面会自动使用主页当前壁纸。

如果使用必应每日壁纸：

* NAS 负责获取和缓存
* 浏览器无需直接访问必应
* 登录页只使用 NAS 已缓存的壁纸地址

---

# 🖱️ 卡片拖拽

网址应用不需要先进入编辑模式。

鼠标：

```text
按住约 0.5 秒
↓
拖动
↓
松开
```

即可重新排序。

拖到其他分组时：

```text
原分组
   ↓
拖动
   ↓
目标分组
```

应用会直接进入目标分组。

触摸设备同样支持长按拖动。

---

# 📦 Docker 容器组件

NASphere 可以将 Docker 容器直接显示在主页。

每个组件拥有独立：

```text
x
y
w
h
```

支持自由摆放。

显示：

```text
容器名称
运行状态
镜像
CPU
内存
上传速度
下载速度
```

默认每 3 秒刷新一次。

停止的容器不会持续读取 stats。

---

# ⚙️ Docker 容器操作

主页右键容器组件可以：

```text
打开
复制链接
启动容器
停止容器
重启容器
移除组件
```

只允许操作：

```text
data/config.json
```

中明确加入 `docker.items` 的容器。

允许动作只有：

```text
start
stop
restart
```

不提供：

```text
docker rm
docker exec
docker inspect
```

等高权限操作接口。

---

# 📊 NAS 资源组件

主页还可以摆 NAS 自己的读数卡，共四种：

```text
NAS 总览
内存
单个存储空间
自定义读数
```

在：

```text
设置 → 应用矩阵 → NAS 资源
```

里点一下就往主页上加一张，摆放、叠放、宽高和容器组件完全是同一套操作。「自定义读数」能加好几张，
勾哪几行就画哪几行，新加的默认给内存 / CPU / 网络三行。

名字和图标随便改，读数本身改不了：「应用矩阵」那一栏每张读数卡右边的 ✎ 打开就是这两件事。图标留空
就用这张卡自带的那枚描边图形，也可以换成 Emoji 或者上传一张图片。

显示：

```text
内存：已用 / 总量 / 百分比
CPU：占用百分比 + 核心数 + 1 分钟负载
网络：下行 / 上行速率
GPU：占用百分比（读不到就在同一行写明为什么读不到）
存储空间：已用 / 总量 / 百分比
物理盘：型号 + 容量（一块都没认出来时，写的是卡在哪一步）
```

默认每 5 秒刷新一次，切到后台的标签页不刷。CPU 占用和网络速率都是拿累计计数作差算出来的，
所以服务起来之后的第一轮写着「刚开始采样」，第二轮才有数字。

用量条在两档变色：

```text
80%  琥珀
90%  红
```

## 只报数字，不读内容

服务端取数只有这几个来源：

```text
/proc/meminfo   → 内存两个计数
/proc/stat      → CPU 的累计 ticks
/proc/loadavg   → 1 / 5 / 15 分钟负载
/proc/net/dev   → 每块网卡的收发字节
/sys/class/drm  → 显卡占用：先看 gpu_busy_percent，再看每个引擎的 busy_percent（i915 只写后者）
/sys/block      → 盘的设备名、型号、总容量
statfs()        → 某个目录所在文件系统的块数
```

回环、`docker0` 和一对端的 `veth` 不计入网络流量，`loop` / `ram` / `zram` / `md` 这类包出来的设备也不报成硬盘。
认盘靠的是这一份排除名单，不是猜盘名前缀：`/sys/block` 下面每一项都是符号链接，各家机器的盘名也差得远。
这些来源给的都是计数器，接口返回的字段全是数字与型号，页面不会列出一个文件名，也没有挂载点路径。

## 卡片上那几句「读不到」是什么意思

```text
刚开始采样 — CPU 占用与网络速率都是作差算的，第二轮起才有数字
读不到 GPU 占用（驱动 … · 频率 …） — 这块卡的驱动不写百分比，括号里给的是驱动名和当前 / 峰值频率
这台机器上没有 /sys/block — 容器里看不见宿主机的 sysfs
/sys/block 里没有可用的盘 — sysfs 看得见，排除掉虚拟设备之后没剩下一块报容量的盘
查不到这块硬盘 — 配置里点名的那块盘不在这份名单里，换盘、拔盘都会这样
查不到这个卷（没挂进容器就读不到） — deploy.sh 生成的只读挂载里没有这一卷
```

## 卷怎么列出来

`deploy.sh` 每次部署都探一遍这台 NAS 上的存储池（`/vol1`、`/volume1`、`/storage1`、`/mnt/*` 这几种摆法），
探到的每一卷自动写一行只读挂载进它生成的 compose：

```text
/volume1:/host/volume1:ro
```

于是主页看得见这台机器上的每一卷，卡片认的名字就是 `/host` 下面那一层的目录名。同一块文件系统只报一次：
数据目录正躺在某一卷里面时，列出来的是那一卷的名字，不再另出一张「数据盘」。

不想让它自动探，就在 `.env` 里点名单：

```text
HOST_VOLUMES=/volume1 /volume2
```

只要数据目录那一卷、别的都别挂进来：

```text
HOST_VOLUMES=none
```

NAS 上新增或删除卷之后要重跑一次 `./deploy.sh`，「NAS 资源」那一列才会跟着多一行或少一行。
手工 compose 路线自己加那一行 `:ro` 挂载就行。

卡片上点名的那一卷要是没挂进来，卡片会整张压暗并写着「查不到这个卷」，配置不用动。

⚠️ 注意边界：挂载点一旦给进容器，容器进程技术上就能读那一卷的文件内容，哪怕页面只显示数字。
逐卷用量换的是这个代价，不接受就写 `HOST_VOLUMES=none`。

---

# ⚠️ Docker Socket 安全说明

如果挂载：

```text
/var/run/docker.sock
```

NASphere 容器实际上拥有很高的 Docker 控制权限。

Docker Socket 本身可以间接获得宿主机级别控制能力。

因此：

* 不建议直接暴露 NASphere 到公网
* 建议只允许可信用户登录
* 公网访问建议再增加反向代理认证
* 如果不需要 Docker 容器组件，可以不挂载 Docker Socket

不挂载 Socket：

```text
NASphere 主页
      ↓
正常使用
```

只是：

```text
Docker 组件
      ↓
Docker 不可用
```

不会影响搜索、图标、壁纸、分组等其他功能。

---

# 📂 分组

分组支持：

* 新建
* 删除
* 修改名称
* 修改图标
* 调整顺序
* 固定内网
* 固定外网

分组标题：

```text
20px
```

固定大小，不跟随卡片字体设置变化。

点击分组名称即可折叠 / 展开。

---

# 🌐 内网 / 外网

每个网址应用可以设置：

```text
外网网址
内网网址
```

例如：

```json
{
  "title": "NAS",
  "url": "https://nas.example.com",
  "urlLan": "http://192.168.8.99:5000"
}
```

右上角可以切换：

```text
内网
外网
```

分组还可以固定：

```json
"netMode": "lan"
```

或者：

```json
"netMode": "wan"
```

固定后的分组不会受到全局开关影响。

取址规则：

```text
两条都填　→ 内网用内网网址，外网用外网网址
只填一条　→ 两种模式都用这一条
两条都没填 → 卡片变灰，点了不跳转
```

所以内网工具只填内网地址、外部站点只填外网地址就够了，切换模式不会把卡片切到点不动的状态。

---

# 📱 手机浏览器

NASphere 不需要单独的移动端页面。

手机浏览器直接访问：

```text
http://<NAS-IP>:18086
```

即可。

自动适配：

* 手机
* 平板
* 桌面
* 触摸屏
* 窄屏

移动端自动：

* 调整卡片布局
* 合并便签 / 待办
* 调整设置窗口高度
* 放大触摸按钮
* 禁止拖动 Docker 组件坐标
* 适配 iPhone 输入框
* 适配刘海与底部安全区域

---

# 🧩 小组件

默认开启：

* 时钟
* 天气

可选：

* 便签
* 待办

天气使用：

```text
Open-Meteo
```

无需 API Key。

可以搜索城市并设置天气位置。

---

# 💾 数据

NASphere 的运行数据全部位于：

```text
data/
```

目录。

主要包括：

```text
data/
├── config.json
├── auth.json
├── .secret
├── .deploy-backup/
└── uploads/
```

因此：

> **备份整个 `data/` 目录，就等于备份整个 NASphere。**

---

# 📝 直接编辑配置

可以直接编辑：

```text
data/config.json
```

例如：

```json
{
  "groups": [
    {
      "name": "NAS 服务",
      "icon": "🗄️",
      "links": [
        {
          "title": "Jellyfin",
          "url": "https://media.example.com",
          "urlLan": "http://192.168.8.99:8096",
          "icon": "🎬"
        }
      ]
    }
  ]
}
```

支持字段别名：

```text
title / name / label
url / href / link
urlLan / lanUrl / url_lan
icon / emoji / img
desc / note
```

缺少协议时自动补：

```text
http://
```

主页上的组件都写在 `docker.items` 里，数组顺序就是叠放顺序，两种卡片混在同一个数组：

```json
{
  "docker": {
    "items": [
      {
        "title": "qBittorrent",
        "container": "qbittorrent",
        "w": 250,
        "h": 118,
        "x": 10,
        "y": 10
      },
      {
        "title": "内存",
        "icon": "🧮",
        "iconKind": "emoji",
        "res": "mem",
        "w": 250,
        "h": 118,
        "x": 330,
        "y": 10
      },
      {
        "title": "volume2",
        "res": "vol",
        "vol": "volume2",
        "w": 250,
        "h": 118,
        "x": 650,
        "y": 10
      },
      {
        "title": "NAS 总览",
        "res": "overview",
        "w": 320,
        "h": 240,
        "x": 10,
        "y": 200
      },
      {
        "title": "自定义读数",
        "res": "custom",
        "rows": [
          "mem",
          "cpu",
          "net",
          "vol:volume2"
        ],
        "w": 300,
        "h": 156,
        "x": 350,
        "y": 200
      }
    ]
  }
}
```

带 `container` 的是容器组件，带 `res` 的是读数卡（`mem` / `vol` / `overview` / `custom`），两者都没有的就是废条目，读取时直接丢掉。`vol` 写的是 `/host` 下的目录名，也就是「NAS 资源」那一栏里列出来的名字。

`custom` 那张的 `rows` 就是勾了哪几行，按勾的顺序从上往下画：

```text
mem      cpu      net      gpu      vols      disks
vol:<卷名>        disk:<盘名>
```

`vols` / `disks` 是「每个卷一行」「每块盘一行」，跟点名的 `vol:` / `disk:` 同时勾会把那一卷画两遍，所以设置里的勾选框会把冲突的那格先按住。认不得的键、重复的键都会在保存时丢掉；一行都没勾，卡上就写着「还没勾选要显示哪一行」。

---

# 🔧 配置限制

服务端会自动进行校验。

主要限制：

```text
分组：120
每组链接：300
Docker 组件：60
搜索引擎：40
待办：300
```

字符串限制：

```text
分组名称：60 字
标题：200 字
备注：200 字
便签：20000 字
网址：2000 字
```

Docker 组件：

```text
宽度：120–900px
高度：64–600px
X：0–4000
Y：0–4000
自定义读数的行：40
```

非法网址协议，例如：

```text
javascript:
```

会被拒绝。

---

# 🔐 安全

NASphere 使用：

* scrypt 密码哈希
* HMAC 会话 Cookie
* 登录失败限流
* CSP
* 上传类型白名单
* 上传大小限制
* 统一登录失败提示

密码不会以明文保存。

`auth.json` 中保存的是：

```text
scrypt hash
```

而不是原始密码。

登录接口不会区分：

```text
账号不存在
```

和：

```text
密码错误
```

统一返回：

```text
账号或密码不正确
```

---

# 💾 备份与迁移

最简单的方法：

```bash
cp -a data /你的备份位置/
```

迁移到另一台 NAS：

```text
NASphere
+
data/
```

即可。

如果使用上传图片，还需要保留：

```text
data/uploads/
```

否则上传的图标和壁纸会丢失。

---

# 🔄 自动备份

每次执行：

```bash
./deploy.sh
```

都会自动备份：

```text
data/config.json
data/auth.json
```

备份位置：

```text
data/.deploy-backup/
```

默认保留最近：

```text
5
```

份。

可以通过：

```env
KEEP_BACKUPS=10
```

修改数量。

---

# 🧹 恢复初始配置

「设置 → 数据」提供：

```text
清空为初始配置
```

会清除：

* 分组
* 应用
* Docker 组件
* 便签
* 待办

同时恢复：

* 默认外观
* 默认搜索引擎
* 默认天气设置

**操作不可撤销。**

建议先：

```text
导出配置 JSON
```

或者备份：

```text
data/
```

---

# ⌨️ 快捷键

| 快捷键        | 功能          |
| ---------- | ----------- |
| `/`        | 聚焦搜索        |
| `Ctrl + K` | 聚焦搜索        |
| `Cmd + K`  | 聚焦搜索        |
| `E`        | 编辑模式        |
| `,`        | 打开设置        |
| `Esc`      | 关闭弹窗 / 取消操作 |

---

# 📁 项目结构

```text
NASphere/
├── Dockerfile
├── DEPLOY.md
├── README.md
├── docker-compose.yml
├── deploy.sh
├── make-image.sh
├── make-image-offline.js
├── .env.example
├── package.json
├── server/
│   └── index.js
├── public/
│   ├── index.html
│   ├── img/
│   │   ├── logo.png
│   │   └── favicon.png
│   ├── css/
│   │   └── styles.css
│   └── js/
│       ├── store.js
│       ├── widgets.js
│       └── app.js
└── data/
    ├── config.json
    ├── auth.json
    ├── .secret
    ├── .deploy-backup/
    └── uploads/
```

`./deploy.sh` 装出来的目录不是这个结构，它不需要源码，里面只有：

```text
dat/
├── docker-compose.yml      # 每次部署由脚本按参数重写
└── data/                   # 你的全部状态
```

脚本不往那儿写自己：下次升级重跑那条 `curl … | bash`（它认得这个目录），或者把 `deploy.sh` 自己放进去 `cd` 进去跑。

---

# 🛠️ 环境变量

## NASphere 服务

| 变量             | 默认值                           | 说明            |
| -------------- | ----------------------------- | ------------- |
| `PORT`         | `18086`                       | 容器内服务监听端口（对外端口用 `HOST_PORT`，默认 18086） |
| `HOST`         | `0.0.0.0`                     | 监听地址          |
| `DATA_DIR`     | `/app/data`                   | 数据目录（镜像里 `ENV DATA_DIR`，宿主机的 `./data` 要挂到这个点） |
| `NAV_USER`     | `admin`                       | 首次初始化账号       |
| `NAV_PASSWORD` | `admin123`                    | 首次初始化密码（`deploy.sh` 和仓库那份 compose 都不注入它，只有 `docker run -e` 那条路线能带） |
| `SESSION_DAYS` | `30`                          | 登录有效期         |
| `MAX_BODY`     | `8388608`                     | 请求体上限         |
| `DOCKER_HOST`  | `unix:///var/run/docker.sock` | Docker API 地址 |
| `NAV_SYS_ROOT` | `/`                         | 自测用：把 `/proc`、`/sys`、`/host` 的读取前缀指到别处，正常部署不用配 |

## deploy.sh

下面这些只有 `deploy.sh` 读（手工 `docker compose up -d` 不读，仓库那份 `docker-compose.yml` 里是写死的值）：

| 变量              | 默认值                        | 说明            |
| --------------- | -------------------------- | ------------- |
| `INSTALL_ROOT`  | `./dat`                    | 安装目录（相对当前目录），等价于 `--root` |
| `IMAGE`         | `ghcr.io/peekaboo789/nasphere` | 镜像仓库，换 fork 或内网仓库就改它 |
| `TAG`           | `1.0.4`                    | 镜像标签（脚本里写死的默认值，不读 package.json） |
| `HOST_PORT`     | `18086`                    | NAS 宿主机端口     |
| `DATA_DIR`      | `<安装目录>/data`              | 宿主侧数据目录      |
| `TZ`            | `Asia/Shanghai`            | 写进 compose 的容器时区 |
| `HOST_VOLUMES`  | 空（自动探）                 | 留空时 `deploy.sh` 自动探这台 NAS 的存储池，每一卷各挂成 `/host/<同名>:ro`；写空格分隔的目录就是点名单，`none` 是只挂数据目录、别探 |
| `COMPOSE_PROJECT` | `nasphere`                | compose 项目名，容器叫 `<项目名>-nasphere-1` |
| `HEALTH_WAIT`   | `40`                       | 健康检查等待秒数      |
| `KEEP_BACKUPS`  | `5`                        | `data/.deploy-backup/` 保留几份 |
| `DOCKER_SOCK`   | `/var/run/docker.sock`     | 挂进容器的 Docker Socket，找不到就不挂 |

`.env` 只在安装目录里那份生效（`<安装目录>/.env`，不是执行命令时的当前目录），生效顺序：

```text
命令行 > 环境变量 > .env > 默认值
```

`deploy.sh` 不再碰账号密码：`NAV_USER` / `NAV_PASSWORD` / `SESSION_DAYS` / `MAX_BODY` 都不由它注入，要改就走服务端的环境变量（`docker run -e` 或自己编辑生成出来的 compose）或页面里的「设置 → 安全」。

---

# 🚀 deploy.sh 参数

```bash
./deploy.sh --port 9000
```

修改宿主端口。

```bash
./deploy.sh --root /volume1/docker/NASphere
```

指定安装目录，目录里没有就建，已经有 `data/` 就算原地升级。

```bash
./deploy.sh --data-dir /volume1/docker/nasphere/data
```

修改数据目录。

```bash
./deploy.sh --tag 1.2.0
```

指定镜像版本，也就是拉 `ghcr.io/peekaboo789/nasphere:1.2.0`。

```bash
./deploy.sh --dry-run
```

只显示操作，不执行。

```bash
./deploy.sh --tar dist/nasphere-1.2.0-linux-arm64.tar.gz
```

使用离线镜像，跳过 `docker pull`。

```bash
./deploy.sh --uninstall
```

删掉本项目的容器和镜像，`data/` 会原样保留。

```bash
./deploy.sh --help
```

看完整参数、环境变量和默认值。

---

# 🧪 本地开发

本地 Node.js：

```text
Node.js >= 18
```

启动：

```bash
DATA_DIR=./data PORT=18080 node server/index.js
```

访问：

```text
http://127.0.0.1:18080
```

检查代码：

```bash
npm run check
```

不需要：

```bash
npm install
```

---

# 🐳 自己构建镜像

正常路线不需要这一节：镜像已经在 `ghcr.io/peekaboo789/nasphere` 上，`deploy.sh` 和 compose 都是直接拉。只有改了 `server/` 或 `public/` 想跑自己的那份时才自己 build。

NASphere 使用：

```dockerfile
node:22-alpine
```

项目本身没有第三方 npm 运行依赖。

如果 Docker Hub 无法访问，可以提前准备基础镜像，例如：

```bash
docker pull docker.m.daocloud.io/library/node:22-alpine
```

然后：

```bash
docker tag docker.m.daocloud.io/library/node:22-alpine node:22-alpine
```

再执行：

```bash
docker build -t nasphere-dev .
```

起来的就是 `nasphere-dev`，跟 §部署 那几条路线互不影响。

---

# 🌐 反向代理

NASphere 本身不内置 HTTPS。

如果需要：

```text
https://nas.example.com
```

建议使用：

```text
Nginx
Caddy
Traefik
```

等反向代理提供 TLS。

例如：

```text
浏览器
  ↓
HTTPS :443
  ↓
反向代理
  ↓
NASphere :18086
```

NASphere 静态资源和 API 都使用根路径：

```text
/
├── css/
├── js/
├── img/
└── api/
```

因此反向代理建议将整个站点转发到：

```text
http://127.0.0.1:18086/
```

而不是只代理：

```text
/nav/
```

---

# ⚠️ 已知边界

### Docker Socket

挂载：

```text
/var/run/docker.sock
```

意味着 NASphere 容器拥有很高的 Docker 控制权限。

因此：

**不要直接把 NASphere 暴露到公网。**

如果不需要 Docker 组件，可以不挂载 Docker Socket。

---

### 天气

天气使用：

```text
Open-Meteo
```

需要浏览器所在网络可以访问相关服务。

天气不可用时不会影响 NASphere 其他功能。

---

### Google

Google 搜索是否可用取决于 NAS 所在网络的出口环境。

---

### 多人同时编辑

NASphere 当前是：

```text
单实例
```

设计。

如果多个用户同时修改配置，后保存的修改可能覆盖先保存的修改。

家庭 NAS 场景下一般只建议少量可信用户使用。

---

# 🆕 更新日志

## v1.0.4

修复：真机上「硬盘读不到」和「核显读不到」这两件事。

```text
硬盘　　→ /sys/block 下面每一项都是符号链接，之前按目录类型去认，一块盘都剩不下；现在只认名字，认盘改成排除名单（loop / ram / zram / sr / md / dm- 这些不算盘），各家那些对不上的盘名（sdX、nvmeXnY、mmcblkX、群晖的 sata1）都进得来
核显　　→ 以前只读 amdgpu 才写的那一个百分比；现在先看 gpu_busy_percent，再退到每个引擎的 busy_percent 取最大值（i915 只写这一份），两处都没有才算读不到
```

读数卡上的「读不到」现在都带原因，写在同一行：括号里给驱动名和当前 / 峰值频率，硬盘那一行给的是卡在哪一步（看不见 sysfs、还是排除之后没剩盘）。详见「📊 NAS 资源组件」里那几句「读不到」的对照表。

新增：读数卡的名字和图标可以改了，读数本身照旧不能改。「应用矩阵」那一栏每张读数卡右边的 ✎ 打开只有名称和图标两件事，图标留空就用这张卡自带的那枚描边图形，也能换成 Emoji 或上传图片。

## v1.0.3

新增：读数卡多了三种读数，并且可以自己挑要哪几行。

```text
CPU　　→ 占用百分比 + 核心数 + 1 分钟负载
网络　　→ 下行 / 上行速率
GPU　　 → 占用百分比（驱动没写这一项就直说读不到）
```

原来那三种是固定内容，现在多一张「自定义读数」：勾哪几行就画哪几行，内存 / CPU / 网络 / GPU / 每个卷 / 每块盘随便组合，想摆几张摆几张。

```text
NAS 总览　　　→ 内存 + 每个卷 + 每块物理盘
内存　　　　　→ 单独一张内存用量卡
单个存储空间　→ 一个卷一张卡
自定义读数　　→ 自己勾出来的行
```

卷也不再只有数据盘那一卷：`deploy.sh` 每次部署自动探这台 NAS 的存储池，探到的每一卷各写一行只读挂载，主页因此能列出全部卷和硬盘。

```text
HOST_VOLUMES 留空　　→ 自动探测（默认）
HOST_VOLUMES 写目录　→ 只挂点名的那几卷
HOST_VOLUMES=none　　→ 只挂数据目录，不探测
```

NAS 上新增或删除卷之后，重跑一次 `./deploy.sh` 就会跟着更新。边界照旧：页面只报容量数字，接口里没有挂载点路径也没有文件名；但卷挂进容器之后，容器进程技术上就能读那一卷的内容，不接受这个代价就写 `none`。

改动：主页的容器卡片不再显示运行状态后面那行镜像名小字；「应用矩阵」那一栏改成按宽度自动排的网格。

详见「📊 NAS 资源组件」。

## v1.0.2

新增：主页上多了三类 NAS 资源读数卡，在「应用矩阵」那一栏点一下就加。

```text
NAS 总览　→ 内存 + 每个卷 + 每块物理盘，一张卡看完
内存　　　 → 单独一张内存用量卡
存储空间　 → 一个卷一张卡，几个卷就能摆几张
```

每张卡 5 秒刷一轮，用量过 80% 数字和容量条转琥珀、过 90% 转红；坐标、长宽和容器组件一样，在主页上长按半秒拖到任意位置。

只报容量，不读内容：内存取 `/proc/meminfo`，物理盘只取型号和容量，卷用量走 `statfs`。接口里没有挂载点路径，也没有文件名，任何时候都不会去翻卷里的东西。

默认只看得见数据目录所在的那一卷；要逐卷显示，就给那一卷加一行只读挂载（`deploy.sh` 用 `HOST_VOLUMES` 生成），页面会自动多出对应的卡。详见「📊 NAS 资源组件」。

## v1.0.1

修复：应用程序只填内网或者外网网址时，内外网都使用这个网址访问。

旧版要一个应用把两条网址都填全，只填一条的卡片切到另一种模式就变灰、点了不跳转。

现在只填一条就够：

```text
内网工具　→ 只填内网网址
外部站点　→ 只填外网网址
```

两种模式下都走这一条，卡片照常新窗口打开。

两条网址都填的应用仍然严格分开，切换模式各走各的；分组固定的 `netMode` 也没有变。规则详见「🌐 内网 / 外网」。

## v1.0.0

首个公开版本：

* 一条命令安装：自动检测架构、生成 compose、拉取 GHCR 镜像、启动并探活
* 零外部依赖：不需要 `npm install`，不需要前端构建
* 自定义图标与壁纸、多引擎搜索、分组卡片长按拖拽
* Docker 容器组件：状态查看与启动 / 停止 / 重启
* 天气、时钟、便签与待办
* 账号密码门禁，配置与图片全部留在 NAS 本地
* 手机浏览器适配

---

# 📜 License

NASphere 使用：

```text
MIT License
```

作者：

**peekaboo789**

---

<div align="center">

**NASphere**

自托管 · 本地化 · 可定制 · 面向 NAS

© 2026 peekaboo789 · NASphere

</div>
