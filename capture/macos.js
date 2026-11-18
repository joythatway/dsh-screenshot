// macOS 采集后端：screencapture + sips + JXA(CoreGraphics)。
//
// 交互式截图（框选 / 系统窗口点选）依赖 screencapture 的原生遮罩；
// 窗口列表和按窗口号截图走 CoreGraphics；缩略图和压缩用 sips。

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bmpIsFlat, classifyCaptureFailure, isOccluded, isUsableWindow } from '../lib/util.js'

const CAPTURE_BINARIES = ['/usr/sbin/screencapture', '/usr/bin/screencapture']
const SIPS = '/usr/bin/sips'
const OSASCRIPT = '/usr/bin/osascript'
const SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
const ACCESSIBILITY_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'

const THUMB_EDGE = 480
const THUMB_TTL_MS = 30_000
const THUMB_MAX_ENTRIES = 16

/** 屏幕录制权限预检：只问权限，不抓任何像素。 */
const PREFLIGHT_SCRIPT = `ObjC.import('CoreGraphics');
ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []]);
JSON.stringify({ granted: $.CGPreflightScreenCaptureAccess() });`

/**
 * 列出屏幕上可见的普通窗口（按前后层级顺序，最前的在前）。
 * 走 JXA + CoreGraphics：只要宿主已有屏幕录制权限，窗口标题也能读到。
 */
const WINDOWS_SCRIPT = `ObjC.import('CoreGraphics');
ObjC.import('Foundation');
(function () {
  var list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1, 0));
  var out = [];
  if (!list) return JSON.stringify(out);
  var n = list.count;
  for (var i = 0; i < n; i++) {
    var w = list.objectAtIndex(i);
    if (ObjC.unwrap(w.objectForKey('kCGWindowLayer')) !== 0) continue;
    var alpha = ObjC.unwrap(w.objectForKey('kCGWindowAlpha'));
    if (alpha === 0) continue;
    var b = ObjC.deepUnwrap(w.objectForKey('kCGWindowBounds')) || {};
    if (!(b.Width >= 100 && b.Height >= 80)) continue;
    out.push({
      id: ObjC.unwrap(w.objectForKey('kCGWindowNumber')),
      app: String(ObjC.unwrap(w.objectForKey('kCGWindowOwnerName')) || ''),
      title: String(ObjC.unwrap(w.objectForKey('kCGWindowName')) || ''),
      x: Math.round(b.X),
      y: Math.round(b.Y),
      w: Math.round(b.Width),
      h: Math.round(b.Height)
    });
  }
  return JSON.stringify(out);
})();`

/** 跑一个命令并等它退出；超时或启动失败返回 -1。 */
function runCommand(binaryPath, args, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(binaryPath, args, { stdio: ['ignore', 'ignore', 'ignore'] })
    } catch {
      resolve(-1)
      return
    }
    let settled = false
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(code)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(-1)
    }, timeoutMs)
    timer.unref?.()
    child.on('error', () => finish(-1))
    child.on('close', (code) => finish(code === null ? -1 : code))
  })
}

/** 把一段 JXA 交给 osascript 跑，返回解析后的 JSON；失败时 undefined。 */
function runJxa(script, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(OSASCRIPT, ['-l', 'JavaScript'], { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch {
      resolve(undefined)
      return
    }
    let stdout = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(undefined)
    }, timeoutMs)
    timer.unref?.()
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout = (stdout + chunk).slice(-262144)
    })
    child.on('error', () => finish(undefined))
    child.on('close', () => {
      try {
        finish(JSON.parse(stdout.trim()))
      } catch {
        finish(undefined)
      }
    })
    child.stdin?.end(script)
  })
}

/**
 * 创建 macOS 采集后端。
 * @returns {{id:string,available:boolean,modes:string[],preflightPermission:Function,listWindows:Function,capture:Function,thumbnail:Function,optimize:Function,openSettings:Function,dispose:Function}}
 */
