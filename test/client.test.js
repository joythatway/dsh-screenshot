// 客户端半边的烟雾测试：不启动浏览器，只验证「模块能加载、apply 能注册、
// 组件能渲染出树、按钮点下去会走对流程」。React 用极简替身：
//   - 组件函数被直接调用；
//   - useState/useRef 按组件缓存，重复 render 能读到上一次的值；
//   - useEffect 在组件返回后同步执行（不跑清理函数）。
// 这不能替代真机验收，但能挡住改名、少括号、渲染里引用未定义变量、
// 以及「快捷键该整屏却打开菜单」这类回归。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** 极简 React 替身。 */
function createReact() {
  const cells = new WeakMap()
  let current = null

  function renderComponent(type, props) {
    const previous = current
    const cellsOfType = cells.get(type) || []
    cells.set(type, cellsOfType)
    const frame = { cells: cellsOfType, index: 0, effects: [] }
    current = frame
    let output
    try {
      output = type(props)
    } finally {
      current = previous
    }
    for (const effect of frame.effects) {
      try {
        effect()
      } catch {
        // 单个 effect 失败不影响后面的断言。
      }
    }
    return output
  }

  function createElement(type, props, ...children) {
    const flat = children.flat(Infinity).filter((child) => child !== null && child !== undefined && typeof child !== 'boolean')
    const merged = { ...(props || {}) }
    if (flat.length === 1) merged.children = flat[0]
    else if (flat.length > 1) merged.children = flat
    if (typeof type === 'function') return renderComponent(type, merged)
    return { type, props: merged }
  }

  return {
    createElement,
    Fragment: Symbol('Fragment'),
    useState(initial) {
      const frame = current
      const index = frame.index++
      if (!(index in frame.cells)) frame.cells[index] = typeof initial === 'function' ? initial() : initial
      const set = (next) => {
        frame.cells[index] = typeof next === 'function' ? next(frame.cells[index]) : next
      }
      return [frame.cells[index], set]
    },
    useEffect(effect, deps) {
      // 依赖数组和真 React 一样做浅比较，避免把「换图才重置」执行成每次都重置。
      const frame = current
      const index = frame.index++
      const previous = frame.cells[index]
      const changed = previous === undefined
        || deps === undefined
        || previous.deps === undefined
        || deps.length !== previous.deps.length
        || deps.some((value, position) => !Object.is(value, previous.deps[position]))
      frame.cells[index] = { deps }
      if (changed) frame.effects.push(effect)
    },
    useLayoutEffect(effect, deps) {
      this.useEffect(effect, deps)
    },
    useRef(value) {
      const frame = current
      const index = frame.index++
      if (!(index in frame.cells)) frame.cells[index] = { current: value }
      return frame.cells[index]
    },
    useMemo(factory) {
      return factory()
    },
    useCallback(callback) {
      return callback
    },
  }
}

/** 收集渲染树里的文本（跳过 <style> 里的 CSS）。 */
function texts(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out)
    return out
  }
  if (typeof node !== 'object') return out
  if (node.type === 'style') return out
  if (node.props !== undefined) texts(node.props.children, out)
  return out
}

function find(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = find(child, predicate)
      if (found !== null) return found
    }
    return null
  }
  if (predicate(node)) return node
  return find(node.props === undefined ? undefined : node.props.children, predicate)
}

function findByClass(node, className) {
  return find(node, (element) => element.props !== undefined && element.props.className === className)
}

function findByText(node, text) {
  return find(node, (element) => {
    const children = element.props === undefined ? undefined : element.props.children
    const values = Array.isArray(children) ? children : [children]
    return values.some((child) => child === text)
  })
}

function containsText(node, text) {
  if (typeof node === 'string' || typeof node === 'number') return String(node) === text
  if (Array.isArray(node)) return node.some((child) => containsText(child, text))
  if (typeof node === 'object' && node !== null && node.props !== undefined) return containsText(node.props.children, text)
  return false
}

