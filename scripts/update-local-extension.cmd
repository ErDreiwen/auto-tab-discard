@echo off
rem Double-click to refresh the local unpacked extension, then click Reload in the browser.
cd /d "%~dp0.."
node scripts\update-local-extension.mjs %*
pause
