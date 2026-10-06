@echo off
REM Leak Scanner - one click start (Windows + XAMPP, no Docker needed)
REM 1. Start MySQL in XAMPP Control Panel first.
REM 2. Double-click this file. First run takes 5-15 minutes, then 30 seconds.
title Leak Scanner
cd /d "%~dp0"
node scripts\start-win.js
pause