/** 按文字找最外层的可点击节点（文字通常挂在按钮里的 span 上）。 */
function findClickable(node, text) {
  return find(node, (element) => element.props !== undefined
    && typeof element.props.onClick === 'function'
    && containsText(element, text))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 加载 client.js，拿到模块定义；fetch / 定时器可替换。 */
function loadClient(options = {}) {
  let definition = null
  const noop = () => {}
  const listeners = []
  const sandbox = {
    console,
    // toast 自带 12 秒自动消失；测试里不需要长定时器，直接忽略。
    setTimeout: (callback, ms) => (ms > 1000 ? 0 : setTimeout(callback, ms)),
    clearTimeout: (id) => {
      if (id !== 0 && id !== undefined) clearTimeout(id)
    },
    setInterval,
    clearInterval,
    URL,
    Blob,
    File,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Promise,
    Error,
    JSON,
    Math,
    Date,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Symbol,
    fetch: options.fetch === undefined ? () => Promise.reject(new Error('offline')) : options.fetch,
    navigator: { platform: 'MacIntel' },
    window: {
      innerWidth: 1200,
      innerHeight: 800,
      addEventListener: noop,
      removeEventListener: noop,
      __ModuleLoader__: {
        load(module) {
          definition = module
        },
      },
    },
    document: {
      body: {},
      documentElement: { dataset: { platform: 'darwin' } },
      addEventListener(type, handler) {
        listeners.push({ type, handler })
      },
      removeEventListener: noop,
      createElement: () => ({}),
    },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  // DOM 替身必须在沙箱里定义，client.js 的 instanceof 才认。
  vm.runInContext(`
    globalThis.Element = class Element {
      constructor(tag) {
        this.tag = tag
        this.parentElement = null
        this.querySelectorResult = null
        this.querySelectorAllResult = []
        this.rect = null
      }
      querySelector() { return this.querySelectorResult }
      querySelectorAll() { return this.querySelectorAllResult }
      getBoundingClientRect() {
        return this.rect === null
          ? { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
          : this.rect
      }
    }
    globalThis.HTMLImageElement = class HTMLImageElement extends globalThis.Element {
      constructor(src) { super('img'); this.src = src }
    }
    globalThis.HTMLButtonElement = class HTMLButtonElement extends globalThis.Element {}
  `, sandbox)
  vm.runInContext(SOURCE, sandbox, { filename: 'client.js' })

  assert.ok(definition !== null, 'client.js 应该注册模块定义')
  assert.equal(definition.id, '@joythatway/dsh-screenshot')

  const React = createReact()
  const require = (name) => {
    if (name === 'react') return React
    if (name === 'react-dom') return { createPortal: (node) => node }
    throw new Error(`unexpected require: ${name}`)
  }
  const module = definition.factory(require)
  return {
    module,
    React,
    listeners,
    newElement: (tag) => new sandbox.Element(tag),
    /** 控制 elementFromPoint 返回什么：真实浏览器里它取的是指针最上层元素。 */
    setPointHit: (element) => {
      sandbox.document.elementFromPoint = () => element
    },
    clearPointHit: () => {
      delete sandbox.document.elementFromPoint
    },
    /** 造一个沙箱里的 <img>，用于模拟点缩略图。 */
    image: (src) => new sandbox.HTMLImageElement(src),
    /** 触发 document 上注册过的某类事件。 */
    dispatch: (type, event) => {
      for (const listener of listeners.filter((entry) => entry.type === type)) listener.handler(event)
    },
  }
}

/** 假 ctx：槽位注册被记录下来，shortcuts / conversation 给可观察的替身。 */
function createContext(options = {}) {
  const registered = []
  const attached = []
  const drafts = []
  let shortcutCommand = null
  const shortcuts = {
    catalog: { getSnapshot: () => [], subscribe: () => () => {} },
    config: { getSnapshot: () => ({ revision: 'rev-1' }) },
    register(command) {
      shortcutCommand = command
      return () => {}
    },
    describeBinding: () => ({ binding: null, keys: [], issue: null, conflicts: [] }),
    edit: async () => ({ status: 'saved' }),
    recording: async () => {},
  }
  const conversation = {
    createDrafts(sessionId, files) {
      drafts.push({ sessionId, files })
      return [{ id: `draft-${drafts.length}` }]
    },
    resolveDraftAttachments: () => (options.attachments === undefined ? [] : options.attachments),
    releaseDraftAttachments: () => {},
  }
  const services = { shortcuts, conversation }
  const slots = {
    inject(owner, callback) {
      callback()
      return () => {}
    },
    register(options, component) {
      registered.push({ options, component })
      return () => {}
    },
  }
  const locale = { register() {}, bind: () => () => undefined }
  services.slots = slots
  services.locale = locale
  return {
    registered,
    attached,
    drafts,
    shortcut: () => shortcutCommand,
    ctx: {
      locale,
      slots,
      get: (name) => services[name],
      effect(callback) {
        const dispose = callback()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      inject(names, callback) {
        if (!names.every((name) => services[name] !== undefined)) return
        callback({
          shortcuts: services.shortcuts,
          effect(callbackInner) {
            const dispose = callbackInner()
            return typeof dispose === 'function' ? dispose : () => {}
          },
        })
      },
    },
  }
}

/** 记录请求并回合适假数据的 fetch。 */
function network() {
  const calls = []
  const json = (payload) => ({ ok: true, json: async () => payload, blob: async () => new Blob([]) })
  const fetchStub = async (url, init = {}) => {
    const target = String(url)
    const method = init.method === undefined ? 'GET' : init.method
    calls.push({ target, method, body: init.body })
    if (target.startsWith('blob:')) {
      const png = new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47])])
      return { ok: true, json: async () => null, blob: async () => png }
    }
    if (target.endsWith('/probe')) return json({ ok: true, supported: true, modes: ['region', 'window', 'screen'] })
    if (method === 'GET' && target.endsWith('/settings')) {
      return json({
        ok: true,
        settings: { saveDir: '', hideOnCapture: true },
        saveDir: '/Users/x/Desktop',
        defaultSaveDir: '/Users/x/Desktop',
      })
    }
    if (method === 'POST' && target.endsWith('/capture')) return json({ ok: true, id: `shot-${calls.length}` })
    if (target.includes('/image/')) {
      return { ok: true, json: async () => null, blob: async () => new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47])]) }
    }
    if (method === 'POST' && target.includes('/save')) {
      return json({ ok: true, path: '/Users/x/Desktop/shot.png', dir: '/Users/x/Desktop', name: 'shot.png' })
    }
    return { ok: false, json: async () => null, blob: async () => null }
  }
  return { calls, fetch: fetchStub }
}