export function createMacosBackend() {
  const binary = CAPTURE_BINARIES.find((candidate) => existsSync(candidate))
  /** windowId -> { buffer, at }：鼠标悬停预览用的小图缓存。 */
  const thumbnails = new Map()
  /** 正在进行的交互式截图进程。 */
  let captureChild = null

  /**
   * 把 screencapture 的参数跑一遍，返回内存里的 PNG。
   * @param {string[]} args 不含输出文件名的参数。
   * @returns {Promise<{ok:true,buffer:Buffer}|{ok:false,error:string}>}
   */
  async function captureToBuffer(args) {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-screenshot-window-')).catch(() => undefined)
    if (dir === undefined) return { ok: false, error: 'capture_failed' }
    const file = join(dir, 'window.png')
    try {
      const code = await runCommand(binary, [...args, file])
      if (code !== 0) return { ok: false, error: 'capture_failed' }
      const buffer = await readFile(file).catch(() => undefined)
      if (buffer === undefined || buffer.length === 0) return { ok: false, error: 'capture_failed' }
      return { ok: true, buffer }
    } finally {
      rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  /**
   * 判断 PNG 是不是纯色空图：缩到 8×8 的 BMP 后看颜色跨度。
   * Metal/GPU 渲染的窗口（比如 Steam）有时经窗口快照读回来就是一张纯色图。
   * @param {Buffer} buffer PNG 字节。
   * @returns {Promise<boolean>} 是否几乎没有任何内容。
   */
  async function looksBlank(buffer) {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-screenshot-check-')).catch(() => undefined)
    if (dir === undefined) return false
    const source = join(dir, 'check.png')
    const probe = join(dir, 'check.bmp')
    try {
      await writeFile(source, buffer)
      const code = await runCommand(SIPS, ['-s', 'format', 'bmp', '-Z', '8', source, '--out', probe])
      if (code !== 0) return false
      const bmp = await readFile(probe).catch(() => undefined)
      if (bmp === undefined) return false
      return bmpIsFlat(bmp)
    } finally {
      rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  /**
   * 按窗口号截整窗。先用精确窗口快照（-l），读回来是空图时，
   * 若该窗口没有被任何更靠前的窗口遮挡，就退回按矩形从屏幕合成里截（-R）。
   * @param {number} windowId CGWindowNumber。
   * @returns {Promise<{ok:true,buffer:Buffer}|{ok:false,error:string}>}
   */
  async function captureWindowImage(windowId) {
    const first = await captureToBuffer(['-l', String(windowId), '-o', '-x', '-t', 'png'])
    if (first.ok && !(await looksBlank(first.buffer))) return first
    const listed = await listWindows()
    if (listed.ok) {
      const index = listed.windows.findIndex((entry) => entry.id === windowId)
      const target = index === -1 ? undefined : listed.windows[index]
      if (target !== undefined && isUsableWindow(target) && !isOccluded(listed.windows, index)) {
        const rect = `${target.x},${target.y},${target.w},${target.h}`
        const second = await captureToBuffer(['-R', rect, '-x', '-t', 'png'])
        if (second.ok && !(await looksBlank(second.buffer))) return second
      }
    }
    return { ok: false, error: 'hidden' }
  }

  /**
   * 跑一次交互式截图：框选，或（无窗口号时）系统窗口点选。
   * @param {'region'|'window'} mode
   * @returns {Promise<{ok:true,buffer:Buffer}|{ok:false,error:string,detail?:string}>}
   */
  function runInteractive(mode) {
    return new Promise((resolve) => {
      const dirPromise = mkdtemp(join(tmpdir(), 'dsh-screenshot-'))
      dirPromise.then((dir) => {
        const file = join(dir, 'capture.png')
        const args = mode === 'window'
          ? ['-i', '-W', '-o', '-x', '-t', 'png', file]
          : ['-i', '-x', '-t', 'png', file]
        let stderr = ''
        let settled = false
        const finish = (result) => {
          if (settled) return
          settled = true
          rm(dir, { recursive: true, force: true }).catch(() => {})
          resolve(result)
        }
        let child
        try {
          child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] })
        } catch {
          finish({ ok: false, error: 'capture_failed' })
          return
        }
        captureChild = child
        child.stderr?.setEncoding('utf8')
        child.stderr?.on('data', (chunk) => {
          stderr = (stderr + chunk).slice(-4096)
        })
        child.on('error', () => {
          captureChild = null
          finish({ ok: false, error: 'capture_failed' })
        })
        child.on('close', (code, signal) => {
          captureChild = null
          const exit = String(signal === null ? code : signal)
          readFile(file)
            .then((buffer) => {
              if (buffer.length > 0) return finish({ ok: true, buffer })
              finish({ ok: false, ...classifyCaptureFailure(stderr, exit) })
            })
            .catch(() => finish({ ok: false, ...classifyCaptureFailure(stderr, exit) }))
        })
      }, () => resolve({ ok: false, error: 'capture_failed' }))
    })
  }

  async function listWindows() {
    const parsed = await runJxa(WINDOWS_SCRIPT)
    if (!Array.isArray(parsed)) return { ok: false, error: 'list_failed' }
    return { ok: true, windows: parsed }
  }

  /** 宿主窗口（Electron 主进程）的进程号：我们的父进程就是它。 */
  const shellPid = typeof process.ppid === 'number' ? process.ppid : 0
  let shellInfoCache

  /**
   * 找到承载本插件的桌面 App（拿它的名字给 System Events 用）。
   * 只有作为 Electron App 的子进程运行时才有；`dsh web` 挂在终端下就没有。
   * @returns {Promise<{pid:number,name:string,bundle:string}|undefined>}
   */
  async function shellAppInfo() {
    if (shellInfoCache !== undefined) return shellInfoCache
    const script = `ObjC.import('AppKit');
(function () {
  var a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${shellPid});
  if (!a) return JSON.stringify(null);
  return JSON.stringify({
    pid: $.NSRunningApplication.runningApplicationWithProcessIdentifier(${shellPid}).processIdentifier,
    name: String(ObjC.unwrap(a.localizedName) || ''),
    bundle: String(ObjC.unwrap(a.bundleIdentifier) || '')
  });
})();`
    const parsed = await runJxa(script, 4000)
    shellInfoCache = parsed !== null && typeof parsed === 'object' && typeof parsed.name === 'string' && parsed.name !== ''
      ? parsed
      : null
    return shellInfoCache === null ? undefined : shellInfoCache
  }

  /** 读宿主 App 当前的隐藏状态；找不到 App 时返回 undefined。 */
  async function shellHiddenState() {
    const script = `ObjC.import('AppKit');
(function () {
  var a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${shellPid});
  if (!a) return JSON.stringify(null);
  return JSON.stringify({ hidden: a.isHidden });
})();`
    const parsed = await runJxa(script, 4000)
    if (parsed === null || typeof parsed !== 'object' || typeof parsed.hidden !== 'boolean') return undefined
    return parsed.hidden
  }

  /**
   * 通过 System Events 设置宿主 App 的可见性。
   * 需要「辅助功能」权限；没有权限时 osascript 返回非 0，调用方按失败处理。
   * @param {string} name App 名称。
   * @param {boolean} visible 是否显示。
   * @returns {Promise<boolean>} 是否执行成功。
   */
  async function setShellVisible(name, visible) {
    const safe = name.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
    const code = await runCommand(OSASCRIPT, [
      '-e',
      `tell application "System Events" to set visible of application process "${safe}" to ${visible ? 'true' : 'false'}`,
    ], 6000)
    return code === 0
  }

  /**
   * 截图前把宿主窗口藏起来，让用户能框选它后面的内容（截图工具的常见做法）。
   * 藏不起来（没有辅助功能权限 / 不是桌面 App）就安静地继续，照常截图。
   * @returns {Promise<{hidden:boolean,reason?:string}>}
   */
  async function hideShellWindow() {
    const info = await shellAppInfo()
    if (info === undefined) return { hidden: false, reason: 'not_desktop' }
    const before = await shellHiddenState()
    if (before === true) return { hidden: true, alreadyHidden: true }
    if (!(await setShellVisible(info.name, false))) return { hidden: false, reason: 'permission' }
    await new Promise((resolve) => setTimeout(resolve, 140))
    const after = await shellHiddenState()
    // 读不到状态时按「已经藏了」处理，宁可多恢复一次也不要把窗口留在隐藏状态。
    if (after === false) return { hidden: false, reason: 'unsupported' }
    return { hidden: true }
  }

  /** 截图结束后把宿主窗口放回来并激活它。 */
  async function showShellWindow() {
    const info = await shellAppInfo()
    if (info === undefined) return
    const restored = await setShellVisible(info.name, true)
    if (!restored && info.bundle !== '') {
      // System Events 不灵时用 open -b 兜底拉起 App。
      await runCommand('/usr/bin/open', ['-b', info.bundle], 5000)
    }
    const script = `ObjC.import('AppKit');
(function () {
  var a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${shellPid});
  if (a) { a.unhide; a.activateWithOptions(0); }
})();`
    await runJxa(script, 4000)
  }

  return {
    id: 'macos',
    available: binary !== undefined,
    modes: ['region', 'window', 'screen'],

    /**
     * 屏幕录制权限预检：CGPreflightScreenCaptureAccess 只回答问题，不抓像素。
     * @returns {Promise<boolean|undefined>} true 有权限，false 没有，undefined 判断不了。
     */
    async preflightPermission() {
      if (binary === undefined) return false
      const parsed = await runJxa(PREFLIGHT_SCRIPT, 4000)
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.granted === 'boolean') {
        return parsed.granted
      }
      return undefined
    },

    listWindows,

    /**
     * 按模式截图。
     * @param {'region'|'window'|'screen'} mode
     * @param {{windowId?:number, hideShell?:boolean}} options hideShell=false 表示不让开宿主窗口。
     * @returns {Promise<{ok:true,buffer:Buffer}|{ok:false,error:string,detail?:string}>}
     */
    async capture(mode, options = {}) {
      if (binary === undefined) return { ok: false, error: 'unsupported' }
      if (mode === 'window' && options.windowId !== undefined) {
        return captureWindowImage(options.windowId)
      }
      if (mode === 'screen') {
        const result = await captureToBuffer(['-x', '-t', 'png'])
        return result.ok ? result : { ok: false, error: 'capture_failed' }
      }
      // 交互式截图（框选 / 系统窗口点选）时先把宿主窗口让开，截图结束再放回来。
      // 设置里关掉「自动隐藏」就完全不动宿主窗口。
      const hiding = options.hideShell === false
        ? { hidden: false, reason: 'disabled' }
        : await hideShellWindow()
      try {
        const result = await runInteractive(mode === 'window' ? 'window' : 'region')
        if (hiding.hidden) return result
        return hiding.reason === 'permission' ? { ...result, hideError: 'permission' } : result
      } finally {
        // 用户本来就藏着窗口的话，截完也别替他打开。
        if (hiding.hidden && hiding.alreadyHidden !== true) await showShellWindow()
      }
    },

    /**
     * 截一个窗口并按最长边 480 缩放，用作列表里的悬停预览。
     * 结果按窗口 id 缓存 30 秒，避免鼠标扫过列表时反复截大图。
     * @param {number} windowId
     * @returns {Promise<Buffer|undefined>}
     */
    async thumbnail(windowId) {
      if (binary === undefined) return undefined
      const cached = thumbnails.get(windowId)
      if (cached !== undefined && Date.now() - cached.at < THUMB_TTL_MS) return cached.buffer
      const captured = await captureToBuffer(['-l', String(windowId), '-o', '-x', '-t', 'png'])
      if (!captured.ok) return undefined
      const dir = await mkdtemp(join(tmpdir(), 'dsh-screenshot-thumb-')).catch(() => undefined)
      if (dir === undefined) return undefined
      const raw = join(dir, 'window.png')
      const small = join(dir, 'thumb.png')
      try {
        await writeFile(raw, captured.buffer)
        const resized = await runCommand(SIPS, ['-Z', String(THUMB_EDGE), raw, '--out', small])
        const buffer = await readFile(resized === 0 ? small : raw).catch(() => undefined)
        if (buffer === undefined || buffer.length === 0) return undefined
        if (await looksBlank(buffer)) return undefined
        thumbnails.set(windowId, { buffer, at: Date.now() })
        while (thumbnails.size > THUMB_MAX_ENTRIES) {
          const oldest = thumbnails.keys().next().value
          if (oldest === undefined) break
          thumbnails.delete(oldest)
        }
        return buffer
      } finally {
        rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    },

    /**
     * 把截图等比缩到长边不超过 maxEdge，只在确实更小时采用结果。
     * @param {Buffer} buffer 原图 PNG。
     * @param {number} maxEdge 长边上限。
     * @returns {Promise<Buffer>}
     */
    async optimize(buffer, maxEdge) {
      const dir = await mkdtemp(join(tmpdir(), 'dsh-screenshot-shrink-')).catch(() => undefined)
      if (dir === undefined) return buffer
      const source = join(dir, 'shot.png')
      const out = join(dir, 'shot-small.png')
      try {
        await writeFile(source, buffer)
        const code = await runCommand(SIPS, ['-Z', String(maxEdge), source, '--out', out])
        if (code !== 0) return buffer
        const small = await readFile(out).catch(() => undefined)
        if (small === undefined || small.length === 0) return buffer
        return small.length < buffer.length ? small : buffer
      } finally {
        rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    },

    /**
     * 打开系统设置里的隐私面板。
     * @param {'screen'|'accessibility'} pane screen=屏幕录制，accessibility=辅助功能。
     * @returns {boolean} 是否成功拉起。
     */
    openSettings(pane = 'screen') {
      const url = pane === 'accessibility' ? ACCESSIBILITY_URL : SETTINGS_URL
      try {
        const opener = spawn('open', [url], { stdio: 'ignore', detached: true })
        opener.unref()
        return true
      } catch {
        return false
      }
    },

    /** 插件卸载时杀掉还在等人框选的截图进程。 */
    dispose() {
      captureChild?.kill('SIGTERM')
      captureChild = null
      thumbnails.clear()
      // 万一截图过程中插件被卸载，别把用户的窗口留在隐藏状态。
      void showShellWindow()
    },
  }
}
