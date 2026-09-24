#!/usr/bin/env bash
# NASphere 一键安装 / 部署 / 升级 / 回滚 / 卸载
#
# 模式一：全新 NAS 一键安装（本机不需要先有项目，脚本自己去 GitHub 取源码）
#
#   curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/peekaboo789/NASphere/main/deploy.sh | bash
#
#   管道执行时 stdin 已经被脚本占着，要带参数得走 bash -s --：
#   curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/peekaboo789/NASphere/main/deploy.sh | \
#     bash -s -- --root /volume1/docker/NASphere --port 9000
#
# 模式二：本机已经有项目目录
#
#   cd /vol2/1000/dockers/NASphere
#   ./deploy.sh
#
# 升级：重跑上面任意一条，脚本自己 pull 新镜像；换版本用 ./deploy.sh --tag 1.1.0
#
# 卸载：
#   ./deploy.sh --uninstall
#
set -euo pipefail

# ============================================================
# 基础配置
# ============================================================

# 想用自己的 fork 或内网镜像，用环境变量覆盖这两行即可
GITHUB_REPO="${GITHUB_REPO:-https://github.com/peekaboo789/NASphere.git}"
GITHUB_PROXY="${GITHUB_PROXY:-https://gh-proxy.com}"
BRANCH="${BRANCH:-main}"

# 没有 git 时的退路：直接下源码压缩包（去掉 .git 后缀就是 archive 地址）
SOURCE_TARBALL="${GITHUB_REPO%.git}/archive/refs/heads/${BRANCH}.tar.gz"

DEFAULT_ROOT="${DEFAULT_ROOT:-/vol2/1000/dockers/NASphere}"

# curl | bash 时 BASH_SOURCE[0] 是未定义的，$0 才是 "bash"。
# 这里必须带 :- 回落，否则 set -u 会让脚本在第 30 行直接死掉，
# 那条一键安装命令连一行输出都不会有。
SCRIPT_SRC="${BASH_SOURCE[0]:-$0}"

if [ -f "$SCRIPT_SRC" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SRC")" && pwd)"
else
  # 脚本从管道读进来，不在磁盘上：只能以当前目录作候选
  SCRIPT_DIR="$PWD"
fi

# 脚本旁边就有项目文件 → 本机模式；否则 → 一键安装模式，先下载源码
LOCAL_MODE=0

if [ -f "$SCRIPT_DIR/Dockerfile" ] && [ -f "$SCRIPT_DIR/server/index.js" ]; then
  LOCAL_MODE=1
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

# 这些 knobs 允许从环境里传进来，先把环境的值存下来。
# 直接写 VAR="" 会把继承来的环境值抹掉，那样文档里那张环境变量表就成了摆设。
ENV_IMAGE="${IMAGE:-}"
ENV_CONTAINER="${CONTAINER:-}"
ENV_HOST_PORT="${HOST_PORT:-}"
ENV_DATA_DIR="${DATA_DIR:-}"
ENV_TAG="${TAG:-}"
ENV_HEALTH_WAIT="${HEALTH_WAIT:-}"
ENV_KEEP_BACKUPS="${KEEP_BACKUPS:-}"
ENV_DOCKER_SOCK="${DOCKER_SOCK:-}"
ENV_NAV_USER="${NAV_USER:-}"
ENV_NAV_PASSWORD="${NAV_PASSWORD:-}"
ENV_SESSION_DAYS="${SESSION_DAYS:-}"
ENV_MAX_BODY="${MAX_BODY:-}"
ENV_TZ="${TZ:-}"

# 一键安装时的目标目录，也允许从环境传进来
ENV_INSTALL_ROOT="${INSTALL_ROOT:-}"

# 命令行槽位（下面按参数填）
TAR=""
SOURCE=""
DRY=0
UNINSTALL=0
TAG=""
HOST_PORT=""
DATA_DIR=""
IMAGE=""
HEALTH_WAIT=""
KEEP_BACKUPS=""
DOCKER_SOCK=""
INSTALL_ROOT=""

usage() {
  cat <<'EOF'

NASphere 一键安装 / 部署工具

两种模式，自动判断：

  模式一 全新 NAS 一键安装（本机不需要先有项目）：
    curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/peekaboo789/NASphere/main/deploy.sh | bash

    管道执行时 stdin 已被脚本占用，要带参数得用 bash -s --：
    curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/peekaboo789/NASphere/main/deploy.sh | \
      bash -s -- --root /volume1/docker/NASphere --port 9000

    源码装到 --root（或 INSTALL_ROOT），默认 /vol2/1000/dockers/NASphere；
    那个目录已经在跑 NASphere 就等于原地升级，data/ 不会被覆盖。

  模式二 本机已有项目目录（在目录里直接执行就是部署 / 升级）：
    cd /vol2/1000/dockers/NASphere
    ./deploy.sh

选项：

  --root <目录>        一键安装时源码装到哪里，默认 /vol2/1000/dockers/NASphere
  --update             从 GitHub 拉取最新版并重新部署
  --source <压缩包>    用本地或内网的源码 tar.gz 安装，跳过 GitHub（NAS 没有 git 时用）
  --tar <文件>         加载 docker save 导出的镜像包，跳过构建
  --tag <标签>         镜像标签，默认使用 package.json version
  --port <端口>        宿主机端口，默认 18086（容器内固定监听 18086）
  --data-dir <路径>    数据目录，默认 <项目目录>/data
  --dry-run            只显示操作，不执行、不落盘
  --uninstall          删除 NASphere 容器和镜像，但保留数据
  -h, --help           显示帮助

环境变量：

  INSTALL_ROOT
  IMAGE
  TAG
  HOST_PORT
  DATA_DIR
  HEALTH_WAIT
  KEEP_BACKUPS
  DOCKER_SOCK
  TZ
  GITHUB_REPO
  GITHUB_PROXY
  BRANCH

生效顺序：命令行 > 环境变量 > .env > 默认值

默认：

  安装目录：
    ./dat

  镜像：
    ghcr.io/peekaboo789/nasphere:1.0.0

  compose 项目名：
    nasphere

  宿主机端口：
    18086

  数据：
    ./data

  初始账号：
    admin

  初始密码：
    首次安装且没有指定 NAV_PASSWORD 时随机生成，写入 .env 并只打印一次

注意：

  NASphere 的 Docker Socket 具有较高宿主机权限。
  只有可信用户才应该使用 Docker 管理功能。

EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --root)
      INSTALL_ROOT="${2:?--root 后面需要跟目录}"
      shift 2
      ;;
    --update)
      UPDATE=1
      shift
      ;;
    --source)
      SOURCE="${2:?--source 后面需要跟源码 tar.gz 路径}"
      shift 2
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
    -h | --help)
      usage
      exit 0
      ;;
    *)
      die "未知参数：$1"
      ;;
  esac
