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
    useEffect(effect) {
      current.effects.push(effect)
    },
    useLayoutEffect(effect) {
      current.effects.push(effect)
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
      addEventListener: noop,
      removeEventListener: noop,
      createElement: () => ({}),
    },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
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
  return { module, React }
}

/** 假 ctx：槽位注册被记录下来，shortcuts / conversation 给可观察的替身。 */
function createContext() {
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
    resolveDraftAttachments: () => [],
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

/** 一个带输入框的会话：让 handles / currentSessionId 就位。 */
/** 用 React 替身渲染一个组件，hooks 才会拿到组件帧。 */
function render(React, component, props) {
  return React.createElement(component, props)
}

function composerProps() {
  return {
    sessionId: 'session-1',
    inputActions: { addAttachments: (ids) => true },
    useInput: (select) => select({ attachmentIds: [] }),
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
  const rendered = texts(render(React, section.component, { close: () => {} })).join('\n')
  assert.match(rendered, /截图快捷键/u)
  assert.match(rendered, /保存位置/u)
  assert.match(rendered, /框选时自动隐藏窗口/u)
  assert.match(rendered, /修改/u)
  assert.match(rendered, /选择…/u)
  assert.match(rendered, /设置立即生效/u)
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
