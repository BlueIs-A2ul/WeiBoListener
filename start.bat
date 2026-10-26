@echo off
setlocal
cd /d "%~dp0"

if not exist logs mkdir logs

rem Prefer the absolute Node path so Task Scheduler can find it.
set "NODE_EXE=C:\nvm4w\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

"%NODE_EXE%" src\index.js >> logs\runner.log 2>&1
