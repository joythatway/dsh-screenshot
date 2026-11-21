import { execFileSync } from 'node:child_process'
import { createWindowsBackend } from '../capture/windows.js'

const backend = createWindowsBackend()
backend.warmup()
await new Promise((resolve) => setTimeout(resolve, 4000))

const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -like '*helper.ps1*' } | ForEach-Object { $p = Get-Process -Id $_.ProcessId; '{0} {1} MB' -f $_.ProcessId, [math]::Round($p.WorkingSet64 / 1MB) }",
], { encoding: 'utf8' })
console.log(out.trim())
backend.dispose()
