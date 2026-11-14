import test from 'node:test'
import assert from 'node:assert/strict'
import {
  bmpIsFlat,
  clampLongEdge,
  isUsableWindow,
  classifyCaptureFailure,
  isOccluded,
  normalizeCaptureMode,
  parseWindowId,
  rectsOverlap,
} from '../lib/util.js'

/**
 * 造一张 BMP，用于空图检测的单元测试。
 * @param {number[][]} rows 每行像素的 [R,G,B] 列表。
 * @returns {Buffer}
 */
function makeBmp(rows) {
  const height = rows.length
  const width = rows[0].length
  const byteWidth = width * 3
  const rowSize = Math.floor((byteWidth + 3) / 4) * 4
  const imageSize = rowSize * height
  const buffer = Buffer.alloc(54 + imageSize)
  buffer.write('BM', 0, 'ascii')
  buffer.writeUInt32LE(buffer.length, 2)
  buffer.writeUInt32LE(54, 10)
  buffer.writeUInt32LE(40, 14)
  buffer.writeInt32LE(width, 18)
  buffer.writeInt32LE(height, 22)
  buffer.writeUInt16LE(1, 26)
  buffer.writeUInt16LE(24, 28)
  buffer.writeUInt32LE(imageSize, 34)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = 54 + y * rowSize + x * 3
      const [r, g, b] = rows[height - 1 - y][x]
      buffer[at] = b
      buffer[at + 1] = g
      buffer[at + 2] = r
    }
  }
  return buffer
}

test('normalizeCaptureMode 只认三种已知模式', () => {
  assert.equal(normalizeCaptureMode('window'), 'window')
  assert.equal(normalizeCaptureMode('screen'), 'screen')
  assert.equal(normalizeCaptureMode('region'), 'region')
  assert.equal(normalizeCaptureMode('nope'), 'region')
  assert.equal(normalizeCaptureMode(undefined), 'region')
  assert.equal(normalizeCaptureMode(null), 'region')
})

test('parseWindowId 只接受正整数', () => {
  assert.equal(parseWindowId('42'), 42)
  assert.equal(parseWindowId(7), 7)
  assert.equal(parseWindowId('0'), undefined)
  assert.equal(parseWindowId('-3'), undefined)
  assert.equal(parseWindowId('abc'), undefined)
  assert.equal(parseWindowId('1.5'), undefined)
  assert.equal(parseWindowId(null), undefined)
})

test('rectsOverlap 判断矩形相交', () => {
  const a = { x: 0, y: 0, w: 100, h: 100 }
  assert.equal(rectsOverlap(a, { x: 50, y: 50, w: 100, h: 100 }), true)
  assert.equal(rectsOverlap(a, { x: 100, y: 0, w: 10, h: 10 }), false)
  assert.equal(rectsOverlap(a, { x: 0, y: 100, w: 10, h: 10 }), false)
  assert.equal(rectsOverlap(a, { x: 99, y: 99, w: 1, h: 1 }), true)
})

test('isOccluded 只看排在前面的窗口', () => {
  const front = { x: 0, y: 0, w: 500, h: 500 }
  const target = { x: 100, y: 100, w: 200, h: 200 }
  const other = { x: 800, y: 800, w: 100, h: 100 }
  assert.equal(isOccluded([front, target], 1), true)
  assert.equal(isOccluded([other, target], 1), false)
  assert.equal(isOccluded([target, front], 0), false)
  assert.equal(isOccluded([], 0), true)
})

test('clampLongEdge 等比缩小且不放大', () => {
  assert.deepEqual(clampLongEdge(4000, 3000, 2560), { width: 2560, height: 1920, scaled: true })
  assert.deepEqual(clampLongEdge(800, 600, 2560), { width: 800, height: 600, scaled: false })
  assert.deepEqual(clampLongEdge(1000, 4000, 2560), { width: 640, height: 2560, scaled: true })
  assert.deepEqual(clampLongEdge(0, 0, 2560), { width: 0, height: 0, scaled: false })
})

test('classifyCaptureFailure 区分权限与取消', () => {
  const permission = classifyCaptureFailure('could not create image from display', 1)
  assert.equal(permission.error, 'permission')
  assert.match(permission.detail, /exit=1/)

  const cancelled = classifyCaptureFailure('', 'SIGTERM')
  assert.equal(cancelled.error, 'cancelled')
  assert.match(cancelled.detail, /exit=SIGTERM/)

  const denied = classifyCaptureFailure('screencapture: not authorized', 1)
  assert.equal(denied.error, 'permission')
})

test('bmpIsFlat 识别纯色空图', () => {
  const flat = makeBmp([
    [[0, 0, 0], [0, 0, 0]],
    [[0, 0, 0], [0, 0, 0]],
  ])
  assert.equal(bmpIsFlat(flat), true)

  const varied = makeBmp([
    [[10, 20, 30], [200, 40, 60]],
    [[90, 10, 250], [5, 5, 5]],
  ])
  assert.equal(bmpIsFlat(varied), false)

  // 头都不对的时候不应该断言"空图"。
  assert.equal(bmpIsFlat(Buffer.from('not a bmp at all')), false)
  const broken = Buffer.from(flat)
  broken[0] = 0x00
  assert.equal(bmpIsFlat(broken), false)
})


test('bmpIsFlat 用标准差识别低对比度空图', () => {
  const rows = []
  for (let y = 0; y < 8; y += 1) {
    const row = []
    for (let x = 0; x < 8; x += 1) row.push([118, 118, 118])
    rows.push(row)
  }
  // 只有一个像素亮一点点：跨度 11（超过纯色阈值），但整体几乎没有内容。
  rows[0][0] = [129, 129, 129]
  assert.equal(bmpIsFlat(makeBmp(rows)), true)
})

test('isUsableWindow 过滤掉小尺寸辅助窗口', () => {
  assert.equal(isUsableWindow({ w: 64, h: 64 }), false)
  assert.equal(isUsableWindow({ w: 99, h: 90 }), false)
  assert.equal(isUsableWindow({ w: 100, h: 80 }), true)
  assert.equal(isUsableWindow({ w: 480, h: 880 }), true)
  assert.equal(isUsableWindow(null), false)
})
