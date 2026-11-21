// 采集层的接口契约：宿主只认这一组方法，缺一个就会在运行时静默失效。
// 这里只检查形状，不真的截图（CI 上没有屏幕）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { createCaptureBackend } from '../capture/index.js'
import { createWindowsBackend } from '../capture/windows.js'

const METHODS = ['preflightPermission', 'listWindows', 'capture', 'thumbnail', 'optimize', 'openSettings', 'dispose']

test('Windows 后端：构造时不起进程，接口与 macOS 后端同形', () => {
  const backend = createWindowsBackend()
  try {
    assert.equal(backend.id, 'windows')
    assert.equal(backend.available, true)
    assert.deepEqual(backend.modes, ['region', 'window', 'screen'])
    assert.equal(typeof backend.warmup, 'function')
    for (const name of METHODS) assert.equal(typeof backend[name], 'function', name)
  } finally {
    backend.dispose()
  }
})

test('Windows 后端：没有辅助功能权限概念，预检返回 undefined', async () => {
  const backend = createWindowsBackend()
  try {
    assert.equal(await backend.preflightPermission(), undefined)
  } finally {
    backend.dispose()
  }
})

test('createCaptureBackend 按平台选后端', () => {
  assert.equal(createCaptureBackend('win32').id, 'windows')
  assert.equal(createCaptureBackend('darwin').id, 'macos')
  assert.equal(createCaptureBackend('linux').available, false)
})

test('npm 包必须带上 Windows helper，否则发布后截图全失效', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(pkg.files.includes('capture/win/*.ps1'), 'package.json files 缺少 capture/win/*.ps1')
  const helper = await readFile(new URL('../capture/win/helper.ps1', import.meta.url), 'utf8')
  assert.match(helper, /PrintWindow/u)
  assert.match(helper, /PICKER_MAX_MS/u)
  assert.match(helper, /ConvertTo-Json/u)
})
