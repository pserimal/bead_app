@echo off
rem bead-local-server 一键启动（局域网 Web 应用，无需 JDK/Python/Node）
rem 前端已编译内嵌于 bead-local-server.exe。
rem 服务将在后台无窗口运行（日志: data\server.log），本窗口自动关闭；
rem 浏览器自动打开页面。停止服务请运行 stop-local.bat
setlocal

set "ROOT=%~dp0"

rem ── onnxruntime.dll：exe 旁（发布版）；无则尝试 conda bead-train 环境（开发机）──
if exist "%ROOT%onnxruntime.dll" (
    set "ORT_DYLIB_PATH=%ROOT%onnxruntime.dll"
) else if defined CONDA_PREFIX (
    set "ORT_DYLIB_PATH=%CONDA_PREFIX%\Lib\site-packages\onnxruntime\capi\onnxruntime.dll"
)

rem ── 数据与配置默认值（本目录自包含）──
if not defined BEAD_PORT set "BEAD_PORT=8080"
if not defined BEAD_DB_PATH set "BEAD_DB_PATH=%ROOT%data\bead-local.db"
if not defined BEAD_UPLOADS_DIR set "BEAD_UPLOADS_DIR=%ROOT%uploads"
if not defined BEAD_COLORS_PATH set "BEAD_COLORS_PATH=%ROOT%data\default_colors.json"
if not defined BEAD_LIBRARY_PATH set "BEAD_LIBRARY_PATH=%ROOT%data\library.json"
if not defined BEAD_ARTIFACT_DIR set "BEAD_ARTIFACT_DIR=%ROOT%models\crnn_color_mard_v8-2026-08-09T04-30-00Z"

echo [start] 正在后台启动 bead-local-server（端口 %BEAD_PORT%）...

rem ── 后台无窗口启动（日志落盘，窗口不驻留）──
powershell.exe -NoProfile -Command "Start-Process -FilePath '%ROOT%bead-local-server.exe' -WindowStyle Hidden -RedirectStandardOutput '%ROOT%data\server.log' -RedirectStandardError '%ROOT%data\server.err.log'"

rem ── 等待端口就绪（最多 ~30 秒）──
set /a tries=0
:waitport
set /a tries+=1
if %tries% gtr 30 (
    echo [start] 启动超时（%BEAD_PORT% 未监听）。请查看 data\server.err.log，或运行 stop-local.bat 后重试。
    echo [start] 窗口即将关闭。
    timeout /t 5 /nobreak >nul
    exit /b 1
)
timeout /t 1 /nobreak >nul
netstat -ano | findstr /R /C:":%BEAD_PORT% .*LISTENING" >nul 2>&1
if errorlevel 1 goto waitport

rem ── 就绪：打开浏览器，窗口自动关闭 ──
start "" "http://localhost:%BEAD_PORT%"
echo [start] 服务已就绪: http://localhost:%BEAD_PORT%  （局域网: http://<本机IP>:%BEAD_PORT%）
echo [start] 浏览器已自动打开，本窗口即将自动关闭。停止服务请运行 stop-local.bat
timeout /t 3 /nobreak >nul
exit /b 0
