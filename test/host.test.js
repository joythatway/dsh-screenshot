// Host 路由的集成测试：用假 req/res 走一遍设置读写、保存、reveal 与准入检查。
// 真正写盘的目录是临时目录，跑完就删。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

/** 假 ctx：只提供 apply 用到的 connection / webServer / effect。 */
function createContext(options = {}) {
  const state = { handler: null, rejection: options.rejection }
  return {
    connection: {
      requestRejection: () => state.rejection,
    },
    webServer: {
      register(route) {
        state.handler = route.handler
        return () => {}
      },
    },
    effect(callback) {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get: () => undefined,
    handler: () => state.handler,
  }
}

function request(method, path, body, headers = {}) {
  const chunks = body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(String(body))]
  return {
    method,
    url: path,
    headers: { 'sec-fetch-site': 'same-origin', ...headers },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function response() {
  const state = { status: 0, headers: {}, body: '' }
  return {
    state,
    writeHead(status, headers) {
      state.status = status
      state.headers = headers === undefined ? {} : headers
    },
    end(body) {
      state.body = body === undefined ? '' : String(body)
    },
  }
}

async function call(ctx, method, path, body, headers) {
  const res = response()
  await ctx.handler()(request(method, path, body, headers), res)
  let json = null
  try {
    json = JSON.parse(res.state.body)
  } catch {
    json = null
  }
  return { status: res.state.status, json, raw: res.state.body, headers: res.state.headers }
}

/** 每个用例一块临时 DSH_HOME，互不干扰。 */
async function withTempHome(run) {
  const previous = process.env.DSH_HOME
  const home = await mkdtemp(join(tmpdir(), 'dsh-screenshot-test-'))
  process.env.DSH_HOME = home
  try {
    await run(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
}

test('GET /settings 返回默认值：桌面、自动隐藏开启', async () => {
  await withTempHome(async () => {
    const ctx = createContext()
    apply(ctx)
    const result = await call(ctx, 'GET', '/api/dsh-screenshot/settings')
    assert.equal(result.status, 200)
    assert.equal(result.json.ok, true)
    assert.equal(result.json.settings.saveDir, '')
    assert.equal(result.json.settings.hideOnCapture, true)
    assert.match(result.json.saveDir, /Desktop$/u)
    assert.match(result.json.defaultSaveDir, /Desktop$/u)
  })
})

test('POST /settings 写入并把设置持久化到文件', async () => {
  await withTempHome(async (home) => {
    const dir = join(home, 'shots')
    const ctx = createContext()
    apply(ctx)
    const posted = await call(ctx, 'POST', '/api/dsh-screenshot/settings', JSON.stringify({ saveDir: dir, hideOnCapture: false }))
    assert.equal(posted.status, 200)
    assert.equal(posted.json.settings.saveDir, dir)
    assert.equal(posted.json.settings.hideOnCapture, false)
    assert.equal(posted.json.saveDir, dir)

    const stored = JSON.parse(await readFile(join(home, 'dsh-screenshot', 'settings.json'), 'utf8'))
    assert.equal(stored.saveDir, dir)
    assert.equal(stored.hideOnCapture, false)

    const read = await call(ctx, 'GET', '/api/dsh-screenshot/settings')
    assert.equal(read.json.settings.saveDir, dir)
  })
})

test('POST /settings 拒绝相对路径和错类型', async () => {
  await withTempHome(async () => {
    const ctx = createContext()
    apply(ctx)
    const relative = await call(ctx, 'POST', '/api/dsh-screenshot/settings', JSON.stringify({ saveDir: 'shots' }))
    assert.equal(relative.status, 400)
    assert.equal(relative.json.error, 'not_absolute')

    const wrongType = await call(ctx, 'POST', '/api/dsh-screenshot/settings', JSON.stringify({ hideOnCapture: 'yes' }))
    assert.equal(wrongType.status, 400)
    assert.equal(wrongType.json.error, 'invalid')
  })
})

test('POST /save 把 PNG 写进保存目录，非 PNG 被拒绝', async () => {
  await withTempHome(async (home) => {
    const dir = join(home, 'shots')
    const ctx = createContext()
    apply(ctx)
    await call(ctx, 'POST', '/api/dsh-screenshot/settings', JSON.stringify({ saveDir: dir }))

    const saved = await call(ctx, 'POST', `/api/dsh-screenshot/save?name=${encodeURIComponent('shot.png')}`, PNG, { 'content-type': 'image/png' })
    assert.equal(saved.status, 200)
    assert.equal(saved.json.ok, true)
    assert.equal(saved.json.path, join(dir, 'shot.png'))
    assert.deepEqual(await readFile(join(dir, 'shot.png')), PNG)

    // 同名再存一次，自动加序号。
    const again = await call(ctx, 'POST', `/api/dsh-screenshot/save?name=${encodeURIComponent('shot.png')}`, PNG, { 'content-type': 'image/png' })
    assert.equal(again.json.path, join(dir, 'shot-2.png'))
    assert.equal((await stat(join(dir, 'shot-2.png'))).size, PNG.length)

    const junk = await call(ctx, 'POST', `/api/dsh-screenshot/save?name=${encodeURIComponent('bad.png')}`, Buffer.from('not a png'), { 'content-type': 'image/png' })
    assert.equal(junk.status, 400)
    assert.equal(junk.json.error, 'not_png')
  })
})

test('POST /save 用安全文件名，挡掉路径穿越', async () => {
  await withTempHome(async (home) => {
    const dir = join(home, 'shots')
    const ctx = createContext()
    apply(ctx)
    await call(ctx, 'POST', '/api/dsh-screenshot/settings', JSON.stringify({ saveDir: dir }))
    const saved = await call(ctx, 'POST', `/api/dsh-screenshot/save?name=${encodeURIComponent('../../evil.png')}`, PNG, { 'content-type': 'image/png' })
    assert.equal(saved.json.name, 'evil.png')
    assert.equal(saved.json.path, join(dir, 'evil.png'))
  })
})

test('POST /reveal 只承认刚写出的文件', async () => {
  await withTempHome(async (home) => {
    const ctx = createContext()
    apply(ctx)
    const denied = await call(ctx, 'POST', '/api/dsh-screenshot/reveal', JSON.stringify({ path: '/etc/passwd' }))
    assert.equal(denied.status, 404)

    const dir = join(home, 'shots')
    await call(ctx, 'POST', '/api/dsh-screenshot/settings', JSON.stringify({ saveDir: dir }))
    const saved = await call(ctx, 'POST', `/api/dsh-screenshot/save?name=${encodeURIComponent('a.png')}`, PNG, { 'content-type': 'image/png' })
    const ok = await call(ctx, 'POST', '/api/dsh-screenshot/reveal', JSON.stringify({ path: saved.json.path }))
    assert.equal(ok.status, 200)
    assert.equal(ok.json.ok, true)
  })
})

test('准入检查：被 connection 拒绝时不再往下走', async () => {
  await withTempHome(async () => {
    const ctx = createContext({ rejection: 401 })
    apply(ctx)
    const result = await call(ctx, 'GET', '/api/dsh-screenshot/settings')
    assert.equal(result.status, 401)
    assert.equal(result.json.error, 'unauthorized')
  })
})

test('跨站请求被挡在同源检查外', async () => {
  await withTempHome(async () => {
    const ctx = createContext()
    apply(ctx)
    const result = await call(ctx, 'GET', '/api/dsh-screenshot/settings', undefined, { 'sec-fetch-site': 'cross-site' })
    assert.equal(result.status, 403)
    assert.equal(result.json.error, 'cross_site')
  })
})
