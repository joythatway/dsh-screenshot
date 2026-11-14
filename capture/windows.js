// Windows 采集后端：PowerShell + .NET（System.Drawing）+ Win32 枚举。
//
// ⚠️ 这一段没有在 Windows 机器上实测过（开发机是 macOS），逻辑与 macOS 后端对齐：
// 列窗口 → 按窗口矩形从屏幕合成里截图；没有系统级框选遮罩，所以 region 模式不提供。
// 真机跑不通时请把 `detail` 里的 PowerShell 报错贴出来。

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isOccluded } from '../lib/util.js'

const POWERSHELL = 'powershell.exe'
const THUMB_EDGE = 480
const THUMB_TTL_MS = 30_000
const THUMB_MAX_ENTRIES = 16

/** 枚举顶层窗口，输出 { windows: [...] }；顺序即 z 序（最前在前）。 */
const LIST_SCRIPT = `param()
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class WinInfo {
  public long id { get; set; }
  public int pid { get; set; }
  public string title { get; set; }
  public int x { get; set; }
  public int y { get; set; }
  public int w { get; set; }
  public int h { get; set; }
}
public class WinEnum {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hWnd, int index);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
  public static List<WinInfo> List() {
    SetProcessDPIAware();
    var items = new List<WinInfo>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || IsIconic(h)) return true;
      if ((GetWindowLong(h, -20) & 0x80) != 0) return true; // WS_EX_TOOLWINDOW
      int len = GetWindowTextLength(h);
      if (len <= 0) return true;
      var sb = new StringBuilder(len + 1);
      GetWindowText(h, sb, sb.Capacity);
      RECT r;
      if (!GetWindowRect(h, out r)) return true;
      int w = r.Right - r.Left, hgt = r.Bottom - r.Top;
      if (w < 60 || hgt < 60) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      items.Add(new WinInfo { id = (long)h, pid = (int)pid, title = sb.ToString(), x = r.Left, y = r.Top, w = w, h = hgt });
      return true;
    }, IntPtr.Zero);
    return items;
  }
}
"@
$list = [WinEnum]::List()
foreach ($item in $list) {
  if (-not $item.title) { $item.title = '' }
  $proc = Get-Process -Id $item.pid -ErrorAction SilentlyContinue
  $item | Add-Member -NotePropertyName app -NotePropertyValue ($(if ($proc) { $proc.ProcessName } else { '' })) -Force
}
@{ windows = @($list) } | ConvertTo-Json -Compress -Depth 4
`

/**
 * 抓一块屏幕区域；宽高传 0 表示整个虚拟桌面。
 * 参数：-Out <png> -X -Y -W -H
 */
const CAPTURE_SCRIPT = `param([string]$Out, [int]$X, [int]$Y, [int]$W, [int]$H)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DpiAware { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
"@
[void][DpiAware]::SetProcessDPIAware()
if ($W -le 0 -or $H -le 0) {
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $X = $b.X; $Y = $b.Y; $W = $b.Width; $H = $b.Height
}
$bmp = New-Object System.Drawing.Bitmap $W, $H
$g = [System.Drawing.Graphics]::FromImage($bmp)
try {
  $g.CopyFromScreen($X, $Y, 0, 0, $bmp.Size)
  $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $g.Dispose(); $bmp.Dispose()
}
`

/** 把图片等比缩到长边不超过 -Max；参数：-In -Out -Max */
const RESIZE_SCRIPT = `param([string]$In, [string]$Out, [int]$Max)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile($In)
try {
  $longest = [Math]::Max($img.Width, $img.Height)
  if ($longest -le $Max) { Copy-Item $In $Out -Force; return }
  $scale = $Max / $longest
  $w = [int][Math]::Round($img.Width * $scale)
  $h = [int][Math]::Round($img.Height * $scale)
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($img, 0, 0, $w, $h)
    $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $g.Dispose(); $bmp.Dispose()
  }
} finally {
  $img.Dispose()
}
`

/**
 * 把脚本写到临时目录并执行，返回 { code, stdout, stderr }。
 * @param {string} script PowerShell 脚本内容。
 * @param {string[]} args 追加到 -File 之后的参数。
 * @param {number} timeoutMs 超时毫秒数。
 * @returns {Promise<{code:number,stdout:string,stderr:string}>}
 */
async function runPowerShell(script, args = [], timeoutMs = 20000) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-screenshot-ps-')).catch(() => undefined)
  if (dir === undefined) return { code: -1, stdout: '', stderr: 'temp_dir_failed' }
  const cleanup = () => {
    rm(dir, { recursive: true, force: true }).catch(() => {})
  }
  const scriptPath = join(dir, 'task.ps1')
  const written = await writeFile(scriptPath, script, 'utf8').then(() => true, () => false)
  if (!written) {
    cleanup()
    return { code: -1, stdout: '', stderr: 'script_write_failed' }
  }

  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cleanup()
      resolve(result)
    }
    let child
    try {
      child = spawn(POWERSHELL, [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        ...args,
      ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch {
      finish({ code: -1, stdout: '', stderr: 'spawn_failed' })
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      finish({ code: -1, stdout, stderr: `${stderr}timeout` })
    }, timeoutMs)
    timer.unref?.()
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout = (stdout + chunk).slice(-262144)
    })
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-16384)
    })
    child.on('error', () => finish({ code: -1, stdout, stderr: 'spawn_failed' }))
    child.on('close', (code) => finish({ code: code === null ? -1 : code, stdout, stderr }))
  })
}

