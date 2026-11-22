@echo off
chcp 65001 >nul
title Danbooru Prompt V1.0 本地标签库同步服务
cd /d "%~dp0"
echo ================================================================
echo   [Danbooru Prompt V1.0] 正在启动本地模块化同步服务...
echo   提示：请保持此黑色窗口开启，关闭窗口将停止文件夹实时写入同步。
echo ================================================================
set AUTO_OPEN_BROWSER=1
where node >nul 2>nul
if %errorlevel% equ 0 (
    echo [启动引擎] 检测到 Node.js，正在启动零依赖本地服务...
    node "%~dp0tag-server.mjs"
    goto :end
)
where python >nul 2>nul
if %errorlevel% equ 0 (
    echo [启动引擎] 未检测到 Node.js，正在使用 Python 备用服务启动...
    python "%~dp0script\tag_server.py"
    goto :end
)
where py >nul 2>nul
if %errorlevel% equ 0 (
    echo [启动引擎] 正在使用 Python Launcher (py) 启动本地服务...
    py -3 "%~dp0script\tag_server.py"
    goto :end
)
echo [提示] 未检测到 Node.js 或 Python，将以纯静态离线模式打开网页...
if exist "%~dp0danbooru_prompt.html" (
    start "" "%~dp0danbooru_prompt.html"
) else (
    echo [错误] 未找到 Node.js 或 Python 环境，请安装 Node.js ^(推荐^) 或 Python 3 后重试。
    pause
)
:end
if %errorlevel% neq 0 (
    echo.
    echo [异常退出] 服务未能正常启动，请检查上方报错信息。
    pause
)
