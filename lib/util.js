// 截图插件的纯函数工具：不碰文件系统、不碰进程，方便单测。

/**
 * 把菜单传上来的模式收敛成受支持的三种。
 * @param {unknown} value 请求体里的 mode。
 * @returns {'region'|'window'|'screen'} 未知值一律当成 region。
 */
export function normalizeCaptureMode(value) {
  if (value === 'window') return 'window'
  if (value === 'screen') return 'screen'
  return 'region'
}

/**
 * 解析窗口号（macOS 的 CGWindowNumber / Windows 的 HWND）。
 * @param {unknown} value 请求体或查询参数里的窗口号。
 * @returns {number|undefined} 正整数才返回。
 */
export function parseWindowId(value) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * 两个窗口矩形是否相交。
 * @param {{x:number,y:number,w:number,h:number}} a
 * @param {{x:number,y:number,w:number,h:number}} b
 * @returns {boolean}
 */
export function rectsOverlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/**
 * 判断列表里第 index 个窗口是否被更靠前的窗口挡住。
 * 窗口列表按前后层级排序，所以只需要看排在它前面的那些。
 * @param {Array<{x:number,y:number,w:number,h:number}>} windows
 * @param {number} index
 * @returns {boolean}
 */
export function isOccluded(windows, index) {
  const target = windows[index]
  if (target === undefined) return true
  for (let i = 0; i < index; i += 1) {
    if (rectsOverlap(target, windows[i])) return true
  }
  return false
}

/**
 * 计算等比缩小到最长边不超过 maxEdge 后的尺寸。
 * @param {number} width
 * @param {number} height
 * @param {number} maxEdge
 * @returns {{width:number,height:number,scaled:boolean}}
 */
export function clampLongEdge(width, height, maxEdge) {
  const longest = Math.max(width, height)
  if (!(longest > 0) || !(maxEdge > 0) || longest <= maxEdge) {
    return { width, height, scaled: false }
  }
  const ratio = maxEdge / longest
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
    scaled: true,
  }
}

/**
 * 把 screencapture / PowerShell 的失败信息归类成给客户端看的状态码。
 * @param {string} stderr 子进程的 stderr。
 * @param {string|number} exit 退出码或信号。
 * @returns {{error:'permission'|'cancelled',detail:string}}
 */
export function classifyCaptureFailure(stderr, exit) {
  const text = String(stderr || '').trim()
  const detail = `${text.slice(0, 400)}${text === '' ? '' : ' | '}exit=${String(exit)}`
  if (/could not create image|not authorized|screen recording|permission/i.test(text)) {
    return { error: 'permission', detail }
  }
  return { error: 'cancelled', detail }
}

/**
 * 读 BMP 头，判断颜色跨度是否小到像一张纯色图（空图检测用）。
 * @param {Buffer} data 8×8 左右的 BMP 字节。
 * @returns {boolean} 是否几乎没有任何内容。
 */
export function bmpIsFlat(data) {
  if (!data || data.length < 54 || data[0] !== 0x42 || data[1] !== 0x4d) return false
  const offset = data.readUInt32LE(10)
  const width = data.readInt32LE(18)
  const height = Math.abs(data.readInt32LE(22))
  const bitsPerPixel = data.readUInt16LE(28)
  if (width <= 0 || height <= 0 || (bitsPerPixel !== 24 && bitsPerPixel !== 32)) return false
  const bytesPerPixel = bitsPerPixel / 8
  const rowSize = Math.floor((bitsPerPixel * width + 31) / 32) * 4
  let min = 255
  let max = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = offset + y * rowSize + x * bytesPerPixel
      if (at + 2 >= data.length) continue
      const value = Math.max(data[at], data[at + 1], data[at + 2])
      if (value < min) min = value
      if (value > max) max = value
    }
  }
  return max - min < 8
}
