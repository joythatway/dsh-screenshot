// 采集层入口：按运行平台挑一个后端，并把接口固定成同一种形状。
//
// 后端接口（host 侧唯一依赖）：
//   id           'macos' | 'windows'
//   available    是否可用（false 时菜单会隐藏所有模式）
//   modes        支持的模式，顺序无关；目前是 region / window / screen 的子集
//   preflightPermission()  true 有权限，false 没有，undefined 判断不了
//   listWindows()          { ok, windows } | { ok:false, error }
//   capture(mode, opts)    { ok, buffer } | { ok:false, error, detail? }
//   thumbnail(windowId)    Buffer | undefined
//   optimize(buffer, edge) Buffer
//   openSettings()         boolean
//   dispose()

import { createMacosBackend } from './macos.js'
import { createWindowsBackend } from './windows.js'

/**
 * 创建当前平台的采集后端；不支持的平台返回一个空实现（菜单会整体隐藏）。
 * @param {string} [platform] 便于测试时覆盖，默认 process.platform。
 * @returns {object} 采集后端。
 */
export function createCaptureBackend(platform = process.platform) {
  if (platform === 'darwin') return createMacosBackend()
  if (platform === 'win32') return createWindowsBackend()
  return {
    id: 'unsupported',
    available: false,
    modes: [],
    async preflightPermission() {
      return false
    },
    async listWindows() {
      return { ok: false, error: 'unsupported' }
    },
    async capture() {
      return { ok: false, error: 'unsupported' }
    },
    async thumbnail() {
      return undefined
    },
    async optimize(buffer) {
      return buffer
    },
    openSettings() {
      return false
    },
    dispose() {},
  }
}
