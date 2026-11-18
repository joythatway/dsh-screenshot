// 截图插件的设置：默认值、校验、JSON 持久化。
//
// 放在这里而不是 Cordis Config 里，是因为这些是「用户偏好」而不是「装配参数」：
//   1. 改 Config 会让 Loader 重启插件，正在编辑的设置页会跟着消失；
//   2. 这个插件在 profile 里是软链的本地目录，模块解析不走 profile 的 node_modules，
//      拿不到 schemastery，声明不了 Config schema。
// 文件很小（三个字段），读写都走原子替换，坏掉的 JSON 直接退回默认值。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

/** 设置文件名；和 DSH 其它插件一样落在 $DSH_HOME 下的同名目录。 */
export const SETTINGS_FILE = 'settings.json'
/** 保存目录留空表示「桌面」，由 resolveSaveDir 负责翻译。 */
export const DEFAULT_SETTINGS = Object.freeze({ saveDir: '', hideOnCapture: true })

/**
 * 设置文件的绝对路径。
 * @param {Record<string, string|undefined>} [env] 便于测试覆盖。
 * @returns {string} 形如 ~/.dsh/dsh-screenshot/settings.json。
 */
export function settingsPath(env = process.env) {
  const home = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== ''
    ? env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'dsh-screenshot', SETTINGS_FILE)
}

/**
 * 把磁盘上读到的东西收敛成一份完整设置；坏字段一律退回默认值。
 * @param {unknown} raw JSON.parse 的结果。
 * @returns {{saveDir:string,hideOnCapture:boolean}} 完整设置。
 */
export function normalizeSettings(raw) {
  const settings = { ...DEFAULT_SETTINGS }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return settings
  const saveDir = /** @type {Record<string, unknown>} */ (raw).saveDir
  if (typeof saveDir === 'string' && saveDir.trim() !== '') settings.saveDir = saveDir.trim()
  const hide = /** @type {Record<string, unknown>} */ (raw).hideOnCapture
  if (typeof hide === 'boolean') settings.hideOnCapture = hide
  return settings
}

/**
 * 展开开头的 ~，让用户可以直接手输 ~/Pictures。
 * @param {unknown} value 原始字符串。
 * @param {string} [home] 家目录。
 * @returns {string} 展开后的字符串；非字符串返回空串。
 */
export function expandTilde(value, home = homedir()) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (trimmed === '~') return home
  if (trimmed.startsWith('~/')) return join(home, trimmed.slice(2))
  return trimmed
}

/**
 * 校验用户填的保存目录。
 * @param {unknown} value 表单值；空串表示恢复默认（桌面）。
 * @param {string} [home] 家目录。
 * @returns {{ok:true,value:string}|{ok:false,reason:'invalid'|'not_absolute'}} 校验结果。
 */
export function validateSaveDir(value, home = homedir()) {
  if (value === null || value === undefined) return { ok: false, reason: 'invalid' }
  if (typeof value !== 'string') return { ok: false, reason: 'invalid' }
  const trimmed = value.trim()
  if (trimmed === '') return { ok: true, value: '' }
  if (trimmed.includes('\u0000')) return { ok: false, reason: 'invalid' }
  const expanded = expandTilde(trimmed, home)
  if (!isAbsolute(expanded)) return { ok: false, reason: 'not_absolute' }
  return { ok: true, value: expanded }
}

/**
 * 真正写盘时用的目录：设置优先，没设置就是桌面。
 * @param {{saveDir?:string}} [settings] 当前设置。
 * @param {string} [home] 家目录。
 * @returns {string} 绝对路径。
 */
export function resolveSaveDir(settings, home = homedir()) {
  const configured = expandTilde(settings === undefined ? '' : settings.saveDir, home)
  return configured !== '' && isAbsolute(configured) ? configured : join(home, 'Desktop')
}

/**
 * 生成保存用的文件名：去掉路径分隔符和系统保留字符，统一 .png 结尾。
 * @param {unknown} input 客户端建议的名字。
 * @param {Date} [now] 生成默认名字用的时间。
 * @returns {string} 安全的文件名。
 */
export function safeFileName(input, now = new Date()) {
  const fallback = `screenshot-${timestamp(now)}.png`
  const trimmed = typeof input === 'string' ? input.trim() : ''
  if (trimmed === '') return fallback
  const cleaned = trimmed
    .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '-')
    .replace(/-{2,}/gu, '-')
    // 去掉前导的点和横线：'../../x' 和 '.hidden' 都不该变成隐藏文件或空段。
    .replace(/^[-.]+/u, '')
    .slice(0, 120)
    .trim()
  if (cleaned === '') return fallback
  return /\.png$/iu.test(cleaned) ? cleaned : `${cleaned}.png`
}

/**
 * 截图文件名的默认时间戳。
 * @param {Date} date 时间。
 * @returns {string} YYYYMMDD-HHMMSS。
 */
export function timestamp(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/**
 * 判断一段字节是不是 PNG：保存前只接受这种，免得把任意文件写进用户目录。
 * @param {Uint8Array} buffer 请求体。
 * @returns {boolean} 是否带 PNG 签名。
 */
export function isPng(buffer) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (buffer === undefined || buffer === null || buffer.length < signature.length) return false
  return signature.every((byte, index) => buffer[index] === byte)
}

/**
 * 读设置文件；文件不存在或内容坏掉都返回默认值，不抛错。
 * @param {string} file 设置文件路径。
 * @returns {Promise<{saveDir:string,hideOnCapture:boolean}>} 完整设置。
 */
export async function readSettings(file) {
  try {
    const text = await readFile(file, 'utf8')
    return normalizeSettings(JSON.parse(text))
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/**
 * 原子写入设置：先写临时文件再改名，避免断电留下半个 JSON。
 * @param {string} file 设置文件路径。
 * @param {{saveDir:string,hideOnCapture:boolean}} settings 完整设置。
 * @returns {Promise<void>} 写完后 resolve。
 */
export async function writeSettings(file, settings) {
  const normalized = normalizeSettings(settings)
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify({ version: 1, ...normalized }, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
}
