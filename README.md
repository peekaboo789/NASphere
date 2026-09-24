# NASphere

<p align="center">
  <strong>一个简洁、现代、自由可定制的 NAS / Docker 导航首页</strong>
</p>

<p align="center">

自定义壁纸 · 应用管理 · Docker 项目 · 多引擎搜索 · 数据持久化

</p>

<p align="center">

<strong>作者：peekaboo789</strong>

</p>

---

## 🖥️ NASphere

NASphere 是一个面向 NAS、家庭服务器和 Docker 环境打造的自托管导航首页。

你可以把 NASphere 作为自己的 NAS 门户首页，集中管理：

* 📦 Docker 项目
* 🚀 常用应用
* 🔎 搜索引擎
* 🖼️ 壁纸
* 🎨 首页外观
* 🧩 自定义小组件
* ⚙️ 个性化配置

NASphere 不依赖第三方云服务，核心数据保存在自己的 NAS / 服务器上。

---

## ✨ 功能特点

### 🎨 自定义外观

支持自由调整首页外观：

* 自定义壁纸
* 自定义应用图标
* 自定义应用名称
* 自定义应用地址
* 自定义应用排序
* 自定义首页布局
* 自定义显示内容

打造属于自己的 NAS 首页。

---

### 📦 Docker 项目管理

NASphere 可以连接宿主机 Docker Socket，读取 Docker 环境中的项目和容器信息。

首页可以展示：

* Docker 项目名称
* 容器数量
* 运行状态
* 创建时间
* 项目路径

例如：

```text
moviepilot
正在运行容器：3

openclaw
正在运行容器：1

qb
正在运行容器：1

transmission
正在运行容器：1
```

这样打开 NASphere 首页，就可以快速了解 NAS 当前 Docker 环境。

> Docker Socket 属于高权限接口，请仅在可信的局域网或受控环境中部署。

---

### 🔎 多搜索引擎

支持自定义搜索引擎。

可以根据自己的使用习惯配置：

* Google
* Bing
* 百度
* 必应
* DuckDuckGo
* 其他自定义搜索服务

---

### 🖼️ 壁纸

支持自定义首页背景，让 NASphere 不只是一个工具页面，也可以作为自己的 NAS 桌面。

---

### 💾 数据持久化

NASphere 使用 Docker Volume / Bind Mount 保存数据。

默认：

```text
./data
```

例如：

```text
NASphere/
├── compose.yaml
└── data/
```

删除容器、重新创建容器或者更新镜像，都不会自动删除 `./data` 中的数据。

---

# 🚀 快速部署

## 方法一：Docker Compose

NASphere 推荐使用 Docker Compose 部署。

你只需要：

```text
compose.yaml
```

不需要：

* Git Clone
* 下载 NASphere 源码
* 下载 ZIP
* 下载 `.tar.gz`
* 手动安装 Node.js
* 手动安装 Git
* 手动编写 Dockerfile

### 1. 创建目录

```bash
mkdir -p NASphere
cd NASphere
```

### 2. 创建 Compose 文件

创建：

```text
compose.yaml
```

将项目提供的 Compose 配置复制进去。

### 3. 启动

```bash
docker compose up -d --build
```

Compose 会自动：

```text
读取 Compose
      ↓
创建 Docker 构建环境
      ↓
获取 Node.js 基础镜像
      ↓
安装 Git
      ↓
通过 gh-proxy 获取 NASphere
      ↓
构建 NASphere 镜像
      ↓
创建容器
      ↓
启动 NASphere
```

---

# 🌐 访问 NASphere

默认端口：

```text
8080
```

浏览器访问：

```text
http://你的NAS-IP:8080
```

例如：

```text
http://192.168.1.100:8080
```

实际访问地址请根据自己的 NAS IP 修改。

---

# 🔐 默认登录信息

默认用户名：

```text
admin
```

默认密码：

```text
admin123
```

**首次登录后建议立即修改密码。**

如果 Compose 文件中提供了环境变量，可以修改：

```yaml
environment:
  NAV_USER: admin
  NAV_PASSWORD: your-strong-password
```

---

# 📁 数据目录

NASphere 默认使用：

```text
./data
```

完整结构：

```text
NASphere/
├── compose.yaml
└── data/
```

这里使用相对路径，是为了让部署文件具有更好的可移植性。

