@echo off
chcp 65001 >nul
cd /d "%~dp0"
node --version >nul 2>&1 || (echo Node.js o'rnatilmagan. https://nodejs.org dan o'rnating. & pause & exit /b)
echo Server ishga tushmoqda... Brauzerda http://localhost:3000 ni oching.
node --disable-warning=ExperimentalWarning server.js
pause
