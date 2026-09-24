#!/usr/bin/env bash
# NASphere 一键部署 / 升级 / 回滚。在项目根目录执行：./deploy.sh
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$PWD"

if [ ! -f Dockerfile ] || [ ! -f server/index.js ]; then
  printf '\033[31m✕\033[0m 请在项目根目录执行本脚本（没找到 Dockerfile / server/index.js）\n' >&2
  exit 1
fi

# .env 只提供默认值，命令行参数优先级更高
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

IMAGE="${IMAGE:-local/nasphere}"
CONTAINER="${CONTAINER:-nasphere}"
HOST_PORT="${HOST_PORT:-8080}"
DATA_DIR="${DATA_DIR:-$ROOT/data}"
HEALTH_WAIT="${HEALTH_WAIT:-40}"
KEEP_BACKUPS="${KEEP_BACKUPS:-5}"
DOCKER_SOCK="${DOCKER_SOCK:-/var/run/docker.sock}"
TAG="${TAG:-$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' package.json 2>/dev/null | head -n 1 || true)}"
TAG="${TAG:-latest}"

TAR=""
DRY=0
COMPOSE=""
SUDO=""

usage() {
  cat <<'EOF'
用法：./deploy.sh [选项]

  --tar <文件>      加载 docker save / make-image.sh 导出的镜像包，跳过本地构建
  --tag <标签>      镜像标签，默认取 package.json 里的 version
  --port <端口>     宿主机端口，默认 8080
  --data-dir <路径>  数据目录，默认项目下的 ./data
  --dry-run         只打印将执行的命令，不动任何东西
  -h, --help        显示本帮助

同名环境变量（IMAGE / CONTAINER / HOST_PORT / DATA_DIR / TAG / HEALTH_WAIT / KEEP_BACKUPS / DOCKER_SOCK）
也可写进 .env。首次部署的初始账号与密码取 .env 的 NAV_USER / NAV_PASSWORD（都不设则为
admin / admin123）；data/auth.json 生成后，改账号或密码只能在页面「设置 → 安全」里改，
这两个变量不再起作用。DOCKER_SOCK 是挂给容器用的 Docker 套接字路径（默认
/var/run/docker.sock），主页 Docker 窗口里的容器组件靠它读实时数据和启停容器。
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --tar) TAR="${2:?--tar 后面要跟文件路径}"; shift 2 ;;
    --tag) TAG="${2:?--tag 后面要跟标签}"; shift 2 ;;
    --port) HOST_PORT="${2:?--port 后面要跟端口}"; shift 2 ;;
    --data-dir) DATA_DIR="${2:?--data-dir 后面要跟路径}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf '\033[31m✕\033[0m 未知参数：%s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

log() { printf '\033[36m›\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m✕\033[0m %s\n' "$*" >&2; exit 1; }

run() {
  if [ "$DRY" = 1 ]; then
    local shown
    shown="$(printf '%s\n' "$*" | sed -E 's/(NAV_PASSWORD=)[^ ]*/\1***/')"
    printf '  [dry-run] %s\n' "$shown"
    return 0
  fi
  "$@"
}

docker() {
  if [ -n "$SUDO" ]; then
    $SUDO docker "$@"
  else
    command docker "$@"
  fi
}

# ---------- 前置检查 ----------

[ -n "$(type -P docker)" ] || die "这台机器上没有 docker，用不了本脚本（不装 Docker 也可以按 README 的「本地开发调试」一节直接跑 node server/index.js）"

if ! docker version >/dev/null 2>&1; then
  if [ "$(id -u)" = 0 ]; then
    die "连不上 docker 守护进程，先确认 Docker / Container Manager 套件已启动"
  fi
  [ -n "$(type -P sudo)" ] || die "当前用户无权访问 docker，且没有 sudo 可用"
  SUDO="sudo"
  docker version >/dev/null 2>&1 || die "sudo docker 仍然连不上守护进程"
  warn "当前用户不在 docker 组，后续命令都带 sudo"
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif [ -n "$(type -P docker-compose)" ]; then
  COMPOSE="docker-compose"
