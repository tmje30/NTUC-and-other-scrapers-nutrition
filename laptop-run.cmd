@echo off
rem Reference copy of the laptop runner's wrapper. The LIVE one that Windows Task
rem Scheduler invokes is C:\Users\newuser\shengsiong-runner\run.cmd (task
rem "ShengSiong Daily Scan", daily 05:30 SGT) — edit that one, and keep this in
rem step. Kept here for the same reason as phone-run.sh: so the scheduling half of
rem the system is readable without going digging on one machine.
setlocal
set "REPO=C:\Users\newuser\shengsiong-runner\repo"
set "LOG=C:\Users\newuser\shengsiong-runner\push-ss.log"
set "RUNNER_SOURCE=laptop"
set "PATH=C:\Users\newuser\scoop\apps\nodejs\current;C:\Users\newuser\scoop\shims;%PATH%"
echo ==== %DATE% %TIME% : run start ==== >> "%LOG%"
cd /d "%REPO%"
git pull >> "%LOG%" 2>&1
call npm run push-ss >> "%LOG%" 2>&1
set "RC=%ERRORLEVEL%"
echo ==== %DATE% %TIME% : run done (exit %RC%) ==== >> "%LOG%"
rem Hand the real exit code back to Task Scheduler. Without this the batch file
rem always ended 0, so "Last Run Result: 0" was reported on a run where all 62
rem searches failed and nothing was written - the failure was invisible.
endlocal & exit /b %RC%
