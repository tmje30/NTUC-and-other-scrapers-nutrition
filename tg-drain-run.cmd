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
rem row means searching the shops, and Sheng Siong challenges datacenter IPs while
rem answering a residential one. Everything else the inbox does now runs in Actions.
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
git pull --quiet --rebase 2>>"%LOG%"
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
