#!/usr/bin/env bash
# 在任意有 Docker 的机器上把镜像导出成 tar.gz，上传到 NAS 后用 ./deploy.sh --tar 加载。
set -euo pipefail

cd "$(dirname "$0")"

IMAGE="${IMAGE:-local/nasphere}"
OUT_DIR="${OUT_DIR:-dist}"
TAG="${TAG:-$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' package.json 2>/dev/null | head -n 1 || true)}"
TAG="${TAG:-latest}"

while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG="${2:?--tag 后面要跟标签}"; shift 2 ;;
    --out) OUT_DIR="${2:?--out 后面要跟目录}"; shift 2 ;;
    -h|--help)
      printf '用法：./make-image.sh [--tag 标签] [--out 目录]\n'
      exit 0
      ;;
    *) printf '\033[31m✕\033[0m 未知参数：%s\n' "$1" >&2; exit 2 ;;
  esac
done

[ -n "$(type -P docker)" ] || { printf '\033[31m✕\033[0m 没有 docker\n' >&2; exit 1; }
docker version >/dev/null 2>&1 || { printf '\033[31m✕\033[0m 连不上 docker 守护进程，试试 sudo ./make-image.sh\n' >&2; exit 1; }

REF="$IMAGE:$TAG"
FILE="$OUT_DIR/nasphere-$TAG.tar.gz"

printf '\033[36m›\033[0m 构建 %s\n' "$REF"
docker build -t "$REF" .

mkdir -p "$OUT_DIR"
printf '\033[36m›\033[0m 导出 %s\n' "$FILE"
docker save "$REF" | gzip > "$FILE"

if [ -n "$(type -P sha256sum)" ]; then
  sha256sum "$FILE" > "$FILE.sha256"
else
  shasum -a 256 "$FILE" > "$FILE.sha256"
fi

printf '\033[32m✓\033[0m 已导出 %s（%s）\n' "$FILE" "$(du -h "$FILE" | awk '{print $1}')"
cat <<EOF

传到 NAS 后在 NAS 的项目目录里执行：
  ./deploy.sh --tar $FILE

校验：sha256sum -c $(basename "$FILE").sha256
EOF
