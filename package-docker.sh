#!/bin/bash
# Docker 镜像完整打包脚本 - 跨平台兼容
# 用法: ./package-docker.sh [TAG] [OUTPUT_DIR]
# 示例: ./package-docker.sh iptv-auto-tester:20261009 /tmp/release

set -euo pipefail

# 获取脚本所在目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 参数
TAG="${1:-iptv-auto-tester:latest}"
OUTPUT_DIR="${2:-$SCRIPT_DIR/release}"

# 生成日期标签（如果用户没指定具体标签）
if [ "$TAG" = "iptv-auto-tester:latest" ]; then
    TAG="iptv-auto-tester:$(date +%Y%m%d)"
fi

echo "=========================================="
echo "IPTV Auto Tester Docker 镜像打包"
echo "=========================================="
echo "标签: $TAG"
echo "输出目录: $OUTPUT_DIR"
echo ""

# 创建输出目录
mkdir -p "$OUTPUT_DIR"

# 检查 Docker 是否可用
if ! command -v docker &>/dev/null; then
    echo "[错误] 未找到 docker 命令"
    exit 1
fi

# 先构建镜像
echo "[1/4] 构建 Docker 镜像..."
bash "$SCRIPT_DIR/build-docker.sh" "$TAG"

# 保存为 tar 文件
TAR_FILE="$OUTPUT_DIR/$(echo $TAG | tr ':' '_').tar"
echo "[2/4] 保存为 tar 文件: $TAR_FILE"
docker save "$TAG" > "$TAR_FILE"

# 压缩为 tar.gz（可选，节省空间）
echo "[3/4] 压缩为 tar.gz..."
GZ_FILE="${TAR_FILE%.tar}.tar.gz"
gzip -c "$TAR_FILE" > "$GZ_FILE"

# 生成校验和
echo "[4/4] 生成校验和..."
cd "$OUTPUT_DIR"
sha256sum "$(basename "$TAR_FILE")" "$(basename "$GZ_FILE")" > SHA256SUMS.txt

# 显示结果
TAR_SIZE=$(du -h "$TAR_FILE" | cut -f1)
GZ_SIZE=$(du -h "$GZ_FILE" | cut -f1)

echo ""
echo "=========================================="
echo "打包完成！"
echo "=========================================="
echo "tar 文件:  $TAR_FILE ($TAR_SIZE)"
echo "gz 文件:   $GZ_FILE ($GZ_SIZE)"
echo ""
echo "在其他机器上加载："
echo "  docker load < $GZ_FILE"
echo ""
echo "或者先解压再加载："
echo "  gunzip -c $GZ_FILE | docker load"
echo "=========================================="