/** 造一个点击事件，记录是否被插件拦下。 */
function clickEvent(target, extra = {}) {
  const state = { prevented: false, stopped: false }
  const event = {
    target,
    preventDefault() { state.prevented = true },
    stopPropagation() { state.stopped = true },
    ...extra,
  }
  return { event, state }
}

/** 一个带输入框的会话：让 handles / currentSessionId 就位。 */
/** 用 React 替身渲染一个组件，hooks 才会拿到组件帧。 */
function render(React, component, props) {
  return React.createElement(component, props)
}

function composerProps(attachmentIds = []) {
  return {
    sessionId: 'session-1',
    inputActions: { addAttachments: (ids) => true },
    useInput: (select) => select({ attachmentIds }),
  }
}

test('client.js 能加载并注册工具栏、设置页、预览宿主', () => {
  const { module } = loadClient()
  assert.deepEqual([...module.inject], ['slots'])
  const { ctx, registered } = createContext()
  module.apply(ctx)
  const names = registered.map((entry) => entry.options.name)
  assert.ok(names.includes('conversation.input.left'))
  assert.ok(names.includes('settings.section'), '应该注册设置页')
  assert.ok(names.includes('settings.section.icon'), '应该注册设置页图标')
  assert.ok(names.includes('plugins.row.config'), '应该注册插件行配置页')
  assert.equal(names.filter((name) => name === 'shell.overlay').length, 3)
})

test('设置页渲染出三行偏好和快捷键', () => {
  const { module, React } = loadClient()
  const { ctx, registered } = createContext()
  module.apply(ctx)
  const section = registered.find((entry) => entry.options.name === 'settings.section')
  const tree = render(React, section.component, { close: () => {} })
  const rendered = texts(tree).join('\n')
  assert.match(rendered, /截图快捷键/u)
  assert.match(rendered, /保存位置/u)
  assert.match(rendered, /框选时自动隐藏窗口/u)
  assert.match(rendered, /修改/u)
  assert.match(rendered, /选择…/u)
  assert.match(rendered, /设置立即生效/u)

  // 开关要跟 Harness 内置 Switch 一致：36×20、border-l3 轨道、switch-thumb 滑块。
  const toggle = find(tree, (element) => element.props !== undefined && element.props.role === 'switch')
  assert.ok(toggle !== null, '应该有开关')
  assert.equal(toggle.props['aria-checked'], 'true')
  const css = String(find(tree, (element) => element.type === 'style').props.children)
  assert.match(css, /width: 36px/u)
  assert.match(css, /padding: 2px/u)
  assert.match(css, /--dsw-alias-border-l3/u)
  assert.match(css, /--dsw-alias-switch-thumb/u)
  assert.match(css, /\[aria-checked="true"\]/u)
})

