@echo off
rem bead-local-server 一键启动（局域网 Web 应用，无需 JDK/Python/Node）
rem 用法：双击本脚本，或命令行运行；浏览器访问 http://<本机IP>:8080
rem 本目录需自包含：exe + onnxruntime.dll + data\ + models\（build-release.bat 生成）
rem
rem 环境变量可覆盖：BEAD_PORT / BEAD_DB_PATH / BEAD_UPLOADS_DIR / BEAD_ARTIFACT_DIR
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

echo [bead-local-server] 启动中，浏览器访问 http://localhost:%BEAD_PORT% （局域网: http://<本机IP>:%BEAD_PORT%）
"%ROOT%bead-local-server.exe"