done

# ============================================================
# 路径与 sudo
# ============================================================

# 后面会 cd 进项目目录，所以所有相对路径都先按调用时的目录定死，
# 免得到时候 --tar dist/xxx.tar.gz 找不到文件
absolute_path() {

  local p="$1"

  case "$p" in
    /*)
      printf '%s' "$p"
      ;;
    ./*)
      printf '%s/%s' "$PWD" "${p#./}"
      ;;
    *)
      printf '%s/%s' "$PWD" "$p"
      ;;
  esac
}

if [ -n "$TAR" ]; then
  TAR="$(absolute_path "$TAR")"
fi

if [ -n "$SOURCE" ]; then
  SOURCE="$(absolute_path "$SOURCE")"
fi

if [ -n "$INSTALL_ROOT" ]; then
  INSTALL_ROOT="$(absolute_path "$INSTALL_ROOT")"
fi

SUDO=""

# 目录/文件操作的提权前缀，和 docker 的 SUDO 分开算：
# docker 能用 sudo 不代表这个目录也写得进去
FSUDO=""

docker_cmd() {
  if [ -n "$SUDO" ]; then
    sudo docker "$@"
  else
    command docker "$@"
  fi
}

# 以 sudo（如果有必要且可用）执行文件类命令
fs_cmd() {
  if [ -n "$FSUDO" ]; then
    sudo "$@"
  else
    "$@"
  fi
}

# 能不能非交互地用 sudo。curl | bash 时 stdin 被脚本占着，
# sudo 真要输密码是输不进去的，所以必须用 -n 先探一下。
sudo_ok() {
  if [ "$(id -u)" = "0" ]; then
    return 0
  fi
  if ! command -v sudo >/dev/null 2>&1; then
    return 1
  fi
  sudo -n true >/dev/null 2>&1
}

run() {
  if [ "$DRY" = 1 ]; then

    printf '  [dry-run] '

    # 把内部函数名翻成人能看的命令
    case "${1:-}" in
      docker_cmd)
        if [ -n "$SUDO" ]; then printf 'sudo '; fi
        printf 'docker '
        shift
        ;;
      docker_compose_cmd)
        if [ -n "$SUDO" ]; then printf 'sudo '; fi
        if [ "$COMPOSE_MODE" = v2 ]; then
          printf 'docker compose '
        else
          printf 'docker-compose '
        fi
        shift
        ;;
      fs_cmd)
        # 文件类命令：前缀就是它自己该不该带 sudo
        if [ -n "$FSUDO" ]; then printf 'sudo '; fi
        shift
        ;;
      *)
        printf '%s ' "$1"
        shift
        ;;
    esac

    local a
    for a in "$@"; do
      case "$a" in
        NAV_PASSWORD=)
          # 空值没什么可藏的，原样打出来更好判断
          printf '%q ' "$a"
          ;;
        NAV_PASSWORD=*)
          # 不能用 %q：它会把星号转义成 \*\*\*，反而看不出是掩码
          printf 'NAV_PASSWORD=*** '
          ;;
        *)
          printf '%q ' "$a"
          ;;
      esac
    done

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
# 取源码：git clone / 源码压缩包
# ============================================================

has_git() {
  command -v git >/dev/null 2>&1
}

http_get() {

  local url="$1" out="$2"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 2 -m 180 -o "$out" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 30 -O "$out" "$url"
  else
    return 1
  fi
}

# 先连 GitHub，失败再走国内代理。目标目录由 $1 给出，必须还不存在。
git_clone_repo() {

  local dest="$1"

  if fs_cmd git clone --branch "$BRANCH" "$GITHUB_REPO" "$dest" >/dev/null 2>&1; then
    return 0
  fi

  fs_cmd rm -rf "$dest"

  warn "GitHub 直连失败，改用国内代理：$GITHUB_PROXY"

  if fs_cmd git clone --branch "$BRANCH" "${GITHUB_PROXY}/${GITHUB_REPO}" "$dest" >/dev/null 2>&1; then
    return 0
  fi

  fs_cmd rm -rf "$dest"

  return 1
}

# 在仓库目录里拉取当前分支；直连失败就临时改用代理，拉完把 origin 还原。
git_pull_repo() {

  fs_cmd git remote set-url origin "$GITHUB_REPO" 2>/dev/null || true

  if fs_cmd git pull --ff-only origin "$BRANCH"; then
    return 0
  fi

  warn "GitHub 直连失败，改用国内代理重试"

  fs_cmd git remote set-url origin "${GITHUB_PROXY}/${GITHUB_REPO}" 2>/dev/null || true

  if ! fs_cmd git pull --ff-only origin "$BRANCH"; then
    fs_cmd git remote set-url origin "$GITHUB_REPO" 2>/dev/null || true
    return 1
  fi

  fs_cmd git remote set-url origin "$GITHUB_REPO" 2>/dev/null || true
}

# 压缩包顶层是 NASphere-<分支>/，剥掉一层就是项目根
extract_source_tarball() {

  local src="$1" dest="$2"

  command -v tar >/dev/null 2>&1 || \
    die "没有 tar，无法解压源码包"

  fs_cmd rm -rf "$dest"

  fs_cmd mkdir -p "$dest"

  fs_cmd tar -xzf "$src" --strip-components=1 -C "$dest" || {
    fs_cmd rm -rf "$dest"
    return 1
  }
}

fetch_via_tarball() {

  local dest="$1" tmp url

  if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    warn "本机既没有 git 也没有 curl/wget，无法下载源码"
    return 1
  fi

  tmp="$(mktemp "${TMPDIR:-/tmp}/nasphere-src-XXXXXX.tar.gz")"

  trap '[ -z "${tmp:-}" ] || rm -f "$tmp"' EXIT

  for url in "$SOURCE_TARBALL" "${GITHUB_PROXY}/${SOURCE_TARBALL}"; do

    log "尝试下载源码包：$url"

    if http_get "$url" "$tmp"; then

      if extract_source_tarball "$tmp" "$dest"; then
        rm -f "$tmp"
        trap - EXIT
        return 0
      fi

      rm -f "$tmp"
      trap - EXIT
      return 1

    fi

  done

  rm -f "$tmp"
  trap - EXIT

  return 1
}

# --source 指定的本地包优先；没有 git 就退回源码压缩包
fetch_source() {

  local dest="$1"

  if [ -n "$SOURCE" ]; then
    [ -f "$SOURCE" ] || \
      die "找不到源码包：$SOURCE"
    log "使用本地源码包：$SOURCE"
    extract_source_tarball "$SOURCE" "$dest" || \
      die "源码包解压失败：$SOURCE"
    return 0
  fi

  if has_git; then
    if git_clone_repo "$dest"; then
      return 0
    fi
    warn "git clone 失败，改用源码压缩包下载"
  else
    warn "本机没有 git，改用源码压缩包下载（这样装完不能用 --update）"
  fi

  fetch_via_tarball "$dest"
}

looks_like_project() {
  [ -f "$1/Dockerfile" ] && [ -f "$1/server/index.js" ]
}

fetch_and_verify() {

  local dest="$1"

  fetch_source "$dest" || return 1

  looks_like_project "$dest" || {
    fs_cmd rm -rf "$dest"
    warn "下载内容不完整（缺 Dockerfile 或 server/index.js）"
    return 1
  }
}

# 源码没更新成功也别把部署搞死：本机版本仍可用，data/ 更不会被动
update_repo() {

  if ! has_git; then
    warn "本机没有 git，跳过源码更新，直接用当前版本部署"
    return 1
  fi

  if [ ! -d "$ROOT/.git" ]; then
    warn "$ROOT 不是 Git 仓库，无法 --update，直接用当前版本部署"
    warn "想要 Git 管理：重新执行一键安装，它会把这个目录换成 GitHub 仓库（data/ 会保留）"
    return 1
  fi

  cd "$ROOT" || {
    warn "无法进入 $ROOT，跳过源码更新"
    return 1
  }

  # 有未提交改动时 pull 必然报错，先让本机版本继续跑，别动用户的东西
  if ! fs_cmd git diff --quiet >/dev/null 2>&1 ||
     ! fs_cmd git diff --cached --quiet >/dev/null 2>&1; then
    warn "检测到未提交的本地改动，跳过 git pull，直接用当前版本部署"
    return 1
  fi

  git_pull_repo
}

# ============================================================
# Compose
# ============================================================

# v2 = `docker compose`，v1 = 独立的 docker-compose，空 = 只能用 docker run
COMPOSE_MODE=""

if docker_cmd compose version >/dev/null 2>&1; then
  COMPOSE_MODE="v2"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_MODE="v1"
fi

docker_compose_cmd() {
  if [ "$COMPOSE_MODE" = v2 ]; then
    docker_cmd compose "$@"
  else
    if [ -n "$SUDO" ]; then
      sudo docker-compose "$@"
    else
      command docker-compose "$@"
    fi
  fi
}

# ============================================================
# 模式一：一键安装 —— 把源码装进安装目录，但不碰已有数据
# ============================================================

# 安装目录写不写得进去。curl | bash 时 stdin 被脚本占着，sudo 真要密码是输不进去的，
# 所以只用免密 sudo 兜底，否则直接给出可以照做的提示。
resolve_write_privilege() {

  local parent="$1"

  if [ "$(id -u)" = "0" ]; then
    return 0
  fi

  if mkdir -p "$parent" 2>/dev/null && [ -w "$parent" ]; then
    return 0
  fi

  if sudo_ok; then
    FSUDO="sudo"
    warn "当前用户对 $parent 没有写权限，改用 sudo；装出来的文件会属于 root"
    fs_cmd mkdir -p "$parent" || \
      die "sudo mkdir -p $parent 仍然失败，请检查存储目录"
    return 0
  fi

  die "没有权限写 $parent，也用不了免密 sudo。请用 root 执行（curl … | sudo bash），或加 --root 指一个你有权限的目录。"
}

# 把旧目录里的运行数据和 .env 搬回新目录：重装不会把壁纸、图标、配置、账号弄丢
keep_local_state() {

  local old="$1" new="$2"

  if [ -d "$old/data" ] && [ ! -e "$new/data" ]; then
    if fs_cmd mv "$old/data" "$new/data"; then
      success "原有数据目录已迁回：$new/data"
    else
      warn "迁移 data/ 失败，请手动把 $old/data 拷回 $new/data"
    fi
  fi

  if [ -f "$old/.env" ] && [ ! -e "$new/.env" ]; then
    if fs_cmd cp -p "$old/.env" "$new/.env"; then
      fs_cmd chmod 600 "$new/.env"
      log "原有 .env 已保留"
    else
      warn "$old/.env 没能拷过来，需要的话手动拷回"
    fi
  fi
}

prepare_install_root() {

  local parent backup_dir

  parent="$(dirname "$ROOT")"

  resolve_write_privilege "$parent"

  if [ -d "$ROOT/.git" ]; then

    log "检测到已有 NASphere Git 仓库，按最新版更新：$ROOT"

    update_repo || warn "源码没有更新，继续使用本机已有版本（data/ 不受影响）"

    return 0

  fi

  if [ -e "$ROOT" ] && [ -n "$(ls -A "$ROOT" 2>/dev/null)" ]; then

    backup_dir="${ROOT}.backup-$(date +%Y%m%d-%H%M%S)"

    warn "$ROOT 里已经有东西，但不是 Git 仓库；先整体备份到 $backup_dir"

    if ! fs_cmd mv "$ROOT" "$backup_dir"; then
      die "无法移动 $ROOT，请检查权限或直接用 --root 换一个目录"
    fi

    if ! fetch_and_verify "$ROOT"; then
      fs_cmd rm -rf "$ROOT"
      fs_cmd mv "$backup_dir" "$ROOT"
      die "源码下载失败，已把原目录还原回 $ROOT"
    fi

    keep_local_state "$backup_dir" "$ROOT"

    log "旧目录仍然保留在：$backup_dir（确认新装没问题后可以删）"

    success "NASphere 源码已准备完成：$ROOT"

    return 0

  fi

  log "下载 NASphere 源码到 $ROOT"

  fetch_and_verify "$ROOT" || \
    die "NASphere 下载失败：检查网络或 GitHub 代理，也可以先用 --source <源码包> 离线安装"

  success "NASphere 源码已准备完成：$ROOT"
}

# ============================================================
# 模式判定与源码准备
# ============================================================

if [ "$LOCAL_MODE" = 1 ]; then

  ROOT="$SCRIPT_DIR"

  log "模式：本机项目目录（$ROOT）"

  if [ -n "$INSTALL_ROOT" ]; then
    warn "--root 只在一键安装时生效，本机模式仍然部署当前目录"
  fi

else

  ROOT="${INSTALL_ROOT:-${ENV_INSTALL_ROOT:-$DEFAULT_ROOT}}"

  log "模式：一键安装（源码目录 $ROOT）"

  if [ "$DRY" = 1 ]; then

    printf '  [dry-run] 下载源码到 %s：git clone %s（失败改用 %s 或压缩包 %s）\n' \
      "$ROOT" "$GITHUB_REPO" "$GITHUB_PROXY" "$SOURCE_TARBALL"

    printf '  [dry-run] 随后按本机模式继续：构建或加载镜像 → 备份 data → 起容器 → 健康检查\n'

    success "dry-run 完成，没有下载、没有落盘"

    exit 0

  fi

  if [ "$UNINSTALL" = 1 ]; then
    log "卸载不需要源码，跳过下载"
  else
    prepare_install_root
  fi

fi

if [ "$LOCAL_MODE" = 1 ] && [ "$UPDATE" = 1 ]; then

  log "更新 NASphere GitHub 源码"

  if update_repo; then
    success "NASphere 源码更新完成"
  else
    warn "源码没有更新，继续使用本机已有版本"
  fi

fi

# 卸载时目录可能早就不在了：那种情况按镜像名和 compose 项目清一遍就够
if [ ! -d "$ROOT" ]; then
  if [ "$UNINSTALL" = 1 ]; then
    warn "目录不存在：$ROOT，只按镜像名和 compose 项目卸载"
    ROOT="$PWD"
  else
    resolve_write_privilege "$(dirname "$ROOT")"
    fs_cmd mkdir -p "$ROOT" || \
      die "创建安装目录失败：$ROOT"
    log "已创建安装目录：$ROOT"
  fi
fi

if [ ! -d "$ROOT" ]; then

  if [ "$UNINSTALL" = 1 ]; then
    warn "目录不存在：$ROOT，只按容器名和镜像名卸载"
    ROOT="$PWD"
  else
    die "找不到项目目录：$ROOT"
  fi

fi

cd "$ROOT" || \
  die "无法进入目录：$ROOT"

# 只卸载容器和镜像时，项目文件缺了也能走完
if [ "$UNINSTALL" = 1 ] && ! looks_like_project "$ROOT"; then

  log "按卸载模式继续（不需要 Dockerfile 与 server/index.js）"

else

  [ -f Dockerfile ] || \
    die "没有找到 Dockerfile"

  [ -f server/index.js ] || \
    die "没有找到 server/index.js"

  [ -f package.json ] || \
    die "没有找到 package.json"

fi

# ============================================================
# 生效优先级：命令行 > 环境变量 > .env > 默认值
# ============================================================

# 命令行解析结果先挪进 CLI_ 槽位，后面 source .env 会占用同名变量
CLI_IMAGE="$IMAGE"
CLI_CONTAINER="$CONTAINER"
CLI_HOST_PORT="$HOST_PORT"
CLI_DATA_DIR="$DATA_DIR"
CLI_TAG="$TAG"
CLI_HEALTH_WAIT="$HEALTH_WAIT"
CLI_KEEP_BACKUPS="$KEEP_BACKUPS"
CLI_DOCKER_SOCK="$DOCKER_SOCK"

DOTENV_IMAGE=""
DOTENV_CONTAINER=""
DOTENV_HOST_PORT=""
DOTENV_DATA_DIR=""
DOTENV_TAG=""
DOTENV_HEALTH_WAIT=""
DOTENV_KEEP_BACKUPS=""
DOTENV_DOCKER_SOCK=""
DOTENV_NAV_USER=""
DOTENV_NAV_PASSWORD=""
DOTENV_SESSION_DAYS=""
DOTENV_MAX_BODY=""
DOTENV_TZ=""

if [ -f "$ROOT/.env" ]; then

  log "读取 $ROOT/.env"

  # 只取赋值行，并去掉 Windows 换行符，避免值结尾带一个 \r
  _env_file="$(mktemp "${TMPDIR:-/tmp}/nasphere-env-XXXXXX")"

  trap '[ -z "${_env_file:-}" ] || rm -f "$_env_file"' EXIT

  grep -E '^[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=' "$ROOT/.env" | tr -d '\r' >"$_env_file" || true

  IMAGE=""
  CONTAINER=""
  HOST_PORT=""
  DATA_DIR=""
  TAG=""
  HEALTH_WAIT=""
  KEEP_BACKUPS=""
  DOCKER_SOCK=""
  NAV_USER=""
  NAV_PASSWORD=""
  SESSION_DAYS=""
  MAX_BODY=""
  TZ=""

  set -a
  # shellcheck disable=SC1090
  . "$_env_file"
  set +a

  rm -f "$_env_file"
  trap - EXIT

  DOTENV_IMAGE="$IMAGE"
  DOTENV_CONTAINER="$CONTAINER"
  DOTENV_HOST_PORT="$HOST_PORT"
  DOTENV_DATA_DIR="$DATA_DIR"
  DOTENV_TAG="$TAG"
  DOTENV_HEALTH_WAIT="$HEALTH_WAIT"
  DOTENV_KEEP_BACKUPS="$KEEP_BACKUPS"
  DOTENV_DOCKER_SOCK="$DOCKER_SOCK"
  DOTENV_NAV_USER="$NAV_USER"
  DOTENV_NAV_PASSWORD="$NAV_PASSWORD"
  DOTENV_SESSION_DAYS="$SESSION_DAYS"
  DOTENV_MAX_BODY="$MAX_BODY"
  DOTENV_TZ="$TZ"

fi

# 版本默认值取自 package.json，先算好
VERSION="$(
  sed -n \
    's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    package.json 2>/dev/null |
    head -n 1 || true
)"

DOTENV_IMAGE=""
DOTENV_HOST_PORT=""
DOTENV_DATA_DIR=""
DOTENV_TAG=""
DOTENV_HEALTH_WAIT=""
DOTENV_KEEP_BACKUPS=""
DOTENV_DOCKER_SOCK=""
DOTENV_TZ=""

IMAGE="${CLI_IMAGE:-${ENV_IMAGE:-${DOTENV_IMAGE:-local/nasphere}}}"
CONTAINER="${CLI_CONTAINER:-${ENV_CONTAINER:-${DOTENV_CONTAINER:-nasphere}}}"
HOST_PORT="${CLI_HOST_PORT:-${ENV_HOST_PORT:-${DOTENV_HOST_PORT:-18086}}}"
DATA_DIR="${CLI_DATA_DIR:-${ENV_DATA_DIR:-${DOTENV_DATA_DIR:-$ROOT/data}}}"
HEALTH_WAIT="${CLI_HEALTH_WAIT:-${ENV_HEALTH_WAIT:-${DOTENV_HEALTH_WAIT:-40}}}"
KEEP_BACKUPS="${CLI_KEEP_BACKUPS:-${ENV_KEEP_BACKUPS:-${DOTENV_KEEP_BACKUPS:-5}}}"
DOCKER_SOCK="${CLI_DOCKER_SOCK:-${ENV_DOCKER_SOCK:-${DOTENV_DOCKER_SOCK:-/var/run/docker.sock}}}"
TAG="${CLI_TAG:-${ENV_TAG:-${DOTENV_TAG:-$VERSION}}}"

# 这几个没有命令行开关，但同样得按 环境变量 > .env > 默认值 排：
# 上面 source .env 用的是 set -a，不重新算一遍的话 .env 会反过来盖掉环境变量
NAV_USER="${ENV_NAV_USER:-${DOTENV_NAV_USER:-admin}}"
NAV_PASSWORD="${ENV_NAV_PASSWORD:-${DOTENV_NAV_PASSWORD:-}}"
SESSION_DAYS="${ENV_SESSION_DAYS:-${DOTENV_SESSION_DAYS:-30}}"
MAX_BODY="${ENV_MAX_BODY:-${DOTENV_MAX_BODY:-8388608}}"
TZ="${ENV_TZ:-${DOTENV_TZ:-Asia/Shanghai}}"

export NAV_USER NAV_PASSWORD SESSION_DAYS MAX_BODY TZ

NEW_REF="$IMAGE:$TAG"

# ============================================================
# 参数校验
# ============================================================

case "$HOST_PORT" in
  ''|*[!0-9]*)
    die "端口必须是数字：$HOST_PORT"
    ;;
esac

if [ "$HOST_PORT" -lt 1 ] || [ "$HOST_PORT" -gt 65535 ]; then
  die "端口超出范围（1–65535）：$HOST_PORT"
fi

case "$KEEP_BACKUPS" in
  ''|*[!0-9]*)
    die "KEEP_BACKUPS 必须是数字：$KEEP_BACKUPS"
    ;;
esac

case "$HEALTH_WAIT" in
  ''|*[!0-9]*)
    die "HEALTH_WAIT 必须是数字：$HEALTH_WAIT"
    ;;
esac

# ============================================================
# 处理相对数据目录
# ============================================================

case "$HOST_PORT" in
  '' | *[!0-9]*)
    die "端口必须是数字：$HOST_PORT"
    ;;
esac

if [ "$HOST_PORT" -lt 1 ] || [ "$HOST_PORT" -gt 65535 ]; then
  die "端口超出范围（1–65535）：$HOST_PORT"
fi

case "$KEEP_BACKUPS" in
  '' | *[!0-9]*)
    die "KEEP_BACKUPS 必须是数字：$KEEP_BACKUPS"
    ;;
esac

case "$HEALTH_WAIT" in
  '' | *[!0-9]*)
    die "HEALTH_WAIT 必须是数字：$HEALTH_WAIT"
    ;;
esac

# 相对数据目录按安装目录定死：compose 文件里写的是绝对路径，
# 相对路径会被 compose 按文件所在目录解释，换台机器就指到别处去了
case "$DATA_DIR" in
  /*)
    ;;
  ./*)
    DATA_DIR="$ROOT/${DATA_DIR#./}"
    ;;
  *)
    DATA_DIR="$ROOT/$DATA_DIR"
    ;;
esac

# 容器起来之后服务端就会补写 auth.json，首启提示必须在启动前取样
FIRST_RUN=0

[ -f "$DATA_DIR/auth.json" ] || FIRST_RUN=1

# ============================================================
# 首次安装的初始密码
# ============================================================

# admin/admin123 是公开仓库里人人可查的默认值，而这个容器还挂着 docker.sock。
# 所以首装时没人指定密码，就随机生成一个，别让用户的第一台机器是裸奔的。
PASSWORD_GENERATED=0

gen_password() {

  local pw="" chunk=""

  # 只用字母数字：要塞进 .env、-e 参数和 compose 插值里，不掺杂需要转义的字符
  while [ "${#pw}" -lt 16 ]; do

    if [ ! -r /dev/urandom ]; then
      break
    fi

    chunk="$(head -c 512 /dev/urandom 2>/dev/null | tr -dc 'A-Za-z0-9')"

    [ -n "$chunk" ] || break

    pw="$pw$chunk"

  done

  pw="${pw:0:16}"

  if [ "${#pw}" -lt 16 ] && command -v openssl >/dev/null 2>&1; then
    pw="$(openssl rand -hex 8)"
  fi

  printf '%s' "$pw"
}

write_env_password() {

  local line

  if [ -f "$ROOT/.env" ]; then
    line="$(printf '\n# deploy.sh 首次安装自动生成（%s）\nNAV_PASSWORD=%s\n' "$(date +%Y-%m-%d)" "$NAV_PASSWORD")"
    printf '%s' "$line" >>"$ROOT/.env"
  else
    printf 'NAV_USER=%s\nNAV_PASSWORD=%s\n' "$NAV_USER" "$NAV_PASSWORD" >"$ROOT/.env"
  fi
}

if [ "$FIRST_RUN" = 1 ] &&
   [ -z "$NAV_PASSWORD" ] &&
   [ "$UNINSTALL" != 1 ] &&
   [ "$DRY" != 1 ]; then

  NAV_PASSWORD="$(gen_password)"

  [ -n "$NAV_PASSWORD" ] || \
    die "无法生成随机初始密码：请在 .env 或环境变量里设置 NAV_PASSWORD 后重试"

  PASSWORD_GENERATED=1

  export NAV_PASSWORD

  # 密码只在结尾打印一次，所以必须有个地方留档；.env 已在 .gitignore 与 .dockerignore 里
  if write_env_password && chmod 600 "$ROOT/.env" 2>/dev/null; then
    log "随机初始密码已写入 $ROOT/.env（权限 600）"
  else
    warn "写不进 $ROOT/.env，随机初始密码只在这次输出里显示一次"
  fi

fi

# ============================================================
# 显示配置
# ============================================================

log "=========================================="
log "          NASphere 部署"
log "=========================================="

log "项目目录：$ROOT"
log "运行模式：$( [ "$LOCAL_MODE" = 1 ] && echo '本机已有项目' || echo '一键安装（源码本次下载）' )"
log "镜像：$NEW_REF"
log "容器：$CONTAINER"
log "端口：$HOST_PORT → 容器内 18086"
log "数据：$DATA_DIR"
log "时区：$TZ"

if [ "$FIRST_RUN" = 1 ]; then
  log "首次启动：账号 $NAV_USER"
fi

if [ -n "$COMPOSE_MODE" ]; then
  log "部署方式：$([ "$COMPOSE_MODE" = v2 ] && echo 'docker compose' || echo docker-compose)"
else
  log "部署方式：docker run"
fi

if [ "$DRY" = 1 ]; then
  warn "dry-run：只打印命令，不做任何修改"
fi

# ============================================================
# 卸载
# ============================================================

if [ "$UNINSTALL" = 1 ]; then

  warn "准备卸载 NASphere（数据目录不会被删除）"

  if [ "$DRY" = 1 ]; then
    run docker_compose_cmd down --remove-orphans
    run docker_cmd rm -f "$CONTAINER"
  else
    if [ -n "$COMPOSE_MODE" ] && [ -f "$ROOT/docker-compose.yml" ]; then
      log "用 Compose 停掉本项目"
      docker_compose_cmd down --remove-orphans || true
    fi

    if docker_cmd inspect "$CONTAINER" >/dev/null 2>&1; then
      log "删除 NASphere 容器"
      docker_cmd rm -f "$CONTAINER" || true
    fi
  fi

  log "删除 NASphere 镜像"

  # grep 没匹配到时退出码 1，在 pipefail 下会整段中断，所以就地吞掉
  old_images="$(docker_cmd images --format '{{.Repository}}:{{.Tag}}' | { grep -F "${IMAGE}:" || true; })"

  if [ -n "$old_images" ]; then
    IFS=$'\n'
    for img in $old_images; do
      [ -n "$img" ] && run docker_cmd rmi "$img" || true
    done
    unset IFS
  fi

  success "NASphere 容器和镜像已删除"

  printf '\n'
  printf '数据目录仍然保留：\n'
  printf '  %s\n' "$DATA_DIR"
  printf '\n'
  printf '如确认不需要数据，可以手动删除：\n'
  printf '  rm -rf %q\n' "$DATA_DIR"
  printf '\n'
  printf '安装目录里那份 compose 文件还在：\n'
  printf '  %q\n' "$COMPOSE_FILE"
  printf '\n'

  exit 0
fi

# ============================================================
# 数据目录与配置备份
# ============================================================

run fs_cmd mkdir -p "$DATA_DIR"

backup_data() {

  if [ ! -f "$DATA_DIR/config.json" ]; then
    log "没有已有配置，跳过备份"
    return 0
  fi

  local stamp
  stamp="$DATA_DIR/.deploy-backup/$(date +%Y%m%d-%H%M%S)"

  run fs_cmd mkdir -p "$stamp"

  local f

  for f in config.json auth.json; do

    if [ -f "$DATA_DIR/$f" ]; then
      run fs_cmd cp -p "$DATA_DIR/$f" "$stamp/$f"
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

backup_data

# ============================================================
# 记录旧镜像（回滚锚点）
# ============================================================

PREV_ID=""

if [ "$DRY" = 0 ]; then

  old_cid="$(compose_ids | head -n 1)"

  if [ -n "$old_cid" ]; then
    PREV_ID="$(docker_cmd inspect -f '{{.Image}}' "$old_cid" 2>/dev/null | sed 's/^sha256://' || true)"
  fi

  if [ -n "$PREV_ID" ]; then

    docker_cmd tag \
      "$PREV_ID" \
      "$IMAGE:rollback" \
      2>/dev/null || true

    log "已记录旧版本镜像：${PREV_ID:0:12}"

  fi

fi

# ============================================================
# 生成 docker-compose.yml
# ============================================================

run fs_cmd mkdir -p "$DATA_DIR"

  printf '# %s，请勿手改：下次部署会整个重写。\n' "$GENERATED_KEY"
  printf '# 要长期改端口或数据目录，就写在 %s/.env 里的 HOST_PORT / DATA_DIR，然后重跑 ./deploy.sh。\n' "$ROOT"
  printf '# 镜像来自 GHCR，本机不需要源码，也不需要 Dockerfile。\n'
  printf '\n'
  printf 'services:\n'
  printf '  nasphere:\n'
  printf '    image: %s\n' "$NEW_REF"
  printf '    restart: unless-stopped\n'
  printf '\n'
  printf '    ports:\n'
  printf '      - "%s:%s"\n' "$HOST_PORT" "$APP_PORT"
  printf '\n'
  printf '    volumes:\n'
  printf '      - %s:/app/data\n' "$DATA_DIR"

  if [ -S "$DOCKER_SOCK" ]; then
    printf '      - %s:%s\n' "$DOCKER_SOCK" "$DOCKER_SOCK"
  fi

  printf '\n'
  printf '    environment:\n'
  printf '      TZ: %s\n' "$TZ"

  # 套接字路径不是镜像默认那个时，才需要显式告诉服务端去哪儿连
  if [ -S "$DOCKER_SOCK" ] && [ "$DOCKER_SOCK" != "/var/run/docker.sock" ]; then
    printf '      DOCKER_HOST: unix://%s\n' "$DOCKER_SOCK"
  fi
}

new_compose="$(render_compose)"

if [ "$DRY" = 1 ]; then

  printf '  [dry-run] 生成 %q\n' "$COMPOSE_FILE"

  printf '%s\n' "$new_compose" | sed 's/^/  [dry-run] | /'

else

  write_it=1

  if [ -f "$COMPOSE_FILE" ]; then

    if printf '%s\n' "$new_compose" | cmp -s - "$COMPOSE_FILE"; then
      write_it=0
      log "docker-compose.yml 与本次参数一致，未改动"
    elif ! grep -q "$GENERATED_KEY" "$COMPOSE_FILE" 2>/dev/null; then
      keep="${COMPOSE_FILE}.backup-$(date +%Y%m%d-%H%M%S)"
      if fs_cmd cp -p "$COMPOSE_FILE" "$keep"; then
        warn "目录里那份 compose 不是本脚本生成的，已备份到 $keep"
      fi
    fi

  fi

  if [ "$write_it" = 1 ]; then
    printf '%s\n' "$new_compose" >"$COMPOSE_FILE"
    log "已生成 $COMPOSE_FILE"
  fi

fi

if [ -S "$DOCKER_SOCK" ]; then
  log "Docker Socket 会挂进容器：$DOCKER_SOCK"
else
  warn "找不到 Docker Socket：$DOCKER_SOCK"
  warn "NASphere Docker 管理功能将不可用（compose 里那行挂载已经省掉，其余功能照常）"
fi

# ============================================================
# 加载离线镜像，并把包里的名字重标成 $NEW_REF
# ============================================================

loaded_ref_of() {

  # 从 `docker load` 的输出里取镜像名；没有标签的包退回镜像 ID
  local out="$1" ref

  ref="$(printf '%s\n' "$out" | sed -n 's/^Loaded image: //p' | tail -n 1)"

  if [ -z "$ref" ]; then
    ref="$(printf '%s\n' "$out" | sed -n 's/^Loaded image ID: sha256:\([0-9a-f]\{64\}\).*/sha256:\1/p' | tail -n 1)"
  fi

  printf '%s' "$ref"
}

