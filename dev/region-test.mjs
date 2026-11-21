import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createWindowsBackend } from '../capture/windows.js'

const backend = createWindowsBackend()
const drag = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(import.meta.dirname, 'drag.ps1')], {
  stdio: ['ignore', 'inherit', 'inherit'],
  windowsHide: true,
})

const started = performance.now()
const result = await backend.capture('region', { maxEdge: 2560, hideShell: false })
const elapsed = Math.round(performance.now() - started)
console.log('region', elapsed, 'ms', JSON.stringify({ ok: result.ok, error: result.error, bytes: result.buffer?.length, detail: result.detail }))
if (result.ok) {
  const out = join(import.meta.dirname, 'region-shot.png')
  await writeFile(out, result.buffer)
  console.log('saved', out)
}
drag.kill()
backend.dispose()
