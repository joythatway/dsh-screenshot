// Windows 采集后端：常驻 PowerShell helper + Win32（PrintWindow / GDI）。
//
// 旧实现每次截图都 spawn 一个 powershell.exe 重新 Add-Type（约 1.2 s），
// 抓完还要再起第二个进程缩放到 2560：整屏一次 3 s 左右，窗口列表 1.4 s。
// 现在 helper 只启动一次，之后所有命令走 stdin/stdout 的 JSON 行，
// 抓屏、缩放、PNG 编码都在同一次调用里完成；图片以 base64 直接回传，不落盘。
//
// 空闲 3 分钟会把 helper 关掉，不在后台常驻内存；下一次截图 / 悬停菜单时再拉起。

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** helper 脚本位置；随包一起发布（package.json 的 files 里要带上）。 */
const HELPER = fileURLToPath(new URL('./win/helper.ps1', import.meta.url))
/** powershell.exe 的位置：优先用系统目录的绝对路径，PATH 被裁过时也能起来。 */
const POWERSHELL = (() => {
  const root = process.env.SystemRoot || process.env.windir
  if (typeof root !== 'string' || root === '') return 'powershell.exe'
  const full = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(full) ? full : 'powershell.exe'
})()
const THUMB_EDGE = 480
const THUMB_TTL_MS = 30_000
const THUMB_MAX_ENTRIES = 16
/** 首次启动要编译 C#（Add-Type），给宽松一点。 */
const START_TIMEOUT_MS = 30_000
const LIST_TIMEOUT_MS = 6_000
const CAPTURE_TIMEOUT_MS = 15_000
/** 框选 / 鼠标点选要等用户操作，超时只是兜底。 */
const INTERACTIVE_TIMEOUT_MS = 180_000
/** 空闲这么久没有请求就退出 helper，把内存还给系统。可用环境变量缩短，方便测试。 */
const IDLE_SHUTDOWN_MS = Number(process.env.DSH_SCREENSHOT_IDLE_MS) || 3 * 60 * 1000
/** 交给模型的长边上限，和 index.js 的 MAX_IMAGE_EDGE 一致。 */
const DEFAULT_MAX_EDGE = 2560

/**
 * 把异常压成一行给 detail 用。
 * @param {unknown} error
 * @returns {string}
 */
function describe(error) {
  if (error instanceof Error) return error.message.slice(0, 300)
  return String(error).slice(0, 300)
}

/**
 * 常驻 helper 的进程管理：懒启动、请求排队、超时、崩溃重启和空闲退出。
 * @returns {object} helper 客户端。
 */
