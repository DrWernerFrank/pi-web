@echo off
rem pi-web: starts the pi browser GUI inside WSL (Ubuntu) and opens it in your browser.
rem This window shows the pi-web log and any pi subagents. Closing it leaves pi-web running;
rem to stop it, run "pi-web stop" in WSL.
title pi-web
set "PIWEB_CMD=%~1"
if "%PIWEB_CMD%"=="" set "PIWEB_CMD=window"
wsl.exe -d Ubuntu -- bash -lic "\"$(wslpath '%~dp0')/bin/pi-web\" %PIWEB_CMD%"
