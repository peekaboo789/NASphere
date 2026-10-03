# IPTV Auto Tester 运行镜像
# 依赖全部装在镜像里：宿主机只需要 Docker，不需要 Python / ffmpeg。
FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    DATA_DIR=/data \
    PORT=9001 \
    TZ=Asia/Shanghai

# ffmpeg/ffprobe：真正拉流检测用；curl 用于健康检查；tzdata 用于时区
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        ffmpeg \
        tzdata \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

# 先装依赖再拷代码，改代码不会重复触发 pip 层重建
COPY requirements.txt /srv/requirements.txt
RUN pip install --no-cache-dir -r /srv/requirements.txt

# 只拷贝应用代码：dev-tools/ 里的假源和验证脚本不进镜像，产品里不会有合成数据
COPY app /srv/app

# 以 uid=1000 运行（多数 NAS 上 /vol2/1000/... 的属主就是 1000）
RUN useradd --create-home --uid 1000 --shell /usr/sbin/nologin iptv \
    && mkdir -p /data/output /data/logs \
    && chown -R iptv:iptv /data /srv
USER iptv

EXPOSE 9001

HEALTHCHECK --interval=30s --timeout=8s --start-period=25s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" || exit 1

# shell 形式，方便 ${PORT} 生效
CMD ["sh", "-c", "exec python -m uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --log-level warning --timeout-graceful-shutdown 15"]
