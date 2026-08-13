@echo off
rem Prices the new items the cloud could not — this machine's only remaining
rem Telegram job. Windows Task Scheduler task "Grocery New-Item Pricing" runs this
rem every 15 minutes.
rem
rem It REPLACES "Grocery Telegram Inbox". That task ran `npm run tg-poll` forever;
rem once the Cloudflare relay holds the webhook, a poller gets 409 Conflict on every
rem call, because a bot may have a webhook OR serve getUpdates, never both. Disable
rem the old task before enabling this one - see relay\README.md.
rem
rem Unlike the poller this is a short batch job: it exits in milliseconds when the
rem queue is empty, which is almost always. So MultipleInstances can stay IgnoreNew
rem and there is nothing to supervise - a missed run simply happens 15 minutes later.
rem
rem Why it is still here and not in the cloud: pricing an item with no Ingredients
rem row means searching the shops, and Sheng Siong's Incapsula challenges addresses
rem OUTSIDE SINGAPORE - Actions runners are US Azure. It is the country, not
rem residential-vs-datacenter (measured 2026-08-11; a Singapore datacenter address
rem scanned all 60 terms with 0 errors). So this laptop qualifies by being in SG, and
rem a ~US$5/mo Singapore VPS could take the job. Everything else runs in Actions.
rem
rem It runs in the DEV clone, for the same reason the poller did: it needs the .env
rem holding NOTION_TOKEN, TELEGRAM_BOT_TOKEN and GITHUB_TOKEN, and the Sheng Siong
rem clone deliberately has none. `commitAndPushData` refuses to reset a dirty tree,
rem so a session's edits are never sacrificed to publish a page.
setlocal
set "REPO=C:\Users\newuser\Claude Private projects\NTUC and other scrapers nutrition"
set "LOG=C:\Users\newuser\shengsiong-runner\tg-drain.log"
set "RUNNER_SOURCE=laptop"
set "PATH=C:\Users\newuser\scoop\apps\nodejs\current;C:\Users\newuser\scoop\shims;%PATH%"

rem Roll the log past ~5 MB.
if exist "%LOG%" for %%A in ("%LOG%") do if %%~zA GTR 5000000 move /y "%LOG%" "%LOG%.old" >nul

cd /d "%REPO%"

rem A run with nothing to do must not fill the log with a header per 15 minutes, so
rem the timestamp is written only when there is actually something queued. `git pull`
rem first: the queue arrives from the cloud, so a stale clone sees an empty one.
rem
rem ⚠️ --autostash, because this runs in the DEV clone and a dev clone is MEANT to be
rem dirty - it holds the .env and it is where sessions work. Plain `--rebase` refuses
rem to run over uncommitted edits, so for as long as anyone had work in progress this
rem pull failed on every single run. Autostash tucks the edits aside, rebases, and
rem puts them back, which keeps the promise the header makes about never sacrificing
rem a session's work.
rem
rem ⚠️ And the result is CHECKED, which it was not until 2026-08-12. Without this the
rem script walked on to a stale queue, found it empty, printed "Nothing queued for
rem pricing." and exited 0 - and that string is exactly what suppresses the log
rem header below. So a failed pull was silent AND green: Task Scheduler recorded
rem success at 21:29:44 while the log recorded the pull failing on the same run. An
rem item texted in would have sat in the cloud unpriced with nothing to say so.
rem Same lesson as the exit code at the bottom of this file, one line further up.
git pull --quiet --rebase --autostash 2>>"%LOG%"
if errorlevel 1 (
  echo ==== %DATE% %TIME% : git pull failed - queue NOT checked ==== >> "%LOG%"
  endlocal & exit /b 1
)
call npm run tg-drain >"%TEMP%\tg-drain-out.txt" 2>&1
set "RC=%ERRORLEVEL%"
findstr /C:"Nothing queued for pricing." "%TEMP%\tg-drain-out.txt" >nul
if errorlevel 1 (
  echo ==== %DATE% %TIME% : drain ==== >> "%LOG%"
  type "%TEMP%\tg-drain-out.txt" >> "%LOG%"
  echo ==== exit %RC% ==== >> "%LOG%"
) else (
  if not "%RC%"=="0" (
    echo ==== %DATE% %TIME% : drain FAILED with nothing queued, exit %RC% ==== >> "%LOG%"
    type "%TEMP%\tg-drain-out.txt" >> "%LOG%"
  )
)
del "%TEMP%\tg-drain-out.txt" >nul 2>&1

rem Hand the real code back - the same lesson as run.cmd, where a wrapper that
rem always returned 0 let Task Scheduler report success on a run where everything
rem failed.
endlocal & exit /b %RC%
