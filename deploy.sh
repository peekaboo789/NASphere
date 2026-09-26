#!/usr/bin/env bash
# NASphere 一键安装 / 部署 / 升级 / 回滚 / 卸载
#
# 这个脚本不需要源码，也不在本机 build 镜像。它做五件事：
#
#   1. 检测 CPU 架构
#   2. 准备安装目录（默认 ./dat）
#   3. 生成 docker-compose.yml
#   4. 从 GHCR 拉镜像：docker pull ghcr.io/peekaboo789/nasphere:1.0.4
#   5. 起容器：docker compose up -d
#
# 装完之后目录里只有两样东西：compose 文件（每次部署由脚本重写）和 data/
# （你的配置、账号、壁纸、图标）。升级、回滚都只动镜像，data/ 一个字节都不碰。
#
# 用法一：全新 NAS，一条命令装
#
#   curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/peekaboo789/NASphere/main/deploy.sh | bash
#
#   管道执行时 stdin 已经被脚本占着，要带参数得走 bash -s --：
#   curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/peekaboo789/NASphere/main/deploy.sh | \
#     bash -s -- --root /volume1/docker/NASphere --port 9000
#
# 用法二：本机已经有安装目录（cd 进去直接跑就是升级）
#
#   cd ./dat
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

# 镜像仓库。想换成自己的 fork 或内网镜像仓库，用 IMAGE / TAG 覆盖即可
DEFAULT_IMAGE="ghcr.io/peekaboo789/nasphere"

# 默认镜像标签。发新版时改这一行（要和 ghcr.io 上推上去的标签对得上）。
# 这里故意不跟 latest：latest 哪天被重推，机器上跑的东西就跟着变了，退不回去。
DEFAULT_TAG="1.0.4"

# 容器内监听端口，和镜像里的 ENV PORT 一致。要改只改宿主机那侧（--port / HOST_PORT）
APP_PORT="18086"

# compose 项目名。不写 container_name 之后容器叫 <项目名>-nasphere-1，
# 脚本一律用项目名 + compose 文件定位容器，不认死容器名，多装几套也不会撞名。
COMPOSE_PROJECT="${COMPOSE_PROJECT:-nasphere}"

# 安装目录的默认值：执行命令时所在目录下的 dat/
DEFAULT_ROOT="${DEFAULT_ROOT:-./dat}"

# 生成的 compose 文件头部标记。靠它区分「脚本产物」和「用户手写的文件」，
# 后者被覆盖前先留一份备份
GENERATED_KEY="由 NASphere deploy.sh 生成"

# curl | bash 时 BASH_SOURCE[0] 是未定义的，$0 才是 "bash"。
# 这里必须带 :- 回落，否则 set -u 会让脚本在下一行直接死掉，
# 那条一键安装命令连一行输出都不会有。
SCRIPT_SRC="${BASH_SOURCE[0]:-$0}"

if [ -f "$SCRIPT_SRC" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SRC")" && pwd)"
else
  # 脚本从管道读进来，不在磁盘上：只能以当前目录作候选
  SCRIPT_DIR="$PWD"
fi

# 就地部署的两种情形：脚本旁边就是 NASphere 项目目录，或者已经放着一份本脚本生成的 compose
LOCAL_MODE=0
LOCAL_WHY=""

if [ -f "$SCRIPT_DIR/Dockerfile" ] && [ -f "$SCRIPT_DIR/server/index.js" ]; then
  LOCAL_MODE=1
  LOCAL_WHY="脚本旁边就是 NASphere 项目目录"
elif [ -f "$SCRIPT_DIR/docker-compose.yml" ] &&
  grep -q "$GENERATED_KEY" "$SCRIPT_DIR/docker-compose.yml" 2>/dev/null; then
  LOCAL_MODE=1
  LOCAL_WHY="脚本旁边已经有本脚本生成的 docker-compose.yml"
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
ENV_HOST_PORT="${HOST_PORT:-}"
ENV_DATA_DIR="${DATA_DIR:-}"
ENV_TAG="${TAG:-}"
ENV_HEALTH_WAIT="${HEALTH_WAIT:-}"
ENV_KEEP_BACKUPS="${KEEP_BACKUPS:-}"
ENV_DOCKER_SOCK="${DOCKER_SOCK:-}"
ENV_TZ="${TZ:-}"
ENV_HOST_VOLUMES="${HOST_VOLUMES:-}"

