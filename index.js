// 框选截图 (screenshot-picker) — Host half
//
// 职责：
//   1. 把页面的截图请求转给当前平台的采集后端（见 capture/）
//   2. 截图先缩放再暂存在内存里，给页面一个同源下载地址
//   3. 页面拿到 PNG 后塞进当前草稿，随消息发给模型
//   4. 保存按钮把 PNG 落到用户设置的目录（默认桌面）
//   5. 读写插件设置：保存目录、框选时是否让开宿主窗口
//
// 为什么在 Host 做：浏览器侧的 getDisplayMedia 在这个壳里被权限处理器直接拒绝，
// 只有宿主机进程才能调用系统截图，也只有它能写文件。

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createCaptureBackend } from './capture/index.js'
import {
  DEFAULT_SETTINGS, isPng, normalizeSettings, readSettings,
  resolveSaveDir, safeFileName, settingsPath, validateSaveDir, writeSettings,
} from './lib/settings.js'
import { normalizeCaptureMode, parseWindowId } from './lib/util.js'

export const name = 'dsh-screenshot'
export const inject = ['webServer', 'connection']

const PREFIX = '/api/dsh-screenshot'
const SHOT_TTL_MS = 60_000
/** 交给模型的截图长边上限：再大也只是多花 token 和上传时间。 */
const MAX_IMAGE_EDGE = 2560
const MAX_BODY_BYTES = 4096
/** 保存请求的上限：图片最大也就几十 MB，超过就直接拒绝，别把内存吃光。 */
const MAX_SAVE_BYTES = 64 * 1024 * 1024
/** 记住最近写过的文件，/reveal 只对它们生效。 */
const WRITTEN_LIMIT = 200

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
 * 把整个请求体读进内存，用于保存 PNG。
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit 字节上限。
 * @returns {Promise<Buffer>} 请求体。
 */
