@echo off
chcp 65001 >nul
rem 构建发布版并准备自包含运行目录：release\
rem   bead-local-server.exe + onnxruntime.dll + start-local.bat
rem   + data\default_colors.json + data\library.json + README.md + VERSION.txt
rem   + models\（空目录——模型由用户按 README 安装说明从网盘下载解压）
rem 前置：frontend/dist 已 build（cd ..\frontend && npm run build）
setlocal
cd /d %~dp0

rem ── 停掉正在运行的实例（否则 exe 被占用，copy 会静默失败）──
set "SRV_PORT=5173"
if defined BEAD_PORT set "SRV_PORT=%BEAD_PORT%"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:":%SRV_PORT% .*LISTENING"') do (
    echo [pack] stopping running instance PID %%p (port %SRV_PORT%)
    taskkill /PID %%p /F >nul 2>&1
)

cargo build --release
if errorlevel 1 exit /b 1

set "OUT=release"
if not exist "%OUT%" mkdir "%OUT%"
if not exist "%OUT%\data" mkdir "%OUT%\data"
if not exist "%OUT%\models" mkdir "%OUT%\models"

rem ── 前端（独立 dist/ 目录部署，不 embed——前端改版只替换 dist/，无需重编）──
if not exist "%OUT%\dist" mkdir "%OUT%\dist"
xcopy /e /i /y "..\frontend\dist\*" "%OUT%\dist" >nul

echo [ok] frontend dist copied (%OUT%\dist)

copy /y target\release\bead-local-server.exe "%OUT%" >nul
echo v0.2.1>"%OUT%\VERSION.txt"
copy /y start-local.bat "%OUT%" >nul
copy /y resources\default_colors.json "%OUT%\data" >nul
copy /y ..\artifacts\colors\library.json "%OUT%\data" >nul

rem ── 模型不打包：用户按 README「安装」第 2 步从网盘下载模型，解压到 models\ ──

if exist "%CONDA_PREFIX%\Lib\site-packages\onnxruntime\capi\onnxruntime.dll" (
    copy /y "%CONDA_PREFIX%\Lib\site-packages\onnxruntime\capi\onnxruntime.dll" "%OUT%" >nul
    echo [ok] onnxruntime.dll copied (from conda)
) else (
    echo [warn] onnxruntime.dll NOT found in conda; copy it manually next to the exe
)


rem ── 打 zip（自动排除运行数据：db/uploads 不进入发布包；运行目录数据原样保留）──
set "ZIP=%~dp0bead-local-server-v0.2.1.zip"
if exist "%ZIP%" del "%ZIP%"
if exist "%~dp0.stage-zip" rmdir /s /q "%~dp0.stage-zip"
mkdir "%~dp0.stage-zip\bead-local-server"
xcopy /e /i /y "%OUT%\*" "%~dp0.stage-zip\bead-local-server\" >nul
rem ── 清空 staged models（release\models 可能有本地运行时模型，不能进 zip）──
rem ── 清空 staged models（整目录移除：目录与散文件 ppocrv5* 都不进 zip）──
rmdir /s /q "%~dp0.stage-zip\bead-local-server\models"
mkdir "%~dp0.stage-zip\bead-local-server\models"
rem 排除运行数据（db 与上传图片），zip 保持干净；release\ 目录不受影响
for %%F in ("%~dp0.stage-zip\bead-local-server\data\bead-local.db*" "%~dp0.stage-zip\bead-local-server\data\server*.log" "%~dp0.stage-zip\bead-local-server\data\model-current.txt" "%~dp0.stage-zip\bead-local-server\uploads\*.*") do del /q "%%F" 2>nul
copy /y ..\README.md "%~dp0.stage-zip\bead-local-server\README.md" >nul
"%WINDIR%\System32\tar.exe" -a -cf "%ZIP%" -C "%~dp0.stage-zip" bead-local-server
rmdir /s /q "%~dp0.stage-zip"

echo.
echo [ok] release dir : %OUT%  (self-contained, copy to any Windows box)
echo [ok] zip         : %ZIP%
echo 部署: 拷贝 %OUT% 或解压 %ZIP% 到目标机器，双击 start-local.bat，浏览器访问 http://^<IP^>:5173
echo 注意: 打包不影响 %OUT%\data\bead-local.db（运行数据原样保留）
