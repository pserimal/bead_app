@echo off
chcp 65001 >nul
rem bead-local-server 一键启动（局域网 Web 应用，无需 JDK/Python/Node）
rem 前端由服务从本目录 dist\ 磁盘读取（改版只需替换 dist\，无需重编/重启服务）。
rem 服务绑定 0.0.0.0（局域网可访问），后台无窗口运行（日志: data\server.log），
rem 本窗口自动关闭并自动打开浏览器。停止请运行 stop-local.bat，重启请运行 restart-local.bat
setlocal

set "ROOT=%~dp0"

rem ── onnxruntime.dll：exe 旁（发布版）；无则尝试 conda bead-train 环境（开发机）──
if exist "%ROOT%onnxruntime.dll" (
    set "ORT_DYLIB_PATH=%ROOT%onnxruntime.dll"
) else if defined CONDA_PREFIX (
    set "ORT_DYLIB_PATH=%CONDA_PREFIX%\Lib\site-packages\onnxruntime\capi\onnxruntime.dll"
)

rem ── 数据与配置默认值（本目录自包含）──
if not defined BEAD_PORT set "BEAD_PORT=5173"
if not defined BEAD_DB_PATH set "BEAD_DB_PATH=%ROOT%data\bead-local.db"
if not defined BEAD_UPLOADS_DIR set "BEAD_UPLOADS_DIR=%ROOT%uploads"
if not defined BEAD_COLORS_PATH set "BEAD_COLORS_PATH=%ROOT%data\default_colors.json"
if not defined BEAD_LIBRARY_PATH set "BEAD_LIBRARY_PATH=%ROOT%data\library.json"
if not defined BEAD_ARTIFACT_DIR set "BEAD_ARTIFACT_DIR=%ROOT%models\bean-mard-v12-2026-08-15T10-39-29Z"

echo [start] 正在后台启动 bead-local-server（绑定 0.0.0.0，端口 %BEAD_PORT%）...

rem ── 后台无窗口启动（日志落盘，窗口不驻留）──
powershell.exe -NoProfile -Command "Start-Process -FilePath '%ROOT%bead-local-server.exe' -WindowStyle Hidden -RedirectStandardOutput '%ROOT%data\server.log' -RedirectStandardError '%ROOT%data\server.err.log'"

rem ── 等待端口就绪（最多 ~60 秒；ping 延迟不依赖控制台交互）──
set /a tries=0
:waitport
set /a tries+=1
if %tries% gtr 60 (
    echo [start] 启动超时（%BEAD_PORT% 未监听）。请查看 data\server.err.log，或运行 stop-local.bat 后重试。
    echo [start] 窗口即将关闭。
    ping -n 4 127.0.0.1 >nul
    exit /b 1
)
ping -n 2 127.0.0.1 >nul
netstat -ano | findstr /R /C:":%BEAD_PORT% .*LISTENING" >nul 2>&1
if errorlevel 1 goto waitport

rem ── 就绪：显示地址（含本机局域网 IP），打开浏览器，窗口自动关闭 ──
rem ── 检测真实局域网 IP（get-lan-ip.ps1 排除虚拟网卡/代理网段）──
set "LAN_IP="
for /f "delims=" %%a in ('powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%get-lan-ip.ps1"') do set "LAN_IP=%%a"

echo [start] 服务已就绪（绑定 0.0.0.0，端口 %BEAD_PORT%）:
echo   本机访问   : http://localhost:%BEAD_PORT%
if defined LAN_IP echo   局域网访问 : http://%LAN_IP%:%BEAD_PORT%
echo [start] 浏览器将打开局域网地址——同一局域网内其他设备（手机/平板/其他电脑）
echo [start] 也可通过上面的局域网地址访问。
echo [start] 本窗口即将自动关闭。停止请运行 stop-local.bat，重启请运行 restart-local.bat
if defined LAN_IP (
    start "" "http://%LAN_IP%:%BEAD_PORT%"
) else (
    start "" "http://localhost:%BEAD_PORT%"
)
ping -n 3 127.0.0.1 >nul
exit /b 0
