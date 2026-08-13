' Runs a .cmd with no console window, waits for it, and hands back its exit code.
'
' Task Scheduler's Exec action has no "hidden" option: a .cmd invoked directly under
' an interactive logon shows a console window every single time. The two grocery jobs
' fire 288 and 96 times a day between them, so that is roughly one window every four
' minutes all day on the user's desktop.
'
' Use it as:
'   Program:   wscript.exe
'   Arguments: //B //Nologo "C:\...\run-hidden.vbs" "C:\...\target.cmd"
'
' ⚠️ Window style 0 AND bWaitOnReturn True, both deliberately:
'   - 0 is genuinely invisible. `powershell -WindowStyle Hidden` is not — it paints a
'     window and then hides it, which on a job this frequent reads as a steady flicker.
'   - True makes wscript BLOCK until the .cmd finishes and return its exit code, so
'     Task Scheduler still sees real success/failure, still enforces ExecutionTimeLimit,
'     and still honours MultipleInstancesPolicy=IgnoreNew. With False it would report
'     instant success on every run and let slow runs pile up on top of each other.
'
' ⚠️ This changes nothing about how often the jobs run or what they do. It hides them.
' A job that was failing silently goes on failing silently, just less visibly - so the
' logs (ss-request.log, tg-drain.log) become the only way to notice. Both already
' record their failures; that is the reason this is safe to hide.

Option Explicit

Dim args, target, i, quoted
Set args = WScript.Arguments

If args.Count < 1 Then
	' No target. Fail loudly rather than "succeeding" at doing nothing - a silent
	' zero here would look like a healthy job that never ran.
	WScript.Quit 2
End If

target = args(0)
quoted = """" & target & """"

' Anything after the target is passed through to the .cmd untouched, so this shim can
' front a job that takes arguments without needing a copy per job.
For i = 1 To args.Count - 1
	quoted = quoted & " """ & args(i) & """"
Next

' ⚠️ The .cmd is launched DIRECTLY, not as `cmd.exe /c "..."`. Both these paths contain
' spaces ("Claude Private projects", "shengsiong-runner"), so both have to be quoted -
' and `cmd /c` then strips the first and last quote of the whole string, which tore the
' path in half and returned 1 without ever running the target. Run() starts a .cmd by
' itself; the extra cmd.exe was never needed.
WScript.Quit CreateObject("WScript.Shell").Run(quoted, 0, True)