function createHelper() {
  let child
  let starting
  let idleTimer
  let seq = 0
  let buffer = ''
  let stderr = ''
  const pending = new Map()

  function clearIdle() {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer)
      idleTimer = undefined
    }
  }

  /** 手上没有请求时开始计时；有请求时绝不退出，避免把框选遮罩杀掉。 */
  function scheduleIdle() {
    clearIdle()
    if (child === undefined || pending.size > 0) return
    idleTimer = setTimeout(() => {
      idleTimer = undefined
      stop()
    }, IDLE_SHUTDOWN_MS)
    idleTimer.unref?.()
  }

  /** 进程没了：把所有等在队列里的请求一次性失败掉，避免页面一直转圈。 */
  function failPending(reason) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error(reason))
    }
    pending.clear()
  }

  function stop() {
    clearIdle()
    const current = child
    child = undefined
    failPending(new Error('helper_stopped'))
    if (current !== undefined) {
      try {
        current.stdin.end()
      } catch {}
      current.kill()
    }
  }

  /** 按行切 helper 的 stdout；一行就是一个 JSON 响应。 */
  function onStdout(chunk) {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line !== '') {
        let message
        try {
          message = JSON.parse(line)
        } catch {
          message = undefined
        }
        if (message !== undefined) {
          const entry = pending.get(message.id)
          if (entry !== undefined) {
            pending.delete(message.id)
            clearTimeout(entry.timer)
            entry.resolve(message)
            if (pending.size === 0) scheduleIdle()
          }
        }
      }
      index = buffer.indexOf('\n')
    }
  }

  function start() {
    const proc = spawn(POWERSHELL, [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-STA',
      '-File',
      HELPER,
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    child = proc
    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')
    proc.stdout.on('data', onStdout)
    proc.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-8192)
    })
    proc.stdin.on('error', () => {})
    proc.on('error', () => {
      if (child === proc) {
        child = undefined
        clearIdle()
        failPending(new Error('helper_spawn_failed'))
      }
    })
    proc.on('exit', () => {
      if (child === proc) {
        child = undefined
        clearIdle()
        failPending(new Error('helper_exited'))
      }
    })
  }

  /**
   * 发一个请求；调用前必须先 await ensure()。
   * @param {string} op 操作名。
   * @param {object} args 参数。
   * @param {number} timeoutMs 超时。
   * @returns {Promise<object>} helper 的响应。
   */
  function request(op, args, timeoutMs) {
    const current = child
    if (current === undefined) return Promise.reject(new Error('helper_not_started'))
    const id = ++seq
    clearIdle()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('helper_timeout'))
        if (pending.size === 0) scheduleIdle()
      }, timeoutMs)
      timer.unref?.()
      pending.set(id, { resolve, reject, timer })
      try {
        current.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`)
      } catch {
        clearTimeout(timer)
        pending.delete(id)
        reject(new Error('helper_write_failed'))
      }
    })
  }

  /** 确保 helper 已经起来；并发调用共用同一次启动。 */
  async function ensure() {
    if (child !== undefined) return
    if (starting !== undefined) return starting
    starting = (async () => {
      start()
      const pong = await request('ping', {}, START_TIMEOUT_MS)
      if (pong === null || pong.ok !== true) throw new Error('helper_ping_failed')
    })()
    try {
      await starting
    } catch (error) {
      const current = child
      child = undefined
      if (current !== undefined) current.kill()
      throw error
    } finally {
      starting = undefined
    }
  }

  /**
   * 真正发请求：先保证进程在，再把 helper 的错误翻成异常。
   * @param {string} op 操作名。
   * @param {object} args 参数。
   * @param {number} timeoutMs 超时。
   * @returns {Promise<object>} 响应。
   */
  async function call(op, args, timeoutMs) {
    await ensure()
    return request(op, args, timeoutMs)
  }

  return {
    ensure,
    call,
    /** 预热：把 Add-Type 的一次性成本挪到后台。 */
    warmup() {
      ensure().catch(() => {})
    },
    /** 把 helper 里的 stderr 尾巴带进错误信息，方便用户贴失败原因。 */
    lastError() {
      return stderr.trim().slice(-400)
    },
    dispose: stop,
  }
}

/**
 * 创建 Windows 采集后端。
 * @returns {object} 与 macOS 后端同形的接口。
 */
export function createWindowsBackend() {
  const helper = createHelper()
  const thumbnails = new Map()

  /**
   * 跑一次采集：helper 直接在内存里编码 PNG 并以 base64 回传，这里解码成 Buffer。
   * 不写临时文件，也就不会给用户磁盘留垃圾。
   * @param {string} op helper 操作名。
   * @param {object} args 参数。
   * @param {number} timeoutMs 超时。
   * @returns {Promise<{ok:boolean,buffer?:Buffer,error?:string,detail?:string}>}
   */
  async function grab(op, args, timeoutMs) {
    try {
      const result = await helper.call(op, args, timeoutMs)
      if (result.ok !== true) {
        return {
          ok: false,
          error: typeof result.error === 'string' ? result.error : 'capture_failed',
          detail: typeof result.detail === 'string' ? result.detail : helper.lastError(),
        }
      }
      const buffer = Buffer.from(typeof result.data === 'string' ? result.data : '', 'base64')
      if (buffer.length === 0) return { ok: false, error: 'capture_failed' }
      return { ok: true, buffer }
    } catch (error) {
      return { ok: false, error: 'capture_failed', detail: [describe(error), helper.lastError()].filter(Boolean).join(' | ') }
    }
  }

  async function listWindows() {
    try {
      const result = await helper.call('list', {}, LIST_TIMEOUT_MS)
      const raw = Array.isArray(result.windows) ? result.windows : (result.windows ? [result.windows] : [])
      const windows = raw.map((entry) => ({
        id: Number(entry.id),
        pid: Number(entry.pid),
        title: typeof entry.title === 'string' ? entry.title : '',
        app: typeof entry.app === 'string' ? entry.app : '',
        x: Number(entry.x) || 0,
        y: Number(entry.y) || 0,
        w: Number(entry.w) || 0,
        h: Number(entry.h) || 0,
      }))
      return { ok: true, windows }
    } catch (error) {
      // helper 的 stderr 尾巴对排查很有用（比如 Add-Type 编译失败），一起带上。
      return { ok: false, error: 'list_failed', detail: [describe(error), helper.lastError()].filter(Boolean).join(' | ') }
    }
  }

  /**
   * 宿主主窗口可能所属的进程：桌面版里宿主跑在 Electron 主进程的子进程里，
   * 父进程才是拥有窗口的那个；万一改成主进程内运行，就轮到自己。
   * 普通 node 环境返回空数组（不隐藏）。
   * @returns {number[]} 候选 pid，优先父进程。
   */
  function shellPids() {
    if (process.versions.electron === undefined) return []
    const pids = [process.ppid, process.pid].filter((pid) => Number.isInteger(pid) && pid > 0)
    return [...new Set(pids)]
  }

  return {
    id: 'windows',
    available: true,
    modes: ['region', 'window', 'screen'],

    async preflightPermission() {
      // Windows 桌面程序没有 macOS 那样的按应用屏幕录制授权，无需预检。
      return undefined
    },

    listWindows,

    async capture(mode, options = {}) {
      const maxEdge = Number.isFinite(options.maxEdge) ? options.maxEdge : DEFAULT_MAX_EDGE
      const hideShell = options.hideShell === true
      if (mode === 'screen') {
        return grab('screen', { maxEdge }, CAPTURE_TIMEOUT_MS)
      }
      if (mode === 'window') {
        if (options.windowId !== undefined) {
          return grab('window', { hwnd: options.windowId, maxEdge }, CAPTURE_TIMEOUT_MS)
        }
        // 没有窗口号 = 菜单里的「改用鼠标点选窗口」：进交互式点选遮罩。
        // 点选不隐藏宿主窗口：遮罩本来就盖住整屏，选中后用 PrintWindow 截窗口内容，
        // 隐藏宿主反而会让桌面窗口重新排布，多此一举。
        return grab('pick', { maxEdge }, INTERACTIVE_TIMEOUT_MS)
      }
      if (mode === 'region') {
        return grab('region', { maxEdge, hideShell, shellPids: shellPids() }, INTERACTIVE_TIMEOUT_MS)
      }
      return { ok: false, error: 'unsupported' }
    },

    async thumbnail(windowId) {
      const cached = thumbnails.get(windowId)
      if (cached !== undefined && Date.now() - cached.at < THUMB_TTL_MS) return cached.buffer
      const result = await grab('thumb', { hwnd: windowId, edge: THUMB_EDGE }, CAPTURE_TIMEOUT_MS)
      if (!result.ok) return undefined
      thumbnails.set(windowId, { buffer: result.buffer, at: Date.now() })
      while (thumbnails.size > THUMB_MAX_ENTRIES) {
        const oldest = thumbnails.keys().next().value
        if (oldest === undefined) break
        thumbnails.delete(oldest)
      }
      return result.buffer
    },

    /** helper 已经按长边缩过了，这里不用再处理。 */
    async optimize(buffer) {
      return buffer
    },

    warmup() {
      helper.warmup()
    },

    openSettings() {
      return false
    },

    dispose() {
      thumbnails.clear()
      helper.dispose()
    },
  }
}
