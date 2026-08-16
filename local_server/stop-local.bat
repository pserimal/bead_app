@echo off

chcp 65001 >nul

rem 停止 bead-local-server（按 BEAD_PORT 找监听进程并结束）

rem 用法：双击本脚本，或命令行运行

setlocal



if not defined BEAD_PORT set "BEAD_PORT=5173"



echo [stop] 查找端口 %BEAD_PORT% 上的监听进程...

set "FOUND="

for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:":%BEAD_PORT% .*LISTENING"') do (

    echo [stop] 结束 PID %%p

    taskkill /PID %%p /F >nul 2>&1

    set "FOUND=1"

)

if defined FOUND (

    echo [stop] 已停止。

) else (

    echo [stop] 未发现运行中的 bead-local-server（端口 %BEAD_PORT% 无监听）。

)

