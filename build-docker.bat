@echo off
REM Docker 镜像构建脚本 - Windows 版本
REM 用法: build-docker.bat [TAG]
REM 示例: build-docker.bat iptv-auto-tester:20261009

setlocal enabledelayedexpansion

REM 获取脚本所在目录
cd /d "%~dp0"

REM 默认标签
set TAG=%1
if "%TAG%"=="" set TAG=iptv-auto-tester:latest

echo ==========================================
echo IPTV Auto Tester Docker 镜像构建
echo ==========================================
echo 标签: %TAG%
echo 目录: %CD%
echo.

REM 检查 Docker 是否可用
where docker >nul 2>&1
if errorlevel 1 (
    echo [错误] 未找到 docker 命令，请先安装 Docker Desktop
    pause
    exit /b 1
)

REM 检查必要文件是否存在
for %%f in (Dockerfile requirements.txt app\main.py) do (
    if not exist "%%f" (
        echo [错误] 缺少必要文件: %%f
        pause
        exit /b 1
    )
)

echo [1/3] 构建 Docker 镜像...
docker build --no-cache --pull -t "%TAG%" .

if errorlevel 1 (
    echo [错误] Docker 镜像构建失败
    pause
    exit /b 1
)

echo [2/3] 验证镜像...
for /f "tokens=*" %%i in ('docker images -q "%TAG%"') do set IMAGE_ID=%%i
for /f "tokens=*" %%i in ('docker images "%TAG%" --format "{{.Size}}"') do set IMAGE_SIZE=%%i

echo.
echo ==========================================
echo 构建成功！
echo ==========================================
echo 镜像: %TAG%
echo ID:   %IMAGE_ID%
echo 大小: %IMAGE_SIZE%
echo.
echo 下一步操作：
echo   1. 保存为 tar 文件:
echo      docker save %TAG% ^> iptv-auto-tester.tar
echo.
echo   2. 在其他机器上加载:
echo      docker load ^< iptv-auto-tester.tar
echo.
echo   3. 或直接运行:
echo      docker run -d --name iptv-tester ^
echo        -p 9001:9001 ^
echo        -v D:\iptv\data:/data ^
echo        %TAG%
echo ==========================================
pause
