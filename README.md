<div align="center">

<img src="public/img/logo.png" alt="NASphere" width="180">

# NASphere

**自托管 NAS 主页 / 导航面板**

自定义图标与壁纸 · 多引擎搜索 · 分组卡片拖拽 · Docker 容器组件 · 账号密码门禁 · 手机浏览器适配

**零外部依赖：后端仅使用 Node.js 标准库，前端使用原生 HTML / CSS / JavaScript。**

无需 `npm install`，无需前端构建，无需数据库。

所有配置、账号信息和上传图片均保存在 NAS 本地，不依赖第三方账号或云服务。

**作者：peekaboo789**

</div>

---

## ✨ 亮点

* **一条命令安装**

  * 支持 GitHub 一键安装
  * 默认使用 GitHub 加速地址获取项目
  * 自动下载源码、构建镜像、启动容器、健康检查
  * 升级与重装不覆盖 `data/`，首装随机生成初始密码
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
下载 NASphere 源码
      ↓
检查 Docker
      ↓
构建 NASphere 镜像
      ↓
创建 / 更新容器
      ↓
健康检查
      ↓
输出访问地址
```

默认：

```text
项目目录：/vol2/1000/dockers/NASphere
容器名称：nasphere
宿主端口：18086
数据目录：./data
```

换安装目录或端口（管道执行必须带 `bash -s --` 才传得进参数）：

```bash
curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/peekaboo789/NASphere/main/deploy.sh | \
  bash -s -- --root /volume1/docker/NASphere --port 9000
```

首次安装如果没有指定密码，会随机生成一个，只打印一次，并留档在项目目录的 `.env`。

同一个目录再执行一次就是原地升级：`data/` 和 `.env` 原样保留，壁纸、图标、配置、账号都不会丢。

安装完成后访问：

```text
http://<NAS-IP>:18086
```

例如：

```text
http://192.168.8.99:18086
```

> 如果你的 NAS Docker 无法正常拉取 `node:22-alpine`，请先解决 Docker 镜像源问题，或者使用下面的离线镜像方式。

---

## 方式二：docker compose部署

services:
  nasphere:
    image: ghcr.io/peekaboo789/nasphere:1.0.0
    container_name: nasphere

    restart: unless-stopped

    ports:
      - "18086:18086"

    volumes:
      - ./data:/app/data
      - /var/run/docker.sock:/var/run/docker.sock

    environment:
      TZ: Asia/Shanghai



# 🔐 首次登录

用 `deploy.sh` 一键安装、且没有预先指定密码时，初始密码随机生成：

```text
用户名：admin
密码　：<admin123>
```





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

---

# 🛠️ 环境变量

## NASphere 服务

| 变量             | 默认值                           | 说明            |
| -------------- | ----------------------------- | ------------- |
| `PORT`         | `18086`                       | 容器内服务监听端口（对外端口用 `HOST_PORT`，默认 18086） |
| `HOST`         | `0.0.0.0`                     | 监听地址          |
| `DATA_DIR`     | `/data`                       | 数据目录          |
| `NAV_USER`     | `admin`                       | 首次初始化账号       |
| `NAV_PASSWORD` | `admin123`                    | 首次初始化密码，`deploy.sh` 首装会随机生成并写进 `.env` |
| `SESSION_DAYS` | `30`                          | 登录有效期         |
| `MAX_BODY`     | `8388608`                     | 请求体上限         |
| `DOCKER_HOST`  | `unix:///var/run/docker.sock` | Docker API 地址 |

## deploy.sh / Compose

| 变量             | 默认值                    | 说明            |
| -------------- | ---------------------- | ------------- |
| `HOST_PORT`    | `18086`                | NAS 宿主机端口     |
| `IMAGE`        | `local/nasphere`       | Docker 镜像     |
| `TAG`          | package.json version   | 镜像标签          |
| `CONTAINER`    | `nasphere`             | 容器名称          |
| `DATA_DIR`     | `./data`               | NASphere 数据目录 |
| `HEALTH_WAIT`  | `40`                   | 健康检查等待时间      |
| `KEEP_BACKUPS` | `5`                    | 保留备份数量        |
| `DOCKER_SOCK`  | `/var/run/docker.sock` | Docker Socket |
| `INSTALL_ROOT` | `/vol2/1000/dockers/NASphere` | 一键安装时源码装到哪里，等价于 `--root` |
| `GITHUB_REPO`  | `https://github.com/peekaboo789/NASphere.git` | 源码地址，用自己的 fork 就改它 |
| `GITHUB_PROXY` | `https://gh-proxy.com` | GitHub 加速前缀，留空则只走直连 |
| `BRANCH`       | `main`                 | 拉取的分支         |

`deploy.sh` 还会读 `NAV_USER`、`NAV_PASSWORD`、`SESSION_DAYS`、`MAX_BODY`、`TZ`，生效顺序：

```text
命令行 > 环境变量 > .env > 默认值
```

---

# 🚀 deploy.sh 参数

```bash
./deploy.sh --port 9000
```

修改宿主端口。

```bash
./deploy.sh --update
```

从 GitHub 拉最新源码后重新部署。

```bash
./deploy.sh --root /volume1/docker/NASphere
```

一键安装时指定源码装到哪里。

```bash
./deploy.sh --data-dir /volume1/docker/nasphere/data
```

修改数据目录。

```bash
./deploy.sh --tag 1.2.0
```

指定镜像版本。

```bash
./deploy.sh --dry-run
```

只显示操作，不执行。

```bash
./deploy.sh --tar dist/nasphere-1.2.0.tar.gz
```

使用离线镜像。

```bash
./deploy.sh --source /tmp/NASphere-src.tar.gz
```

使用本地源码包安装，跳过 GitHub。

```bash
./deploy.sh --uninstall
```

删除容器和镜像，`data/` 会原样保留。

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

# 🐳 Docker 基础镜像

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
docker build -t local/nasphere:latest .
```

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