# 退回方案：直接读包里的 manifest.json，取 RepoTags[0]
ref_from_manifest() {

  local src="$1"

  tar -xOf "$src" manifest.json 2>/dev/null |
    tr -d '\n\r ' |
    sed -n 's/.*"RepoTags":\["\([^"]*\)".*/\1/p'
}

retag_loaded() {

  local loaded="$1"

  if [ -z "$loaded" ]; then
    die "无法识别刚加载的镜像名，请手动 docker tag 成 $NEW_REF 后重试"
  fi

  if [ "$loaded" = "$NEW_REF" ]; then
    log "包内镜像已经是 $NEW_REF"
    return 0
  fi

  docker_cmd tag "$loaded" "$NEW_REF" || \
    die "重标失败：$loaded → $NEW_REF"

  log "已把包内镜像 $loaded 重标为 $NEW_REF"
}

# ============================================================
# Docker 镜像
# ============================================================

loaded_ref_of() {

  # 从 `docker load` 的输出里取镜像名；没有标签的包退回镜像 ID
  local out="$1" ref

  ref="$(printf '%s\n' "$out" | sed -n 's/^Loaded image: //p' | tail -n 1)"

  if [ -z "$ref" ]; then
    ref="$(printf '%s\n' "$out" | sed -n 's/^Loaded image ID: sha256:\([0-9a-f]\{64\}\).*/sha256:\1/p' | tail -n 1)"
  fi

  printf '%s' "$ref"
}

