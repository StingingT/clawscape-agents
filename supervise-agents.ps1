$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath 'C:\Users\guyro\Documents\Guy\clawscape-agent'
# Stay attached so Task Scheduler owns the supervisor for its entire lifetime.
& 'C:\Users\guyro\.bun\bin\bun.exe' 'scripts/supervise.ts'
exit $LASTEXITCODE
