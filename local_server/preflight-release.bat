@echo off
chcp 65001 >nul
rem ── 发布前检查：前端构建+测试、Rust release 构建+测试 ──
rem 全部通过（exit 0）才能打 tag 发布；任何一步失败立即退出（非 0）
setlocal
cd /d %~dp0

rem Rust 工具链（无环境变量时兜底到本机路径）
if not defined RUSTUP_HOME set "RUSTUP_HOME=D:\devtools\rust"
if not defined CARGO_HOME set "CARGO_HOME=D:\repos\cargo"
set "PATH=%CARGO_HOME%\bin;%PATH%"

echo === [1/4] 前端类型检查 + 构建（tsc -b + vite build）===
cd /d %~dp0..\frontend
call npm run build
if errorlevel 1 (
    echo [FAIL] 前端构建失败，中止发布
    exit /b 1
)

echo === [2/4] 前端测试（vitest）===
call npm test
if errorlevel 1 (
    echo [FAIL] 前端测试失败，中止发布
    exit /b 1
)

echo === [3/4] Rust release 构建（--locked）===
cd /d %~dp0
cargo build --release --locked
if errorlevel 1 (
    echo [FAIL] Rust 构建失败，中止发布
    exit /b 1
)

echo === [4/4] Rust 测试（unit + contract，--locked，无需 ORT/模型）===
cargo test --locked --lib
if errorlevel 1 (
    echo [FAIL] Rust unit 测试失败，中止发布
    exit /b 1
)
cargo test --locked --test api_contract
if errorlevel 1 (
    echo [FAIL] Rust contract 测试失败，中止发布
    exit /b 1
)

echo.
echo [OK] 全部检查通过，可以打 tag 发布
exit /b 0