test('工具栏按钮渲染成相机按钮，插件行配置页复用设置页', () => {
  const { module, React } = loadClient()
  const { ctx, registered } = createContext()
  module.apply(ctx)
  const controls = registered.find((entry) => entry.options.name === 'conversation.input.left')
  const button = findByClass(render(React, controls.component, composerProps()), 'sp-shot-button')
  assert.ok(button !== null, '应该渲染工具条按钮')
  assert.match(String(button.props.title), /截图/u)

  const rowConfig = registered.find((entry) => entry.options.name === 'plugins.row.config')
  assert.equal(rowConfig.options.key, '@joythatway/dsh-screenshot#dsh-screenshot')
  assert.equal(render(React, rowConfig.component, { view: 'summary' }), null)
  assert.match(texts(render(React, rowConfig.component, { view: 'page' })).join('\n'), /保存位置/u)
})

test('快捷键注册成「直接截图」，默认 Control+Shift+S', () => {
  const { module } = loadClient()
  const { ctx, shortcut } = createContext()
  module.apply(ctx)
  const command = shortcut()
  assert.ok(command !== null, '应该注册一条快捷键命令')
  assert.equal(command.id, 'screenshot-picker.capture')
  const mac = command.defaults['desktop:macos']
  assert.equal(mac.code, 'KeyS')
  assert.deepEqual([...mac.modifiers], ['control', 'shift'])
})

test('按下快捷键直接整屏截图并进草稿，不打开菜单', async () => {
  const { calls, fetch } = network()
  const { module, React } = loadClient({ fetch })
  const { ctx, registered, shortcut, drafts } = createContext()
  module.apply(ctx)

  // 先渲染工具栏，让 handles / currentSessionId 就位。
  const controls = registered.find((entry) => entry.options.name === 'conversation.input.left')
  render(React, controls.component, composerProps())

  const resolution = shortcut().resolve({ modal: null, region: 'page', source: 'keyboard', target: null })
  assert.equal(resolution.status, 'handled', '有会话时快捷键应由插件处理')
  resolution.run()
  await sleep(400)

  const capture = calls.find((call) => call.method === 'POST' && call.target.endsWith('/capture'))
  assert.ok(capture !== undefined, '应该直接请求 /capture')
  const body = JSON.parse(String(capture.body))
  assert.equal(body.mode, 'screen', '快捷键应该是整屏截图')
  assert.equal(body.hideShell, true)
  assert.equal(drafts.length, 1, '截完应该进草稿')
  assert.equal(drafts[0].sessionId, 'session-1')
})

test('没有输入框时快捷键不拦截，交给页面自己处理', () => {
  const { module } = loadClient()
  const { ctx, shortcut } = createContext()
  module.apply(ctx)
  const resolution = shortcut().resolve({ modal: null, region: 'page', source: 'keyboard', target: null })
  assert.equal(resolution.status, 'pass')
})

test('菜单 → 框选 → 确认框 → 保存：POST /save 并提示路径', async () => {
  const { calls, fetch } = network()
  const { module, React } = loadClient({ fetch })
  const { ctx, registered, drafts } = createContext()
  module.apply(ctx)

  const controls = registered.find((entry) => entry.options.name === 'conversation.input.left')
  const props = composerProps()
  const button = findByClass(render(React, controls.component, props), 'sp-shot-button')
  button.props.onClick({ clientX: 400, clientY: 700 })

  // 菜单打开后重新渲染，点「框选截图」。
  const opened = render(React, controls.component, props)
  const regionRow = findClickable(opened, '框选截图')
  assert.ok(regionRow !== null, '菜单里应该有框选截图')
  regionRow.props.onClick()
  await sleep(400)

  const capture = calls.find((call) => call.method === 'POST' && call.target.endsWith('/capture'))
  assert.equal(JSON.parse(String(capture.body)).mode, 'region')

  const review = registered.find((entry) => entry.options.id === 'screenshot-picker-review')
  const tree = render(React, review.component, {})
  const saveButton = findClickable(tree, '保存')
  assert.ok(saveButton !== null, '确认框里应该有「保存」')
  assert.ok(findClickable(tree, '确认') !== null, '有会话时应该能确认入草稿')

  saveButton.props.onClick()
  await sleep(80)
  const saved = calls.find((call) => call.method === 'POST' && call.target.includes('/save'))
  assert.ok(saved !== undefined, '保存应该 POST /save')
  assert.match(String(saved.target), /name=screenshot-\d{8}-\d{6}\.png/u)

  const toastHost = registered.find((entry) => entry.options.id === 'screenshot-picker-toast')
  assert.match(texts(render(React, toastHost.component, {})).join('\n'), /已保存到 \/Users\/x\/Desktop\/shot\.png/u)
  assert.equal(drafts.length, 0, '保存不应该同时塞进草稿')
})

