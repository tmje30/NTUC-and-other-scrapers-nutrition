@echo off
rem Keeps the Telegram inbox listening. Windows Task Scheduler task "Grocery
rem Telegram Inbox" runs this at logon and then re-runs it every 15 minutes; the
rem task's MultipleInstances policy is IgnoreNew, so a repeat while the poller is
rem alive does nothing and a repeat after it died starts it again. That repetition
rem IS the supervisor - there is no other one.
rem
rem Why it needed one at all: until 2026-08-11 nothing started `npm run tg-poll`.
rem The inbox only existed while someone remembered to launch it by hand, and a
rem bot that answers only when watched looks broken rather than off. It is also
rem what made Remaining work 29 possible - a button tapped with no poller running
rem is answered by nobody, and when one finally starts, Telegram refuses the stale
rem callback id and the tap is consumed and lost.
rem
rem ⚠️ Unlike the Sheng Siong scan, this runs in the DEV clone, not
rem C:\Users\newuser\shengsiong-runner\repo - it needs NOTION_TOKEN and
rem TELEGRAM_BOT_TOKEN, and the .env holding them lives here. Two consequences:
rem it runs whatever source is checked out (a broken tree crash-loops the poller,
rem visibly, in the log), and its git push refuses to reset a dirty working tree,
rem so a session's edits are never sacrificed to publish a page.
setlocal
set "REPO=C:\Users\newuser\Claude Private projects\NTUC and other scrapers nutrition"
set "LOG=C:\Users\newuser\shengsiong-runner\tg-poll.log"
set "RUNNER_SOURCE=laptop"
set "PATH=C:\Users\newuser\scoop\apps\nodejs\current;C:\Users\newuser\scoop\shims;%PATH%"

rem Roll the log past ~5 MB. This process runs for days and retries a dead network
rem every 5 seconds, so an unrotated log is a slow leak.
if exist "%LOG%" for %%A in ("%LOG%") do if %%~zA GTR 5000000 move /y "%LOG%" "%LOG%.old" >nul

echo ==== %DATE% %TIME% : inbox start ==== >> "%LOG%"
cd /d "%REPO%"
call npm run tg-poll >> "%LOG%" 2>&1
set "RC=%ERRORLEVEL%"
echo ==== %DATE% %TIME% : inbox exited (exit %RC%) ==== >> "%LOG%"
rem The poller is supposed to run forever, so ANY exit is news. Hand the real code
rem back - the same lesson as run.cmd, where a wrapper that always returned 0 let
rem Task Scheduler report success on a run where every search failed.
endlocal & exit /b %RC%
