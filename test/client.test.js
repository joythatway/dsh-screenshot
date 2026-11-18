// 客户端半边的烟雾测试：不启动浏览器，只验证「模块能加载、apply 能注册、
// 设置页和工具栏能渲染出树」。React 用极简替身，组件被直接调用。
//
// 这不能替代真机验收，但能挡住改名、少括号、渲染里引用未定义变量这类错误。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** 极简 React 替身：函数组件直接调用，hooks 返回固定值。 */
function createReact() {
  function createElement(type, props, ...children) {
    const flat = children.flat(Infinity).filter((child) => child !== null && child !== undefined && typeof child !== 'boolean')
    const merged = { ...(props || {}) }
    if (flat.length === 1) merged.children = flat[0]
    else if (flat.length > 1) merged.children = flat
    if (typeof type === 'function') return type(merged)
    return { type, props: merged }
  }
  return {
    createElement,
    Fragment: Symbol('Fragment'),
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect() {},
    useLayoutEffect() {},
    useRef(value) {
      return { current: value }
    },
    useMemo(factory) {
      return factory()
    },
    useCallback(callback) {
      return callback
    },
  }
}

/** 收集渲染树里的所有文本，方便断言页面确实画出了这三行。 */
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
  if (typeof node === 'object' && node.type === 'style') return out
  if (typeof node === 'object' && node.props !== undefined) texts(node.props.children, out)
  return out
}

function findByClass(node, className) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByClass(child, className)
      if (found !== null) return found
    }
    return null
  }
  if (node.props !== undefined && node.props.className === className) return node
  return findByClass(node.props === undefined ? undefined : node.props.children, className)
}

function findByText(node, text) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByText(child, text)
      if (found !== null) return found
    }
    return null
  }
  const children = node.props === undefined ? undefined : node.props.children
  const values = Array.isArray(children) ? children : [children]
  if (values.some((child) => child === text)) return node
  return findByText(children, text)
}

/** 加载 client.js，拿到模块定义并执行 apply。 */
function loadClient(options = {}) {
  let definition = null
  const noop = () => {}
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
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
    Blob,
    File,
    Response,
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

/** 假 ctx：槽位注册被记录下来，shortcuts 服务给一份可改的替身。 */
function createContext() {
  const registered = []
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
  const services = { shortcuts }
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
  // 没有词典时 t() 会退回中文兜底文案，断言就用这些兜底文案。
  const locale = { register() {}, bind: () => () => undefined }
  services.slots = slots
  services.locale = locale
  return {
    registered,
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
        const available = names.every((name) => services[name] !== undefined)
        if (!available) return
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
  const { module } = loadClient()
  const { ctx, registered } = createContext()
  module.apply(ctx)
  const section = registered.find((entry) => entry.options.name === 'settings.section')
  const tree = section.component({ close: () => {} })
  const rendered = texts(tree).join('\n')
  assert.match(rendered, /截图快捷键/u)
  assert.match(rendered, /保存位置/u)
  assert.match(rendered, /框选时自动隐藏窗口/u)
  assert.match(rendered, /修改/u)
  assert.match(rendered, /选择…/u)
  assert.match(rendered, /设置立即生效/u)
})

test('工具栏按钮渲染成相机按钮，插件行配置页复用设置页', () => {
  const { module } = loadClient()
  const { ctx, registered } = createContext()
  module.apply(ctx)
  const controls = registered.find((entry) => entry.options.name === 'conversation.input.left')
  const tree = controls.component({
    sessionId: 'session-1',
    inputActions: { addAttachments: () => true },
    useInput: (select) => select({ attachmentIds: [] }),
  })
  const button = findByClass(tree, 'sp-shot-button')
  assert.ok(button !== null, '应该渲染工具条按钮')
  assert.match(String(button.props.title), /截图/u)

  const rowConfig = registered.find((entry) => entry.options.name === 'plugins.row.config')
  assert.equal(rowConfig.options.key, '@joythatway/dsh-screenshot#dsh-screenshot')
  assert.equal(rowConfig.component({ view: 'summary' }), null)
  assert.match(texts(rowConfig.component({ view: 'page' })).join('\n'), /保存位置/u)
})

test('快捷键注册成「打开截图菜单」，默认 Control+Shift+S', () => {
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

test('框选 → 确认框 → 保存：请求 /save 并提示落盘路径', async () => {
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
    if (method === 'POST' && target.endsWith('/capture')) return json({ ok: true, id: 'shot-1' })
    if (target.includes('/image/')) {
      return { ok: true, json: async () => null, blob: async () => new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47])]) }
    }
    if (method === 'POST' && target.includes('/save')) {
      return json({ ok: true, path: '/Users/x/Desktop/shot.png', dir: '/Users/x/Desktop', name: 'shot.png' })
    }
    return { ok: false, json: async () => null, blob: async () => null }
  }

  const { module } = loadClient({ fetch: fetchStub })
  const { ctx, registered, shortcut } = createContext()
  module.apply(ctx)

  // 没有输入框时，快捷键直接框选，确认框只剩「保存」。
  const resolution = shortcut().resolve({ modal: null, region: 'page', source: 'keyboard', target: null })
  assert.equal(resolution.status, 'handled')
  resolution.run()
  await new Promise((resolve) => setTimeout(resolve, 400))

  const capture = calls.find((call) => call.method === 'POST' && call.target.includes('/capture'))
  assert.ok(capture !== undefined, '应该请求 /capture')
  const body = JSON.parse(String(capture.body))
  assert.equal(body.mode, 'region')
  assert.equal(body.hideShell, true)

  const review = registered.find((entry) => entry.options.id === 'screenshot-picker-review')
  const tree = review.component({})
  const saveButton = findByText(tree, '保存')
  assert.ok(saveButton !== null, '确认框里应该有「保存」')
  assert.equal(findByText(tree, '确认'), null, '没有会话时不该出现「确认」')

  saveButton.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 80))
  const saved = calls.find((call) => call.method === 'POST' && call.target.includes('/save'))
  assert.ok(saved !== undefined, '保存应该 POST /save')
  assert.match(String(saved.target), /name=screenshot-\d{8}-\d{6}\.png/u)

  const toastHost = registered.find((entry) => entry.options.id === 'screenshot-picker-toast')
  assert.match(texts(toastHost.component({})).join('\n'), /已保存到 \/Users\/x\/Desktop\/shot\.png/u)
})