test('确认按钮把框选结果放进草稿', async () => {
  const { fetch } = network()
  const { module, React } = loadClient({ fetch })
  const { ctx, registered, drafts } = createContext()
  module.apply(ctx)

  const controls = registered.find((entry) => entry.options.name === 'conversation.input.left')
  const props = composerProps()
  const button = findByClass(render(React, controls.component, props), 'sp-shot-button')
  button.props.onClick({ clientX: 400, clientY: 700 })
  const opened = render(React, controls.component, props)
  findClickable(opened, '框选截图').props.onClick()
  await sleep(400)

  const review = registered.find((entry) => entry.options.id === 'screenshot-picker-review')
  const confirmButton = findClickable(render(React, review.component, {}), '确认')
  assert.ok(confirmButton !== null, '确认框里应该有「确认」')
  confirmButton.props.onClick()
  assert.equal(drafts.length, 1, '确认后应该进草稿')
})

test('单张截图点开预览：近黑背景、顶部缩放 + 保存', async () => {
  const { calls, fetch } = network()
  const { module, React, image, dispatch } = loadClient({ fetch })
  const previewUrl = 'blob:shot-preview'
  const { ctx, registered, shortcut } = createContext({
    attachments: [{ id: 'draft-1', kind: 'image', previewUrl }],
  })
  module.apply(ctx)

  // 先截一张，草稿里就有一张「本插件截的」图。
  const controls = registered.find((entry) => entry.options.name === 'conversation.input.left')
  render(React, controls.component, composerProps(['draft-1']))
  shortcut().resolve({}).run()
  await sleep(400)

  // 点缩略图：单张也应该进自己的预览，而不是内置灯箱。
  dispatch('click', { target: image(previewUrl), preventDefault() {}, stopPropagation() {} })

  const gallery = registered.find((entry) => entry.options.id === 'screenshot-picker-gallery')
  const tree = render(React, gallery.component, {})
  assert.ok(tree !== null, '点缩略图应该打开预览')

  const style = find(tree, (element) => element.type === 'style')
  assert.match(String(style.props.children), /rgba\(0, 0, 0, \.86\)/u, '背景应该接近全黑')
  assert.match(String(style.props.children), /sp-shot-gallery-tools/u)

  const rendered = texts(tree).join('\n')
  assert.match(rendered, /100%/u, '默认 100%')
  assert.match(rendered, /保存/u)
  assert.equal(findByClass(tree, 'sp-shot-gallery-strip'), null, '单张不显示缩略图条')

  const zoomIn = find(tree, (element) => element.props !== undefined && element.props['aria-label'] === '放大')
  assert.ok(zoomIn !== null, '应该有放大按钮')
  zoomIn.props.onClick()
  const zoomed = render(React, gallery.component, {})
  assert.match(texts(zoomed).join('\n'), /125%/u, '点放大后应该是 125%')

  const zoomOut = find(zoomed, (element) => element.props !== undefined && element.props['aria-label'] === '缩小')
  zoomOut.props.onClick()
  const back = render(React, gallery.component, {})
  assert.match(texts(back).join('\n'), /100%/u, '缩小回 100%')

  // 滚轮缩放：往上放大、往下缩小。
  const wheelHost = find(back, (element) => element.props !== undefined && typeof element.props.onWheel === 'function')
  assert.ok(wheelHost !== null, '预览层应该接滚轮事件')
  wheelHost.props.onWheel({ deltaY: -100, deltaMode: 0, target: null })
  const wheeled = render(React, gallery.component, {})
  assert.match(texts(wheeled).join('\n'), /116%/u, '向上滚应该放大')

  const saveButton = findClickable(wheeled, '保存')
  assert.ok(saveButton !== null, '顶部应该有保存按钮')
  saveButton.props.onClick()
  await sleep(80)
  assert.ok(calls.some((call) => call.method === 'POST' && call.target.includes('/save')), '保存应该 POST /save')
  assert.equal(render(React, gallery.component, {}), null, '保存成功后应该退出预览')

  const toastHost = registered.find((entry) => entry.options.id === 'screenshot-picker-toast')
  const toastTree = render(React, toastHost.component, {})
  assert.match(texts(toastTree).join('\n'), /已保存到/u)
  const toastStyle = find(toastTree, (element) => element.type === 'style')
  assert.match(String(toastStyle.props.children), /z-index: 950/u, '提示要浮在预览上面')
  assert.match(String(toastStyle.props.children), /rgba\(30, 30, 32, \.92\)/u, '提示应该是深色玻璃，不是浅灰')
})