# 退回方案：直接读包里的 manifest.json，取 RepoTags[0]
ref_from_manifest() {

  local src="$1"

  tar -xOf "$src" manifest.json 2>/dev/null |
    tr -d '\n\r ' |
    sed -n 's/.*"RepoTags":\["\([^"]*\)".*/\1/p'
}

retag_loaded() {

  local loaded="$1"

  if [ -z "$loaded" ]; then
    die "无法识别刚加载的镜像名，请手动 docker tag 成 $NEW_REF 后重试"
  fi

  if [ "$loaded" = "$NEW_REF" ]; then
    log "包内镜像已经是 $NEW_REF"
    return 0
  fi

  docker_cmd tag "$loaded" "$NEW_REF" || \
    die "重标失败：$loaded → $NEW_REF"

  log "已把包内镜像 $loaded 重标为 $NEW_REF"
}

if [ -n "$TAR" ]; then

  [ -f "$TAR" ] || \
    die "找不到镜像文件：$TAR"

  log "加载离线 Docker 镜像：$TAR"

  if [ "$DRY" = 1 ]; then

    printf '  [dry-run] docker load -i %q && docker tag <包内镜像> %q\n' "$TAR" "$NEW_REF"

  else

    load_src="$TAR"

    case "$TAR" in

      *.gz)

        # docker load 本身能吃 gz，这里还是先展开成普通 tar，
        # 好让后面读 manifest.json 的兜底逻辑用同一个路径
        tmp_tar="$(mktemp "${TMPDIR:-/tmp}/nasphere-image-XXXXXX.tar")"

        trap '[ -z "${tmp_tar:-}" ] || rm -f "$tmp_tar"' EXIT

        gunzip -c "$TAR" >"$tmp_tar"

        load_src="$tmp_tar"

        ;;

    esac

    load_out="$(docker_cmd load -i "$load_src")"

    printf '%s\n' "$load_out"

    loaded_ref="$(loaded_ref_of "$load_out")"

    if [ -z "$loaded_ref" ]; then
      loaded_ref="$(ref_from_manifest "$load_src")"
    fi

    retag_loaded "$loaded_ref"

    [ -z "${tmp_tar:-}" ] || rm -f "$tmp_tar"

  fi

