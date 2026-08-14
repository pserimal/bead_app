@echo off
rem 构建发布版并准备自包含运行目录：release\
rem   bead-local-server.exe + onnxruntime.dll + start-local.bat
rem   + data\default_colors.json + data\library.json + models\<artifact>\
rem 前置：frontend/dist 已 build（cd ..\frontend && npm run build）
setlocal
cd /d %~dp0

cargo build --release
if errorlevel 1 exit /b 1

set "OUT=release"
if not exist "%OUT%" mkdir "%OUT%"
if not exist "%OUT%\data" mkdir "%OUT%\data"
if not exist "%OUT%\models" mkdir "%OUT%\models"

copy /y target\release\bead-local-server.exe "%OUT%" >nul
copy /y start-local.bat "%OUT%" >nul
copy /y ..\server\src\main\resources\default_colors.json "%OUT%\data" >nul
copy /y ..\artifacts\colors\library.json "%OUT%\data" >nul

set "ART=..\artifacts\models\crnn_color_mard_v8-2026-08-09T04-30-00Z"
if not exist "%OUT%\models\crnn_color_mard_v8-2026-08-09T04-30-00Z" mkdir "%OUT%\models\crnn_color_mard_v8-2026-08-09T04-30-00Z"
copy /y "%ART%\model.onnx" "%OUT%\models\crnn_color_mard_v8-2026-08-09T04-30-00Z" >nul
copy /y "%ART%\manifest.json" "%OUT%\models\crnn_color_mard_v8-2026-08-09T04-30-00Z" >nul
copy /y "%ART%\charset.json" "%OUT%\models\crnn_color_mard_v8-2026-08-09T04-30-00Z" >nul
copy /y "%ART%\code_dict.json" "%OUT%\models\crnn_color_mard_v8-2026-08-09T04-30-00Z" >nul

if exist "%CONDA_PREFIX%\Lib\site-packages\onnxruntime\capi\onnxruntime.dll" (
    copy /y "%CONDA_PREFIX%\Lib\site-packages\onnxruntime\capi\onnxruntime.dll" "%OUT%" >nul
    echo [ok] onnxruntime.dll copied (from conda)
) else (
    echo [warn] onnxruntime.dll NOT found in conda; copy it manually next to the exe
)

rem ── 打 zip（自动排除运行数据：db/uploads 不进入发布包；运行目录数据原样保留）──
set "ZIP=%~dp0bead-local-server-v0.1.0.zip"
if exist "%ZIP%" del "%ZIP%"
if exist "%~dp0.stage-zip" rmdir /s /q "%~dp0.stage-zip"
mkdir "%~dp0.stage-zip\bead-local-server"
xcopy /e /i /y "%OUT%\*" "%~dp0.stage-zip\bead-local-server\" >nul
rem 排除运行数据（db 与上传图片），zip 保持干净；release\ 目录不受影响
for %%F in ("%~dp0.stage-zip\bead-local-server\data\bead-local.db*" "%~dp0.stage-zip\bead-local-server\data\server*.log" "%~dp0.stage-zip\bead-local-server\uploads\*.*") do del /q "%%F" 2>nul
"%WINDIR%\System32\tar.exe" -a -cf "%ZIP%" -C "%~dp0.stage-zip" bead-local-server
rmdir /s /q "%~dp0.stage-zip"

echo.
echo 发布目录: %OUT%  （自包含，可整体拷贝到任意 Windows 机器）
echo 压缩包  : %ZIP%
echo 部署: 拷贝 %OUT% 或解压 %ZIP% 到目标机器，双击 start-local.bat，浏览器访问 http://^<IP^>:8080
echo 注意: 打包不影响 %OUT%\data\bead-local.db（运行数据原样保留）
