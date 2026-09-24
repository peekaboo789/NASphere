# NASphere

> 🚀 一个轻量、现代、可自托管的 NAS / Docker 首页导航面板
> 支持自定义应用、图标、壁纸、搜索引擎以及 Docker 容器管理。

**作者：peekaboo789**

GitHub：

https://github.com/peekaboo789/NASphere

---

## ✨ 项目特点

NASphere 专为 NAS、家庭服务器和 Docker 环境设计。

### 🎨 个性化首页

* 自定义壁纸
* 自定义应用图标
* 自定义应用名称
* 自定义应用地址
* 自定义应用排序
* 自定义首页布局

### 🔎 搜索

支持自定义搜索引擎，可以根据自己的使用习惯设置：

* 百度
* Bing
* Google
* 必应
* 自定义搜索地址

### 🐳 Docker

NASphere 可以连接宿主机 Docker Socket，用于显示 Docker 项目信息。

例如：

* 项目名称
* 容器数量
* 运行状态
* 创建时间
* 项目路径

因此可以直接在 NAS 首页查看 Docker 项目状态。

### 💾 数据持久化

所有 NASphere 数据保存到：

```text
./data
```

删除容器不会删除数据。

重新部署后继续挂载 `./data` 即可恢复配置。

---

# 🚀 一、推荐部署方式

NASphere 支持通过单个 Docker Compose 文件完成部署。

用户不需要：

* Git Clone
* 下载源码
* 下载压缩包
* 手动安装 Node.js
* 手动安装 Git
* 手动构建 Dockerfile

只需要：

```text
docker-compose.yml
```

然后执行一条命令。

---

# 📦 二、创建部署目录

在 NAS 上创建目录：

```bash
mkdir -p /vol2/1000/dockers/NASphere
cd /vol2/1000/dockers/NASphere
```

---

# 📝 三、创建 docker-compose.yml

创建：

```bash
nano docker-compose.yml
```

粘贴以下完整内容：

```yaml
services:
  nasphere:
    build:
      context: .
      dockerfile_inline: |
        FROM m.daocloud.io/docker.io/library/node:22-alpine

        RUN apk add --no-cache git

        WORKDIR /app

        RUN git clone --depth 1 \
            https://gh-proxy.com/https://github.com/peekaboo789/NASphere.git \
            /tmp/nasphere \
            && cp -a /tmp/nasphere/server /app/server \
            && cp -a /tmp/nasphere/public /app/public \
            && cp /tmp/nasphere/package.json /app/package.json \
            && rm -rf /tmp/nasphere

        ENV NODE_ENV=production
        ENV PORT=8080
        ENV DATA_DIR=/data

        RUN mkdir -p /data \
            && chmod 700 /data \
            && npm install --omit=dev

        EXPOSE 8080

        HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
          CMD node -e "require('http').get('http://127.0.0.1:8080/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

        CMD ["node", "server/index.js"]

    container_name: nasphere

    restart: unless-stopped
    init: true

    # Docker Socket 所属 GID
    group_add:
      - "994"

    ports:
      - "8080:8080"

    environment:
      TZ: Asia/Shanghai

      # NASphere 登录账号
      NAV_USER: admin
      NAV_PASSWORD: admin123

      SESSION_DAYS: "30"
      MAX_BODY: "8388608"

      # Docker API
      DOCKER_HOST: unix:///var/run/docker.sock

    volumes:
      # NASphere 数据
      - ./data:/data

      # Docker API
      - /var/run/docker.sock:/var/run/docker.sock

    # 强制本地构建，不拉取 nasphere 镜像
    pull_policy: build
```

保存：

```text
Ctrl + O
Enter
Ctrl + X
```

---

# ▶️ 四、一条命令启动

在 `docker-compose.yml` 所在目录执行：

```bash
docker compose up -d --build
```

第一次部署会自动完成：

```text
Docker Compose
     │
     ▼
读取内嵌 Dockerfile
     │
     ▼
DaoCloud 获取 Node 22 Alpine
     │
     ▼
安装 Git
     │
     ▼
gh-proxy.com
     │
     ▼
GitHub / peekaboo789 / NASphere
     │
     ▼
下载最新 NASphere 源码
     │
     ▼
构建 Docker 镜像
     │
     ▼
创建 nasphere 容器
     │
     ▼
启动 NASphere
```