test('点输入框周围的界面不会打开预览：祖先里有缩略图也不行', async () => {
  const { fetch } = network()
  const { module, React, image, dispatch, setPointHit, newElement } = loadClient({ fetch })
  const previewUrl = 'blob:shot-preview'
  const { ctx, registered, shortcut } = createContext({
    attachments: [{ id: 'draft-1', kind: 'image', previewUrl }],
  })
  module.apply(ctx)

  const controls = registered.find((entry) => entry.options.name === 'conversation.input.left')
  render(React, controls.component, composerProps(['draft-1']))
  shortcut().resolve({}).run()
  await sleep(400)

  // 包着输入框的卡片里正好有缩略图，指针下最上层的也是这张卡片，
  // 但落点离缩略图很远：这不是「点在图片上」。
  const thumbnail = image(previewUrl)
  thumbnail.rect = { left: 20, top: 620, right: 84, bottom: 684, width: 64, height: 64 }
  const composer = newElement('div')
  composer.querySelectorResult = thumbnail
  composer.querySelectorAllResult = [thumbnail]
  setPointHit(composer)

  const { event, state } = clickEvent(composer, { clientX: 700, clientY: 500 })
  dispatch('click', event)
  assert.equal(state.prevented, false, '不该拦掉输入框周围的点击')
  assert.equal(state.stopped, false, '不该阻止事件冒泡')

  const gallery = registered.find((entry) => entry.options.id === 'screenshot-picker-gallery')
  assert.equal(render(React, gallery.component, {}), null, '不该打开预览')
})

test('点缩略图所在那一行的空白处不会打开预览', async () => {
  const { fetch } = network()
  const { module, React, image, dispatch, setPointHit, newElement } = loadClient({ fetch })
  const previewUrl = 'blob:shot-preview'
  const { ctx, registered, shortcut } = createContext({
    attachments: [{ id: 'draft-1', kind: 'image', previewUrl }],
  })
  module.apply(ctx)

  const controls = registered.find((entry) => entry.options.name === 'conversation.input.left')
  render(React, controls.component, composerProps(['draft-1']))
  shortcut().resolve({}).run()
  await sleep(400)

  // 草稿缩略图那一行是整行宽，图片只占左边 64px：点右边的空白不该打开预览。
  const thumbnail = image(previewUrl)
  thumbnail.rect = { left: 20, top: 620, right: 84, bottom: 684, width: 64, height: 64 }
  const row = newElement('div')
  row.querySelectorResult = thumbnail
  row.querySelectorAllResult = [thumbnail]
  setPointHit(row)

  const { event, state } = clickEvent(row, { clientX: 600, clientY: 650 })
  dispatch('click', event)
  assert.equal(state.prevented, false, '不该拦掉这一行的点击')
  assert.equal(state.stopped, false, '不该阻止事件冒泡')

  const gallery = registered.find((entry) => entry.options.id === 'screenshot-picker-gallery')
  assert.equal(render(React, gallery.component, {}), null, '不该打开预览')
})

