```bash
#!/usr/bin/env bash
# NASphere 一键安装 / 部署 / 升级 / 回滚 / 卸载
#
# 全新安装：
#   curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/peekaboo789/NASphere/main/deploy.sh | bash
#
# 已有项目：
#   cd /vol2/1000/dockers/NASphere
#   ./deploy.sh
#
# 更新：
#   ./deploy.sh --update
#
# 卸载：
#   ./deploy.sh --uninstall
#
set -euo pipefail

# ============================================================
# 基础配置
# ============================================================

PROJECT_NAME="NASphere"
GITHUB_REPO="https://github.com/peekaboo789/NASphere.git"
GITHUB_RAW="https://raw.githubusercontent.com/peekaboo789/NASphere/main"
GITHUB_PROXY="https://gh-proxy.com"

DEFAULT_ROOT="/vol2/1000/dockers/NASphere"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR"

# 当脚本通过 curl | bash 执行时：
# SCRIPT_DIR 通常不是 NASphere 项目目录
REMOTE_INSTALL=0

if [ ! -f "$ROOT/Dockerfile" ] || [ ! -f "$ROOT/server/index.js" ]; then
  REMOTE_INSTALL=1
fi

# ============================================================
# 彩色输出
# ============================================================

log() {
  printf '\033[36m›\033[0m %s\n' "$*"
}

success() {
  printf '\033[32m✓\033[0m %s\n' "$*"
}

warn() {
  printf '\033[33m!\033[0m %s\n' "$*" >&2
}

die() {
  printf '\033[31m✕\033[0m %s\n' "$*" >&2
  exit 1
}

# ============================================================
# 参数
# ============================================================

TAR=""
DRY=0
UPDATE=0
UNINSTALL=0
TAG=""
HOST_PORT=""
DATA_DIR=""
IMAGE=""
CONTAINER=""
HEALTH_WAIT=""
KEEP_BACKUPS=""
DOCKER_SOCK=""

usage() {
  cat <<'EOF'

NASphere 一键部署工具

用法：

  全新安装：
    curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/peekaboo789/NASphere/main/deploy.sh | bash

  已有项目：
    ./deploy.sh

  更新：
    ./deploy.sh --update

  离线镜像：
    ./deploy.sh --tar nasphere.tar

选项：

  --update             从 GitHub 拉取最新版并重新部署
  --tar <文件>         加载 docker save 导出的镜像包，跳过构建
  --tag <标签>         镜像标签，默认使用 package.json version
  --port <端口>        宿主机端口，默认 8080
  --data-dir <路径>    数据目录，默认 ./data
  --dry-run             只显示操作，不执行
  --uninstall           删除 NASphere 容器和镜像，但保留数据
  -h, --help            显示帮助

环境变量：

  IMAGE
  CONTAINER
  HOST_PORT
  DATA_DIR
  TAG
  HEALTH_WAIT
  KEEP_BACKUPS
  DOCKER_SOCK
  NAV_USER
  NAV_PASSWORD
  SESSION_DAYS
  MAX_BODY
  TZ

默认：

  项目目录：
    /vol2/1000/dockers/NASphere

  容器：
    nasphere

  端口：
    8080

  数据：
    /vol2/1000/dockers/NASphere/data

注意：

  NASphere 的 Docker Socket 具有较高宿主机权限。
  只有可信用户才应该使用 Docker 管理功能。

EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --update)
      UPDATE=1
      shift
      ;;
    --tar)
      TAR="${2:?--tar 后面需要跟文件路径}"
      shift 2
      ;;
    --tag)
      TAG="${2:?--tag 后面需要跟标签}"
      shift 2
      ;;
    --port)
      HOST_PORT="${2:?--port 后面需要跟端口}"
      shift 2
      ;;
    --data-dir)
      DATA_DIR="${2:?--data-dir 后面需要跟路径}"
      shift 2
      ;;
    --dry-run)
      DRY=1
      shift
      ;;
    --uninstall)
      UNINSTALL=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "未知参数：$1"
      ;;
  esac
done

# ============================================================
# sudo / Docker
# ============================================================

SUDO=""

docker_cmd() {
  if [ -n "$SUDO" ]; then
    sudo docker "$@"
  else
    command docker "$@"
  fi
}

run() {
  if [ "$DRY" = 1 ]; then
    printf '  [dry-run] '
    printf '%q ' "$@"
    printf '\n'
    return 0
  fi

  "$@"
}

# ============================================================
# 检查 Docker
# ============================================================

check_docker() {

  command -v docker >/dev/null 2>&1 || \
    die "没有检测到 Docker，请先安装并启动 Docker / Container Manager"

  if docker version >/dev/null 2>&1; then
    return 0
  fi

  if [ "$(id -u)" = "0" ]; then
    die "Docker 守护进程无法连接，请确认 Docker 已启动"
  fi

  command -v sudo >/dev/null 2>&1 || \
    die "当前用户无法访问 Docker，且系统没有 sudo"

  SUDO="sudo"

  docker_cmd version >/dev/null 2>&1 || \
    die "sudo docker 仍然无法连接 Docker"

  warn "当前用户不在 docker 组，后续 Docker 命令将使用 sudo"
}

check_docker

# ============================================================
# Git
# ============================================================

check_git() {
  command -v git >/dev/null 2>&1 || \
    die "没有检测到 git，请先安装 git"
}

# ============================================================
# Compose
# ============================================================

COMPOSE=""

if docker_cmd compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
fi

# ============================================================
# 全新安装：下载 GitHub 项目
# ============================================================

install_from_github() {

  check_git

  local parent
  parent="$(dirname "$DEFAULT_ROOT")"

  mkdir -p "$parent"

  if [ -d "$DEFAULT_ROOT/.git" ]; then

    log "检测到已有 NASphere Git 仓库"

    cd "$DEFAULT_ROOT"

    log "更新 GitHub 仓库"

    if git remote -v >/dev/null 2>&1; then
      git remote set-url origin "$GITHUB_REPO" 2>/dev/null || true
    fi

    if ! git pull --ff-only origin main; then

      warn "直接 GitHub 拉取失败，尝试通过国内代理重新获取"

      cd "$parent"

      local backup_dir
      backup_dir="${DEFAULT_ROOT}.backup-$(date +%Y%m%d-%H%M%S)"

      mv "$DEFAULT_ROOT" "$backup_dir"

      git clone \
        "${GITHUB_PROXY}/${GITHUB_REPO}" \
        "$DEFAULT_ROOT" || {
          rm -rf "$DEFAULT_ROOT"
          mv "$backup_dir" "$DEFAULT_ROOT"
          die "GitHub 下载失败，请检查网络或代理"
        }

      log "原项目已保留在：$backup_dir"
    fi

  elif [ -d "$DEFAULT_ROOT" ] && [ -n "$(find "$DEFAULT_ROOT" -mindepth 1 -maxdepth 1 2>/dev/null | head -n 1)" ]; then

    warn "发现已有 NASphere 目录，但不是 Git 仓库"

    local backup_dir
    backup_dir="${DEFAULT_ROOT}.backup-$(date +%Y%m%d-%H%M%S)"

    mv "$DEFAULT_ROOT" "$backup_dir"

    log "旧目录已备份：$backup_dir"

    git clone \
      "${GITHUB_PROXY}/${GITHUB_REPO}" \
      "$DEFAULT_ROOT" || {
        rm -rf "$DEFAULT_ROOT"
        mv "$backup_dir" "$DEFAULT_ROOT"
        die "GitHub 下载失败"
      }

  else

    log "从 GitHub 国内代理下载 NASphere"

    git clone \
      "${GITHUB_PROXY}/${GITHUB_REPO}" \
      "$DEFAULT_ROOT" || \
      die "NASphere 下载失败，请检查 GitHub 国内代理是否可用"

  fi

  ROOT="$DEFAULT_ROOT"

  success "NASphere 源码已准备完成：$ROOT"
}

if [ "$REMOTE_INSTALL" = 1 ]; then
  install_from_github
else
  cd "$ROOT"

  if [ "$UPDATE" = 1 ]; then
    check_git

    if [ -d "$ROOT/.git" ]; then

      log "更新 NASphere GitHub 源码"

      if ! git pull --ff-only origin main; then
        warn "GitHub 直接连接失败，尝试国内代理"

        git remote set-url origin "${GITHUB_PROXY}/${GITHUB_REPO}" 2>/dev/null || true

        git pull --ff-only origin main || \
          die "NASphere 更新失败"
      fi

      success "NASphere 源码更新完成"

    else
      warn "当前目录不是 Git 仓库，无法执行 --update"
      die "请重新执行一键安装，或者手动将项目克隆到 NASphere 目录"
    fi
  fi
fi

# ============================================================
# 项目检查
# ============================================================

cd "$ROOT"

[ -f Dockerfile ] || \
  die "没有找到 Dockerfile"

[ -f server/index.js ] || \
  die "没有找到 server/index.js"

[ -f package.json ] || \
  die "没有找到 package.json"

# ============================================================
# 读取 package.json 版本
# ============================================================

VERSION="$(
  sed -n \
    's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    package.json 2>/dev/null |
    head -n 1 || true
)"

VERSION="${VERSION:-latest}"

IMAGE="${IMAGE:-local/nasphere}"
CONTAINER="${CONTAINER:-nasphere}"
HOST_PORT="${HOST_PORT:-8080}"
DATA_DIR="${DATA_DIR:-$ROOT/data}"
HEALTH_WAIT="${HEALTH_WAIT:-40}"
KEEP_BACKUPS="${KEEP_BACKUPS:-5}"
DOCKER_SOCK="${DOCKER_SOCK:-/var/run/docker.sock}"

TAG="${TAG:-$VERSION}"

NEW_REF="$IMAGE:$TAG"

# ============================================================
# 处理相对数据目录
# ============================================================

case "$DATA_DIR" in
  /*)
    ;;
  *)
    DATA_DIR="$ROOT/$DATA_DIR"
    ;;
esac

# ============================================================
# 显示配置
# ============================================================

log "=========================================="
log "          NASphere 部署"
log "=========================================="

log "项目目录：$ROOT"
log "镜像：$NEW_REF"
log "容器：$CONTAINER"
log "端口：$HOST_PORT → 8080"
log "数据：$DATA_DIR"

if [ -n "$COMPOSE" ]; then
  log "部署方式：$COMPOSE"
else
  log "部署方式：docker run"
fi

# ============================================================
# 卸载
# ============================================================

if [ "$UNINSTALL" = 1 ]; then

  warn "准备卸载 NASphere"

  if docker_cmd inspect "$CONTAINER" >/dev/null 2>&1; then
    log "删除 NASphere 容器"
    docker_cmd rm -f "$CONTAINER" || true
  fi

  log "删除 NASphere 镜像"

  docker_cmd images \
    --format '{{.Repository}}:{{.Tag}}' |
    grep '^local/nasphere:' |
    while read -r img; do
      [ -n "$img" ] && docker_cmd rmi "$img" || true
    done

  success "NASphere 容器和镜像已删除"

  printf '\n'
  printf '数据目录仍然保留：\n'
  printf '  %s\n' "$DATA_DIR"
  printf '\n'
  printf '如确认不需要数据，可以手动删除：\n'
  printf '  rm -rf %q\n' "$DATA_DIR"
  printf '\n'

  exit 0
fi

# ============================================================
# 备份
# ============================================================

backup_data() {

  if [ ! -f "$DATA_DIR/config.json" ]; then
    log "没有已有配置，跳过备份"
    return 0
  fi

  local stamp
  stamp="$DATA_DIR/.deploy-backup/$(date +%Y%m%d-%H%M%S)"

  run mkdir -p "$stamp"

  local f

  for f in config.json auth.json; do

    if [ -f "$DATA_DIR/$f" ]; then
      run cp -p "$DATA_DIR/$f" "$stamp/$f"
    fi

  done

  log "配置已备份到：$stamp"

  if [ "$DRY" = 0 ] &&
     [ -d "$DATA_DIR/.deploy-backup" ]; then

    ls -1dt \
      "$DATA_DIR/.deploy-backup"/*/ \
      2>/dev/null |
      tail -n +$((KEEP_BACKUPS + 1)) |
      while read -r old; do
        rm -rf "${old%/}"
      done || true

  fi
}

# ============================================================
# 记录旧镜像
# ============================================================

PREV_ID=""

if [ "$DRY" = 0 ]; then

  PREV_ID="$(
    docker_cmd inspect \
      -f '{{.Image}}' \
      "$CONTAINER" \
      2>/dev/null || true
  )"

  if [ -n "$PREV_ID" ]; then

    docker_cmd tag \
      "$PREV_ID" \
      "$IMAGE:rollback" \
      2>/dev/null || true

    log "已记录旧版本镜像：${PREV_ID:0:12}"

  fi

fi

# ============================================================
# 创建数据目录
# ============================================================

run mkdir -p "$DATA_DIR"

backup_data

# ============================================================
# Docker 镜像
# ============================================================

if [ -n "$TAR" ]; then

  [ -f "$TAR" ] || \
    die "找不到镜像文件：$TAR"

  log "加载离线 Docker 镜像：$TAR"

  case "$TAR" in

    *.gz)

      if [ "$DRY" = 1 ]; then

        printf '  [dry-run] gunzip + docker load\n'

      else

        tmp="$(
          mktemp \
            "${TMPDIR:-/tmp}/nasphere-XXXXXX.tar"
        )"

        trap 'rm -f "$tmp"' EXIT

        gunzip -c "$TAR" > "$tmp"

        docker_cmd load -i "$tmp"

        rm -f "$tmp"

      fi

      ;;

    *)

      run docker_cmd load -i "$TAR"

      ;;

  esac

else

  log "开始构建 NASphere Docker 镜像"

  log "基础镜像：node:22-alpine"

  run docker_cmd build \
    -t "$NEW_REF" \
    -t "$IMAGE:latest" \
    .

fi

if [ "$DRY" = 0 ]; then

  docker_cmd image inspect "$NEW_REF" >/dev/null 2>&1 || \
    die "镜像 $NEW_REF 不存在，构建/加载失败"

fi

# ============================================================
# 启动容器
# ============================================================

up_with() {

  local ref="$1"

  if [ -n "$COMPOSE" ]; then

    IMAGE="${ref%:*}"
    TAG="${ref##*:}"

    export IMAGE
    export TAG
    export CONTAINER
    export HOST_PORT
    export DATA_DIR

    run $COMPOSE up -d --remove-orphans

    return 0

  fi

  run docker_cmd rm -f "$CONTAINER" || true

  local sock=()

  if [ -S "$DOCKER_SOCK" ]; then

    sock=(
      -e "DOCKER_HOST=unix://$DOCKER_SOCK"
      -v "$DOCKER_SOCK:$DOCKER_SOCK"
    )

  else

    warn "找不到 Docker Socket：$DOCKER_SOCK"

    warn "NASphere Docker 管理功能将不可用"

  fi

  run docker_cmd run -d \
    --name "$CONTAINER" \
    --restart unless-stopped \
    --init \
    -p "$HOST_PORT:8080" \
    -e "NAV_USER=${NAV_USER:-admin}" \
    -e "NAV_PASSWORD=${NAV_PASSWORD:-}" \
    -e "SESSION_DAYS=${SESSION_DAYS:-30}" \
    -e "MAX_BODY=${MAX_BODY:-8388608}" \
    -e "TZ=${TZ:-Asia/Shanghai}" \
    -v "$DATA_DIR:/data" \
    ${sock[@]+"${sock[@]}"} \
    "$ref"
}

# ============================================================
# 启动
# ============================================================

log "启动 NASphere"

up_with "$NEW_REF"

# ============================================================
# 获取 NAS IP
# ============================================================

lan_ip() {

  local v

  v="$(
    hostname -I 2>/dev/null || true
  )"

  if [ -z "$v" ]; then
    v="$(
      hostname -i 2>/dev/null || true
    )"
  fi

  set -- $v

  printf '%s' "${1:-127.0.0.1}"
}

# ============================================================
# 健康检查
# ============================================================

probe() {

  local url
  url="http://127.0.0.1:$HOST_PORT/api/health"

  if command -v curl >/dev/null 2>&1; then

    curl \
      -fsS \
      -m 3 \
      -o /dev/null \
      "$url"

  elif command -v wget >/dev/null 2>&1; then

    wget \
      -q \
      -T 3 \
      -O /dev/null \
      "$url"

  else

    docker_cmd exec \
      "$CONTAINER" \
      node \
      -e \
      "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

  fi
}

if [ "$DRY" = 1 ]; then

  success "dry-run 完成，没有修改任何内容"

  exit 0

fi

# ============================================================
# 等待服务
# ============================================================

log "等待 NASphere 服务启动（最多 ${HEALTH_WAIT}s）"

OK=0
N=0

while [ "$N" -lt "$HEALTH_WAIT" ]; do

  if probe 2>/dev/null; then
    OK=1
    break
  fi

  sleep 1

  N=$((N + 1))

done

# ============================================================
# 成功
# ============================================================

if [ "$OK" = 1 ]; then

  IP="$(lan_ip)"

  printf '\n'
  printf '\033[32m==========================================\033[0m\n'
  printf '\033[32m        NASphere 安装/更新完成 ✓\033[0m\n'
  printf '\033[32m==========================================\033[0m\n'
  printf '\n'

  printf '访问地址：\n'
  printf '  http://%s:%s\n' "$IP" "$HOST_PORT"

  printf '\n'

  printf '容器：\n'
  docker_cmd ps \
    --filter "name=$CONTAINER" \
    --format '  {{.Names}} ｜ {{.Status}} ｜ {{.Image}}' \
    2>/dev/null || true

  printf '\n'

  printf '数据目录：\n'
  printf '  %s\n' "$DATA_DIR"

  printf '\n'

  if [ ! -f "$DATA_DIR/auth.json" ]; then

    warn "检测到首次启动"

    if [ -n "${NAV_PASSWORD:-}" ]; then
      printf '初始账号：%s\n' "${NAV_USER:-admin}"
      printf '初始密码：已使用环境变量 NAV_PASSWORD\n'
    else
      printf '初始账号：%s\n' "${NAV_USER:-admin}"
      printf '初始密码：请查看 NASphere 首次启动提示/初始化流程\n'
    fi

    printf '\n'
    warn "首次登录后请立即修改管理员密码"

  fi

  printf '\n'

  success "NASphere 已正常运行"

  exit 0

fi

# ============================================================
# 失败
# ============================================================

warn "NASphere 健康检查失败"

printf '\n'
printf '容器最后 30 行日志：\n'

docker_cmd logs \
  --tail 30 \
  "$CONTAINER" \
  2>&1 |
  sed 's/^/  /' ||
  true

printf '\n'

# ============================================================
# 自动回滚
# ============================================================

if [ -n "$PREV_ID" ]; then

  warn "尝试自动回滚到旧版本：${PREV_ID:0:12}"

  docker_cmd tag \
    "$PREV_ID" \
    "$NEW_REF" \
    2>/dev/null || true

  up_with "$NEW_REF"

  sleep 3

  if probe 2>/dev/null; then

    success "已成功回滚到旧版本"

    die "新版本部署失败，但旧版本仍然可用"

  fi

fi

die "NASphere 部署失败，请检查：docker logs $CONTAINER"

```
