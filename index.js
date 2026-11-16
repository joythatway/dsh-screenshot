// 框选截图 (screenshot-picker) — Host half
//
// 职责：
//   1. 把页面的截图请求转给当前平台的采集后端（见 capture/）
//   2. 截图先缩放再暂存在内存里，给页面一个同源下载地址
//   3. 页面拿到 PNG 后塞进当前草稿，随消息发给模型
//
// 为什么在 Host 做：浏览器侧的 getDisplayMedia 在这个壳里被权限处理器直接拒绝，
// 只有宿主机进程才能调用系统截图。

import { randomUUID } from 'node:crypto'
import { createCaptureBackend } from './capture/index.js'
import { normalizeCaptureMode, parseWindowId } from './lib/util.js'

export const name = 'dsh-screenshot'
export const inject = ['webServer', 'connection']

const PREFIX = '/api/dsh-screenshot'
const SHOT_TTL_MS = 60_000
/** 交给模型的截图长边上限：再大也只是多花 token 和上传时间。 */
const MAX_IMAGE_EDGE = 2560
const MAX_BODY_BYTES = 4096

function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * 读一个很小的 JSON 请求体；读不到就当空对象。
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Record<string, unknown>>}
 */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('body_too_large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 注册截图插件的 Host 半边。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const backend = createCaptureBackend()
  /** id -> { buffer, timer } —— 已经截好、等页面来取图的暂存区。 */
  const shots = new Map()
  /** 同一时刻只允许一个交互式截图，避免两个遮罩打架。 */
  let capturing = false

  function retainShot(buffer) {
    const id = randomUUID()
    const timer = setTimeout(() => {
      shots.delete(id)
    }, SHOT_TTL_MS)
    timer.unref?.()
    shots.set(id, { buffer, timer })
    return id
  }

  function dropShot(id) {
    const shot = shots.get(id)
    if (shot === undefined) return undefined
    clearTimeout(shot.timer)
    shots.delete(id)
    return shot
  }

  async function capture(res, body) {
    if (!backend.available) {
      send(res, 200, { ok: false, error: 'unsupported' })
      return
    }
    const mode = normalizeCaptureMode(body.mode)
    if (!backend.modes.includes(mode)) {
      send(res, 200, { ok: false, error: 'unsupported', detail: `mode ${mode} is not available on ${backend.id}` })
      return
    }
    if (capturing) {
      send(res, 200, { ok: false, error: 'busy' })
      return
    }
    const windowId = parseWindowId(body.windowId)
    capturing = true
    try {
      const granted = await backend.preflightPermission()
      if (granted === false) {
        send(res, 200, { ok: false, error: 'permission', detail: 'screen recording permission is not granted' })
        return
      }
      const result = await backend.capture(mode, { windowId })
      if (!result.ok) {
        send(res, 200, { ok: false, error: result.error, detail: result.detail || '' })
        return
      }
      const optimized = await backend.optimize(result.buffer, MAX_IMAGE_EDGE)
      const id = retainShot(optimized)
      send(res, 200, {
        ok: true,
        id,
        mode,
        bytes: optimized.length,
        ...(result.hideError === undefined ? {} : { hideError: result.hideError }),
      })
    } finally {
      capturing = false
    }
  }

  async function handler(req, res) {
    // 先过 DSH 自己的准入检查：Host/Origin 围栏 + 浏览器登录态。
    // webServer.register 挂出来的路由不会被框架自动加这层，必须手动问一次。
    try {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) {
        send(res, rejection, { ok: false, error: rejection === 401 ? 'unauthorized' : 'forbidden' })
        return
      }
    } catch {
      // 拿不到 connection 服务时退回下面的同源检查。
    }

    // 只接受同源请求：这是本机截图能力，不能让任意网页调。
    const site = req.headers['sec-fetch-site']
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
      send(res, 403, { ok: false, error: 'cross_site' })
      return
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const route = url.pathname.slice(PREFIX.length) || '/'
    const method = req.method || 'GET'

    try {
      if (method === 'GET' && route === '/probe') {
        send(res, 200, {
          ok: true,
          supported: backend.available,
          platform: backend.id,
          modes: backend.available ? backend.modes : [],
          capturing,
        })
        return
      }

      if (method === 'GET' && route === '/windows') {
        const listed = await backend.listWindows()
        send(res, 200, listed.ok
          ? { ok: true, windows: listed.windows }
          : { ok: false, error: listed.error || 'list_failed' })
        return
      }

      if (method === 'GET' && route === '/thumbnail') {
        const windowId = parseWindowId(url.searchParams.get('id'))
        if (windowId === undefined) {
          send(res, 400, { ok: false, error: 'invalid_id' })
          return
        }
        const buffer = await backend.thumbnail(windowId)
        if (buffer === undefined) {
          send(res, 404, { ok: false, error: 'thumbnail_failed' })
          return
        }
        res.writeHead(200, {
          'content-type': 'image/png',
          'cache-control': 'no-store',
          'content-length': buffer.length,
        })
        res.end(buffer)
        return
      }

      if (method === 'POST' && route === '/capture') {
        const body = await readBody(req).catch(() => ({}))
        await capture(res, body)
        return
      }

      if (method === 'POST' && route === '/settings-screen') {
        const body = await readBody(req).catch(() => ({}))
        send(res, 200, { ok: backend.openSettings(body.pane === 'accessibility' ? 'accessibility' : 'screen') })
        return
      }

      if (method === 'GET' && route.startsWith('/image/')) {
        const shot = dropShot(route.slice('/image/'.length))
        if (shot === undefined) {
          send(res, 404, { ok: false, error: 'not_found' })
          return
        }
        res.writeHead(200, {
          'content-type': 'image/png',
          'cache-control': 'no-store',
          'content-length': shot.buffer.length,
        })
        res.end(shot.buffer)
        return
      }

      send(res, 404, { ok: false, error: 'not_found' })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      send(res, 500, { ok: false, error: 'internal', detail: detail.slice(0, 300) })
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler }))

  // 插件卸载时收尾：停掉采集后端，清掉内存里的图。
  ctx.effect(() => () => {
    backend.dispose()
    for (const id of [...shots.keys()]) dropShot(id)
    capturing = false
  })
}
