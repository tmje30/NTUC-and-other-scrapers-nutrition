@echo off
rem Reference copy of the scan-request runner's wrapper. The LIVE one that Windows
rem Task Scheduler invokes is C:\Users\newuser\shengsiong-runner\ss-request-run.cmd
rem (task "ShengSiong Scan Request", every 5 minutes) - edit that one, and keep
rem this in step. Kept here for the same reason as laptop-run.cmd: so the
rem scheduling half of the system is readable without going digging on one machine.
rem
rem This is the laptop's answer to the page's Rescan button. The cloud commits
rem data/scan-request.json; this pulls, and src/scripts/ss-on-request.ts decides
rem whether that marker is worth a scan. See src/core/scan-request.ts.
setlocal
set "REPO=C:\Users\newuser\shengsiong-runner\repo"
set "LOG=C:\Users\newuser\shengsiong-runner\ss-request.log"
set "OUT=%TEMP%\ss-request-out.txt"
set "RUNNER_SOURCE=laptop"
set "PATH=C:\Users\newuser\scoop\apps\nodejs\current;C:\Users\newuser\scoop\shims;%PATH%"
if exist "%LOG%" for %%A in ("%LOG%") do if %%~zA GTR 5000000 move /y "%LOG%" "%LOG%.old" >nul
cd /d "%REPO%"

rem ⚠️ No retry loop here, unlike the morning runner. This fires every 5 minutes,
rem so the retry IS the next run - and a wake-up race that the morning job has to
rem sit through costs this one nothing. A pull that fails is logged and dropped.
git pull --quiet > "%OUT%" 2>&1
if errorlevel 1 (
  echo ==== %DATE% %TIME% : git pull failed ==== >> "%LOG%"
  type "%OUT%" >> "%LOG%"
  del "%OUT%" >nul 2>&1
  endlocal & exit /b 1
)

rem ⚠️ --silent, and the log is written ONLY when there is something to say. This
rem runs 288 times a day and does nothing on almost all of them; a start/finish
rem line each time would bury the handful of runs that scanned under a wall of
rem runs that didn't. ss-on-request.ts is deliberately quiet on the no-op path.
call npm run --silent ss-on-request > "%OUT%" 2>&1
set "RC=%ERRORLEVEL%"
for %%A in ("%OUT%") do if %%~zA GTR 0 (
  echo ==== %DATE% %TIME% : run ^(exit %RC%^) ==== >> "%LOG%"
  type "%OUT%" >> "%LOG%"
)
del "%OUT%" >nul 2>&1
endlocal & exit /b %RC%