---

# 🌐 五、访问 NASphere

部署成功以后：

```text
http://你的NAS_IP:8080
```

例如：

```text
http://192.168.8.99:8080
```

默认账号：

```text
admin
```

默认密码：

```text
admin123
```

第一次登录以后建议立即修改密码。

---

# 🐳 六、Docker 项目显示

NASphere 使用：

```text
/var/run/docker.sock
```

连接宿主机 Docker。

Compose 中已经配置：

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
```

并加入：

```yaml
group_add:
  - "994"
```

这是针对 Docker Socket 所属 GID 为 `994` 的环境。

可以通过：

```bash
ls -l /var/run/docker.sock
```

查看：

```text
root 994
```

如果你的 NAS 上 Docker Socket GID 不是 `994`，需要修改：

```yaml
group_add:
  - "你的Docker Socket GID"
```

例如：

```yaml
group_add:
  - "999"
```

---

# ⚠️ 七、Docker Socket 安全说明

NASphere 使用 Docker Socket 是为了读取 Docker 项目和容器状态。

但是：

```text
/var/run/docker.sock
```

属于高权限接口。

因此不要把 NASphere 直接暴露到公网。

推荐：

```text
互联网
   │
   ▼
Cloudflare / 反向代理
   │
   ▼
NASphere
   │
   ▼
Docker Socket
```

如果只是家庭 LAN 使用，可以直接：

```text
192.168.x.x:8080
```

---

# 🔄 八、更新 NASphere

由于源码是在构建阶段通过 GitHub 获取，因此更新非常简单。

进入目录：

```bash
cd /vol2/1000/dockers/NASphere
```

然后：

```bash
docker compose build --no-cache
docker compose up -d
```

或者直接：

```bash
docker compose up -d --build
```

如果需要确保重新从 GitHub 获取最新代码，可以使用：

```bash
docker compose build --no-cache
docker compose up -d
```

---

# 🛑 九、停止 NASphere

```bash
docker compose down
```

这不会删除：

```text
./data
```

所以 NASphere 的数据仍然保留。

---

# ▶️ 十、重新启动

```bash
docker compose up -d
```

---

# 🗑️ 十一、彻底删除 NASphere

删除容器：

```bash
docker compose down
```

删除构建出来的镜像：

```bash
docker image rm nasphere-nasphere
```

如果还需要删除数据：

```bash
rm -rf ./data
```

⚠️ 删除 `./data` 会清除 NASphere 保存的数据。

---

# 🔍 十二、检查运行状态

查看容器：

```bash
docker ps -a --filter name=nasphere
```

正常应该看到：

```text
Up ...
```

查看日志：

```bash
docker logs --tail 100 nasphere
```

实时查看：

```bash
docker logs -f nasphere
```

---

# ❤️ 十三、健康检查

NASphere 提供：

```text
/api/health
```

可以测试：

```bash
curl http://127.0.0.1:8080/api/health
```

如果服务正常，应返回 HTTP 200。

也可以：

```bash
docker inspect nasphere --format '{{.State.Health.Status}}'
```

正常情况下：

```text
healthy
```

---

# 🧪 十四、Docker Socket 测试

如果 NASphere 页面显示：

```text
连不上 Docker（unix:///var/run/docker.sock）
```

首先检查：

```bash
ls -l /var/run/docker.sock
```

例如：

```text
srw-rw---- 1 root 994 /var/run/docker.sock
```

然后检查容器：

```bash
docker exec nasphere sh -c 'ls -l /var/run/docker.sock'
```

如果能看到：

```text
srw-rw---- 0 root 994 /var/run/docker.sock
```

说明 Socket 已经正确挂载。

再测试：

```bash
docker exec nasphere sh -c 'node -e "const fs=require(\"fs\"); try { fs.accessSync(\"/var/run/docker.sock\", fs.constants.R_OK|fs.constants.W_OK); console.log(\"Docker Socket OK\") } catch(e) { console.error(e.message); process.exit(1) }"'
```

正常输出：

```text
Docker Socket OK
```

---

# 🛠️ 十五、修改端口

默认：

```yaml
ports:
  - "8080:8080"
