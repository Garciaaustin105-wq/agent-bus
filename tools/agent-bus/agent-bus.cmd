@echo off
rem Agent Bus — launches the command hub as a desktop app.
rem
rem Double-click this, or the Agent Bus shortcut on the desktop.
rem
rem Everything this file used to carry — the port pick (now a bind-to-0 read,
rem never a netstat grep), the wait-until-the-port-answers loop, the
rem chrome/Edge --app fallback chain — now lives in the `open` verb of
rem server.mjs, where it works on every platform and gets tested by the gate
rem (packaging.md item 2). This shim stays a shim so the double-click keeps
rem working; /min keeps its console out of the way, as before.
start "" /min cmd /c node "%~dp0server.mjs" open