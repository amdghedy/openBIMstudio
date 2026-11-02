@echo off
rem ---------------------------------------------------------------------------
rem openBIM NWC Bridge launcher (Windows)
rem Starts the local loopback service that converts .nwc/.nwd/.nwf to IFC
rem with the Navisworks installation on this PC (via the free BIMCamel
rem exporter plug-in). Keep this window open while converting.
rem ---------------------------------------------------------------------------
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo [openbim-nwc-bridge] Node.js was not found on PATH.
  echo Install Node.js from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
echo [openbim-nwc-bridge] starting on 127.0.0.1:8424 ...
node "%~dp0openbim-nwc-bridge.mjs"
pause