fi

case "$DATA_DIR" in
  /*) ;;
  *) DATA_DIR="$PWD/$DATA_DIR" ;;
esac

NEW_REF="$IMAGE:$TAG"
log "镜像 $NEW_REF ｜容器 $CONTAINER｜端口 $HOST_PORT→8080｜数据 $DATA_DIR"
if [ -n "$COMPOSE" ]; then
  log "部署方式：$COMPOSE"
else
  log "部署方式：docker run（没检测到 compose）"
fi

# ---------- 备份配置 ----------

backup_data() {
  if [ ! -f "$DATA_DIR/config.json" ]; then
    log "没有已有配置，跳过备份"
    return 0
  fi
  local stamp="$DATA_DIR/.deploy-backup/$(date +%Y%m%d-%H%M%S)"
  run mkdir -p "$stamp"
  local f
  for f in config.json auth.json; do
    if [ -f "$DATA_DIR/$f" ]; then
      run cp -p "$DATA_DIR/$f" "$stamp/$f"
    fi
  done
  log "已备份 config.json / auth.json → $stamp（保留最近 $KEEP_BACKUPS 份）"
  if [ "$DRY" = 0 ] && [ -d "$DATA_DIR/.deploy-backup" ]; then
    ls -1dt "$DATA_DIR/.deploy-backup"/*/ 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | while read -r old; do
      rm -rf "${old%/}"
    done || true
  fi
}

# ---------- 记下旧镜像，供回滚 ----------

PREV_ID=""
if [ "$DRY" = 0 ]; then
  PREV_ID="$(docker inspect -f '{{.Image}}' "$CONTAINER" 2>/dev/null || true)"
  if [ -n "$PREV_ID" ]; then
    docker tag "$PREV_ID" "$IMAGE:rollback" 2>/dev/null || true
    log "当前镜像 ${PREV_ID:0:12} 已记下，探活失败会自动回滚到它"
  fi
fi

# ---------- 出镜像 ----------

if [ -n "$TAR" ]; then
  [ -f "$TAR" ] || die "找不到镜像包：$TAR"
  log "从 $TAR 加载镜像"
  # 解开成临时文件再 load，省掉管道与 sudo 的引号麻烦
  case "$TAR" in
    *.gz)
      if [ "$DRY" = 1 ]; then
        printf '  [dry-run] gunzip -c %s > <tmp> && docker load -i <tmp>\n' "$TAR"
      else
        tmp="$(mktemp "${TMPDIR:-/tmp}/nasphere-XXXXXX.tar")"
        gunzip -c "$TAR" > "$tmp"
        run docker load -i "$tmp"
        rm -f "$tmp"
      fi
      ;;
    *) run docker load -i "$TAR" ;;
  esac
  if [ "$DRY" = 0 ]; then
    case "$TAR" in
      *.gz) inner="$(gunzip -c "$TAR" | tar -xO manifest.json 2>/dev/null || true)" ;;
      *) inner="$(tar -xO -f "$TAR" manifest.json 2>/dev/null || true)" ;;
    esac
    loaded="$(printf '%s' "$inner" | sed -n 's/.*"RepoTags":\[\("[^"]*"\).*/\1/p' | tr -d '"' | head -n 1 || true)"
    if [ -n "$loaded" ] && [ "$loaded" != "$NEW_REF" ]; then
      docker tag "$loaded" "$NEW_REF"
      log "镜像包里的 $loaded 已重标为 $NEW_REF"
    fi
  fi
else
  log "构建镜像（首次要拉 node:22-alpine，约 1–2 分钟）"
  run docker build -t "$NEW_REF" -t "$IMAGE:latest" .
fi

if [ "$DRY" = 0 ]; then
  docker image inspect "$NEW_REF" >/dev/null 2>&1 || die "镜像 $NEW_REF 不存在，构建或加载没成功"
fi

# ---------- 起容器 ----------

