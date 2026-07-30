@echo off
rem Double-clickable launcher for RSConclave. Starts the server in a minimized
rem window and opens the UI. Close that window to stop the server.
rem Override the port with: set PORT=8080 && RSConclave.cmd
if "%PORT%"=="" set PORT=7777
start "RSConclave server" /min node "%~dp0server\main.ts"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:%PORT%"
