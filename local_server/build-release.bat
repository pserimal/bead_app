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

echo.
echo 发布目录: %OUT%  （自包含，可整体拷贝到任意 Windows 机器）
echo 部署: 拷贝 %OUT% 到目标机器，双击 start-local.bat，浏览器访问 http://^<IP^>:8080
