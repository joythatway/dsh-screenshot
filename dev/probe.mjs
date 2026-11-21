import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const helperPath = fileURLToPath(new URL('../capture/win/helper.ps1', import.meta.url))
const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-File', helperPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => process.stderr.write('[ps] ' + chunk))
child.stdout.setEncoding('utf8')

let buffer = ''
const waiting = new Map()
let seq = 0
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line === '') continue
    let message
    try { message = JSON.parse(line) } catch { console.log('UNPARSED', line.slice(0, 200)); continue }
    const entry = waiting.get(message.id)
    if (entry) { waiting.delete(message.id); entry(message) }
  }
})

function request(op, args = {}, timeoutMs = 60000) {
  const id = ++seq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error('timeout ' + op)) }, timeoutMs)
    waiting.set(id, (message) => { clearTimeout(timer); resolve(message) })
    child.stdin.write(JSON.stringify({ id, op, ...args }) + '\n')
  })
}

const t = (label, start) => console.log(label, Math.round(performance.now() - start), 'ms')

let start = performance.now()
const ping = await request('ping')
t('ping', start)
console.log('ping ->', JSON.stringify(ping))

start = performance.now()
const list = await request('list')
t('list', start)
console.log('windows', list.windows?.length)
for (const w of list.windows ?? []) {
  console.log(`  ${w.id}\t${w.app}\t${w.cls}\t${w.w}x${w.h}\t${w.title}`)
}

const dir = await mkdtemp(join(tmpdir(), 'probe-'))
start = performance.now()
const screen = await request('screen', { path: join(dir, 'screen.png'), maxEdge: 2560 })
t('screen', start)
console.log('screen ->', JSON.stringify(screen), 'file', (await stat(join(dir, 'screen.png'))).size)

if (list.windows?.length) {
  const target = list.windows[0]
  start = performance.now()
  const shot = await request('window', { hwnd: target.id, path: join(dir, 'window.png'), maxEdge: 2560 })
  t('window', start)
  console.log('window ->', JSON.stringify(shot), 'file', (await stat(join(dir, 'window.png'))).size)

  start = performance.now()
  const thumb = await request('thumb', { hwnd: target.id, path: join(dir, 'thumb.png'), edge: 480 })
  t('thumb', start)
  console.log('thumb ->', JSON.stringify(thumb), 'file', (await stat(join(dir, 'thumb.png'))).size)
}

console.log('dir', dir)
child.stdin.end()
await new Promise((resolve) => child.on('exit', resolve))
