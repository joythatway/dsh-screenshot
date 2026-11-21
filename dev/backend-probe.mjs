import { createWindowsBackend } from '../capture/windows.js'

const backend = createWindowsBackend()
const now = () => Math.round(performance.now())
let start = now()

const list = await backend.listWindows()
console.log(`list: ${now() - start}ms ok=${list.ok} count=${list.windows?.length}`, list.detail ?? '')
for (const w of list.windows ?? []) {
  console.log(`  ${w.id}\t${w.app}\t${w.w}x${w.h}\t${w.title}`)
}

start = now()
const screen = await backend.capture('screen', { maxEdge: 2560, hideShell: true })
console.log(`screen: ${now() - start}ms ok=${screen.ok} bytes=${screen.buffer?.length}`, screen.detail ?? '')

if (screen.ok) {
  start = now()
  const optimized = await backend.optimize(screen.buffer, 2560)
  console.log(`optimize: ${now() - start}ms same=${optimized === screen.buffer}`)
}

if (list.windows?.length) {
  const target = list.windows[0]
  start = now()
  const win = await backend.capture('window', { windowId: target.id, maxEdge: 2560 })
  console.log(`window: ${now() - start}ms ok=${win.ok} bytes=${win.buffer?.length}`, win.detail ?? '')

  start = now()
  const thumb = await backend.thumbnail(target.id)
  console.log(`thumbnail: ${now() - start}ms bytes=${thumb?.length}`)

  start = now()
  const again = await backend.thumbnail(target.id)
  console.log(`thumbnail cached: ${now() - start}ms bytes=${again?.length}`)

  const bogus = await backend.capture('window', { windowId: 12345, maxEdge: 2560 })
  console.log('bogus window ->', JSON.stringify(bogus))
}

backend.dispose()
