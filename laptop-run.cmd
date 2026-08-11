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
rem that isn't there yet. (ping, not timeout: timeout needs a console and Task
rem Scheduler doesn't give it one.)
rem
rem The retry budget was 2 attempts 20s apart and that was not enough: 2026-08-10
rem AND 2026-08-11 both failed the same way and the page was FairPrice-only two
rem days running. The task does not fire at 05:30 at all - StartWhenAvailable
rem fires it on WAKE, ~06:47, which is exactly the minute DNS is still coming up.
rem A wake-up race is usually over in seconds, but not always, so: 6 attempts 30s
rem apart, ~2.5 minutes of patience before giving up on the morning.
rem
rem ⚠️ The task's RunOnlyIfNetworkAvailable is already true and did NOT prevent
rem any of this. It asks whether an adapter has a connection, not whether DNS
rem resolves, and on wake the adapter is up first.
set /a TRY=0
:pull
set /a TRY+=1
git pull >> "%LOG%" 2>&1
if not errorlevel 1 goto pulled
if %TRY% GEQ 6 goto nonetwork
echo ---- git pull failed (attempt %TRY% of 6) - waiting 30s for the network >> "%LOG%"
ping -n 31 127.0.0.1 >nul
goto pull
:nonetwork
echo !! git pull failed 6 times - NOT scanning (see above for the git error) >> "%LOG%"
echo ==== %DATE% %TIME% : run done (exit 1, no scan) ==== >> "%LOG%"
endlocal & exit /b 1
:pulled

call npm run push-ss >> "%LOG%" 2>&1
set "RC=%ERRORLEVEL%"
echo ==== %DATE% %TIME% : run done (exit %RC%) ==== >> "%LOG%"
rem Hand the real exit code back to Task Scheduler. Without this the batch file
rem always ended 0, so "Last Run Result: 0" was reported on a run where all 62
rem searches failed and nothing was written - the failure was invisible.
rem
rem It matters twice over now: task.xml carries RestartOnFailure (3 tries, 10 min
rem apart), so a non-zero exit is what buys the second and third attempt. That is
rem also the only cover for the 2026-08-11 failure, where the machine went back to
rem sleep DURING the 30s wait and Task Scheduler recorded 1067 (ERROR_PROCESS_
rem ABORTED) - no amount of in-script retrying survives the process being killed.
endlocal & exit /b %RC%
