@echo off
rem Agent Bus — launches the command hub as a desktop app.
rem
rem WHY A .CMD AND NOT ELECTRON: the bus has no dependencies and that is
rem deliberate — adding a package here means editing package.json, which other
rem agents have open. Chrome and Edge both support --app=<url>, which opens a
rem window with no tabs, no address bar and its own taskbar entry. That is a
rem desktop app for the price of one flag.
rem
rem Double-click this, or the Agent Bus shortcut on the desktop.

setlocal
cd /d "%~dp0..\.."

rem This is its own app: the bus derives THIS repo's .git, and the dashboard
rem shows this repo's own board. Nothing points at another checkout. (If you
rem ever want to serve a different project root from here, AGENT_BUS_PROJECT
rem is the seam — see the top-level README.)

rem Pick a free port so a second launch does not fail on an in-use socket.
set PORT=7777
netstat -ano | find ":7777 " >nul 2>&1 && set PORT=7778
netstat -ano | find ":7778 " >nul 2>&1 && if "%PORT%"=="7778" set PORT=7779

start "" /min cmd /c "node tools\agent-bus\server.mjs dashboard %PORT%"

rem Give the listener a moment before pointing a window at it. A failed first
rem load shows an error page the user then has to refresh, which reads as broken.
timeout /t 2 /nobreak >nul

set URL=http://127.0.0.1:%PORT%

rem App mode, in whichever browser is actually installed. Edge ships with
rem Windows, so it is the reliable fallback rather than the first choice.
set CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe
set CHROMEX=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe
set EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe

if exist "%CHROME%"  start "" "%CHROME%"  --app=%URL% & goto :eof
if exist "%CHROMEX%" start "" "%CHROMEX%" --app=%URL% & goto :eof
if exist "%EDGE%"    start "" "%EDGE%"    --app=%URL% & goto :eof

rem No app-mode browser found — open it however the system wants to.
start "" %URL%
