@echo off
setlocal
cd /d "%~dp0"

rem 与 start.bat 保持一致：优先使用绝对 Node 路径，找不到时回退到 PATH 中的 node。
set "NODE_EXE=C:\nvm4w\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

"%NODE_EXE%" src\admin.js %*

if errorlevel 1 (
  echo.
  echo 控制台异常退出。按任意键关闭窗口。
  pause >nul
)