例如用户可以把整个目录放在：

```text
/volume1/docker/NASphere
```

也可以放在：

```text
/volume2/docker/NASphere
```

或者：

```text
/data/docker/NASphere
```

NASphere 本身不要求固定的宿主机路径。

---

# 🔄 更新 NASphere

NASphere 源码在构建时从 GitHub 获取。

更新时进入 Compose 所在目录：

```bash
cd NASphere
```

执行：

```bash
docker compose up -d --build
```

如果希望完全重新获取最新源码并重新构建：

```bash
docker compose build --no-cache
docker compose up -d
```

Docker Compose 官方支持通过 `docker compose build` 构建或重新构建服务。

---

# 🛑 停止 NASphere

```bash
docker compose down
```

这不会自动删除：

```text
./data
```

因此重新启动：

```bash
docker compose up -d
```

即可恢复服务。

---

# 🗑️ 卸载 NASphere

删除容器和网络：

```bash
docker compose down
```

如果还需要删除构建出来的镜像，可以根据实际镜像名称删除。

如果需要彻底删除 NASphere 数据：

```bash
rm -rf ./data
```

> ⚠️ 删除 `./data` 会同时删除 NASphere 保存的数据，请确认后再执行。

---

# 🐳 Docker Socket

如果需要使用 Docker 项目展示功能，Compose 中需要挂载：

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
```

同时 NASphere 容器需要具备访问 Docker Socket 的权限。

Docker Socket 通常类似：

```text
srw-rw---- root docker /var/run/docker.sock
```

不同 NAS、不同 Docker 安装方式的 Socket GID 可能不同。

---

## Docker Socket GID

查看宿主机 Docker Socket：

```bash
ls -ln /var/run/docker.sock
```

例如：

```text
srw-rw---- 1 0 994 0 ... /var/run/docker.sock
```

其中：

```text
994
```

就是 Docker Socket 的 GID。

如果 Compose 中使用：

```yaml
group_add:
  - "994"
```

那么：

**994 只是示例值，不代表所有 NAS 都是 994。**

如果你的 NAS 显示其他 GID，例如：

```text
999
```

则需要修改为：

```yaml
group_add:
  - "999"
```

---

# ⚠️ Docker Socket 安全说明

NASphere 使用：

```text
/var/run/docker.sock
```

是为了读取 Docker 项目和容器信息。

Docker Socket 本身属于高权限接口。

因此建议：

* 仅在可信局域网使用
* 不要直接暴露 Docker Socket
* 不要将 NASphere 无保护地开放到公网
* 使用反向代理时配置访问控制
* 使用强密码
* 定期更新 NASphere

如果 NASphere 仅用于家庭 NAS 局域网环境，可以直接通过：

```text
http://NAS-IP:8080
```

访问。

---

# 🌏 GitHub 加速

NASphere 的源码仓库：

```text
https://github.com/peekaboo789/NASphere
```

当前单 YAML 部署方案在构建过程中通过：

```text
gh-proxy.com
```

获取 GitHub 源码。

例如：

```text
https://gh-proxy.com/https://github.com/peekaboo789/NASphere.git
```

因此用户无需提前下载 NASphere 源码。

---

# 🇨🇳 国内 Docker 镜像加速

当前 Compose 使用：

```text
m.daocloud.io/docker.io/library/node:22-alpine
```

作为 Node.js 基础镜像。

这样可以减少部分环境访问 Docker Hub 时遇到的网络问题。

如果你的环境可以正常访问 Docker Hub，也可以将：

```dockerfile
FROM m.daocloud.io/docker.io/library/node:22-alpine
```

改成：

```dockerfile
FROM node:22-alpine
```

> 注意：国内镜像代理属于外部网络服务，未来可用性可能发生变化。如果该服务不可用，可以更换为自己环境中可访问的 Node.js 镜像源。

---

# 📋 系统要求

建议：

* Docker
* Docker Compose v2
* Linux NAS / Linux Server
* x86_64 或其他 Docker 支持的平台

当前 Compose 使用：

```yaml
dockerfile_inline:
```

该功能要求 Docker Compose **2.17.0 或更高版本**。

检查版本：

```bash
docker compose version
```

例如：

```text
Docker Compose version v2.x.x
```

Docker Compose 使用当前的 Compose Specification，旧版 2.x / 3.x 格式已经统一到 Compose Specification。

---

# 🔧 常用命令

## 查看容器

```bash
docker ps -a --filter name=nasphere
```

## 查看日志

```bash
docker logs nasphere
```

实时查看：

```bash
docker logs -f nasphere
```

## 重启

```bash
docker compose restart
```

## 停止

```bash
docker compose down
```

## 启动

```bash
docker compose up -d
```

## 重新构建

```bash
docker compose up -d --build
```

## 无缓存重新构建

```bash
docker compose build --no-cache
docker compose up -d
```

---

# 🩺 故障排查

## 1. 页面无法打开

首先检查：

```bash
docker ps -a --filter name=nasphere
```

如果没有运行：

```bash
docker logs nasphere
```

查看具体错误。

---

## 2. 显示无法连接 Docker

如果 NASphere 显示：

```text
连不上 Docker（unix:///var/run/docker.sock）
```

检查：

```bash
ls -ln /var/run/docker.sock
```

然后检查容器：

```bash
docker exec nasphere ls -l /var/run/docker.sock
```

如果 Socket 存在但无法访问，重点检查 Compose 中：

```yaml
group_add:
  - "Docker Socket GID"
