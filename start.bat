@echo off
cd /d %~dp0
if not exist server\node_modules call npm run install:all
if not exist server\.env copy server\.env.example server\.env
call npm run build
start "" http://localhost:5000
rem Keeps the server running: if it crashes or exits, it restarts after 10 seconds. Close this window to stop it.
:loop
call npm --prefix server start
echo [%date% %time%] Server stopped - restarting in 10 seconds (close this window to stop)
timeout /t 10 /nobreak >nul
goto loop
