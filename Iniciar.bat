@echo off
cd /d "%~dp0"
start "XAUUSD Servidor Local" cmd /k python -m http.server 8080
timeout /t 1 /nobreak >nul
start "" "http://localhost:8080/index.html"