# 安装目录，也允许从环境传进来
ENV_INSTALL_ROOT="${INSTALL_ROOT:-}"

# 命令行槽位（下面按参数填）
TAR=""
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

流程：检测 CPU 架构 → 准备目录 → 生成 docker-compose.yml → 从 GHCR 拉镜像 → docker compose up -d。
不需要源码，不在本机 build。

两种用法，自动判断：

  用法一 全新 NAS 一条命令装（本机不需要先有项目）：
    curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/peekaboo789/NASphere/main/deploy.sh | bash

    管道执行时 stdin 已被脚本占用，要带参数得用 bash -s --：
    curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/peekaboo789/NASphere/main/deploy.sh | \
      bash -s -- --root /volume1/docker/NASphere --port 9000

    装到 --root（或 INSTALL_ROOT），默认 ./dat，也就是执行命令时所在目录下的 dat/；
    那个目录已经在跑 NASphere 就等于原地升级，data/ 不会被覆盖。

  用法二 本机已经有安装目录（cd 进去直接跑就是升级）：
    cd ./dat
    ./deploy.sh

选项：

  --root <目录>        安装到哪里，默认 ./dat（相对当前目录）
  --tar <文件>         加载 docker save 导出的离线镜像包，跳过从 GHCR 拉取
  --tag <标签>         镜像标签，默认 1.0.4
  --port <端口>        宿主机端口，默认 18086（容器内固定监听 18086）
  --data-dir <路径>    数据目录，默认 <安装目录>/data
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
  HOST_VOLUMES
  COMPOSE_PROJECT

生效顺序：命令行 > 环境变量 > .env > 默认值

.env 读的是安装目录里那一份（<安装目录>/.env），不是执行命令时的当前目录。

默认：

  安装目录：
    ./dat

  镜像：
    ghcr.io/peekaboo789/nasphere:1.0.4

  compose 项目名：
    nasphere

  宿主机端口：
    18086

  数据：
    ./data

  时区：
    Asia/Shanghai

  逐卷读数（HOST_VOLUMES）：
    留空 = 自动探测这台 NAS 上挂载的存储池，每一卷各加一行只读挂载进 /host/<目录名>，
    主页的读数卡因此能看见全部卷和硬盘。NAS 上新增或删除卷之后要重跑一次本脚本才会更新。
    想固定清单就写成空格分隔的绝对路径；HOST_VOLUMES=none 表示只挂数据目录、不探测。

  初始账号 / 密码：
    admin / admin123（镜像内置的默认值，装完立刻登录去「设置 → 安全」改掉）

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

# 后面会 cd 进安装目录，所以所有相对路径都先按调用时的目录定死，
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
      printf '%q ' "$a"
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
# 检查 Compose：新版整套部署都靠它起容器
# ============================================================

# v2 = `docker compose`，v1 = 独立的 docker-compose，空 = 没有 compose
COMPOSE_MODE=""

if docker_cmd compose version >/dev/null 2>&1; then
  COMPOSE_MODE="v2"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_MODE="v1"
fi

if [ "$COMPOSE_MODE" = "" ]; then
  die "这台机器上没有 docker compose（v2 或独立的 docker-compose 都行）。本脚本一律用 compose 起容器，装不了。"
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

# 所有 compose 操作都锁定「安装目录里那份文件 + 固定项目名」：
# 不受当前目录名影响，也不会误伤机器上别的 compose 项目
compose_cmd() {
  docker_compose_cmd -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT" "$@"
}

compose_run() {
  run docker_compose_cmd -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT" "$@"
}

# 本项目容器的 ID，一行一个。还没有 compose 文件（首次部署前）就是空。
compose_ids() {
  if [ ! -f "$COMPOSE_FILE" ]; then
    return 0
  fi
  compose_cmd ps -q 2>/dev/null || true
}

# ============================================================
# CPU 架构
# ============================================================

ARCH="$(uname -m 2>/dev/null || echo unknown)"