```

如果 8080 已经被占用，可以改成：

```yaml
ports:
  - "5666:8080"
```

那么访问：

```text
http://192.168.8.99:5666
```

容器内部仍然使用：

```text
8080
```

---

# 🔐 十六、修改登录密码

修改：

```yaml
environment:
  NAV_USER: admin
  NAV_PASSWORD: admin123
```

例如：

```yaml
environment:
  NAV_USER: admin
  NAV_PASSWORD: YourStrongPassword
```

修改以后需要重新创建容器：

```bash
docker compose up -d --build
```

---

# 💾 十七、数据目录

默认：

```yaml
volumes:
  - ./data:/data
```

也就是说：

```text
NASphere/
├── docker-compose.yml
└── data/
```

NASphere 的持久化数据保存在：

```text
/vol2/1000/dockers/NASphere/data
```

这样即使删除：

```text
nasphere
```

容器重新创建以后数据仍然存在。

---

# 🌏 十八、为什么使用 gh-proxy

NASphere 的源码仓库：

```text
https://github.com/peekaboo789/NASphere
```

构建时使用：

```text
https://gh-proxy.com/https://github.com/peekaboo789/NASphere.git
```

因此用户不需要提前：

```bash
git clone
```

也不需要手动下载源码。

源码始终以 GitHub 仓库为准。

---

# 📦 十九、为什么使用 DaoCloud Node 镜像

基础镜像：

```text
m.daocloud.io/docker.io/library/node:22-alpine
```

用于获取：

```text
Node.js 22
Alpine Linux
```

这样可以避开部分 Docker Hub 镜像访问问题。

如果你的 Docker 环境可以正常访问 Docker Hub，也可以将：

```dockerfile
FROM m.daocloud.io/docker.io/library/node:22-alpine
```

修改为：

```dockerfile
FROM node:22-alpine
```

---

# 🧩 二十、整个项目的部署结构

最终结构：

```text
NAS
│
├── /vol2/1000/dockers/NASphere
│   │
│   ├── docker-compose.yml
│   │
│   └── data
│
└── Docker
     │
     ├── nasphere
     │
     ├── moviepilot
     ├── openclaw
     ├── cc-our-story
     ├── qb
     ├── transmission
     └── ...
```

NASphere 通过：

```text
Docker Socket
```

读取：

```text
Docker
  ↓
Compose 项目
  ↓
容器
  ↓
运行状态
```

---

# 🚀 二十一、最简部署

如果已经准备好：

```text
docker-compose.yml
```

那么以后用户只需要：

```bash
docker compose up -d --build
```

即可。

访问：

```text
http://NAS-IP:8080
```

---

# 📌 二十二、注意事项

### 1. Docker Compose 版本

这个方案使用：

```yaml
dockerfile_inline:
```

需要较新的 Docker Compose。

建议：

```bash
docker compose version
```

确认版本。

### 2. Docker Socket

如果 Docker Socket 的 GID 与：

```yaml
group_add:
  - "994"
```

不同，需要修改。

### 3. 网络

构建过程中需要访问：

```text
m.daocloud.io
```

以及：

```text
gh-proxy.com
```

如果其中一个无法访问，Docker 构建会失败。

### 4. 数据

不要随意删除：

```text
./data
```

否则 NASphere 保存的配置可能丢失。

### 5. 公网访问

不建议直接把：

```text
8080
```

暴露到公网。

NASphere 使用 Docker Socket，应该尽量限制访问范围。

---

# 📄 License

MIT License

Copyright (c) peekaboo789

---

# 👤 Author

**peekaboo789**

NASphere —— 为 NAS 打造一个简单、漂亮、自由可控的首页。

```

这份说明可以直接作为 **`DEPLOY.md`** 或 README 的部署章节使用。

另外有一点我建议你注意：**现在这份 YAML 已经在你的 NAS 上实际验证过核心构建链路**，但 `group_add: 994` 是针对你这台 NAS 的环境值，不适合原样写死给所有用户。正式发布 NASphere 时，最好把它改成**自动读取宿主机 Docker Socket GID**的部署方式，否则别人的 NAS 可能出现同样的 Docker Socket 权限问题。