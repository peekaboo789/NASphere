#!/bin/bash
# Docker 镜像构建脚本 - 跨平台兼容（Linux / macOS / Windows Git Bash）
# 用法: ./build-docker.sh [TAG]
# 示例: ./build-docker.sh iptv-auto-tester:20261009

set -euo pipefail

# 获取脚本所在目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 默认标签
TAG="${1:-iptv-auto-tester:latest}"

echo "=========================================="
echo "IPTV Auto Tester Docker 镜像构建"
echo "=========================================="
echo "标签: $TAG"
echo "目录: $SCRIPT_DIR"
echo ""

# 检查 Docker 是否可用
if ! command -v docker &>/dev/null; then
    echo "[错误] 未找到 docker 命令，请先安装 Docker"
    exit 1
fi

# 检查必要文件是否存在
for file in Dockerfile requirements.txt app/main.py; do
    if [ ! -e "$file" ]; then
        echo "[错误] 缺少必要文件: $file"
        exit 1
    fi
done

echo "[1/3] 清理旧的构建缓存..."
docker system prune -f --filter "until=24h" 2>/dev/null || true

echo "[2/3] 构建 Docker 镜像..."
docker build \
    --no-cache \
    --pull \
    -t "$TAG" \
    .

if [ $? -ne 0 ]; then
    echo "[错误] Docker 镜像构建失败"
    exit 1
fi

echo "[3/3] 验证镜像..."
IMAGE_ID=$(docker images -q "$TAG" | head -n1)
IMAGE_SIZE=$(docker images "$TAG" --format "{{.Size}}" | head -n1)

echo ""
echo "=========================================="
echo "构建成功！"
echo "=========================================="
echo "镜像: $TAG"
echo "ID:   $IMAGE_ID"
echo "大小: $IMAGE_SIZE"
echo ""
echo "下一步操作："
echo "  1. 保存为 tar 文件:"
echo "     docker save $TAG > iptv-auto-tester.tar"
echo ""
echo "  2. 在其他机器上加载:"
echo "     docker load < iptv-auto-tester.tar"
echo ""
echo "  3. 或直接运行:"
echo "     docker run -d --name iptv-tester \\"
echo "       -p 9001:9001 \\"
echo "       -v /path/to/data:/data \\"
echo "       $TAG"
echo "=========================================="
