import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createWindowsBackend } from '../capture/windows.js'

const backend = createWindowsBackend()
const hwnd = Number(process.argv[2])
const list = await backend.listWindows()
console.log('list', list.ok, list.windows?.map((w) => `${w.id}:${w.app}:${w.title.slice(0, 20)}`))
const started = performance.now()
const shot = await backend.capture('window', { windowId: hwnd, maxEdge: 2560 })
console.log('window', Math.round(performance.now() - started), 'ms', JSON.stringify({ ok: shot.ok, bytes: shot.buffer?.length, error: shot.error, detail: shot.detail }))
if (shot.ok) {
  const out = join(import.meta.dirname, 'window-shot.png')
  await writeFile(out, shot.buffer)
  console.log('saved', out)
}
backend.dispose()
