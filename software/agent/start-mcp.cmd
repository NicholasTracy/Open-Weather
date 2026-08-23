@echo off
setlocal
set "OW_AGENT_PORT=17832"
set "NODE_EXE=C:\PROGRA~1\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
"%NODE_EXE%" "%~dp0mcp-server.mjs"