up_with() {
  local ref="$1"
  if [ -n "$COMPOSE" ]; then
    IMAGE="${ref%:*}"
    TAG="${ref##*:}"
    export IMAGE TAG CONTAINER HOST_PORT DATA_DIR
    run $COMPOSE up -d --remove-orphans
  else
    run docker rm -f "$CONTAINER" || true
    # Docker 窗口要能连上 dockerd；没这个套接字（或宿主上没装 Docker）就不挂，页面只会显示「Docker 不可用」
    local sock=()
    if [ -S "$DOCKER_SOCK" ]; then
      sock=(-e DOCKER_HOST="unix://$DOCKER_SOCK" -v "$DOCKER_SOCK:$DOCKER_SOCK")
    else
      warn "找不到 Docker 套接字 $DOCKER_SOCK，这次不挂它：容器组件会显示「Docker 不可用」，其余功能照常"
    fi
    run docker run -d --name "$CONTAINER" --restart unless-stopped --init \
      -p "$HOST_PORT:8080" \
      -e NAV_USER="${NAV_USER:-admin}" \
      -e NAV_PASSWORD="${NAV_PASSWORD:-admin123}" \
      -e SESSION_DAYS="${SESSION_DAYS:-30}" \
      -e MAX_BODY="${MAX_BODY:-8388608}" \
      -e TZ="${TZ:-Asia/Shanghai}" \
      -v "$DATA_DIR:/data" \
      ${sock[@]+"${sock[@]}"} \
      "$ref"
  fi
}

run mkdir -p "$DATA_DIR"
backup_data
log "启动容器"
up_with "$NEW_REF"

# ---------- 探活 ----------

# busybox 的 hostname 不一定支持 -I，取不到就退回 127.0.0.1
lan_ip() {
  local v
  v="$(hostname -I 2>/dev/null || true)"
  [ -n "$v" ] || v="$(hostname -i 2>/dev/null || true)"
  set -- $v
  printf '%s' "${1:-127.0.0.1}"
}

probe() {
  local url="http://127.0.0.1:$HOST_PORT/api/health"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS -m 3 -o /dev/null "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 3 -O /dev/null "$url"
  else
    docker exec "$CONTAINER" node -e \
      "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
  fi
}

if [ "$DRY" = 1 ]; then
  log "dry-run 结束，什么都没改动"
  exit 0
fi

log "等待服务就绪（最多 ${HEALTH_WAIT}s）"
ok=0
n=0
while [ "$n" -lt "$HEALTH_WAIT" ]; do
  if probe 2>/dev/null; then
    ok=1
    break
  fi
  sleep 1
  n=$((n + 1))
done

if [ "$ok" = 1 ]; then
  printf '\033[32m✓\033[0m 部署完成：http://%s:%s\n' "$(lan_ip)" "$HOST_PORT"
  docker ps --filter "name=$CONTAINER" --format '  {{.Status}} ｜ {{.Image}}' 2>/dev/null || true
  if [ ! -f "$DATA_DIR/auth.json" ]; then
    warn "这次是首次启动，登录账号/密码已初始化成 .env 里的 NAV_USER / NAV_PASSWORD（没设则为 admin / admin123），登录后立刻改掉"
  fi
  exit 0
fi

warn "探活失败，容器最后 20 行日志："
docker logs --tail 20 "$CONTAINER" 2>&1 | sed 's/^/  /' || true

if [ -n "$PREV_ID" ]; then
  warn "回滚到旧镜像 ${PREV_ID:0:12}"
  docker tag "$PREV_ID" "$NEW_REF" 2>/dev/null || true
  up_with "$NEW_REF"
  sleep 3
  if probe 2>/dev/null; then
    printf '\033[32m✓\033[0m 已回滚，旧版本还能用；新版本请查上面的日志\n'
    die "部署失败（已回滚到旧版本）"
  fi
fi

die "部署失败，回滚后仍不可用。数据在 $DATA_DIR，手动 docker logs $CONTAINER 排查"
