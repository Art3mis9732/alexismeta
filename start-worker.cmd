@echo off
rem Starts the alexismeta worker (live prices, news, paper trading) on this computer. Uses npm.cmd so PowerShell execution policy is not involved.
cd /d "%~dp0"
node --version >nul 2>&1 || (echo Node.js 22.23 or newer is required: https://nodejs.org & pause & exit /b 1)
echo Starting the worker. Open http://127.0.0.1:8787 in your browser. Press Ctrl+C once to stop it safely.
npm.cmd start
pause