test('指针落在缩略图上时照样打开预览：事件被外层接住也算', async () => {
  const { fetch } = network()
  const { module, React, image, dispatch, setPointHit, newElement } = loadClient({ fetch })
  const previewUrl = 'blob:shot-preview'
  const { ctx, registered, shortcut } = createContext({
    attachments: [{ id: 'draft-1', kind: 'image', previewUrl }],
  })
  module.apply(ctx)

  const controls = registered.find((entry) => entry.options.name === 'conversation.input.left')
  render(React, controls.component, composerProps(['draft-1']))
  shortcut().resolve({}).run()
  await sleep(400)

  // 缩略图外面套着按钮：指针压的是按钮，图片就在按钮里，落点也在图片上。
  const thumbnail = image(previewUrl)
  thumbnail.rect = { left: 20, top: 620, right: 84, bottom: 684, width: 64, height: 64 }
  const wrapper = newElement('button')
  wrapper.querySelectorResult = thumbnail
  wrapper.querySelectorAllResult = [thumbnail]
  setPointHit(wrapper)

  const gallery = registered.find((entry) => entry.options.id === 'screenshot-picker-gallery')
  // 先点图片右边的空白：不打开。
  dispatch('click', clickEvent(wrapper, { clientX: 120, clientY: 650 }).event)
  assert.equal(render(React, gallery.component, {}), null, '点图片右边不该打开预览')

  // 再点图片本身：打开。
  const { event, state } = clickEvent(wrapper, { clientX: 40, clientY: 650 })
  dispatch('click', event)
  assert.equal(state.prevented, true, '应该接管这次点击')
  assert.ok(render(React, gallery.component, {}) !== null, '点图片应该打开预览')
})

test('点缩略图上的删除叉不会被预览拦截', async () => {
  const { fetch } = network()
  const { module, React, image, dispatch, setPointHit, newElement } = loadClient({ fetch })
  const previewUrl = 'blob:shot-preview'
  const { ctx, registered, shortcut } = createContext({
    attachments: [{ id: 'draft-1', kind: 'image', previewUrl }],
  })
  module.apply(ctx)
  const controls = registered.find((entry) => entry.options.name === 'conversation.input.left')
  render(React, controls.component, composerProps(['draft-1']))
  shortcut().resolve({}).run()
  await sleep(400)

  // 删除叉盖在缩略图角上：指针处最上层是叉子按钮，里面没有 img。
  const removeButton = newElement('button')
  removeButton.querySelectorResult = null
  setPointHit(removeButton)
  const { event, state } = clickEvent(removeButton, { clientX: 300, clientY: 720 })
  dispatch('click', event)
  assert.equal(state.prevented, false)
  assert.equal(state.stopped, false)

  const gallery = registered.find((entry) => entry.options.id === 'screenshot-picker-gallery')
  assert.equal(render(React, gallery.component, {}), null)
})

test('预览打开后，点里面的按钮不再被点击拦截', async () => {
  const { fetch } = network()
  const { module, React, image, dispatch, setPointHit, newElement, clearPointHit } = loadClient({ fetch })
  const previewUrl = 'blob:shot-preview'
  const { ctx, registered, shortcut } = createContext({
    attachments: [{ id: 'draft-1', kind: 'image', previewUrl }],
  })
  module.apply(ctx)
  const controls = registered.find((entry) => entry.options.name === 'conversation.input.left')
  render(React, controls.component, composerProps(['draft-1']))
  shortcut().resolve({}).run()
  await sleep(400)

  // 点缩略图打开预览。
  const thumbnail = image(previewUrl)
  setPointHit(thumbnail)
  dispatch('click', clickEvent(thumbnail, { clientX: 300, clientY: 720 }).event)
  const gallery = registered.find((entry) => entry.options.id === 'screenshot-picker-gallery')
  assert.ok(render(React, gallery.component, {}) !== null, '应该打开预览')

  // 预览里的按钮：不要再被「草稿缩略图」逻辑拦掉。
  clearPointHit()
  const saveButton = newElement('button')
  const { event, state } = clickEvent(saveButton, { clientX: 900, clientY: 40 })
  dispatch('click', event)
  assert.equal(state.prevented, false)
  assert.equal(state.stopped, false)
})

