@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title 安卓控制台 - 开发版

set "CHECK_ONLY=0"
set "PROJECT_ENTERED=0"
set "EXIT_CODE=1"
if /i "%~1"=="--check" set "CHECK_ONLY=1"

set "FAIL_REASON=无法进入脚本所在的项目目录。"
pushd "%~dp0" >nul 2>&1
if errorlevel 1 goto :failed
set "PROJECT_ENTERED=1"

set "FAIL_REASON=项目文件不完整，请将此脚本放在项目根目录。"
if not exist "package.json" goto :failed
if not exist "package-lock.json" goto :failed
if not exist "src-tauri\Cargo.toml" goto :failed
if not exist "src-tauri\tauri.conf.json" goto :failed

echo 正在检查开发环境...
set "FAIL_REASON=未找到 Node.js，请安装 Node.js LTS 并将其加入 PATH，然后重新打开此脚本。"
where.exe node.exe >nul 2>&1
if errorlevel 1 goto :failed
node.exe --version
set "FAIL_REASON=Node.js 版本过低或不受支持。需要 Node.js 20.19+（20.x）或 22.12+，建议使用 24 LTS。"
node.exe -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit((major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22 ? 0 : 1)" >nul 2>&1
if errorlevel 1 goto :failed

set "FAIL_REASON=未找到可用的 npm，请检查 Node.js 安装及 PATH。"
where.exe npm.cmd >nul 2>&1
if errorlevel 1 goto :failed
call npm.cmd --version
if errorlevel 1 goto :failed

where.exe cargo.exe >nul 2>&1
if errorlevel 1 if exist "%USERPROFILE%\.cargo\bin\cargo.exe" set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
set "FAIL_REASON=未找到可用的 Rust 工具链，请安装 Rust MSVC 工具链及 Visual Studio C++ 生成工具后重试。"
where.exe cargo.exe >nul 2>&1
if errorlevel 1 goto :failed
cargo.exe --version
if errorlevel 1 goto :failed
rustc.exe --version
if errorlevel 1 goto :failed

if "%CHECK_ONLY%"=="1" goto :check_ok
if not exist "node_modules\.bin\tauri.cmd" goto :install_dependencies
if not exist "node_modules\.bin\vite.cmd" goto :install_dependencies
goto :launch

:install_dependencies
echo.
echo 前端依赖尚未准备好，正在按锁定版本安装，首次安装需要网络...
set "FAIL_REASON=前端依赖安装失败。请查看上方日志，检查网络和 npm 配置后重试。"
call npm.cmd ci --include=dev
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" goto :failed

:launch
echo.
echo 正在启动安卓控制台开发版，请等待编译完成...
echo 请保持此窗口打开；需要停止开发服务时按 Ctrl+C。
echo.
set "FAIL_REASON=桌面开发版启动或运行失败。请查看上方日志；若端口 1420 已被占用，请先检查是否已有开发实例。"
call npm.cmd run tauri -- dev
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" goto :failed
popd
exit /b 0

:check_ok
echo.
echo 环境检查通过。本次未安装依赖，也未启动桌面窗口。
if not exist "node_modules\.bin\tauri.cmd" echo 提示：正式启动时会自动安装缺少的前端依赖。
if exist "node_modules\.bin\tauri.cmd" if not exist "node_modules\.bin\vite.cmd" echo 提示：正式启动时会自动安装缺少的前端依赖。
popd
exit /b 0

:failed
if "%EXIT_CODE%"=="0" set "EXIT_CODE=1"
echo.
echo [失败] %FAIL_REASON%
echo 退出码：%EXIT_CODE%
if "%CHECK_ONLY%"=="0" pause
if "%PROJECT_ENTERED%"=="1" popd
exit /b %EXIT_CODE%