else

  log "拉取 NASphere 镜像：$NEW_REF"

  if [ "$DRY" = 1 ]; then

    run docker_cmd pull "$NEW_REF"

  elif ! docker_cmd pull "$NEW_REF"; then

    warn "拉取失败：$NEW_REF"

    if [ "$ARCH" = arm64 ]; then
      warn "报的是 no matching manifest 的话：GHCR 上这个标签还没有 linux/arm64 那份（本仓库目前只发布 amd64）。"
      warn "两条退路：① 用离线包 ./deploy.sh --tar nasphere-$TAG-linux-arm64.tar.gz（load 完会自动重标成 $NEW_REF）；② 让仓库推多架构镜像（buildx --platform linux/amd64,linux/arm64）。"
    else
      warn "常见原因是这台机器到 ghcr.io 不通。换台机器 docker save 成离线包，再 ./deploy.sh --tar <包>。"
    fi

    die "镜像没弄到手，部署到此为止；data/ 没有被改动"

  fi

fi

if [ "$DRY" = 0 ]; then

  docker_cmd image inspect "$NEW_REF" >/dev/null 2>&1 || \
    die "镜像 $NEW_REF 不存在，拉取/加载失败"

fi

# ============================================================
# 启动容器
# ============================================================

up_with() {

  local ref="$1"
  local img tag

  img="${ref%:*}"
  tag="${ref##*:}"

  if [ -n "$COMPOSE_MODE" ]; then

    # 把脚本算好的最终值交给 compose，避免它再用 .env 里的默认值
    export IMAGE="$img"
    export TAG="$tag"
    export CONTAINER HOST_PORT DATA_DIR DOCKER_SOCK

    # 账号密码同理：compose 文件里那两个 ${...:-默认值} 要看到本次算好的值
    export NAV_USER NAV_PASSWORD SESSION_DAYS MAX_BODY TZ

    run docker_compose_cmd up -d --remove-orphans

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
    -p "$HOST_PORT:18086" \
    -e "NAV_USER=$NAV_USER" \
    -e "NAV_PASSWORD=$NAV_PASSWORD" \
    -e "SESSION_DAYS=$SESSION_DAYS" \
    -e "MAX_BODY=$MAX_BODY" \
    -e "TZ=$TZ" \
    -v "$DATA_DIR:/data" \
    ${sock[@]+"${sock[@]}"} \
    "$ref"
}

