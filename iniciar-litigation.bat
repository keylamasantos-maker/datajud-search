@echo off
cd /d "%~dp0"
set "NODE=node"
where node >nul 2>nul || set "NODE=%USERPROFILE%\node-portable\node-v22.16.0-win-x64\node.exe"
start "" http://localhost:4173/litigation
"%NODE%" server.js
pause