case "$ARCH" in
  x86_64 | amd64)
    ARCH="amd64"
    log "检测到 CPU 架构：AMD64（x86_64）"
    ;;
  aarch64 | arm64)
    ARCH="arm64"
    log "检测到 CPU 架构：ARM64（aarch64）"
    ;;
  *)
    die "不支持的 CPU 架构：$ARCH（只测过 x86_64 与 aarch64）"
    ;;
esac

# ============================================================
# 安装目录
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

if [ "$LOCAL_MODE" = 1 ] && [ -z "$INSTALL_ROOT" ] && [ -z "$ENV_INSTALL_ROOT" ]; then
  ROOT="$SCRIPT_DIR"
  log "就地部署：$ROOT"
  log "（$LOCAL_WHY）"
else
  # 默认值可以是相对路径（./dat），必须在这里按调用时的目录定死，
  # 后面会 cd 进安装目录，晚一步解析就会指到别处
  ROOT="$(absolute_path "${INSTALL_ROOT:-${ENV_INSTALL_ROOT:-$DEFAULT_ROOT}}")"
  log "安装目录：$ROOT"
  if [ "$LOCAL_MODE" = 1 ]; then
    log "（$LOCAL_WHY，但以 --root / INSTALL_ROOT 给的目录为准）"
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

COMPOSE_FILE="$ROOT/docker-compose.yml"

cd "$ROOT" || \
  die "无法进入目录：$ROOT"

# ============================================================
# 生效优先级：命令行 > 环境变量 > .env > 默认值
# ============================================================

# 命令行解析结果先挪进 CLI_ 槽位，后面 source .env 会占用同名变量
CLI_IMAGE="$IMAGE"
CLI_HOST_PORT="$HOST_PORT"
CLI_DATA_DIR="$DATA_DIR"
CLI_TAG="$TAG"
CLI_HEALTH_WAIT="$HEALTH_WAIT"
CLI_KEEP_BACKUPS="$KEEP_BACKUPS"
CLI_DOCKER_SOCK="$DOCKER_SOCK"

DOTENV_IMAGE=""
DOTENV_HOST_PORT=""
DOTENV_DATA_DIR=""
DOTENV_TAG=""
DOTENV_HEALTH_WAIT=""
DOTENV_KEEP_BACKUPS=""
DOTENV_DOCKER_SOCK=""
DOTENV_TZ=""
DOTENV_HOST_VOLUMES=""

if [ -f "$ROOT/.env" ]; then

  log "读取 $ROOT/.env"

  # 只取赋值行，并去掉 Windows 换行符，避免值结尾带一个 \r
  _env_file="$(mktemp "${TMPDIR:-/tmp}/nasphere-env-XXXXXX")"

  trap '[ -z "${_env_file:-}" ] || rm -f "$_env_file"' EXIT

  grep -E '^[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=' "$ROOT/.env" | tr -d '\r' >"$_env_file" || true

  IMAGE=""
  HOST_PORT=""
  DATA_DIR=""
  TAG=""
  HEALTH_WAIT=""
  KEEP_BACKUPS=""
  DOCKER_SOCK=""
  TZ=""
  HOST_VOLUMES=""

  set -a
  # shellcheck disable=SC1090
  . "$_env_file"
  set +a

  rm -f "$_env_file"
  trap - EXIT

  DOTENV_IMAGE="$IMAGE"
  DOTENV_HOST_PORT="$HOST_PORT"
  DOTENV_DATA_DIR="$DATA_DIR"
  DOTENV_TAG="$TAG"
  DOTENV_HEALTH_WAIT="$HEALTH_WAIT"
  DOTENV_KEEP_BACKUPS="$KEEP_BACKUPS"
  DOTENV_DOCKER_SOCK="$DOCKER_SOCK"
  DOTENV_TZ="$TZ"
  DOTENV_HOST_VOLUMES="$HOST_VOLUMES"

fi

# 一键安装新建的目录里没有 .env 是正常的，但有人习惯把 .env 留在当前目录，
# 这里提醒一句，别让人以为参数已经生效了
if [ ! -f "$ROOT/.env" ] && [ -f "$PWD/.env" ] && [ "$PWD" != "$SCRIPT_DIR" ]; then
  warn "$PWD/.env 不会被读取，.env 要放在 $ROOT/.env 才生效"
