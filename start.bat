@echo off
title PoE1 Gem Profit Checker
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on your PATH.
  echo Install it from https://nodejs.org  then run this again.
  pause
  exit /b 1
)
node serve.js
echo.
echo Server stopped.
pause
