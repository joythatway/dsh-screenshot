import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { createWindowsBackend } from '../capture/windows.js'

const backend = createWindowsBackend()
const rightclick = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(import.meta.dirname, 'rightclick.ps1'), '-X', '1200', '-Y', '700'], {
  stdio: ['ignore', 'inherit', 'inherit'],
  windowsHide: true,
})

const started = performance.now()
const result = await backend.capture('region', { maxEdge: 2560 })
console.log('region-cancel', Math.round(performance.now() - started), 'ms', JSON.stringify({ ok: result.ok, error: result.error }))
rightclick.kill()
backend.dispose()
if (result.ok !== false || result.error !== 'cancelled') {
  console.error('EXPECTED cancelled')
  process.exitCode = 1
}