fi

IMAGE="${CLI_IMAGE:-${ENV_IMAGE:-${DOTENV_IMAGE:-$DEFAULT_IMAGE}}}"
HOST_PORT="${CLI_HOST_PORT:-${ENV_HOST_PORT:-${DOTENV_HOST_PORT:-$APP_PORT}}}"
TAG="${CLI_TAG:-${ENV_TAG:-${DOTENV_TAG:-$DEFAULT_TAG}}}"
HEALTH_WAIT="${CLI_HEALTH_WAIT:-${ENV_HEALTH_WAIT:-${DOTENV_HEALTH_WAIT:-40}}}"
KEEP_BACKUPS="${CLI_KEEP_BACKUPS:-${ENV_KEEP_BACKUPS:-${DOTENV_KEEP_BACKUPS:-5}}}"
DOCKER_SOCK="${CLI_DOCKER_SOCK:-${ENV_DOCKER_SOCK:-${DOTENV_DOCKER_SOCK:-/var/run/docker.sock}}}"

# TZ 没有命令行开关，但同样得按 环境变量 > .env > 默认值 排：
# 上面 source .env 用的是 set -a，不重新算一遍的话 .env 会反过来盖掉环境变量
TZ="${ENV_TZ:-${DOTENV_TZ:-Asia/Shanghai}}"

# 逐卷用量要挂进来的宿主机目录，同样没有命令行开关（这是一份清单，不是每次都换的参数）
HOST_VOLUMES="${ENV_HOST_VOLUMES:-${DOTENV_HOST_VOLUMES:-}}"

# 数据目录默认在安装目录里，所以要等 ROOT 定死之后再算
DATA_DIR="${CLI_DATA_DIR:-${ENV_DATA_DIR:-${DOTENV_DATA_DIR:-$ROOT/data}}}"

NEW_REF="$IMAGE:$TAG"

# ============================================================
# 参数校验
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

# 逐卷用量要挂进来的宿主机目录：HOST_VOLUMES 是空格分隔的清单，每一项各挂成 /host/<同名>:ro。
# 页面只从 /host 那一层数出有几个目录，就列几卷，所以这里唯一的口径就是把目录名摆正。
# 清单没写就先探一遍：家用 NAS 的存储池就那么几种摆法，探到的卷全部只读挂进来，主页于是能看见
# 这台机器上的每一卷。写 HOST_VOLUMES=none 才是「只挂数据目录、别探」。
EXTRA_MOUNTS=""
VOL_AUTO=0
VOL_SKIPPED=""

# 一卷的标志是「跟父目录不在同一个文件系统上」：同一个 st_dev 就是顺手建出来的空目录，不是卷
is_volume_mount() {
  local here there
  here="$(stat -c %d "$1" 2>/dev/null)" || return 1
  there="$(stat -c %d "$2" 2>/dev/null)" || return 1
  [ -n "$here" ] && [ -n "$there" ] && [ "$here" != "$there" ]
}

# 存储池的两种摆法：根目录下直接是池（/vol1 绿联 UGOS、/volume1 群晖），或者池挂在父目录下面（/mnt/*）
detect_host_volumes() {
  local found="" dir parent
  for dir in /vol[0-9] /vol[0-9][0-9] /volume[0-9] /volume[0-9][0-9] /storage[0-9] /data[0-9]; do
    case "$dir" in *'['* | *'*'*) continue ;; esac
    [ -d "$dir" ] || continue
    is_volume_mount "$dir" / || continue
    found="$found $dir"
  done
  for parent in /mnt /media /storage; do
    [ -d "$parent" ] || continue
    for dir in "$parent"/*; do
      case "$dir" in *'['* | *'*'*) continue ;; esac
      [ -d "$dir" ] || continue
      is_volume_mount "$dir" "$parent" || continue
      found="$found $dir"
    done
  done
  printf '%s' "$found" | sed 's/^ *//'
}

