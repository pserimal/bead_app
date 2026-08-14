@echo off
chcp 65001 >nul
rem 重启 bead-local-server：先停止（按 BEAD_PORT 杀进程），再启动
rem 用法：双击本脚本，或命令行运行
setlocal

if not defined BEAD_PORT set "BEAD_PORT=8080"

echo [restart] 正在停止服务（端口 %BEAD_PORT%）...
call "%~dp0stop-local.bat"

rem ── 等待端口完全释放（避免 TIME_WAIT 影响重新绑定）──
ping -n 3 127.0.0.1 >nul

echo [restart] 正在启动服务...
call "%~dp0start-local.bat"
