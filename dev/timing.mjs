import { createWindowsBackend } from '../capture/windows.js'

const backend = createWindowsBackend()
await backend.listWindows()

for (let i = 0; i < 3; i += 1) {
  const started = performance.now()
  const screen = await backend.capture('screen', { maxEdge: 2560 })
  console.log(`screen #${i + 1}`, Math.round(performance.now() - started), 'ms', screen.buffer?.length, screen.error ?? '')
}

const list = await backend.listWindows()
const target = list.windows?.find((w) => w.app !== 'DeepSeek Harness') ?? list.windows?.[0]
if (target !== undefined) {
  for (let i = 0; i < 2; i += 1) {
    const started = performance.now()
    const shot = await backend.capture('window', { windowId: target.id, maxEdge: 2560 })
    console.log(`window #${i + 1}`, Math.round(performance.now() - started), 'ms', shot.buffer?.length, shot.error ?? '')
  }
}

backend.dispose()
