@echo off
rem Reference copy of the vendor sweep's wrapper. The LIVE one that Windows Task
rem Scheduler invokes is C:\Users\newuser\shengsiong-runner\vendor-sweep-run.cmd
rem (task "Grocery Vendor Sweep") - edit that one, and keep this in step. Kept here
rem for the same reason as laptop-run.cmd: so the scheduling half of the system is
rem readable without going digging on one machine.
rem
rem WHAT IT DOES. Prices the three shops the cloud cannot reach - Watsons, iHerb and
rem Carousell - into the Vendor 1..4 price book. The other 106 of the 120 row-vendor
rem pairs are the cloud sweep's job; see docs\finish-singapore.md.
rem
rem   vendor-sweep-run.cmd              -> sweeps and WRITES
rem   vendor-sweep-run.cmd dry          -> sweeps and writes NOTHING (report only)
rem
rem ⚠️ TWO OF THE THREE NEED A HEADED CHROME. Watsons renders its grid and then has it
rem WIPED by an Akamai check ~22s in, and iHerb 403s a plain fetch; both detect
rem headless. So the task must run with LogonType=InteractiveToken ("run only when
rem user is logged on"). "Run whether user is logged on or not" gives it a session-0
rem desktop with nothing for a headed Chrome to render into, and the failure reads
rem exactly like bot detection - which is how this shop collected two false "dead
rem end" verdicts already.
rem
rem ⚠️ Carousell needs NO browser since 2026-08-17 - it goes through ss-worker, and
rem that is about the CLIENT, not geography (Node's fetch gets 403 on /search/ where
rem curl and the Worker both get 200). It needs SCAN_SECRET from .env instead.
rem
rem ⚠️ WHY THIS CLONE AND NOT THE DEV ONE. This writes prices into live Notion rows,
rem unattended. A job in the dev clone runs whatever source is checked out, and that
rem tree is MEANT to be mid-edit - so an unfinished refactor would go straight into a
rem real write. This clone is never edited: it pulls main and runs it. The .env was
rem copied here on 2026-08-31 for that reason; the old "a scan-only clone needs no
rem secrets" rule expired when the sweep started needing Notion.
setlocal
set "REPO=C:\Users\newuser\shengsiong-runner\repo"
set "LOG=C:\Users\newuser\shengsiong-runner\vendor-sweep.log"
set "RUNNER_SOURCE=laptop"
set "PATH=C:\Users\newuser\scoop\apps\nodejs\current;C:\Users\newuser\scoop\shims;%PATH%"

rem Report-only when called as `vendor-sweep-run.cmd dry`. The first live run should
rem be one of these: it shows what WOULD be written without touching Notion.
set "EXTRA=--write"
if /I "%~1"=="dry" set "EXTRA="

rem Roll the log past ~5 MB.
if exist "%LOG%" for %%A in ("%LOG%") do if %%~zA GTR 5000000 move /y "%LOG%" "%LOG%.old" >nul

echo ==== %DATE% %TIME% : sweep start (%EXTRA%) ==== >> "%LOG%"
cd /d "%REPO%"

rem ⚠️ Record the lockfile BEFORE the pull - see the npm ci block below.
for /f %%H in ('git rev-parse HEAD:package-lock.json') do set "LOCK_BEFORE=%%H"

rem Do NOT sweep when the pull failed. Same reasoning as laptop-run.cmd: the laptop
rem wakes before DNS is up, and RunOnlyIfNetworkAvailable does not cover that - it
rem asks whether an adapter has a connection, not whether a name resolves. 6 attempts
rem 30s apart, ~2.5 minutes of patience. (ping, not timeout: timeout needs a console
rem and Task Scheduler does not give one.)
rem
rem It matters more here than it does for the scan: a sweep that runs on a stale
rem checkout prices against yesterday's routing rules and writes the result.
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
echo !! git pull failed 6 times - NOT sweeping (see above for the git error) >> "%LOG%"
echo ==== %DATE% %TIME% : sweep done (exit 1, no sweep) ==== >> "%LOG%"
endlocal & exit /b 1
:pulled

rem ⚠️ NOTHING ELSE IN THE LAPTOP PATH INSTALLS DEPENDENCIES. Not laptop-run.cmd, not
rem ss-request-run.cmd, not tg-drain-run.cmd - they pull and run. That was harmless
rem only for as long as package.json stood still, and it had NOT: on 2026-08-31 this
rem clone's node_modules was 17 days stale and the lockfile had moved under it. A
rem pull that changes the lockfile and then runs against the old tree fails in
rem whatever way the moved dependency happens to fail, at 6am, with nobody watching.
rem So: compare, and only install when it actually moved. `npm ci` on every run would
rem add ~40s to a job that mostly has nothing to do.
for /f %%H in ('git rev-parse HEAD:package-lock.json') do set "LOCK_AFTER=%%H"
if not "%LOCK_BEFORE%"=="%LOCK_AFTER%" (
  echo ---- package-lock.json moved %LOCK_BEFORE% -^> %LOCK_AFTER% - running npm ci >> "%LOG%"
  call npm ci >> "%LOG%" 2>&1
  if errorlevel 1 (
    echo !! npm ci FAILED - NOT sweeping, node_modules is now unknown >> "%LOG%"
    echo ==== %DATE% %TIME% : sweep done (exit 1, no sweep) ==== >> "%LOG%"
    endlocal & exit /b 1
  )
)

call npm run vendor-scan -- --only watsons,iherb,carousell %EXTRA% >> "%LOG%" 2>&1
set "RC=%ERRORLEVEL%"
echo ==== %DATE% %TIME% : sweep done (exit %RC%) ==== >> "%LOG%"

rem Hand the real exit code back to Task Scheduler. Without this the batch file
rem always ends 0, and "Last Run Result: 0" gets reported on a run where every shop
rem failed - the exact hole that let the Sheng Siong scan look healthy while writing
rem nothing. It is also what buys the RestartOnFailure attempts, which are the only
rem cover for the machine going back to sleep mid-run (Task Scheduler records that as
rem 1067 ERROR_PROCESS_ABORTED, and no in-script retry survives being killed).
endlocal & exit /b %RC%
