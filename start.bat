@echo off
setlocal
chcp 65001 >nul
title ICPC Workbench

cd /d "%~dp0"

echo [ICPC Workbench] 正在检查运行环境...

where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo [错误] 未找到 Node.js。
    echo 请安装 Node.js 22.16 或更高版本后重试：
    echo https://nodejs.org/
    goto :error
)

where npm >nul 2>&1
if errorlevel 1 (
    echo.
    echo [错误] 未找到 npm，请重新安装 Node.js 后重试。
    goto :error
)

for /f "tokens=1,2 delims=." %%A in ('node -p "process.versions.node"') do (
    set "NODE_MAJOR=%%A"
    set "NODE_MINOR=%%B"
)

if %NODE_MAJOR% LSS 22 goto :old_node
if %NODE_MAJOR% EQU 22 if %NODE_MINOR% LSS 16 goto :old_node

echo [正常] Node.js %NODE_MAJOR%.%NODE_MINOR%

if not exist "node_modules\" (
    echo.
    echo [首次运行] 正在安装项目依赖，请保持网络连接...
    call npm install
    if errorlevel 1 (
        echo.
        echo [错误] 依赖安装失败，请检查网络连接和上方错误信息。
        goto :error
    )
)

echo.
echo [启动] 正在启动前端和后端服务...
echo 浏览器将在服务就绪后自动打开：http://localhost:5173
echo 需要停止服务时，请在此窗口按 Ctrl+C。
echo.

start "" powershell.exe -NoProfile -WindowStyle Hidden -Command "$url='http://localhost:5173'; for ($i=0; $i -lt 60; $i++) { try { $response=Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 1; if ($response.StatusCode -ge 200) { Start-Process $url; break } } catch {}; Start-Sleep -Seconds 1 }"

call npm run dev
set "DEV_EXIT=%ERRORLEVEL%"

echo.
if not "%DEV_EXIT%"=="0" echo [错误] 开发服务已异常退出，退出代码：%DEV_EXIT%
if "%DEV_EXIT%"=="0" echo [提示] 开发服务已停止。
pause
exit /b %DEV_EXIT%

:old_node
echo.
echo [错误] 当前 Node.js 版本为：
node --version
echo 本项目要求 Node.js 22.16 或更高版本。
echo 下载地址：https://nodejs.org/
goto :error

:error
echo.
pause
exit /b 1
