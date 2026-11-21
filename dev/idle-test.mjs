import { execFileSync } from 'node:child_process'
import { createWindowsBackend } from '../capture/windows.js'

const count = () => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  "(Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -like '*helper.ps1*' }).Count",
], { encoding: 'utf8' }).trim()

const backend = createWindowsBackend()
backend.warmup()
await new Promise((resolve) => setTimeout(resolve, 3000))
console.log('helpers at 3s:', count())
await new Promise((resolve) => setTimeout(resolve, 4000))
console.log('helpers at 7s:', count())
const list = await backend.listWindows()
console.log('restart works:', list.ok, list.windows.length)
backend.dispose()
