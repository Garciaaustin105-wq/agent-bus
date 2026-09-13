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

rem ONE BUS. The state file is shared, so a second launch must never start a
rem second server on a second port — that is a second steward waking every
rem minute to ask the model the same questions double. If the hub is already
rem listening, double-clicking again just points another window at it.
set PORT=7777
netstat -ano | find ":7777 " | find "LISTENING" >nul 2>&1
if %errorlevel%==0 goto :open

start "" /min cmd /c "node tools\agent-bus\server.mjs dashboard %PORT%"

rem Wait until the port actually answers before pointing a window at it. A
rem window opened too early lands on the browser's own error page — our
rem auto-refresh watcher is not on that page, so it would never recover by
rem itself, which reads as "the hub shows nothing".
set /a tries=0
:wait
timeout /t 1 /nobreak >nul
netstat -ano | find ":7777 " | find "LISTENING" >nul 2>&1
if %errorlevel%==0 goto :open
set /a tries+=1
if %tries% lss 20 goto :wait

:open
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