# 一个目录 → 一行只读挂载。自动探到的那些不合适就悄悄跳过（一堆目录不该打断安装），
# 他写在清单里的则照样报错——那是他明确点的名。
add_host_volume() {
  local host_vol="$1" auto="$2" vol_name

  case "$host_vol" in
    /*)
      ;;
    *)
      [ "$auto" = 1 ] && return 0
      die "HOST_VOLUMES 里每一项都得是绝对路径（中间不能带空格）：$host_vol"
      ;;
  esac

  vol_name="$(basename "$host_vol")"

  # 这个名字会直接写进 compose 的挂载点，也是卡片认卷用的 id，只留字母数字和 . _ -
  case "$vol_name" in
    '' | . | .. | .*)
      [ "$auto" = 1 ] && { VOL_SKIPPED="$VOL_SKIPPED $vol_name"; return 0; }
      die "HOST_VOLUMES 里这一项的目录名页面认不了（只能用字母、数字、点、减号、下划线）：$host_vol"
      ;;
    *[!A-Za-z0-9._-]*)
      [ "$auto" = 1 ] && { VOL_SKIPPED="$VOL_SKIPPED $vol_name"; return 0; }
      die "HOST_VOLUMES 里这一项的目录名页面认不了（只能用字母、数字、点、减号、下划线）：$host_vol"
      ;;
  esac

  # 数据目录所在那一卷已经挂在 /app/data 了，再挂一遍只会多出个同名卷
  case "$DATA_DIR/" in
    "$host_vol"/*)
      [ "$auto" = 1 ] && return 0
      ;;
  esac

  # 目录不存在时 compose 会替你先建一个空目录挂进来，看着就像一卷空的，所以这里提醒一句
  if [ ! -d "$host_vol" ]; then
    [ "$auto" = 1 ] && return 0
    warn "HOST_VOLUMES 里这个目录现在不存在：$host_vol"
  fi

  EXTRA_MOUNTS="${EXTRA_MOUNTS}      - ${host_vol}:/host/${vol_name}:ro
"
}

if [ "$HOST_VOLUMES" = "none" ]; then
  HOST_VOLUMES=""
else
  [ -n "$HOST_VOLUMES" ] || { HOST_VOLUMES="$(detect_host_volumes)"; VOL_AUTO=1; }
fi

# 探到的卷有个数上限：一堆目录全挂进来只会把 compose 撑成读不动的一长串
if [ "$VOL_AUTO" = 1 ]; then
  VOL_KEEP=""
  VOL_N=0
  for host_vol in $HOST_VOLUMES; do
    VOL_N=$((VOL_N + 1))
    [ "$VOL_N" -gt 16 ] && { VOL_SKIPPED="$VOL_SKIPPED $host_vol"; continue; }
    VOL_KEEP="$VOL_KEEP $host_vol"
  done
  HOST_VOLUMES="$(printf '%s' "$VOL_KEEP" | sed 's/^ *//')"
fi

for host_vol in $HOST_VOLUMES; do
  add_host_volume "$host_vol" "$VOL_AUTO"
done

# 容器起来之后服务端就会补写 auth.json，首启提示必须在启动前取样
FIRST_RUN=0

[ -f "$DATA_DIR/auth.json" ] || FIRST_RUN=1

# ============================================================
# 显示配置
# ============================================================

log "=========================================="
log "          NASphere 部署"
log "=========================================="

log "镜像：$NEW_REF"
[ "$UNINSTALL" = 1 ] || log "取镜像方式：docker pull（本机不需要源码，也不构建）"
log "容器：compose 项目 $COMPOSE_PROJECT → 容器名 ${COMPOSE_PROJECT}-nasphere-1"
log "端口：$HOST_PORT → 容器内 $APP_PORT"
log "数据：$DATA_DIR"
log "时区：$TZ"

if [ -n "$EXTRA_MOUNTS" ]; then
  if [ "$VOL_AUTO" = 1 ]; then
    log "逐卷用量：自动探到并挂进 $(printf '%s' "$EXTRA_MOUNTS" | grep -c .) 卷到 /host（只读）"
  else
    log "逐卷用量：按 HOST_VOLUMES 挂进 $(printf '%s' "$EXTRA_MOUNTS" | grep -c .) 卷到 /host（只读）"
  fi
  [ -n "$VOL_SKIPPED" ] && log "  跳过不像存储池的目录：$VOL_SKIPPED"
else
  [ "$VOL_AUTO" = 1 ] && log "逐卷用量：没探到额外的存储池，主页只列数据目录那一卷"
fi

if [ "$FIRST_RUN" = 1 ] && [ "$UNINSTALL" != 1 ]; then
  log "首次启动：账号 admin、密码 admin123（镜像内置默认值）"
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

    compose_run down --remove-orphans

  else

    if [ -f "$COMPOSE_FILE" ]; then
      log "用 Compose 停掉本项目"
      compose_cmd down --remove-orphans || true
    fi

    # 老版本用 docker run 起过一个就叫 nasphere 的容器，它会一直占着端口
    if docker_cmd inspect "$COMPOSE_PROJECT" >/dev/null 2>&1; then
      log "删除旧版本留下的同名容器：$COMPOSE_PROJECT"
      docker_cmd rm -f "$COMPOSE_PROJECT" || true
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

# 每次部署都按本次算好的参数重写它：喂给自己的容器，参数不能丢。
# 目录里如果躺着一份手写的 compose（比如从 GitHub 上直接拷下来那份），先备份再覆盖。
render_compose() {

  printf '# %s，请勿手改：下次部署会整个重写。\n' "$GENERATED_KEY"
  printf '# 要长期改端口、数据目录或逐卷读数的清单，就写在 %s/.env 里的 HOST_PORT / DATA_DIR / HOST_VOLUMES，然后重跑 ./deploy.sh。\n' "$ROOT"
  printf '# HOST_VOLUMES 留空是自动探测这台 NAS 的存储池全挂进来，none 是只挂数据目录；NAS 上加了卷也要重跑一次。\n'
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

  # 探到或指定的每一卷各一行只读挂载，主页的读数卡据此列出对应的卷
  if [ -n "$EXTRA_MOUNTS" ]; then
    printf '%s' "$EXTRA_MOUNTS"
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
# 准备镜像：离线包 load，或从 GHCR 拉
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

    printf '  [dry-run] docker load -i %q && docker tag <包内镜像> %q（跳过 docker pull）\n' "$TAR" "$NEW_REF"

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

  local cid
  cid="$(compose_ids | head -n 1)"

  [ -n "$cid" ] || return 1

  docker_cmd exec \
    "$cid" \
    node \
    -e \
    "require('http').get('http://127.0.0.1:'+(process.env.PORT||$APP_PORT)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" \
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
    printf '  用户名：admin\n'
    printf '  密码　：admin123\n'

    printf '\n'
    printf '这是镜像内置的默认密码，公开仓库上人人可查。\n'

    if [ -S "$DOCKER_SOCK" ]; then
      printf '而且这个容器挂了 docker.sock，页面账号等于能启停宿主机上的容器。\n'
    fi

    printf '登录后立刻去「设置 → 安全」把账号和密码一起改掉。\n'

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
  --filter "label=com.docker.compose.project=$COMPOSE_PROJECT" \
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

    compose_cmd up -d --remove-orphans || true

    R=0

    while [ "$R" -lt 10 ]; do
      sleep 2
      if probe 2>/dev/null; then
        success "已成功回滚到旧版本，$HOST_PORT 端口仍然可用"
        printf '本机 %s 现在指向的是旧镜像（另外留了一份 %s:rollback）。\n' "$NEW_REF" "$IMAGE"
        printf '\n'
        exit 1
      fi
      R=$((R + 1))
    done

  fi

  warn "新版本部署失败，旧版本回滚也没能通过探活"
  printf '\n'
  printf '旧版本镜像仍然在本机：%s:rollback\n' "$IMAGE"
  printf '退回它（别再直接跑 ./deploy.sh，那会把坏的那份重新 pull 回来）：\n'
  printf '  docker tag %s:rollback %s\n' "$IMAGE" "$NEW_REF"
  printf '  cd %q && docker compose up -d\n' "$ROOT"
  printf '或者拿上一版本的离线包走这条：./deploy.sh --tar <包>（它跳过 pull）\n'
  printf '\n'

fi

printf '手工排查：cd %q && docker compose -p %q logs --tail 50\n' "$ROOT" "$COMPOSE_PROJECT"

die "NASphere 部署失败"
