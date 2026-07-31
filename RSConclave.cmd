@echo off
rem Double-clickable launcher for RSConclave. Starts the server in a minimized
rem window and opens the UI. Close that window to stop the server.
rem Override the port with: set PORT=8080 && RSConclave.cmd
setlocal
if "%PORT%"=="" set PORT=7777

rem Everything below the launch is about failing legibly. This file is how
rem someone who was handed the app starts it, so a silent exit here is a dead
rem browser tab and no explanation.
where node >nul 2>nul
if errorlevel 1 (
    echo Node.js was not found on your PATH.
    echo.
    echo RSConclave needs Node 22.18 or newer. Install it from https://nodejs.org
    echo and run this again - there is nothing else to set up.
    echo.
    pause
    exit /b 1
)

rem The minor matters, not just the major: type stripping landed in 22.18, so
rem 22.0 through 22.17 pass a major-only test and then fail at the first import
rem with a syntax error nobody can act on. Let node do the comparison.
for /f "tokens=1,2 delims=." %%v in ('node -e "process.stdout.write(process.versions.node)"') do (
    set NODEMAJOR=%%v
    set NODEMINOR=%%w
)
set NODEOK=1
if %NODEMAJOR% LSS 22 set NODEOK=0
if %NODEMAJOR% EQU 22 if %NODEMINOR% LSS 18 set NODEOK=0
if %NODEOK% EQU 0 (
    echo Node %NODEMAJOR%.%NODEMINOR% is too old: RSConclave runs TypeScript directly,
    echo which needs the type stripping added in Node 22.18.
    echo.
    echo Install a current version from https://nodejs.org and run this again.
    echo.
    pause
    exit /b 1
)

rem --disable-warning: package.json declares no "type" field, so Node prints a
rem MODULE_TYPELESS_PACKAGE_JSON warning advising you to add "type": "module" -
rem which is the one change that breaks this app (see the //type note in
rem package.json). Suppressed here for the same reason the npm scripts and the
rem Dockerfile suppress it, and because this window is the one a user keeps open.
start "RSConclave server" /min node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON "%~dp0server\main.ts"

rem The server switches itself to HTTPS whenever it finds a certificate pair, so
rem the launcher has to open the scheme it will actually be listening on. Opening
rem http:// against an HTTPS listener just fails, with nothing to explain why.
set SCHEME=http
if exist "%~dp0data\certs\server.crt" if exist "%~dp0data\certs\server.key" set SCHEME=https

rem ping, not timeout: timeout needs a real console and exits with "Input
rem redirection is not supported" the moment stdin is redirected - which is what
rem happens when this is launched from a shortcut, a scheduled task or a wrapper
rem script rather than by double-clicking. ping just waits, everywhere.
ping -n 3 127.0.0.1 >nul
start "" "%SCHEME%://127.0.0.1:%PORT%"
endlocal
