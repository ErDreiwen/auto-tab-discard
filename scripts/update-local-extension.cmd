@echo off
rem Double-click to refresh the local unpacked extension, then click Reload in the browser.
rem To run it from the Desktop, create a shortcut to this file; a copy cannot find the updater.
if not exist "%~dp0update-local-extension.mjs" (
  echo This copy cannot find update-local-extension.mjs next to it.
  echo Create a shortcut to the original file in the project's scripts folder instead.
  pause
  exit /b 1
)
node "%~dp0update-local-extension.mjs" %*
pause