# ============================================================
# 启动
# ============================================================

log "启动 NASphere"

compose_run up -d --remove-orphans

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

probe_url() {

  local url="$1"

  if command -v curl >/dev/null 2>&1; then
    curl -fsS -m 3 -o /dev/null "$url"
    return $?
  fi

  if command -v wget >/dev/null 2>&1; then
    wget -q -T 3 -O /dev/null "$url"
    return $?
  fi

  return 1
}

# 宿主机上既没有 curl 也没有 wget 时，进到刚起的容器里用 node 自己探
probe_in_container() {

  docker_cmd exec \
    "$CONTAINER" \
    node \
    -e \
    "require('http').get('http://127.0.0.1:'+(process.env.PORT||18086)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" \
    >/dev/null 2>&1
}

probe() {

  probe_url "http://127.0.0.1:$HOST_PORT/api/health" && return 0

  # 服务绑定了特定地址时，退回用局域网 IP 探一次
  probe_url "http://$(lan_ip):$HOST_PORT/api/health" && return 0

  probe_in_container
}

if [ "$DRY" = 1 ]; then

  printf '\n'
  printf '上面这些 [dry-run] 就是本次要做的事；把 --dry-run 去掉就照这个执行。\n'

  success "dry-run 完成，没有下载、没有落盘"

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
    --filter "label=com.docker.compose.project=$COMPOSE_PROJECT" \
    --format '  {{.Names}} ｜ {{.Status}} ｜ {{.Image}}' \
    2>/dev/null || true

  printf '\n'

  printf '安装目录：\n'
  printf '  %s\n' "$ROOT"

  printf '\n'

  printf '数据目录：\n'
  printf '  %s\n' "$DATA_DIR"

  printf '\n'

  if [ "$FIRST_RUN" = 1 ]; then

    printf '\033[33m------------------------------------------\033[0m\n'

    printf '首次启动，登录账号：\n'
    printf '  用户名：%s\n' "$NAV_USER"
    printf '  密码　：%s\n' "$NAV_PASSWORD"

    printf '\n'

    if [ "$PASSWORD_GENERATED" = 1 ]; then

      printf '这个密码是本次安装随机生成的，不是默认密码。\n'
      printf '已留档在：%s/.env（权限 600，忘记密码时在这里查）\n' "$ROOT"

    else

      printf '密码来自 NAV_PASSWORD（环境变量或 .env）。\n'

    fi

    printf '\n'
    warn "请立刻记下密码，并登录后在「设置 → 安全」改成自己的"

    printf '\n'

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
printf '容器状态：\n'
docker_cmd ps -a \
  --filter "name=$CONTAINER" \
  --format '  {{.Names}} ｜ {{.Status}} ｜ {{.Image}}' \
  2>/dev/null || true

