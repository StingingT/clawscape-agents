$ErrorActionPreference = 'Stop'
# Task Scheduler keeps the supervisor independent of Codex and this terminal.
Start-ScheduledTask -TaskName 'Clawscape Agents Watchdog'
Get-ScheduledTask -TaskName 'Clawscape Agents Watchdog' | Select-Object TaskName, State