/**
 * 创建 Windows 采集后端。
 * @returns {object} 与 macOS 后端同形的接口。
 */
export function createWindowsBackend() {
  const thumbnails = new Map()

  async function captureRect(x, y, w, h) {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-screenshot-win-')).catch(() => undefined)
    if (dir === undefined) return { ok: false, error: 'capture_failed' }
    const out = join(dir, 'shot.png')
    try {
      const result = await runPowerShell(CAPTURE_SCRIPT, ['-Out', out, '-X', String(x), '-Y', String(y), '-W', String(w), '-H', String(h)])
      if (result.code !== 0) {
        return { ok: false, error: 'capture_failed', detail: result.stderr.trim().slice(0, 400) }
      }
      const buffer = await readFile(out).catch(() => undefined)
      if (buffer === undefined || buffer.length === 0) return { ok: false, error: 'capture_failed' }
      return { ok: true, buffer }
    } finally {
      rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  async function listWindows() {
    const result = await runPowerShell(LIST_SCRIPT)
    if (result.code !== 0) {
      return { ok: false, error: 'list_failed', detail: result.stderr.trim().slice(0, 400) }
    }
    try {
      const parsed = JSON.parse(result.stdout.trim() || '{}')
      const windows = Array.isArray(parsed.windows) ? parsed.windows : []
      return { ok: true, windows }
    } catch {
      return { ok: false, error: 'list_failed' }
    }
  }

  async function captureWindow(windowId) {
    const listed = await listWindows()
    if (!listed.ok) return { ok: false, error: listed.error || 'list_failed' }
    const index = listed.windows.findIndex((entry) => Number(entry.id) === windowId)
    const target = index === -1 ? undefined : listed.windows[index]
    if (target === undefined) return { ok: false, error: 'hidden' }
    // CopyFromScreen 抓到的是屏幕上真实叠放的内容，被挡住的窗口截出来是别人。
    if (isOccluded(listed.windows, index)) return { ok: false, error: 'hidden' }
    return captureRect(target.x, target.y, target.w, target.h)
  }

  async function optimize(buffer, maxEdge) {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-screenshot-shrink-')).catch(() => undefined)
    if (dir === undefined) return buffer
    const source = join(dir, 'shot.png')
    const out = join(dir, 'shot-small.png')
    try {
      await writeFile(source, buffer)
      const result = await runPowerShell(RESIZE_SCRIPT, ['-In', source, '-Out', out, '-Max', String(maxEdge)])
      if (result.code !== 0) return buffer
      const small = await readFile(out).catch(() => undefined)
      if (small === undefined || small.length === 0) return buffer
      return small.length < buffer.length ? small : buffer
    } finally {
      rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  return {
    id: 'windows',
    available: true,
    // 没有系统级框选遮罩，region 不提供；调用时会返回 unsupported。
    modes: ['window', 'screen'],

    async preflightPermission() {
      // Windows 桌面程序没有 macOS 那样的按应用屏幕录制授权，无需预检。
      return undefined
    },

    listWindows,

    async capture(mode, options = {}) {
      if (mode === 'screen') return captureRect(0, 0, 0, 0)
      if (mode === 'window' && options.windowId !== undefined) {
        return captureWindow(options.windowId)
      }
      return { ok: false, error: 'unsupported' }
    },

    async thumbnail(windowId) {
      const cached = thumbnails.get(windowId)
      if (cached !== undefined && Date.now() - cached.at < THUMB_TTL_MS) return cached.buffer
      const listed = await listWindows()
      if (!listed.ok) return undefined
      const index = listed.windows.findIndex((entry) => Number(entry.id) === windowId)
      const target = index === -1 ? undefined : listed.windows[index]
      if (target === undefined || isOccluded(listed.windows, index)) return undefined
      const captured = await captureRect(target.x, target.y, target.w, target.h)
      if (!captured.ok) return undefined
      const dir = await mkdtemp(join(tmpdir(), 'dsh-screenshot-thumb-')).catch(() => undefined)
      if (dir === undefined) return undefined
      const raw = join(dir, 'window.png')
      const small = join(dir, 'thumb.png')
      try {
        await writeFile(raw, captured.buffer)
        const resized = await runPowerShell(RESIZE_SCRIPT, ['-In', raw, '-Out', small, '-Max', String(THUMB_EDGE)])
        if (resized.code !== 0) return undefined
        const buffer = await readFile(small).catch(() => undefined)
        if (buffer === undefined || buffer.length === 0) return undefined
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

    optimize,

    openSettings() {
      return false
    },

    dispose() {
      thumbnails.clear()
    },
  }
}
