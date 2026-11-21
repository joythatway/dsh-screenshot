// 伪 ctx + 真 HTTP：验证插件路由在 Windows 后端下的完整链路。
import http from 'node:http'
import { apply } from '../index.js'

const routes = []
const disposers = []
const ctx = {
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
  connection: {
    requestRejection() {
      return undefined
    },
  },
  effect(fn) {
    const disposer = fn()
    if (typeof disposer === 'function') disposers.push(disposer)
    return () => {}
  },
}

apply(ctx)

const prefix = '/api/dsh-screenshot'
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (!url.pathname.startsWith(prefix)) {
    res.writeHead(404).end()
    return
  }
  const handler = routes.find((route) => route.path === prefix)
  if (handler === undefined) {
    res.writeHead(500).end()
    return
  }
  Promise.resolve(handler.handler(req, res)).catch((error) => {
    res.writeHead(500).end(String(error))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}${prefix}`

const json = async (path, options) => {
  const response = await fetch(base + path, options)
  return { status: response.status, body: await response.json() }
}

console.log('probe', JSON.stringify(await json('/probe')))
console.log('warm', JSON.stringify(await json('/warm', { method: 'POST' })))

let started = performance.now()
const capture = await json('/capture', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ mode: 'screen' }),
})
console.log('capture screen', Math.round(performance.now() - started), 'ms', JSON.stringify(capture.body))

if (capture.body.ok) {
  started = performance.now()
  const image = await fetch(`${base}/image/${capture.body.id}`)
  const buffer = Buffer.from(await image.arrayBuffer())
  console.log('image', Math.round(performance.now() - started), 'ms', image.status, buffer.length, 'png=', buffer.subarray(1, 4).toString() === 'PNG', 'w=', buffer.readUInt32BE(16), 'h=', buffer.readUInt32BE(20))
}

const windows = await json('/windows')
console.log('windows', windows.body.ok, windows.body.windows?.length)
const first = windows.body.windows?.[0]
if (first !== undefined) {
  started = performance.now()
  const shot = await json('/capture', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'window', windowId: first.id }),
  })
  console.log('capture window', Math.round(performance.now() - started), 'ms', JSON.stringify(shot.body))
  if (shot.body.ok) {
    const image = await fetch(`${base}/image/${shot.body.id}`)
    const buffer = Buffer.from(await image.arrayBuffer())
    console.log('window image', image.status, buffer.length)
  }

  started = performance.now()
  const thumb = await fetch(`${base}/thumbnail?id=${first.id}`)
  const thumbBuffer = Buffer.from(await thumb.arrayBuffer())
  console.log('thumbnail', Math.round(performance.now() - started), 'ms', thumb.status, thumbBuffer.length)
}

const settings = await json('/settings')
console.log('settings', settings.status, JSON.stringify(settings.body.settings), settings.body.platform)

server.close()
for (const dispose of disposers) dispose()