```

是否与宿主机实际 GID 一致。

---

## 3. 构建失败

查看：

```bash
docker compose build
```

重点检查：

```text
gh-proxy.com
```

和：

```text
m.daocloud.io
```

是否能够正常访问。

如果 GitHub 加速服务暂时不可用，可以直接测试：

```bash
curl -I https://gh-proxy.com
```

---

## 4. 端口被占用

如果：

```text
8080
```

已经被其他服务使用，可以修改：

```yaml
ports:
  - "8080:8080"
```

例如：

```yaml
ports:
  - "5666:8080"
```

然后访问：

```text
http://NAS-IP:5666
```

---

# 🏗️ 项目结构

NASphere 项目主要结构：

```text
NASphere/
├── public/
│   ├── css/
│   ├── img/
│   ├── js/
│   └── index.html
│
├── server/
│   └── index.js
│
├── Dockerfile
├── docker-compose.yml
├── deploy.sh
├── package.json
└── README.md
```

---

# 🛠️ 开发

克隆项目：

```bash
git clone https://github.com/peekaboo789/NASphere.git
cd NASphere
```

检查 Node.js：

```bash
node --version
```

检查代码：

```bash
npm run check
```

启动：

```bash
npm start
```

---

# 📦 Docker 构建

项目也提供标准 Dockerfile。

直接构建：

```bash
docker build -t nasphere:latest .
```

启动：

```bash
docker run -d \
  --name nasphere \
  -p 8080:8080 \
  -v ./data:/data \
  -v /var/run/docker.sock:/var/run/docker.sock \
  nasphere:latest
```

---

# 🤝 参与贡献

欢迎提交：

* Bug
* 功能建议
* UI 改进
* Docker 部署优化
* NAS 兼容性反馈
* 新功能

欢迎提交 Pull Request。

---

# 📄 License

MIT License

---

# 👤 Author

**peekaboo789**

GitHub：

https://github.com/peekaboo789/NASphere

---

<p align="center">

<strong>NASphere</strong>

<br>

让 NAS 首页更简单、更漂亮、更自由。

</p>
```

### 我检查后的结论

**这版作为 GitHub README 比之前合适。**尤其是把存储目录统一成：

```text
./data
```

这一点是对的。用户把 Compose 放在哪里，数据就跟着放在哪里，不再绑定你的 `/vol2/1000/dockers/NASphere`。

不过我建议你**正式发布前再改一个东西**：`group_add: "994"`。

你现在这台 NAS 确实是 `994`，但它不是通用值。README 已经明确告诉用户要检查 GID，但如果目标是做到真正的**“下载一个 YAML → 一条命令 → 大多数 NAS 直接成功”**，后面最好把这个权限处理进一步自动化。

另外，`dockerfile_inline` 本身是官方 Compose 功能，不是我们自己“碰巧能跑”的写法；官方文档明确要求 Compose 2.17.0+。

**还有一个很重要的发布建议：**README 里我保留了 DaoCloud 和 `gh-proxy.com`，但把它们明确写成“当前加速方案”，而不是 NASphere 的硬性依赖。这样以后你换镜像源/代理，不需要重新设计项目定位。
