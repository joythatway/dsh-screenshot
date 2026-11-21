import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createWindowsBackend } from '../capture/windows.js'

const backend = createWindowsBackend()
const list = await backend.listWindows()
const target = (list.windows ?? []).find((w) => w.app !== 'DeepSeek Harness') ?? list.windows?.[0]
if (target === undefined) throw new Error('no target window')
const dsh = (list.windows ?? []).find((w) => w.app === 'DeepSeek Harness')
const inside = (w, x, y) => x >= w.x && x < w.x + w.w && y >= w.y && y < w.y + w.h
const candidates = [
  [target.x + 80, target.y + 80],
  [target.x + target.w - 80, target.y + target.h - 80],
  [target.x + 80, target.y + target.h - 80],
  [target.x + target.w - 80, target.y + 80],
  [Math.round(target.x + target.w / 2), Math.round(target.y + target.h / 2)],
]
const point = candidates.find(([x, y]) => !(dsh && inside(dsh, x, y))) ?? candidates[0]
const [x, y] = point
console.log('target', target.app, target.title.slice(0, 40), 'at', x, y)

const click = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(import.meta.dirname, 'click.ps1'), '-X', String(x), '-Y', String(y)], {
  stdio: ['ignore', 'inherit', 'inherit'],
  windowsHide: true,
})

const started = performance.now()
const result = await backend.capture('window', { maxEdge: 2560 })
console.log('pick', Math.round(performance.now() - started), 'ms', JSON.stringify({ ok: result.ok, error: result.error, bytes: result.buffer?.length, detail: result.detail }))
if (result.ok) {
  const out = join(import.meta.dirname, 'pick-shot.png')
  await writeFile(out, result.buffer)
  console.log('saved', out)
}
click.kill()
backend.dispose()