printf '\n'
printf '容器最后 30 行日志：\n'

compose_cmd logs --tail 30 2>&1 |
  sed 's/^/  /' || true

printf '\n'

# ============================================================
# 自动回滚
# ============================================================

if [ -n "$PREV_ID" ]; then

  warn "尝试自动回滚到旧版本：${PREV_ID:0:12}"

  # 把旧镜像重新指到 compose 里那个标签上：compose 文件不用改，up 一次就退回去。
  # 代价是本机这个标签暂时不等于 GHCR 上那份，下次重跑脚本 pull 到了就正回来。
  docker_cmd tag \
    "$PREV_ID" \
    "$NEW_REF" \
    2>/dev/null || true

  if docker_cmd image inspect "$NEW_REF" >/dev/null 2>&1; then

    up_with "$NEW_REF"

    R=0

    while [ "$R" -lt 10 ]; do
      sleep 2
      if probe 2>/dev/null; then
        success "已成功回滚到旧版本，$HOST_PORT 端口仍然可用"
        break
      fi
      R=$((R + 1))
    done

  fi

  warn "新版本部署失败，旧版本回滚也没能通过探活"
  printf '\n'
  printf '旧版本镜像仍然在本机：%s:rollback\n' "$IMAGE"
  printf '要退回它：docker tag %s:rollback %s，再用平时的方式起容器（docker compose up -d，或直接 ./deploy.sh --tar <上版本的包>）。\n' "$IMAGE" "$NEW_REF"
  printf '\n'

fi

die "NASphere 部署失败，请检查：docker logs $CONTAINER"
