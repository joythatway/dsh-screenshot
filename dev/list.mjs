import { createWindowsBackend } from '../capture/windows.js'

const backend = createWindowsBackend()
const started = performance.now()
const list = await backend.listWindows()
const elapsed = Math.round(performance.now() - started)
console.log(`list ${elapsed}ms ok=${list.ok} count=${list.windows?.length}`)
for (const w of list.windows ?? []) {
  console.log(`  ${w.id}\t${w.pid}\t${w.app}\t${w.w}x${w.h}\t${w.title}`)
}
backend.dispose()
