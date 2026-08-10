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

rem Do NOT scan when the pull failed. On 2026-08-05 the laptop woke before DNS
rem was up, the pull died with "Could not resolve host", the scan then ran
rem perfectly (58 terms, 0 errors) and the push was rejected for being 12 commits
rem behind - a whole day's Sheng Siong data stranded locally while the cloud built
rem FairPrice-only. push-shengsiong.ts now re-applies and retries a rejected push,
rem but the cheaper half of the fix is not starting a 5-minute scan into a network
rem that isn't there yet. A wake-up race is usually over in seconds, so retry
rem twice before giving up. (ping, not timeout: timeout needs a console and Task
rem Scheduler doesn't give it one.)
set /a TRY=0
:pull
set /a TRY+=1
git pull >> "%LOG%" 2>&1
if not errorlevel 1 goto pulled
if %TRY% GEQ 3 goto nonetwork
echo ---- git pull failed (attempt %TRY%) - waiting 20s for the network >> "%LOG%"
ping -n 21 127.0.0.1 >nul
goto pull
:nonetwork
echo !! git pull failed 3 times - NOT scanning (see above for the git error) >> "%LOG%"
echo ==== %DATE% %TIME% : run done (exit 1, no scan) ==== >> "%LOG%"
endlocal & exit /b 1
:pulled

call npm run push-ss >> "%LOG%" 2>&1
set "RC=%ERRORLEVEL%"
echo ==== %DATE% %TIME% : run done (exit %RC%) ==== >> "%LOG%"
rem Hand the real exit code back to Task Scheduler. Without this the batch file
rem always ended 0, so "Last Run Result: 0" was reported on a run where all 62
rem searches failed and nothing was written - the failure was invisible.
endlocal & exit /b %RC%
