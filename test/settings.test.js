// 设置模块的纯函数测试：不碰真磁盘、不碰真实家目录。

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_SETTINGS,
  expandTilde,
  isPng,
  normalizeSettings,
  resolveSaveDir,
  safeFileName,
  settingsPath,
  timestamp,
  validateSaveDir,
} from '../lib/settings.js'

const HOME = '/Users/tester'

test('normalizeSettings 缺字段时补齐默认值', () => {
  assert.deepEqual(normalizeSettings(undefined), { ...DEFAULT_SETTINGS })
  assert.deepEqual(normalizeSettings(null), { ...DEFAULT_SETTINGS })
  assert.deepEqual(normalizeSettings([1, 2]), { ...DEFAULT_SETTINGS })
  assert.deepEqual(normalizeSettings({ saveDir: 42, hideOnCapture: 'yes' }), { ...DEFAULT_SETTINGS })
})

test('normalizeSettings 保留合法字段并去掉目录两端空白', () => {
  assert.deepEqual(
    normalizeSettings({ saveDir: '  /Users/tester/Pictures  ', hideOnCapture: false }),
    { saveDir: '/Users/tester/Pictures', hideOnCapture: false },
  )
  // 空白目录等于没设置，仍然回落到桌面。
  assert.deepEqual(normalizeSettings({ saveDir: '   ' }), { ...DEFAULT_SETTINGS })
})

test('expandTilde 展开家目录，其它原样返回', () => {
  assert.equal(expandTilde('~', HOME), HOME)
  assert.equal(expandTilde('~/Pictures', HOME), '/Users/tester/Pictures')
  assert.equal(expandTilde('/tmp/shots', HOME), '/tmp/shots')
  assert.equal(expandTilde('relative/path', HOME), 'relative/path')
  assert.equal(expandTilde(undefined, HOME), '')
})

test('validateSaveDir 只接受空串或绝对路径', () => {
  assert.deepEqual(validateSaveDir('', HOME), { ok: true, value: '' })
  assert.deepEqual(validateSaveDir('   ', HOME), { ok: true, value: '' })
  assert.deepEqual(validateSaveDir('~/Pictures', HOME), { ok: true, value: '/Users/tester/Pictures' })
  assert.deepEqual(validateSaveDir('/tmp/shots', HOME), { ok: true, value: '/tmp/shots' })
  assert.deepEqual(validateSaveDir('shots', HOME), { ok: false, reason: 'not_absolute' })
  assert.deepEqual(validateSaveDir(null, HOME), { ok: false, reason: 'invalid' })
  assert.deepEqual(validateSaveDir(7, HOME), { ok: false, reason: 'invalid' })
  assert.deepEqual(validateSaveDir('/tmp/a\u0000b', HOME), { ok: false, reason: 'invalid' })
})

test('resolveSaveDir 默认桌面，设置优先', () => {
  assert.equal(resolveSaveDir(DEFAULT_SETTINGS, HOME), '/Users/tester/Desktop')
  assert.equal(resolveSaveDir({ saveDir: '' }, HOME), '/Users/tester/Desktop')
  assert.equal(resolveSaveDir({ saveDir: '/tmp/shots' }, HOME), '/tmp/shots')
  assert.equal(resolveSaveDir({ saveDir: '~/Pictures' }, HOME), '/Users/tester/Pictures')
  // 相对路径不该被当成目录用，退回桌面。
  assert.equal(resolveSaveDir({ saveDir: 'shots' }, HOME), '/Users/tester/Desktop')
})

test('safeFileName 去掉路径与保留字符并补 .png', () => {
  assert.equal(safeFileName('shot.png'), 'shot.png')
  assert.equal(safeFileName('shot'), 'shot.png')
  assert.equal(safeFileName('../../etc/passwd'), 'etc-passwd.png')
  assert.equal(safeFileName('a:b*c?.png'), 'a-b-c-.png')
  assert.equal(safeFileName('   '), `screenshot-${timestamp(new Date())}.png`)
})

test('safeFileName 对空值是稳定可读的默认名', () => {
  const at = new Date(2026, 10, 18, 9, 5, 3)
  assert.equal(safeFileName(undefined, at), 'screenshot-20261118-090503.png')
  assert.equal(safeFileName('', at), 'screenshot-20261118-090503.png')
  assert.equal(safeFileName('.hidden', at), 'hidden.png')
})

test('isPng 只认 PNG 签名', () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
  assert.equal(isPng(png), true)
  assert.equal(isPng(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), false)
  assert.equal(isPng(new Uint8Array(0)), false)
  assert.equal(isPng(undefined), false)
})

test('settingsPath 跟随 DSH_HOME', () => {
  assert.equal(settingsPath({ DSH_HOME: '/tmp/dsh-home' }), '/tmp/dsh-home/dsh-screenshot/settings.json')
  // 没有 DSH_HOME 时用家目录下的 .dsh。
  assert.match(settingsPath({}), /\/\.dsh\/dsh-screenshot\/settings\.json$/u)
})