async function readBinary(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('body_too_large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * 找一个没被占用的文件名：同名时加 -2、-3。
 * @param {string} dir 目标目录。
 * @param {string} name 期望的文件名。
 * @returns {Promise<string>} 可用的文件名。
 */
async function uniqueName(dir, name) {
  const extension = /\.png$/iu.test(name) ? name.slice(-4) : ''
  const stem = extension === '' ? name : name.slice(0, -4)
  for (let index = 1; index <= 999; index += 1) {
    const candidate = index === 1 ? `${stem}${extension}` : `${stem}-${index}${extension}`
    try {
      await access(join(dir, candidate))
    } catch {
      return candidate
    }
  }
  return `${stem}-${Date.now()}${extension}`
}

/**
 * 在「最近写过」集合里记住一个路径；集合满时丢掉最早的。
 * @param {Set<string>} written 集合。
 * @param {string} path 文件的绝对路径。
 */
function rememberWritten(written, path) {
  written.add(path)
  while (written.size > WRITTEN_LIMIT) {
    const first = written.values().next().value
    if (first === undefined) break
    written.delete(first)
  }
}

/**
 * 在系统文件管理器里定位一个文件。
 * @param {string} path 文件的绝对路径。
 */
function revealInFileManager(path) {
  // 测试里不要真的弹出 Finder 窗口。
  if (process.env.NODE_TEST_CONTEXT !== undefined) return
  const child = process.platform === 'darwin'
    ? spawn('/usr/bin/open', ['-R', path], { detached: true, stdio: 'ignore' })
    : process.platform === 'win32'
      ? spawn('explorer.exe', [`/select,${path}`], { detached: true, stdio: 'ignore' })
      : spawn('/usr/bin/xdg-open', [dirname(path)], { detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
}

/**
 * 注册截图插件的 Host 半边。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const backend = createCaptureBackend()
  /**
   * 预热采集后端。Windows 后端首次启动 helper 要编译 C#（约 1 s），
   * 让它在用户选模式的时候就起来，别等真正点截图。测试里不预热，免得留进程。
   */
  function warmBackend() {
    if (process.env.NODE_TEST_CONTEXT !== undefined) return
    backend.warmup?.()
  }
  // 晚一拍再预热：别和宿主自己的启动抢 CPU；悬停按钮 / 打开菜单时还会再叫一次。
  const warmTimer = setTimeout(warmBackend, 1500)
  warmTimer.unref?.()
  /** id -> { buffer, timer } —— 已经截好、等页面来取图的暂存区。 */
  const shots = new Map()
  /** 同一时刻只允许一个交互式截图，避免两个遮罩打架。 */
  let capturing = false
  /** 最近由本插件写出的文件；/reveal 只承认它们。 */
  const written = new Set()
  /** 设置文件路径与当前值；读盘完成前先用默认值应答。 */
  const file = settingsPath()
  let settings = { ...DEFAULT_SETTINGS }
  const settingsReady = readSettings(file).then((loaded) => {
    settings = loaded
    return loaded
  })

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
    // 框选时是否让开宿主窗口：默认让开，设置页可以关掉。
    const hideShell = body.hideShell !== false
    capturing = true
    try {
      const granted = await backend.preflightPermission()
      if (granted === false) {
        send(res, 200, { ok: false, error: 'permission', detail: 'screen recording permission is not granted' })
        return
      }
      const result = await backend.capture(mode, { windowId, hideShell, maxEdge: MAX_IMAGE_EDGE })
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

  /** 返回当前设置，以及页面里要显示的两个目录。 */
  async function readSettingsPayload() {
    await settingsReady
    return {
      ok: true,
      settings,
      saveDir: resolveSaveDir(settings),
      defaultSaveDir: join(homedir(), 'Desktop'),
      platform: process.platform,
    }
  }

  /** 写设置：只认识 saveDir / hideOnCapture 两个字段。 */
  async function updateSettings(res, body) {
    await settingsReady
    const next = { ...settings }
    if (Object.hasOwn(body, 'saveDir')) {
      const checked = validateSaveDir(body.saveDir)
      if (!checked.ok) {
        send(res, 400, { ok: false, error: checked.reason })
        return
      }
      next.saveDir = checked.value
    }
    if (Object.hasOwn(body, 'hideOnCapture')) {
      if (typeof body.hideOnCapture !== 'boolean') {
        send(res, 400, { ok: false, error: 'invalid' })
        return
      }
      next.hideOnCapture = body.hideOnCapture
    }
    try {
      await writeSettings(file, next)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      send(res, 500, { ok: false, error: 'settings_write_failed', detail: detail.slice(0, 300) })
      return
    }
    settings = normalizeSettings(next)
    send(res, 200, { ok: true, settings, saveDir: resolveSaveDir(settings) })
  }

  /** 把请求体里的 PNG 写进保存目录。 */
  async function saveShot(res, url, req) {
    const buffer = await readBinary(req, MAX_SAVE_BYTES)
    if (!isPng(buffer)) {
      send(res, 400, { ok: false, error: 'not_png' })
      return
    }
    await settingsReady
    const dir = resolveSaveDir(settings)
    await mkdir(dir, { recursive: true })
    const name = await uniqueName(dir, safeFileName(url.searchParams.get('name')))
    const path = join(dir, name)
    await writeFile(path, buffer)
    rememberWritten(written, path)
    send(res, 200, { ok: true, path, dir, name, bytes: buffer.length })
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

      // 预热：页面在悬停 / 打开菜单时先叫一声，Windows 后端就趁这点时间把 helper 拉起来。
      if (method === 'POST' && route === '/warm') {
        warmBackend()
        send(res, 200, { ok: true })
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

      if (route === '/settings') {
        if (method === 'GET') {
          send(res, 200, await readSettingsPayload())
          return
        }
        if (method === 'POST') {
          const body = await readBody(req).catch(() => ({}))
          await updateSettings(res, body)
          return
        }
      }

      if (method === 'POST' && route === '/save') {
        await saveShot(res, url, req)
        return
      }

      if (method === 'POST' && route === '/reveal') {
        const body = await readBody(req).catch(() => ({}))
        const path = typeof body.path === 'string' ? body.path : ''
        if (!written.has(path)) {
          send(res, 404, { ok: false, error: 'not_found' })
          return
        }
        revealInFileManager(path)
        send(res, 200, { ok: true })
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
      const status = detail === 'body_too_large' ? 413 : 500
      send(res, status, { ok: false, error: status === 413 ? 'body_too_large' : 'internal', detail: detail.slice(0, 300) })
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler }))

  // 插件卸载时收尾：停掉采集后端，清掉内存里的图。
  ctx.effect(() => () => {
    clearTimeout(warmTimer)
    backend.dispose()
    for (const id of [...shots.keys()]) dropShot(id)
    capturing = false
    written.clear()
  })
}