test('点空白关掉预览后，同一手势的点击不会又把它打开', async () => {
  const { fetch } = network()
  const { module, React, image, dispatch, setPointHit } = loadClient({ fetch })
  const previewUrl = 'blob:shot-preview'
  const { ctx, registered, shortcut } = createContext({
    attachments: [{ id: 'draft-1', kind: 'image', previewUrl }],
  })
  module.apply(ctx)

  const controls = registered.find((entry) => entry.options.name === 'conversation.input.left')
  render(React, controls.component, composerProps(['draft-1']))
  shortcut().resolve({}).run()
  await sleep(400)

  const gallery = registered.find((entry) => entry.options.id === 'screenshot-picker-gallery')
  const thumbnail = image(previewUrl)
  setPointHit(thumbnail)
  dispatch('click', clickEvent(thumbnail, { clientX: 300, clientY: 720 }).event)
  const opener = render(React, gallery.component, {})
  assert.ok(opener !== null, '应该先打开预览')

  // 点遮罩空白：走 mousedown 关闭。
  const overlay = find(opener, (element) => element.props !== undefined && element.props.className === 'sp-shot-gallery')
  overlay.props.onMouseDown({ target: overlay, currentTarget: overlay })
  assert.equal(render(React, gallery.component, {}), null, '点空白应该关掉预览')

  // 同一手势里紧接着的 click（比如落在草稿缩略图上）不能再打开。
  dispatch('click', clickEvent(thumbnail, { clientX: 300, clientY: 720 }).event)
  assert.equal(render(React, gallery.component, {}), null, '同一手势不该重新打开预览')
})

test('横图切竖图不会先套用上一张的尺寸闪一下', async () => {
  const { fetch } = network()
  const { module, React, image, dispatch, setPointHit } = loadClient({ fetch })
  const wide = 'blob:wide-shot'
  const tall = 'blob:tall-shot'
  const { ctx, registered } = createContext({
    attachments: [
      { id: 'draft-1', kind: 'image', previewUrl: wide },
      { id: 'draft-2', kind: 'image', previewUrl: tall },
    ],
  })
  module.apply(ctx)

  const controls = registered.find((entry) => entry.options.name === 'conversation.input.left')
  render(React, controls.component, composerProps(['draft-1', 'draft-2']))
  setPointHit(image(wide))
  dispatch('click', clickEvent(image(wide), { clientX: 300, clientY: 720 }).event)

  const gallery = registered.find((entry) => entry.options.id === 'screenshot-picker-gallery')
  const first = render(React, gallery.component, {})
  assert.ok(first !== null, '应该打开预览')

  // 横图 onLoad：1600×900
  const wideImage = find(first, (element) => element.props !== undefined && element.props.className === 'sp-shot-gallery-image')
  wideImage.props.onLoad({ currentTarget: { naturalWidth: 1600, naturalHeight: 900 } })
  const measuredWide = render(React, gallery.component, {})
  const wideAgain = find(measuredWide, (element) => element.props !== undefined && element.props.className === 'sp-shot-gallery-image')
  assert.match(String(wideAgain.props.style.width), /^\d+px$/u, '横图应该有按视口算出来的宽度')

  // 切到竖图：新的图还没 onLoad，绝对不能沿用横图的宽度。
  const thumbs = []
  const collect = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(collect); return }
    if (node.props !== undefined && typeof node.props.className === 'string'
      && node.props.className.startsWith('sp-shot-gallery-thumb')) thumbs.push(node)
    collect(node.props === undefined ? undefined : node.props.children)
  }
  collect(measuredWide)
  assert.equal(thumbs.length, 2, '应该有两个缩略图')
  const secondThumb = thumbs[1]
  secondThumb.props.onClick()

  const switched = render(React, gallery.component, {})
  const tallImage = find(switched, (element) => element.props !== undefined && element.props.className === 'sp-shot-gallery-image')
  assert.equal(tallImage.props.src, tall, '应该切到竖图')
  assert.equal(tallImage.props.style.width, undefined, '竖图 onLoad 前不能有像素宽度')

  // 竖图 onLoad 后再按自己的比例算。
  tallImage.props.onLoad({ currentTarget: { naturalWidth: 900, naturalHeight: 1600 } })
  const measuredTall = render(React, gallery.component, {})
  const tallAgain = find(measuredTall, (element) => element.props !== undefined && element.props.className === 'sp-shot-gallery-image')
  const tallWidth = Number.parseInt(String(tallAgain.props.style.width), 10)
  assert.ok(Number.isFinite(tallWidth) && tallWidth > 0, '竖图应该有宽度')
  assert.ok(tallWidth < 900, '竖图按高度收窄，比原始宽度小')
})
