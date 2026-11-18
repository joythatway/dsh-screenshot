// 框选截图 (screenshot-picker) — Client half
//
// 注册两处：
//   1. conversation.input.left 一个相机图标按钮 → 一键框选，同时把该会话的
//      inputActions 记下来给截图流程用
//   2. shell.overlay 一条轻提示 → 截图失败/没权限时告诉用户怎么办
//
// 截图本身交给 Host：它调 macOS 原生 screencapture -i 框选，这里只负责
// 取回 PNG、造成 File、塞进当前草稿。

window.__ModuleLoader__.load({
  id: '@joythatway/dsh-screenshot',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const h = React.createElement
    const { useEffect, useRef, useState } = React

    const NS = 'screenshot-picker'
    const API = '/api/dsh-screenshot'
    // 点完按钮先让工具栏恢复常态，再让系统铺框选遮罩。
    const MENU_SETTLE_MS = 260

    const ZH = {
      'menu.label': '截图',
      'menu.hint': '截图：框选 / 窗口 / 整屏（快捷键 Control+Shift+S）',
      'menu.hintKeys': '截图：框选 / 窗口 / 整屏；{keys} 直接整屏截图',
      'menu.region': '框选截图',
      'menu.window': '窗口截图',
      'menu.screen': '整屏截图',
      'picker.back': '返回',
      'picker.title': '选择窗口',
      'picker.loading': '正在读取窗口…',
      'picker.empty': '没有可选的窗口',
      'picker.failed': '读取窗口失败，可改用鼠标点选',
      'picker.untitled': '无标题窗口',
      'picker.previewLoading': '正在生成预览…',
      'picker.unknownApp': '未知应用',
      'picker.fallback': '改用鼠标点选窗口',
      'error.unsupported': '当前系统不支持直接截图',
      'error.permission': '需要屏幕录制权限：系统设置 › 隐私与安全性 › 屏幕录制，勾选 DeepSeek Harness 后重试',
      'error.permission.action': '打开设置',
      'error.network': '截图服务没有响应，请重试',
      'error.capture': '截图失败，请重试',
      'error.busy': '已有一次截图在进行中',
      'error.composer': '输入框当前不可用，稍后再试',
      'error.image': '截图图片读取失败，请重试',
      'error.hidden': '这个窗口现在读不到画面（可能被完全遮挡了），先把它切到前台再截',
      'hint.autoHide': '截图时想让窗口自动让开？给 DeepSeek Harness 开启「辅助功能」权限即可（只需一次）',
      'review.title': '确认截图',
      'review.cancel': '取消',
      'review.confirm': '确认',
      'picker.previewUnavailable': '窗口当前不可见',
      'gallery.prev': '上一张',
      'gallery.next': '下一张',
      'gallery.close': '关闭预览',
      'gallery.save': '保存',
      'gallery.zoomIn': '放大',
      'gallery.zoomOut': '缩小',
      'gallery.resetZoom': '恢复到 100%（滚轮也可以缩放）',
      'settings.nav': '截图',
      'settings.shortcut.title': '截图快捷键',
      'settings.shortcut.description': '按下直接整屏截图，和菜单里的「整屏截图」等价',
      'settings.shortcut.recording': '请按下新的组合键…',
      'settings.shortcut.cancel': '取消',
      'settings.shortcut.change': '修改',
      'settings.shortcut.reset': '恢复默认',
      'settings.shortcut.unbound': '未设置',
      'settings.shortcut.invalid': '这个组合键不受支持',
      'settings.shortcut.issue.reserved': '这个组合键被系统或 Harness 保留了',
      'settings.shortcut.issue.unsupported-browser': '浏览器里不能用这个组合键',
      'settings.shortcut.issue.modifier-required': '至少要带一个修饰键（⌘ / ⌃ / ⌥ / ⇧）',
      'settings.shortcut.issue.unsupported-key': '这个键不能单独用作快捷键',
      'settings.shortcut.conflict': '这个组合键已经被「{name}」占用',
      'settings.shortcut.failed': '保存快捷键失败，请重试',
      'settings.shortcut.unsupported': '当前环境不支持修改快捷键',
      'settings.save.title': '保存位置',
      'settings.save.description': '点「保存」时把 PNG 存到这个文件夹',
      'settings.save.pick': '选择…',
      'settings.save.reset': '恢复默认',
      'settings.save.notAbsolute': '请填绝对路径，例如 /Users/you/Pictures',
      'settings.save.failed': '保存目录没写进去，请重试',
      'settings.save.pickFailed': '当前环境打不开文件夹选择器，直接输入路径也可以',
      'settings.hide.title': '框选时自动隐藏窗口',
      'settings.hide.description': '框选期间把 Harness 窗口让开，截完自动恢复（需要「辅助功能」权限）',
      'settings.hide.failed': '设置没写进去，请重试',
      'settings.footer': '设置立即生效 · 保存在 ~/.dsh/dsh-screenshot/settings.json',
      'settings.loadFailed': '没能读到设置，改动可能不会保存',
      'save.done': '已保存到 {path}',
      'save.reveal': '显示',
      'save.failed': '保存失败，请检查保存位置是否可写',
      'review.save': '保存',
      'review.savedOnly': '没有打开的会话，确认后直接存到磁盘',
    }
    const EN = {
      'menu.label': 'Screenshot',
      'menu.hint': 'Capture: region / window / whole screen (Control+Shift+S)',
      'menu.hintKeys': 'Capture: region / window / whole screen; {keys} captures the whole screen',
      'menu.region': 'Region',
      'menu.window': 'Window',
      'menu.screen': 'Whole screen',
      'picker.back': 'Back',
      'picker.title': 'Choose a window',
      'picker.loading': 'Reading windows…',
      'picker.empty': 'No window available',
      'picker.failed': 'Could not list windows; you can still click a window',
      'picker.untitled': 'Untitled window',
      'picker.previewLoading': 'Building preview…',
      'picker.unknownApp': 'Unknown app',
      'picker.fallback': 'Pick with the mouse instead',
      'error.unsupported': 'Direct screenshots are not supported on this platform',
      'error.permission': 'Screen Recording permission is required: System Settings › Privacy & Security › Screen Recording, enable DeepSeek Harness, then retry',
      'error.permission.action': 'Open Settings',
      'error.network': 'The screenshot service did not respond. Try again.',
      'error.capture': 'Screenshot failed. Try again.',
      'error.busy': 'A screenshot is already in progress',
      'error.composer': 'The composer is not available right now',
      'error.image': 'Could not read the screenshot. Try again.',
      'error.hidden': 'This window returns no image right now (it is probably fully covered). Bring it to the front and retry.',
      'hint.autoHide': 'Want the app window to step aside while capturing? Grant DeepSeek Harness the Accessibility permission once.',
      'review.title': 'Confirm screenshot',
      'review.cancel': 'Cancel',
      'review.confirm': 'Confirm',
      'picker.previewUnavailable': 'Window not visible',
      'gallery.prev': 'Previous',
      'gallery.next': 'Next',
      'gallery.close': 'Close preview',
      'gallery.save': 'Save',
      'gallery.zoomIn': 'Zoom in',
      'gallery.zoomOut': 'Zoom out',
      'gallery.resetZoom': 'Reset to 100% (mouse wheel also zooms)',
      'settings.nav': 'Screenshot',
      'settings.shortcut.title': 'Screenshot shortcut',
      'settings.shortcut.description': 'Captures the whole screen directly; same as Whole screen in the menu',
      'settings.shortcut.recording': 'Press the new combination…',
      'settings.shortcut.cancel': 'Cancel',
      'settings.shortcut.change': 'Change',
      'settings.shortcut.reset': 'Restore default',
      'settings.shortcut.unbound': 'Not set',
      'settings.shortcut.invalid': 'That combination is not supported',
      'settings.shortcut.issue.reserved': 'That combination is reserved by the system or Harness',
      'settings.shortcut.issue.unsupported-browser': 'That combination is not available in a browser',
      'settings.shortcut.issue.modifier-required': 'Include at least one modifier (⌘ / ⌃ / ⌥ / ⇧)',
      'settings.shortcut.issue.unsupported-key': 'That key cannot be a shortcut on its own',
      'settings.shortcut.conflict': 'That combination is already used by "{name}"',
      'settings.shortcut.failed': 'Could not save the shortcut. Try again.',
      'settings.shortcut.unsupported': 'Shortcuts cannot be changed in this environment',
      'settings.save.title': 'Save location',
      'settings.save.description': 'The Save button writes PNG files into this folder',
      'settings.save.pick': 'Choose…',
      'settings.save.reset': 'Restore default',
      'settings.save.notAbsolute': 'Use an absolute path, such as /Users/you/Pictures',
      'settings.save.failed': 'The save location was not written. Try again.',
      'settings.save.pickFailed': 'The folder picker is unavailable here; type the path instead',
      'settings.hide.title': 'Hide the window while selecting a region',
      'settings.hide.description': 'Steps the Harness window aside while you drag, then restores it (needs Accessibility permission)',
      'settings.hide.failed': 'The setting was not written. Try again.',
      'settings.footer': 'Applies immediately · stored in ~/.dsh/dsh-screenshot/settings.json',
      'settings.loadFailed': 'Could not read the settings; changes may not be saved',
      'save.done': 'Saved to {path}',
      'save.reveal': 'Show',
      'save.failed': 'Could not save the file. Check that the folder is writable.',
      'review.save': 'Save',
      'review.savedOnly': 'No session is open, so the screenshot goes straight to disk',
    }

    let translate = null
    function t(key, fallback) {
      try {
        const value = translate === null ? undefined : translate(key)
        return typeof value === 'string' && value.length > 0 ? value : fallback
      } catch {
        return fallback
      }
    }

    /** 取景框 + 相机，和工具栏其它按钮同一套线性图标风格。 */
    function CameraIcon(props) {
      const size = props && Number.isFinite(props.size) ? props.size : 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, style: { display: 'block' },
      },
        h('path', { d: 'M2.2 5.9V3.9c0-.9.7-1.7 1.7-1.7h2' }),
        h('path', { d: 'M10.1 2.2h2c.9 0 1.7.7 1.7 1.7v2' }),
        h('path', { d: 'M13.8 10.1v2c0 .9-.7 1.7-1.7 1.7h-2' }),
        h('path', { d: 'M5.9 13.8h-2c-.9 0-1.7-.7-1.7-1.7v-2' }),
        h('circle', { cx: 8, cy: 8, r: 2.4 }),
      )
    }

    /** 返回箭头，用在窗口列表的标题行。 */
    function BackIcon(props) {
      const size = props && Number.isFinite(props.size) ? props.size : 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, style: { display: 'block' },
      }, h('path', { d: 'M9.9 3.4 5.3 8l4.6 4.6' }))
    }

    /** 一台显示器：屏幕 + 底座，用来区分「截整个桌面」。 */
    function MonitorIcon(props) {
      const size = props && Number.isFinite(props.size) ? props.size : 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, style: { display: 'block' },
      },
        h('rect', { x: 1.9, y: 2.7, width: 12.2, height: 8.6, rx: 1.7 }),
        h('path', { d: 'M8 11.3v2.4' }),
        h('path', { d: 'M5.4 13.9h5.2' }),
      )
    }

    /** 一个窗口：标题栏 + 内容区，用来区分「截整个窗口」。 */
    function WindowIcon(props) {
      const size = props && Number.isFinite(props.size) ? props.size : 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, style: { display: 'block' },
      },
        h('rect', { x: 2.1, y: 3.1, width: 11.8, height: 9.8, rx: 1.9 }),
        h('path', { d: 'M2.1 6.2h11.8' }),
        h('circle', { cx: 4.2, cy: 4.7, r: 0.55, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 6.1, cy: 4.7, r: 0.55, fill: 'currentColor', stroke: 'none' }),
      )
    }

    /** 下载箭头 + 托盘，用在保存按钮上。 */
    function SaveIcon(props) {
      const size = props && Number.isFinite(props.size) ? props.size : 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, style: { display: 'block', flex: 'none' },
      },
        h('path', { d: 'M8 2.4v7.2' }),
        h('path', { d: 'M5.2 6.8 8 9.6l2.8-2.8' }),
        h('path', { d: 'M2.9 11.2v1.1c0 .7.6 1.3 1.3 1.3h7.6c.7 0 1.3-.6 1.3-1.3v-1.1' }),
      )
    }

    // sessionId -> { inputActions }，由工具栏按钮维护。
    const handles = new Map()

    // 本插件自己放进草稿的附件 id：预览时据此判断要不要接管点击（给保存按钮）。
    const ownDraftIds = new Set()
    function rememberOwnDraft(id) {
      if (typeof id !== 'string') return
      ownDraftIds.add(id)
      while (ownDraftIds.size > 200) {
        const first = ownDraftIds.values().next().value
        if (first === undefined) break
        ownDraftIds.delete(first)
      }
    }

    // 轻提示：截图失败时给出可操作的一句话。
    let toast = null
    let toastSeq = 0
    const toastListeners = new Set()
    function publishToast(next) {
      toast = next
      for (const listener of toastListeners) listener()
    }
    function showToast(text, action) {
      toastSeq += 1
      publishToast({ text, action, seq: toastSeq })
    }
    function dismissToast(seq) {
      if (toast !== null && toast.seq === seq) publishToast(null)
    }

    // 框选结束后先给用户一次「取消 / 确认」的机会，确认了才放进草稿。
    let review = null
    const reviewListeners = new Set()
    function publishReview(next) {
      const previous = review
      review = next
      if (previous !== null && previous !== next) {
        try {
          URL.revokeObjectURL(previous.url)
        } catch {
          // 释放失败不影响新的一轮。
        }
      }
      for (const listener of reviewListeners) listener()
    }

    function ToastHost() {
      const [state, setState] = useState(toast)
      useEffect(() => {
        const listener = () => setState(toast)
        toastListeners.add(listener)
        listener()
        return () => {
          toastListeners.delete(listener)
        }
      }, [])
      useEffect(() => {
        if (state === null) return undefined
        // 3 秒足够看清路径；想提前关掉点一下提示即可。
        const timer = setTimeout(() => dismissToast(state.seq), 3000)
        return () => clearTimeout(timer)
      }, [state])

      if (state === null) return null
      return createPortal(h('div', {
        className: 'sp-toast',
        role: 'status',
        onClick: () => dismissToast(state.seq),
      },
        h('style', { key: 'css' }, TOAST_CSS),
        h('span', { style: { flex: 1 } }, state.text),
        state.action === undefined ? null : h('button', {
          key: 'action',
          type: 'button',
          className: 'sp-toast-button',
          onClick: () => {
            try {
              state.action.run()
            } catch {
              // 打开设置失败就保持原样，提示仍会自己消失。
            }
            dismissToast(state.seq)
          },
        }, state.action.label),
      ), document.body)
    }

    // 草稿里多张图片的预览：点任意一张打开，左右切换。
    let gallery = null
    const galleryListeners = new Set()
    function publishGallery(next) {
      gallery = next
      for (const listener of galleryListeners) listener()
    }
    function stepGallery(delta) {
      if (gallery === null) return
      const total = gallery.urls.length
      const index = Math.min(Math.max(gallery.index + delta, 0), total - 1)
      if (index === gallery.index) return
      publishGallery({ ...gallery, index })
    }

    /** 右箭头图标（左箭头复用 BackIcon）。 */
    function NextIcon(props) {
      const size = props && Number.isFinite(props.size) ? props.size : 18
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, style: { display: 'block' },
      }, h('path', { d: 'M6.1 3.4 10.7 8l-4.6 4.6' }))
    }

    /** 放大镜里一个加号，和保存按钮同一套线性图标。 */
    function ZoomInIcon(props) {
      const size = props && Number.isFinite(props.size) ? props.size : 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, style: { display: 'block' },
      },
        h('circle', { cx: 6.9, cy: 6.9, r: 4.4 }),
        h('path', { d: 'M10.2 10.2 13.6 13.6' }),
        h('path', { d: 'M4.9 6.9h4M6.9 4.9v4' }),
      )
    }

    /** 放大镜里一个减号。 */
    function ZoomOutIcon(props) {
      const size = props && Number.isFinite(props.size) ? props.size : 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, style: { display: 'block' },
      },
        h('circle', { cx: 6.9, cy: 6.9, r: 4.4 }),
        h('path', { d: 'M10.2 10.2 13.6 13.6' }),
        h('path', { d: 'M4.9 6.9h4' }),
      )
    }

    /** 图片预览：暗色背景 + 顶部「缩小 / 百分比 / 放大 / 保存」，和豆包的预览一致。 */
    function GalleryHost() {
      const [state, setState] = useState(gallery)
      const [busy, setBusy] = useState(false)
      const [failed, setFailed] = useState(false)
      const [zoom, setZoom] = useState(1)
      const [natural, setNatural] = useState(null)
      const rootRef = useRef(null)
      const stageRef = useRef(null)

      useEffect(() => {
        const listener = () => setState(gallery)
        galleryListeners.add(listener)
        listener()
        return () => {
          galleryListeners.delete(listener)
        }
      }, [])

      // 换图 / 关掉再打开时回到 100%，并重新量一下原图尺寸。
      useEffect(() => {
        setZoom(1)
        setNatural(null)
        setFailed(false)
      }, [state === null ? null : state.urls[state.index]])

      useEffect(() => {
        if (state === null) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            publishGallery(null)
            return
          }
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault()
            event.stopPropagation()
            stepGallery(event.key === 'ArrowLeft' ? -1 : 1)
            return
          }
          if (event.key === '+' || event.key === '=') {
            event.preventDefault()
            event.stopPropagation()
            zoomBy(1.25)
            return
          }
          if (event.key === '-' || event.key === '_') {
            event.preventDefault()
            event.stopPropagation()
            zoomBy(0.8)
            return
          }
          if (event.key === '0') {
            event.preventDefault()
            event.stopPropagation()
            setZoom(1)
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [state])

      function zoomBy(factor) {
        setZoom((value) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * factor * 100) / 100)))
      }

      /** 滚轮 / 触控板双指：往上放大、往下缩小；缩略图条上的滚轮留给它自己滚动。 */
      function onWheel(event) {
        const target = event.target
        if (target instanceof Element && target.closest('.sp-shot-gallery-strip') !== null) return
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1
        const delta = (typeof event.deltaY === 'number' ? event.deltaY : 0) * unit
        if (delta === 0) return
        zoomBy(Math.exp(-delta * 0.0015))
      }

      // 每次缩放都把视口对准图片中心：放大的第一眼看到的是中间，不是左上角。
      useEffect(() => {
        const stage = stageRef.current
        if (stage === null) return
        stage.scrollLeft = Math.max(0, (stage.scrollWidth - stage.clientWidth) / 2)
        stage.scrollTop = Math.max(0, (stage.scrollHeight - stage.clientHeight) / 2)
      }, [zoom])

      // React 的 wheel 监听是 passive 的，preventDefault 得用原生监听补一刀，
      // 否则滚轮会顺带把后面的页面也滚走。
      useEffect(() => {
        const node = rootRef.current
        if (node === null || typeof node.addEventListener !== 'function') return undefined
        const blockDefault = (event) => {
          const target = event.target
          if (target instanceof Element && target.closest('.sp-shot-gallery-strip') !== null) return
          event.preventDefault()
        }
        node.addEventListener('wheel', blockDefault, { passive: false })
        return () => {
          node.removeEventListener('wheel', blockDefault)
        }
      }, [state === null])

      /** 放大之后用鼠标拖图片平移：滚轮已经被缩放占用，得留一条移动的路。 */
      function startPan(event) {
        const stage = stageRef.current
        if (stage === null || event.button !== 0 || zoom <= 1) return
        const startX = event.clientX
        const startY = event.clientY
        const startLeft = stage.scrollLeft
        const startTop = stage.scrollTop
        const move = (moveEvent) => {
          stage.scrollLeft = startLeft - (moveEvent.clientX - startX)
          stage.scrollTop = startTop - (moveEvent.clientY - startY)
        }
        const end = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', end)
          if (stage instanceof Element) stage.classList.remove('panning')
        }
        if (stage instanceof Element) stage.classList.add('panning')
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', end)
        event.preventDefault()
      }

      if (state === null || state.urls.length === 0) return null
      const index = Math.min(Math.max(state.index, 0), state.urls.length - 1)
      const current = state.urls[index]
      const total = state.urls.length
      const viewportWidth = typeof window === 'undefined' ? 1280 : window.innerWidth
      const viewportHeight = typeof window === 'undefined' ? 800 : window.innerHeight
      // 100% 是「整张图刚好放得下」的尺寸；缩放基于它，而不是原图像素。
      // 100% 只缩小、不放大：小图保持原尺寸，需要的话再手动放大。
      const fitScale = natural === null
        ? 1
        : Math.min(1, Math.max(160, viewportWidth - 192) / natural.width, Math.max(160, viewportHeight - 200) / natural.height)
      const imageWidth = natural === null ? undefined : Math.max(24, Math.round(natural.width * fitScale * zoom))
      const percent = Math.round(zoom * 100)
      const closeOnBackdrop = (event) => {
        if (event.target !== event.currentTarget) return
        closedByBackdrop = Date.now()
        publishGallery(null)
      }
      const saveCurrent = async () => {
        if (busy) return
        setBusy(true)
        setFailed(false)
        const blob = await fetch(current).then((response) => (response.ok ? response.blob() : null)).catch(() => null)
        if (blob === null || blob.size === 0) {
          setBusy(false)
          setFailed(true)
          return
        }
        const payload = await uploadShot(blob, fileName())
        setBusy(false)
        if (payload === null) {
          setFailed(true)
          return
        }
        announceSaved(payload)
        // 存完就退出预览：接下来多半是要继续打字。
        closedByBackdrop = Date.now()
        publishGallery(null)
      }

      return createPortal(h('div', {
        ref: rootRef,
        className: 'sp-shot-gallery',
        role: 'dialog',
        'aria-modal': 'true',
        onMouseDown: closeOnBackdrop,
        onWheel,
      },
        h('style', { key: 'css' }, GALLERY_CSS),
        h('div', {
          key: 'topbar',
          className: 'sp-shot-gallery-topbar',
          onMouseDown: (event) => event.stopPropagation(),
        },
          h('div', { key: 'tools', className: 'sp-shot-gallery-tools' },
            total > 1
              ? h('span', { key: 'counter', className: 'sp-shot-gallery-counter' }, `${index + 1} / ${total}`)
              : null,
            total > 1 ? h('span', { key: 'sep-a', className: 'sp-shot-gallery-sep' }) : null,
            h('button', {
              key: 'zoom-out',
              type: 'button',
              className: 'sp-shot-gallery-tool',
              title: t('gallery.zoomOut', ZH['gallery.zoomOut']),
              'aria-label': t('gallery.zoomOut', ZH['gallery.zoomOut']),
              disabled: zoom <= MIN_ZOOM + 0.001,
              onClick: () => zoomBy(1 / 1.25),
            }, h(ZoomOutIcon, { size: 16 })),
            h('button', {
              key: 'zoom-reset',
              type: 'button',
              className: 'sp-shot-gallery-zoom',
              title: t('gallery.resetZoom', ZH['gallery.resetZoom']),
              onClick: () => setZoom(1),
            }, `${percent}%`),
            h('button', {
              key: 'zoom-in',
              type: 'button',
              className: 'sp-shot-gallery-tool',
              title: t('gallery.zoomIn', ZH['gallery.zoomIn']),
              'aria-label': t('gallery.zoomIn', ZH['gallery.zoomIn']),
              disabled: zoom >= MAX_ZOOM - 0.001,
              onClick: () => zoomBy(1.25),
            }, h(ZoomInIcon, { size: 16 })),
            h('span', { key: 'sep', className: 'sp-shot-gallery-sep' }),
            h('button', {
              key: 'save',
              type: 'button',
              className: 'sp-shot-gallery-tool save',
              title: failed ? t('save.failed', ZH['save.failed']) : t('gallery.save', ZH['gallery.save']),
              disabled: busy,
              onClick: () => { void saveCurrent() },
            },
              h(SaveIcon, { size: 15 }),
              h('span', { key: 'label', className: 'sp-shot-gallery-save-label' }, busy ? '…' : t('gallery.save', ZH['gallery.save'])),
            ),
          ),
          failed
            ? h('span', { key: 'error', className: 'sp-shot-gallery-error', role: 'alert' }, t('save.failed', ZH['save.failed']))
            : null,
        ),
        h('div', {
          key: 'stage',
          ref: stageRef,
          className: 'sp-shot-gallery-stage',
          onMouseDown: closeOnBackdrop,
        },
          h('div', { key: 'frame', className: 'sp-shot-gallery-frame' },
            h('img', {
              key: current,
              className: 'sp-shot-gallery-image',
              src: current,
              alt: '',
              draggable: false,
              onPointerDown: startPan,
              onLoad: (event) => {
                const image = event.currentTarget
                if (image.naturalWidth > 0 && image.naturalHeight > 0) {
                  setNatural({ width: image.naturalWidth, height: image.naturalHeight })
                }
              },
              style: {
                cursor: zoom > 1 ? 'grab' : 'default',
                ...(natural === null ? {} : { width: `${imageWidth}px`, maxWidth: 'none', maxHeight: 'none' }),
              },
            })),
        ),
        index === 0 ? null : h('button', {
          key: 'prev',
          type: 'button',
          className: 'sp-shot-gallery-nav prev',
          title: t('gallery.prev', ZH['gallery.prev']),
          'aria-label': t('gallery.prev', ZH['gallery.prev']),
          onClick: () => stepGallery(-1),
        }, h(BackIcon, { size: 18 })),
        index === total - 1 ? null : h('button', {
          key: 'next',
          type: 'button',
          className: 'sp-shot-gallery-nav next',
          title: t('gallery.next', ZH['gallery.next']),
          'aria-label': t('gallery.next', ZH['gallery.next']),
          onClick: () => stepGallery(1),
        }, h(NextIcon, { size: 18 })),
        total > 1 ? h('div', {
          key: 'strip',
          className: 'sp-shot-gallery-strip',
          onMouseDown: (event) => event.stopPropagation(),
        },
          state.urls.map((url, position) => h('button', {
            key: url,
            type: 'button',
            className: position === index ? 'sp-shot-gallery-thumb current' : 'sp-shot-gallery-thumb',
            'aria-current': position === index,
            onClick: () => publishGallery({ ...state, index: position }),
          }, h('img', { src: url, alt: '' })))) : null,
        h('button', {
          key: 'close',
          type: 'button',
          className: 'sp-shot-gallery-close',
          title: t('gallery.close', ZH['gallery.close']),
          'aria-label': t('gallery.close', ZH['gallery.close']),
          onClick: () => publishGallery(null),
        }, h('span', { 'aria-hidden': true }, '×')),
      ), document.body)
    }

    const GALLERY_CSS = `
      /* 和豆包一致的看图界面：整屏近黑遮罩，图片浮在中间，工具在顶部。 */
      .sp-shot-gallery {
        position: fixed;
        inset: 0;
        z-index: 901;
        background: rgba(0, 0, 0, .86);
        backdrop-filter: blur(10px);
      }
      .sp-shot-gallery-topbar {
        position: absolute;
        top: 14px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 2;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        max-width: calc(100vw - 128px);
      }
      /* 深色玻璃胶囊：缩放和保存都在这一条里。 */
      .sp-shot-gallery-tools {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        padding: 4px;
        border: .5px solid rgba(255, 255, 255, .14);
        border-radius: 999px;
        background: rgba(30, 30, 32, .72);
        backdrop-filter: blur(24px);
        box-shadow: 0 8px 24px rgba(0, 0, 0, .35);
        color: #fff;
      }
      .sp-shot-gallery-tool {
        display: inline-grid;
        place-items: center;
        box-sizing: border-box;
        width: 28px;
        height: 28px;
        padding: 0;
        border: none;
        border-radius: 999px;
        background: transparent;
        color: inherit;
        font: inherit;
        cursor: pointer;
      }
      .sp-shot-gallery-tool:hover:not(:disabled) { background: rgba(255, 255, 255, .12); }
      .sp-shot-gallery-tool:disabled { opacity: .35; cursor: default; }
      .sp-shot-gallery-tool.save {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        width: auto;
        padding: 0 10px 0 8px;
      }
      .sp-shot-gallery-save-label { font-size: 12px; line-height: 1; }
      .sp-shot-gallery-zoom {
        min-width: 46px;
        height: 28px;
        padding: 0 4px;
        border: none;
        border-radius: 999px;
        background: transparent;
        color: rgba(255, 255, 255, .8);
        font: inherit;
        font-size: 12px;
        font-variant-numeric: tabular-nums;
        cursor: pointer;
      }
      .sp-shot-gallery-zoom:hover { background: rgba(255, 255, 255, .12); }
      .sp-shot-gallery-counter {
        padding: 0 6px 0 6px;
        font-size: 12px;
        color: rgba(255, 255, 255, .72);
        font-variant-numeric: tabular-nums;
      }
      .sp-shot-gallery-sep {
        flex: none;
        width: 1px;
        height: 16px;
        margin: 0 4px;
        background: rgba(255, 255, 255, .16);
      }
      .sp-shot-gallery-error {
        padding: 4px 10px;
        border-radius: 999px;
        background: rgba(0, 0, 0, .6);
        font-size: 12px;
        line-height: 18px;
        color: #ff8f8f;
      }
      /* 图片自己滚动：放大到超出视口时，用 margin:auto 的 flex 仍然能滚到左上角。 */
      .sp-shot-gallery-stage {
        position: absolute;
        inset: 0;
        display: flex;
        overflow: auto;
        padding: 62px 96px 116px;
      }
      .sp-shot-gallery-frame {
        display: flex;
        flex: none;
        margin: auto;
      }
      .sp-shot-gallery-stage.panning { cursor: grabbing; }
      .sp-shot-gallery-image {
        display: block;
        max-width: calc(100vw - 192px);
        max-height: calc(100vh - 200px);
        border-radius: var(--dsw-radius-md, 8px);
        box-shadow: 0 24px 64px rgba(0, 0, 0, .5);
        user-select: none;
        -webkit-user-drag: none;
      }
      /* 与顶部胶囊同一套：圆形深色玻璃按钮。 */
      .sp-shot-gallery-nav,
      .sp-shot-gallery-close {
        position: absolute;
        display: grid;
        place-items: center;
        box-sizing: border-box;
        width: 36px;
        height: 36px;
        padding: 0;
        border: .5px solid rgba(255, 255, 255, .14);
        border-radius: 999px;
        background: rgba(30, 30, 32, .72);
        backdrop-filter: blur(24px);
        color: #fff;
        cursor: pointer;
      }
      .sp-shot-gallery-nav:hover,
      .sp-shot-gallery-close:hover { background: rgba(60, 60, 64, .82); }
      .sp-shot-gallery-nav:focus-visible,
      .sp-shot-gallery-close:focus-visible,
      .sp-shot-gallery-tool:focus-visible,
      .sp-shot-gallery-zoom:focus-visible {
        outline: 2px solid rgba(255, 255, 255, .6);
        outline-offset: 2px;
      }
      .sp-shot-gallery-nav { top: 50%; transform: translateY(-50%); }
      .sp-shot-gallery-nav.prev { left: 24px; }
      .sp-shot-gallery-nav.next { right: 24px; }
      .sp-shot-gallery-close {
        position: absolute;
        top: 20px;
        right: 20px;
        font-size: 18px;
        line-height: 1;
      }
      .sp-shot-gallery-strip {
        position: absolute;
        left: 50%;
        bottom: 18px;
        transform: translateX(-50%);
        display: flex;
        gap: 8px;
        max-width: calc(100vw - 128px);
        padding: 6px;
        overflow-x: auto;
        border: .5px solid rgba(255, 255, 255, .14);
        border-radius: 12px;
        background: rgba(30, 30, 32, .72);
        backdrop-filter: blur(24px);
      }
      .sp-shot-gallery-thumb {
        flex: none;
        width: 56px;
        height: 40px;
        padding: 0;
        overflow: hidden;
        border: .5px solid transparent;
        border-radius: 6px;
        background: transparent;
        cursor: pointer;
        opacity: .7;
        transition: opacity .12s ease, border-color .12s ease;
      }
      .sp-shot-gallery-thumb img {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      .sp-shot-gallery-thumb:hover { opacity: 1; }
      .sp-shot-gallery-thumb.current {
        opacity: 1;
        border-color: rgba(255, 255, 255, .9);
      }
    `


    function ReviewHost() {
      const [state, setState] = useState(review)
      const [busy, setBusy] = useState(false)
      const [failed, setFailed] = useState(false)
      useEffect(() => {
        const listener = () => setState(review)
        reviewListeners.add(listener)
        listener()
        return () => {
          reviewListeners.delete(listener)
        }
      }, [])
      const save = async () => {
        if (busy || review === null) return
        setBusy(true)
        setFailed(false)
        const saved = await saveReview()
        setBusy(false)
        if (!saved) setFailed(true)
      }
      useEffect(() => {
        if (state === null) return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Escape' && event.key !== 'Enter') return
          event.preventDefault()
          event.stopPropagation()
          if (event.key === 'Escape') cancelReview()
          else if (state.sessionId === undefined) save()
          else confirmReview()
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [state, busy])

      if (state === null) return null
      const canAttach = state.sessionId !== undefined
      return createPortal(h('div', {
        className: 'sp-shot-review',
        role: 'dialog',
        'aria-modal': 'true',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) cancelReview()
        },
      },
        h('div', {
          className: 'sp-shot-review-card',
          'aria-label': t('review.title', ZH['review.title']),
        },
          h('div', { key: 'body', className: 'sp-shot-review-body' },
            h('img', { className: 'sp-shot-review-image', src: state.url, alt: '' }),
          ),
          h('div', { key: 'actions', className: 'sp-shot-review-actions' },
            failed
              ? h('span', { key: 'error', className: 'sp-shot-review-error', role: 'alert' }, t('save.failed', ZH['save.failed']))
              : canAttach
                ? null
                : h('span', { key: 'hint', className: 'sp-shot-review-hint' }, t('review.savedOnly', ZH['review.savedOnly'])),
            h('button', {
              key: 'cancel',
              type: 'button',
              className: 'sp-shot-review-button',
              onClick: () => cancelReview(),
            }, t('review.cancel', ZH['review.cancel'])),
            h('button', {
              key: 'save',
              type: 'button',
              className: 'sp-shot-review-button',
              disabled: busy,
              onClick: () => { void save() },
            }, busy ? '…' : t('review.save', ZH['review.save'])),
            canAttach ? h('button', {
              key: 'confirm',
              type: 'button',
              className: 'sp-shot-review-button primary',
              onClick: () => confirmReview(),
            }, t('review.confirm', ZH['review.confirm'])) : null,
          ),
        ),
      ), document.body)
    }

    // 框选确认弹窗里的保存：存盘并关掉弹窗，不进草稿。
    let reviewSaving = false
    async function saveReview() {
      if (review === null || reviewSaving) return false
      const current = review
      reviewSaving = true
      try {
        const payload = await uploadShot(current.blob, fileName())
        if (payload === null) return false
        publishReview(null)
        announceSaved(payload)
        return true
      } finally {
        reviewSaving = false
      }
    }

    function confirmReview() {
      if (review === null) return
      const current = review
      publishReview(null)
      try {
        const file = new File([current.blob], fileName(), { type: 'image/png' })
        attach(ctxRef, current.sessionId, file)
      } finally {
        URL.revokeObjectURL(current.url)
      }
    }

    function cancelReview() {
      if (review === null) return
      publishReview(null)
    }

    // 提示条用和预览顶栏同一套深色玻璃：bg-overlay 在深色主题里是中灰，
    // 浮在近黑的预览上会发白发浅，所以这里直接用固定的深色材质。
    const TOAST_CSS = `
      .sp-toast {
        position: fixed;
        left: 50%;
        bottom: 108px;
        transform: translateX(-50%);
        /* 预览层是 901：保存成功的提示必须浮在它上面。 */
        z-index: 950;
        display: flex;
        align-items: center;
        gap: 10px;
        max-width: min(560px, calc(100vw - 48px));
        padding: 10px 14px;
        border: .5px solid rgba(255, 255, 255, .14);
        border-radius: 12px;
        background: rgba(30, 30, 32, .92);
        backdrop-filter: blur(24px);
        box-shadow: 0 12px 32px rgba(0, 0, 0, .35);
        color: #fff;
        font-size: 13px;
        line-height: 1.5;
        cursor: pointer;
      }
      .sp-toast-button {
        flex: none;
        padding: 4px 10px;
        border: .5px solid rgba(255, 255, 255, .22);
        border-radius: 8px;
        background: rgba(255, 255, 255, .08);
        color: #fff;
        font: inherit;
        font-size: 12px;
        cursor: pointer;
      }
      .sp-toast-button:hover { background: rgba(255, 255, 255, .18); }
    `

    const BUTTON_CSS = `
      .sp-shot-group {
        display: inline-flex;
        align-items: center;
      }
      .sp-shot-button {
        width: 28px;
        height: 28px;
        flex: none;
        display: grid;
        place-items: center;
        padding: 0;
        border: none;
        border-radius: 999px;
        background: transparent;
        color: var(--dsw-alias-label-secondary);
        cursor: pointer;
        transition: background-color .12s ease, color .12s ease;
      }
      .sp-shot-button:hover:not(:disabled),
      .sp-shot-button[aria-expanded="true"] {
        background: var(--dsw-alias-interactive-bg-hover-solid, var(--dsw-alias-bg-layer-2));
        color: var(--dsw-alias-label-primary);
      }
      .sp-shot-button:disabled { opacity: .5; cursor: default; }
      .sp-shot-button[data-busy="true"] svg { opacity: .55; }
      /* 与内置菜单同一套材质：MenuSurface 的填充 + 背景模糊 + .5px 描边。 */
      .sp-shot-pop {
        position: fixed;
        z-index: 800;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        min-width: 96px;
        padding: 4px;
        border: .5px solid var(--dsw-alias-border-l2);
        border-radius: var(--dsw-radius-md, 10px);
        background: var(--dsw-menu-surface-fill, var(--dsw-alias-bg-overlay));
        backdrop-filter: var(--dsw-menu-backdrop-filter, none);
        box-shadow: var(--dsw-elevation-panel, 0 12px 32px rgba(0, 0, 0, 0.18));
        color: var(--dsw-alias-label-primary);
        font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px);
        line-height: 1.4;
      }
      .sp-shot-menu-row {
        width: 100%;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 7px;
        border: none;
        border-radius: var(--dsw-radius-md, 8px);
        background: transparent;
        color: var(--dsw-alias-label-primary);
        font: inherit;
        text-align: left;
        cursor: pointer;
      }
      .sp-shot-menu-row:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
      .sp-shot-menu-icon {
        flex: none;
        display: grid;
        place-items: center;
        color: var(--dsw-alias-label-secondary);
      }
      .sp-shot-menu-keys {
        margin-left: auto;
        flex: none;
        font-size: 11px;
        letter-spacing: .02em;
        color: var(--dsw-alias-label-secondary);
      }
      .sp-shot-pop-head {
        flex: none;
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 3px 4px 5px;
        font-size: 11px;
        color: var(--dsw-alias-label-secondary);
      }
      .sp-shot-back {
        width: 20px;
        height: 20px;
        flex: none;
        display: grid;
        place-items: center;
        padding: 0;
        border: none;
        border-radius: var(--dsw-radius-sm, 6px);
        background: transparent;
        color: var(--dsw-alias-label-secondary);
        cursor: pointer;
      }
      .sp-shot-back:hover {
        background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
        color: var(--dsw-alias-label-primary);
      }
      .sp-shot-pop-list {
        overflow-y: auto;
        max-height: 300px;
        padding: 0;
      }
      .sp-shot-pop-row {
        width: 100%;
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 0 8px;
        padding: 4px 7px;
        border: none;
        border-radius: var(--dsw-radius-md, 8px);
        background: transparent;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
      }
      .sp-shot-pop-row:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
      .sp-shot-pop-title {
        grid-column: 1;
        grid-row: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-weight: 500;
        color: var(--dsw-alias-label-primary);
      }
      .sp-shot-pop-size {
        grid-column: 2;
        grid-row: 1;
        align-self: center;
        font-size: 10.5px;
        color: var(--dsw-alias-label-secondary);
      }
      .sp-shot-pop-app {
        grid-column: 1 / -1;
        grid-row: 2;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 11px;
        color: var(--dsw-alias-label-secondary);
      }
      .sp-shot-preview {
        position: fixed;
        z-index: 801;
        pointer-events: none;
        width: 340px;
        padding: 6px;
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 88px;
        border: .5px solid var(--dsw-alias-border-l2);
        border-radius: var(--dsw-radius-md, 10px);
        background: var(--dsw-menu-surface-fill, var(--dsw-alias-bg-overlay));
        backdrop-filter: var(--dsw-menu-backdrop-filter, none);
        box-shadow: var(--dsw-elevation-panel, 0 12px 32px rgba(0, 0, 0, 0.18));
      }
      .sp-shot-preview img {
        display: block;
        max-width: 100%;
        max-height: 220px;
        border-radius: 8px;
      }
      .sp-shot-preview-empty {
        font-size: 12px;
        color: var(--dsw-alias-label-secondary);
      }
      /* 与内置 Dialog / Button 同一套：遮罩 + bg-layer-2 卡片 + primary 按钮。 */
      .sp-shot-review {
        position: fixed;
        inset: 0;
        z-index: 900;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
      }
      .sp-shot-review::before {
        content: "";
        position: absolute;
        inset: 0;
        background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, .45));
        backdrop-filter: var(--dsw-mask-blur, blur(6px));
      }
      .sp-shot-review-card {
        position: relative;
        z-index: 1;
        display: flex;
        flex-direction: column;
        gap: 8px;
        max-width: min(920px, 100%);
        max-height: calc(100vh - 48px);
        padding: 0;
        overflow: hidden;
        border: .5px solid var(--dsw-alias-border-l2);
        border-radius: var(--dsw-radius-md, 10px);
        background: var(--dsw-alias-bg-layer-2);
        box-shadow: var(--dsw-elevation-soft, 0 8px 24px rgba(0, 0, 0, .28));
      }
      .sp-shot-review-body {
        display: flex;
        justify-content: center;
        min-width: 0;
        padding: 8px 8px 0;
      }
      .sp-shot-review-image {
        display: block;
        max-width: 100%;
        max-height: calc(100vh - 220px);
        border: .5px solid var(--dsw-alias-border-l1);
        border-radius: var(--dsw-radius-sm, 6px);
      }
      .sp-shot-review-actions {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 6px;
        padding: 0 8px 8px;
      }
      .sp-shot-review-error {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12px;
        color: var(--dsw-alias-state-error-primary);
      }
      .sp-shot-review-hint {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12px;
        color: var(--dsw-alias-label-secondary);
      }
      .sp-shot-review-button:disabled { opacity: .55; cursor: default; }
      .sp-shot-review-button {
        box-sizing: border-box;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 62px;
        height: 28px;
        padding: 0 12px;
        border: none;
        border-radius: var(--dsw-radius-sm, 6px);
        background: transparent;
        color: var(--dsw-alias-label-primary);
        font: inherit;
        font-size: 12px;
        line-height: 18px;
        cursor: pointer;
      }
      .sp-shot-review-button:hover {
        background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
      }
      .sp-shot-review-button.primary {
        background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary));
        color: var(--dsw-alias-label-primary-foreground, #fff);
      }
      .sp-shot-review-button.primary:hover:not(:disabled) {
        background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-button-primary-fill));
      }
      .sp-shot-pop-empty {
        padding: 6px 10px 10px;
        font-size: 12px;
        color: var(--dsw-alias-label-secondary);
      }
      .sp-shot-pop-fallback {
        flex: none;
        margin: 2px 0 0;
        padding: 4px 7px;
        border: none;
        border-radius: var(--dsw-radius-md, 8px);
        background: transparent;
        color: var(--dsw-alias-label-secondary);
        font: inherit;
        font-size: 11px;
        text-align: left;
        cursor: pointer;
      }
      .sp-shot-pop-fallback:hover {
        background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
        color: var(--dsw-alias-label-primary);
      }
    `

    // ---- 设置页：快捷键 / 保存位置 / 框选时自动隐藏窗口 ----------------------

    /** 一个设置行：左边标题 + 说明，右边控件；和 Harness 设置页的 General 行同构。 */
    function SettingsRow(props) {
      return h('div', { className: 'sp-set-row' },
        h('div', { key: 'text', className: 'sp-set-text' },
          h('div', { key: 'title', className: 'sp-set-title' }, props.title),
          props.description === undefined ? null : h('div', { key: 'desc', className: 'sp-set-desc' }, props.description),
          props.error === undefined || props.error === null
            ? null
            : h('div', { key: 'error', className: 'sp-set-error', role: 'alert' }, props.error),
        ),
        h('div', { key: 'control', className: 'sp-set-control' }, props.children),
      )
    }

    /** 开关：role=switch + aria-checked，和内置 Switch 的语义一致。 */
    function SettingsSwitch(props) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': props.checked === true ? 'true' : 'false',
        'aria-label': props.label,
        disabled: props.disabled === true,
        className: props.checked === true ? 'sp-set-switch on' : 'sp-set-switch',
        onClick: () => {
          if (props.disabled !== true) props.onChange(props.checked !== true)
        },
      }, h('span', { key: 'knob', className: 'sp-set-knob' }))
    }

    /** 设置 › 截图：三行偏好，改动立刻生效。 */
    function SettingsSection() {
      const [settings, setSettings] = useState(settingsState)
      const [shortcut, setShortcut] = useState(shortcutInfo)
      const [recording, setRecording] = useState(false)
      const [draft, setDraft] = useState(null)
      const [busy, setBusy] = useState(null)
      const [error, setError] = useState(null)
      const [shortcutError, setShortcutError] = useState(null)

      useEffect(() => {
        const listener = () => setSettings(settingsState)
        settingsListeners.add(listener)
        listener()
        return () => {
          settingsListeners.delete(listener)
        }
      }, [])
      useEffect(() => {
        const listener = () => setShortcut(shortcutInfo)
        shortcutListeners.add(listener)
        listener()
        return () => {
          shortcutListeners.delete(listener)
        }
      }, [])
      useEffect(() => {
        if (settings.status === 'loading') void loadSettings()
      }, [settings.status])

      function issueText(issue) {
        const keys = {
          reserved: 'settings.shortcut.issue.reserved',
          'unsupported-browser': 'settings.shortcut.issue.unsupported-browser',
          'modifier-required': 'settings.shortcut.issue.modifier-required',
          'unsupported-key': 'settings.shortcut.issue.unsupported-key',
        }
        const key = keys[issue]
        return key === undefined
          ? t('settings.shortcut.invalid', ZH['settings.shortcut.invalid'])
          : t(key, ZH[key])
      }

      function conflictText(ids) {
        const service = shortcutsService()
        const catalog = service === undefined ? undefined : service.catalog
        let labels = []
        if (catalog !== undefined && typeof catalog.getSnapshot === 'function') {
          try {
            const entries = catalog.getSnapshot()
            labels = (Array.isArray(entries) ? entries : [])
              .filter((entry) => entry !== null && ids.includes(entry.id) && typeof entry.label === 'string')
              .map((entry) => entry.label)
          } catch {
            labels = []
          }
        }
        const name = labels.length > 0 ? labels.join(' / ') : ids.join(' / ')
        return t('settings.shortcut.conflict', ZH['settings.shortcut.conflict']).replace('{name}', name)
      }

      function stopRecording() {
        setRecording(false)
        shortcutRecording = false
        const service = shortcutsService()
        if (service !== undefined && typeof service.recording === 'function') {
          Promise.resolve(service.recording(false)).catch(() => {})
        }
      }

      function startRecording() {
        const service = shortcutsService()
        if (service === undefined || typeof service.edit !== 'function') {
          setShortcutError(t('settings.shortcut.unsupported', ZH['settings.shortcut.unsupported']))
          return
        }
        setShortcutError(null)
        setRecording(true)
        shortcutRecording = true
        if (typeof service.recording === 'function') {
          Promise.resolve(service.recording(true)).catch(() => {})
        }
      }

      async function applyShortcut(binding) {
        const service = shortcutsService()
        if (service === undefined) return
        let described
        try {
          described = service.describeBinding(binding)
        } catch {
          setShortcutError(t('settings.shortcut.invalid', ZH['settings.shortcut.invalid']))
          return
        }
        if (described.issue !== null && described.issue !== undefined) {
          setShortcutError(issueText(described.issue))
          return
        }
        if (described.conflicts.length > 0) {
          setShortcutError(conflictText(described.conflicts))
          return
        }
        const revision = service.config.getSnapshot().revision
        const result = await service.edit({ type: 'set', id: SHORTCUT_ID, binding }, revision).catch(() => null)
        if (result !== null && result.status === 'saved') {
          stopRecording()
          setShortcutError(null)
          refreshShortcutInfo()
          return
        }
        const issue = result === null ? null : result.issue
        const conflicts = result === null || result.conflicts === undefined ? [] : result.conflicts
        if (issue !== null && issue !== undefined) setShortcutError(issueText(issue))
        else if (conflicts.length > 0) setShortcutError(conflictText(conflicts))
        else setShortcutError(t('settings.shortcut.failed', ZH['settings.shortcut.failed']))
      }

      async function resetShortcut() {
        const service = shortcutsService()
        if (service === undefined) return
        const revision = service.config.getSnapshot().revision
        const result = await service.edit({ type: 'reset', id: SHORTCUT_ID }, revision).catch(() => null)
        if (result !== null && result.status === 'saved') {
          setShortcutError(null)
          refreshShortcutInfo()
          return
        }
        setShortcutError(t('settings.shortcut.failed', ZH['settings.shortcut.failed']))
      }

      useEffect(() => {
        if (!recording) return undefined
        const onKeyDown = (event) => {
          event.preventDefault()
          event.stopPropagation()
          if (event.repeat === true) return
          if (event.key === 'Escape') {
            stopRecording()
            return
          }
          const binding = bindingFromEvent(event)
          if (binding === null) return
          if (Array.isArray(binding.modifiers) && binding.modifiers.length === 0) {
            setShortcutError(issueText('modifier-required'))
            return
          }
          void applyShortcut(binding)
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [recording])

      // 设置面板关掉时如果还在录制，把键盘交还给快捷键层。
      useEffect(() => () => {
        if (!shortcutRecording) return
        shortcutRecording = false
        const service = shortcutsService()
        if (service !== undefined && typeof service.recording === 'function') {
          Promise.resolve(service.recording(false)).catch(() => {})
        }
      }, [])

      async function commitSaveDir(value) {
        const next = typeof value === 'string' ? value.trim() : ''
        if (next === (settings.saveDir || settings.defaultSaveDir)) {
          setDraft(null)
          return
        }
        setBusy('saveDir')
        setError(null)
        const result = await patchSettings({ saveDir: next })
        setBusy(null)
        setDraft(null)
        if (!result.ok) {
          setError({
            scope: 'saveDir',
            text: result.error === 'not_absolute' || result.error === 'invalid'
              ? t('settings.save.notAbsolute', ZH['settings.save.notAbsolute'])
              : t('settings.save.failed', ZH['settings.save.failed']),
          })
        }
      }

      async function pickSaveDir() {
        const workspace = ctxRef === null ? undefined : ctxRef.get('uiWorkspace')
        if (workspace === undefined || typeof workspace.pickDirectory !== 'function') {
          setError({ scope: 'saveDir', text: t('settings.save.pickFailed', ZH['settings.save.pickFailed']) })
          return
        }
        setBusy('saveDir')
        setError(null)
        const picked = await workspace.pickDirectory().catch(() => null)
        if (picked === null || picked === undefined) {
          setBusy(null)
          return
        }
        const result = await patchSettings({ saveDir: picked })
        setBusy(null)
        setDraft(null)
        if (!result.ok) {
          setError({ scope: 'saveDir', text: t('settings.save.failed', ZH['settings.save.failed']) })
        }
      }

      async function resetSaveDir() {
        setBusy('saveDir')
        setError(null)
        const result = await patchSettings({ saveDir: '' })
        setBusy(null)
        setDraft(null)
        if (!result.ok) {
          setError({ scope: 'saveDir', text: t('settings.save.failed', ZH['settings.save.failed']) })
        }
      }

      async function toggleHide(next) {
        setBusy('hide')
        setError(null)
        const result = await patchSettings({ hideOnCapture: next })
        setBusy(null)
        if (!result.ok) {
          setError({ scope: 'hide', text: t('settings.hide.failed', ZH['settings.hide.failed']) })
        }
      }

      const saveDirValue = settings.saveDir || settings.defaultSaveDir
      const shownPath = draft === null ? saveDirValue : draft
      const keys = shortcut.unbound
        ? null
        : shortcut.keys.map((key, index) => h('kbd', { key: `${key}-${index}`, className: 'sp-set-key' }, key))
      const shortcutScopeError = shortcutError
      const saveDirError = error !== null && error.scope === 'saveDir' ? error.text : undefined
      const hideError = error !== null && error.scope === 'hide' ? error.text : undefined

      return h('div', { className: 'sp-set' },
        h('style', { key: 'css' }, SETTINGS_CSS),
        h(SettingsRow, {
          key: 'shortcut',
          title: t('settings.shortcut.title', ZH['settings.shortcut.title']),
          description: t('settings.shortcut.description', ZH['settings.shortcut.description']),
          error: shortcutScopeError,
        },
          recording
            ? [
              h('span', { key: 'hint', className: 'sp-set-recording' }, t('settings.shortcut.recording', ZH['settings.shortcut.recording'])),
              h('button', {
                key: 'cancel',
                type: 'button',
                className: 'sp-set-button',
                onClick: () => stopRecording(),
              }, t('settings.shortcut.cancel', ZH['settings.shortcut.cancel'])),
            ]
            : [
              keys === null || keys.length === 0
                ? h('span', { key: 'unbound', className: 'sp-set-unbound' }, shortcut.ready
                  ? t('settings.shortcut.unbound', ZH['settings.shortcut.unbound'])
                  : '…')
                : h('span', { key: 'keys', className: 'sp-set-keys' }, keys),
              h('button', {
                key: 'change',
                type: 'button',
                className: 'sp-set-button',
                onClick: () => startRecording(),
              }, t('settings.shortcut.change', ZH['settings.shortcut.change'])),
              shortcut.modified
                ? h('button', {
                  key: 'reset',
                  type: 'button',
                  className: 'sp-set-button ghost',
                  onClick: () => { void resetShortcut() },
                }, t('settings.shortcut.reset', ZH['settings.shortcut.reset']))
                : null,
            ],
        ),
        h(SettingsRow, {
          key: 'saveDir',
          title: t('settings.save.title', ZH['settings.save.title']),
          description: t('settings.save.description', ZH['settings.save.description']),
          error: saveDirError,
        },
          h('input', {
            key: 'input',
            className: 'sp-set-input',
            value: shownPath,
            spellCheck: false,
            disabled: busy === 'saveDir',
            title: shownPath,
            'aria-label': t('settings.save.title', ZH['settings.save.title']),
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void commitSaveDir(shownPath)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                setDraft(null)
              }
            },
            onBlur: () => {
              if (draft !== null) void commitSaveDir(draft)
            },
          }),
          h('button', {
            key: 'pick',
            type: 'button',
            className: 'sp-set-button',
            disabled: busy === 'saveDir',
            onClick: () => { void pickSaveDir() },
          }, t('settings.save.pick', ZH['settings.save.pick'])),
          h('button', {
            key: 'resetDir',
            type: 'button',
            className: 'sp-set-button ghost',
            disabled: busy === 'saveDir' || settings.settings.saveDir === '',
            onClick: () => { void resetSaveDir() },
          }, t('settings.save.reset', ZH['settings.save.reset'])),
        ),
        h(SettingsRow, {
          key: 'hide',
          title: t('settings.hide.title', ZH['settings.hide.title']),
          description: t('settings.hide.description', ZH['settings.hide.description']),
          error: hideError,
        },
          h(SettingsSwitch, {
            key: 'switch',
            checked: settings.settings.hideOnCapture !== false,
            disabled: busy === 'hide',
            label: t('settings.hide.title', ZH['settings.hide.title']),
            onChange: (next) => { void toggleHide(next) },
          }),
        ),
        h('div', { key: 'foot', className: 'sp-set-foot' },
          settings.status === 'failed'
            ? t('settings.loadFailed', ZH['settings.loadFailed'])
            : t('settings.footer', ZH['settings.footer'])),
      )
    }

    const SETTINGS_CSS = `
      .sp-set {
        display: flex;
        flex-direction: column;
        width: 100%;
        padding-top: 4px;
      }
      .sp-set-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 12px 24px;
        padding: 16px 0;
        border-bottom: .5px solid var(--dsw-alias-border-l2);
      }
      .sp-set-text {
        flex: 1 1 220px;
        min-width: 0;
      }
      .sp-set-title {
        font-size: 14px;
        line-height: 20px;
        color: var(--dsw-alias-label-primary);
      }
      .sp-set-desc {
        margin-top: 4px;
        font-size: 12px;
        line-height: 18px;
        color: var(--dsw-alias-label-secondary);
      }
      .sp-set-error {
        margin-top: 4px;
        font-size: 12px;
        line-height: 18px;
        color: var(--dsw-alias-state-error-primary);
      }
      .sp-set-control {
        display: flex;
        flex-wrap: wrap;
        flex: 0 1 auto;
        align-items: center;
        justify-content: flex-end;
        gap: 8px;
        max-width: 100%;
        margin-left: auto;
      }
      .sp-set-keys {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      .sp-set-key {
        display: inline-grid;
        place-items: center;
        box-sizing: border-box;
        min-width: 22px;
        height: 22px;
        padding: 0 5px;
        border: .5px solid var(--dsw-alias-border-l2);
        border-radius: 5px;
        background: var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-2));
        color: var(--dsw-alias-label-secondary);
        font: inherit;
        font-size: 11px;
        line-height: 1;
      }
      .sp-set-unbound,
      .sp-set-recording {
        font-size: 12px;
        color: var(--dsw-alias-label-secondary);
      }
      .sp-set-recording { color: var(--dsw-alias-brand-primary); }
      .sp-set-button {
        height: 28px;
        padding: 0 10px;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: var(--dsw-alias-label-primary);
        font: inherit;
        font-size: 12px;
        cursor: pointer;
      }
      .sp-set-button:hover:not(:disabled) {
        background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
      }
      .sp-set-button.ghost { color: var(--dsw-alias-label-secondary); }
      .sp-set-button:disabled { opacity: .5; cursor: default; }
      .sp-set-input {
        box-sizing: border-box;
        flex: 1 1 150px;
        width: 200px;
        min-width: 120px;
        max-width: 100%;
        height: 28px;
        padding: 0 8px;
        border: .5px solid var(--dsw-alias-border-l2);
        border-radius: 6px;
        background: transparent;
        color: var(--dsw-alias-label-primary);
        font: inherit;
        font-size: 12px;
      }
      .sp-set-input:focus-visible,
      .sp-set-button:focus-visible,
      .sp-set-switch:focus-visible {
        outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary));
        outline-offset: 1px;
      }
      .sp-set-switch {
        position: relative;
        flex: none;
        width: 32px;
        height: 20px;
        padding: 0;
        border: none;
        border-radius: 999px;
        background: var(--dsw-alias-state-idle-primary, rgba(128, 128, 128, .45));
        cursor: pointer;
        transition: background-color .12s ease;
      }
      .sp-set-switch.on { background: var(--dsw-alias-brand-primary); }
      .sp-set-switch:disabled { opacity: .5; cursor: default; }
      .sp-set-knob {
        position: absolute;
        top: 2px;
        left: 2px;
        width: 16px;
        height: 16px;
        border-radius: 999px;
        background: #fff;
        box-shadow: 0 1px 2px rgba(0, 0, 0, .25);
        transition: transform .12s ease;
      }
      .sp-set-switch.on .sp-set-knob { transform: translateX(12px); }
      .sp-set-foot {
        padding: 14px 0 4px;
        font-size: 12px;
        line-height: 18px;
        color: var(--dsw-alias-label-secondary);
      }
    `

    /** 当前设备是否是 macOS 键盘（决定快捷键显示成 ⌘ 还是 Ctrl）。 */
    function isMacKeyboard() {
      const dataset = typeof document === 'undefined' ? undefined : document.documentElement.dataset.platform
      const name = dataset !== undefined ? dataset : typeof navigator === 'undefined' ? '' : navigator.platform
      return /darwin|mac|iphone|ipad/iu.test(String(name || ''))
    }

    function wait(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms))
    }

    function fileName() {
      const now = new Date()
      const pad = (value) => String(value).padStart(2, '0')
      return `screenshot-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`
    }

    const ALL_MODES = ['region', 'window', 'screen']
    /** 预览的缩放范围：25% ~ 400%，100% = 整张图刚好放得下。 */
    const MIN_ZOOM = 0.25
    const MAX_ZOOM = 4
    const EMPTY_INPUT = { attachmentIds: [] }

    /**
     * 把当前草稿里的图片附件解析成预览 URL 列表（顺序即 rail 里的顺序）。
     * @param {unknown} ids 草稿附件 id 列表。
     * @returns {string[]} 图片的 blob 预览地址；解析不了时返回空数组。
     */
    function draftImageUrls(ids) {
      if (!Array.isArray(ids) || ids.length === 0) return []
      const conversation = ctxRef === null ? undefined : ctxRef.get('conversation')
      if (conversation === undefined || typeof conversation.resolveDraftAttachments !== 'function') return []
      try {
        return conversation
          .resolveDraftAttachments(ids)
          .filter((attachment) => attachment && attachment.kind === 'image' && typeof attachment.previewUrl === 'string')
          .map((attachment) => attachment.previewUrl)
      } catch {
        return []
      }
    }
    // 当前平台能干什么：/probe 回来之前先乐观地假设三种都能用。
    let capabilities = { supported: true, modes: ALL_MODES }
    const capabilityListeners = new Set()
    function publishCapabilities(next) {
      capabilities = next
      for (const listener of capabilityListeners) listener()
    }
    let inFlight = false
    // 「自动让开」的权限提示只在本次页面会话里说一次。
    let autoHideHintShown = false
    // 当前渲染中的 composer 属于哪个会话，供快捷键定位目标。
    let currentSessionId
    // 快捷键触发时把菜单收掉（由组件挂载时注入）。
    let closeMenu = null
    // 根 ctx，供按钮里的截图流程取 conversation 服务；apply 时赋值。
    let ctxRef = null

    /** 最近一次「点空白关掉预览」的时间：同一手势的 click 不该再打开它。 */
    let closedByBackdrop = 0

    // ---- 设置与快捷键：Host 持久化，这里只留一份给界面读的缓存 --------------

    /** 快捷键命令 id；改名等于丢掉用户已有的绑定，所以保持不变。 */
    const SHORTCUT_ID = 'screenshot-picker.capture'
    const DEFAULT_PLUGIN_SETTINGS = { saveDir: '', hideOnCapture: true }
    /** status: loading | ready | failed */
    let settingsState = {
      status: 'loading',
      settings: { ...DEFAULT_PLUGIN_SETTINGS },
      saveDir: '',
      defaultSaveDir: '',
    }
    const settingsListeners = new Set()
    function publishSettings(patch) {
      settingsState = { ...settingsState, ...patch }
      for (const listener of settingsListeners) listener()
    }

    /** 快捷键的当前绑定；keys 是已经本地化好的键帽。 */
    let shortcutInfo = { ready: false, keys: [], label: '', modified: false, unbound: true, issue: null, conflicts: [] }
    const shortcutListeners = new Set()
    /** 设置页录制新组合键期间，别让旧快捷键把截图流程点着。 */
    let shortcutRecording = false
    function shortcutsService() {
      return ctxRef === null ? undefined : ctxRef.get('shortcuts')
    }

    /**
     * 从 shortcuts 服务里读本插件这条命令的生效绑定。
     * 服务缺席（比如纯浏览器环境没有键盘桥）时返回 ready:false。
     * @returns {typeof shortcutInfo} 最新绑定。
     */
    function readShortcutInfo() {
      const service = shortcutsService()
      const catalog = service === undefined ? undefined : service.catalog
      if (catalog === undefined || catalog === null || typeof catalog.getSnapshot !== 'function') {
        return { ...shortcutInfo, ready: false }
      }
      let entries
      try {
        entries = catalog.getSnapshot()
      } catch {
        return { ...shortcutInfo, ready: true }
      }
      const entry = Array.isArray(entries) ? entries.find((item) => item !== null && item.id === SHORTCUT_ID) : undefined
      if (entry === undefined) {
        return { ready: true, keys: [], label: '', modified: false, unbound: true, issue: null, conflicts: [] }
      }
      return {
        ready: true,
        keys: Array.isArray(entry.keys) ? entry.keys : [],
        label: typeof entry.label === 'string' ? entry.label : '',
        modified: entry.modified === true,
        unbound: entry.binding === null || entry.binding === undefined,
        issue: entry.issue === undefined ? null : entry.issue,
        conflicts: Array.isArray(entry.conflicts) ? entry.conflicts : [],
      }
    }

    function refreshShortcutInfo() {
      shortcutInfo = readShortcutInfo()
      for (const listener of shortcutListeners) listener()
    }

    /** 菜单与提示里显示的快捷键文本；没绑定时是空串。 */
    function shortcutKeysText() {
      if (!shortcutInfo.ready || shortcutInfo.unbound || shortcutInfo.keys.length === 0) return ''
      return shortcutInfo.keys.join(' ')
    }

    /** 键盘事件 -> 快捷键绑定；只按下修饰键时返回 null。 */
    function bindingFromEvent(event) {
      const modifierCodes = ['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'CapsLock', 'Fn', 'FnLock']
      if (typeof event.code !== 'string' || event.code === '' || modifierCodes.includes(event.code)) return null
      const modifiers = []
      if (isMacKeyboard()) {
        if (event.metaKey) modifiers.push('meta')
        if (event.ctrlKey) modifiers.push('control')
      } else {
        if (event.ctrlKey) modifiers.push('control')
        if (event.metaKey) modifiers.push('meta')
      }
      if (event.altKey) modifiers.push('alt')
      if (event.shiftKey) modifiers.push('shift')
      if (modifiers.length === 0) return { code: event.code, modifiers: [], invalid: 'modifier-required' }
      return { code: event.code, modifiers }
    }

    function readJson(response) {
      return response.json().catch(() => null)
    }

    function openPrivacySettings(pane) {
      fetch(API + '/settings-screen', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pane }),
      }).catch(() => {})
    }

    /**
     * 把一张截图交给 Host 落盘。
     * @param {Blob} blob PNG 数据。
     * @param {string} name 建议的文件名。
     * @returns {Promise<{path:string,dir:string,name:string}|null>} 落盘结果，失败为 null。
     */
    async function uploadShot(blob, name) {
      try {
        const response = await fetch(`${API}/save?name=${encodeURIComponent(name)}`, {
          method: 'POST',
          headers: { 'content-type': 'image/png' },
          body: blob,
        })
        const payload = await readJson(response)
        return payload !== null && payload.ok === true ? payload : null
      } catch {
        return null
      }
    }

    /** 在 Finder / 资源管理器里定位刚保存的文件。 */
    function revealSaved(path) {
      fetch(API + '/reveal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path }),
      }).catch(() => {})
    }

    /** 保存成功后的轻提示：带上路径和「显示」入口。 */
    function announceSaved(payload) {
      const text = t('save.done', ZH['save.done']).replace('{path}', payload.path)
      showToast(text, { label: t('save.reveal', ZH['save.reveal']), run: () => revealSaved(payload.path) })
    }

    /** 读一次 Host 设置。 */
    async function loadSettings() {
      const payload = await fetch(API + '/settings').then(readJson).catch(() => null)
      if (payload === null || payload.ok !== true) {
        publishSettings({ status: 'failed' })
        return
      }
      publishSettings({
        status: 'ready',
        settings: {
          saveDir: typeof payload.settings?.saveDir === 'string' ? payload.settings.saveDir : '',
          hideOnCapture: payload.settings?.hideOnCapture !== false,
        },
        saveDir: typeof payload.saveDir === 'string' ? payload.saveDir : '',
        defaultSaveDir: typeof payload.defaultSaveDir === 'string' ? payload.defaultSaveDir : '',
      })
    }

    /**
     * 改设置并等 Host 确认。
     * @param {{saveDir?:string, hideOnCapture?:boolean}} patch 要改的字段。
     * @returns {Promise<{ok:boolean, error?:string}>} Host 的应答。
     */
    async function patchSettings(patch) {
      const payload = await fetch(API + '/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      }).then(readJson).catch(() => null)
      if (payload === null) return { ok: false, error: 'network' }
      if (payload.ok !== true) return { ok: false, error: typeof payload.error === 'string' ? payload.error : 'failed' }
      publishSettings({
        status: 'ready',
        settings: {
          saveDir: typeof payload.settings?.saveDir === 'string' ? payload.settings.saveDir : settingsState.settings.saveDir,
          hideOnCapture: payload.settings?.hideOnCapture !== false,
        },
        saveDir: typeof payload.saveDir === 'string' ? payload.saveDir : settingsState.saveDir,
      })
      return { ok: true }
    }

    function fail(code) {
      if (code === 'cancelled') return
      if (code === 'busy') {
        showToast(t('error.busy', ZH['error.busy']))
        return
      }
      if (code === 'permission') {
        showToast(t('error.permission', ZH['error.permission']), {
          label: t('error.permission.action', ZH['error.permission.action']),
          run: () => openPrivacySettings('screen'),
        })
        return
      }
      if (code === 'unsupported') {
        showToast(t('error.unsupported', ZH['error.unsupported']))
        return
      }
      if (code === 'hidden') {
        showToast(t('error.hidden', ZH['error.hidden']))
        return
      }
      showToast(t('error.capture', ZH['error.capture']))
    }

    /** 把截到的图片登记成草稿附件，并挂到当前输入框。 */
    function attach(ctx, sessionId, file) {
      const conversation = ctx.get('conversation')
      const handle = handles.get(sessionId)
      if (conversation === undefined || handle === undefined) {
        showToast(t('error.composer', ZH['error.composer']))
        return
      }
      let drafts
      try {
        drafts = conversation.createDrafts(sessionId, [file])
      } catch {
        showToast(t('error.image', ZH['error.image']))
        return
      }
      const ids = drafts.map((draft) => draft.id)
      for (const id of ids) rememberOwnDraft(id)
      const added = handle.inputActions.addAttachments(ids)
      if (added === false) {
        try {
          conversation.releaseDraftAttachments(drafts)
        } catch {
          // 释放失败不影响提示。
        }
        showToast(t('error.composer', ZH['error.composer']))
      }
    }

    /**
     * 跑一次截图。
     * @param {object} ctx 客户端根 ctx。
     * @param {string|undefined} sessionId 目标会话；框选模式允许没有会话（只存盘）。
     * @param {'region'|'window'|'screen'} mode 截图方式。
     * @param {number} [windowId] 窗口号。
     */
    async function startCapture(ctx, sessionId, mode, windowId) {
      if (inFlight) return
      const attachable = sessionId !== undefined && handles.get(sessionId) !== undefined
      // 窗口 / 整屏只有一条路：直接进草稿。没有输入框就没必要截。
      if (!attachable && mode !== 'region') {
        showToast(t('error.composer', ZH['error.composer']))
        return
      }
      inFlight = true
      try {
        await wait(MENU_SETTLE_MS)
        const body = {
          mode,
          ...(windowId === undefined ? {} : { windowId }),
          hideShell: settingsState.settings.hideOnCapture !== false,
        }
        const response = await fetch(API + '/capture', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }).catch(() => null)
        if (response === null) {
          showToast(t('error.network', ZH['error.network']))
          return
        }
        const payload = await readJson(response)
        if (payload === null || payload.ok !== true) {
          fail(payload === null ? 'capture_failed' : payload.error)
          return
        }
        if (payload.hideError === 'permission' && !autoHideHintShown) {
          autoHideHintShown = true
          showToast(t('hint.autoHide', ZH['hint.autoHide']), {
            label: t('error.permission.action', ZH['error.permission.action']),
            run: () => openPrivacySettings('accessibility'),
          })
        }
        const image = await fetch(API + '/image/' + encodeURIComponent(String(payload.id))).catch(() => null)
        if (image === null || !image.ok) {
          showToast(t('error.image', ZH['error.image']))
          return
        }
        const blob = await image.blob().catch(() => null)
        if (blob === null || blob.size === 0) {
          showToast(t('error.image', ZH['error.image']))
          return
        }
        if (mode === 'region') {
          publishReview({ url: URL.createObjectURL(blob), blob, sessionId: attachable ? sessionId : undefined })
          return
        }
        const file = new File([blob], fileName(), { type: 'image/png' })
        attach(ctx, sessionId, file)
      } finally {
        inFlight = false
      }
    }

    /** 工具栏上的截图按钮：点开是「框选 / 窗口 / 整屏」三项。 */
    function ScreenshotControls(props) {
      const sessionId = props && props.sessionId
      const inputActions = props && props.inputActions
      const [busy, setBusy] = useState(false)
      const [menu, setMenu] = useState(null)
      const [hoverWindow, setHoverWindow] = useState(null)
      const [hoverAnchor, setHoverAnchor] = useState(null)
      const [preview, setPreview] = useState(null)
      const [caps, setCaps] = useState(capabilities)
      const [shortcut, setShortcut] = useState(shortcutInfo)
      // 记住点击时刻的指针位置：列表可能在指针正下方出现，此时不会触发 mouseenter。
      const pointerRef = useRef({ x: 0, y: 0 })
      const thumbCache = useRef(new Map())
      const buttonRef = useRef(null)
      const popoverRef = useRef(null)
      const useInput = props && typeof props.useInput === 'function' ? props.useInput : (select) => select(EMPTY_INPUT)
      const attachmentIds = useInput((state) => state.attachmentIds)
      const attachmentIdsRef = useRef(attachmentIds)
      attachmentIdsRef.current = attachmentIds
      useEffect(() => {
        const listener = () => setCaps(capabilities)
        capabilityListeners.add(listener)
        listener()
        return () => {
          capabilityListeners.delete(listener)
        }
      }, [])

      useEffect(() => {
        const listener = () => setShortcut(shortcutInfo)
        shortcutListeners.add(listener)
        listener()
        return () => {
          shortcutListeners.delete(listener)
        }
      }, [])

      // 点草稿缩略图打开自己的预览（单张截图也接管，内置 ImageLightbox 没有保存按钮）。
      // 关键：只认「指针下面真的压着这张图」。早先版本向上找 img，结果点输入框、
      // 点预览里的按钮、点缩略图上的删除叉都会命中祖先里的图，把点击吞掉。
      useEffect(() => {
        const onClick = (event) => {
          const target = event.target
          if (!(target instanceof Element)) return
          // 刚点空白关掉预览时，同一手势产生的 click 不能再把它打开。
          if (Date.now() - closedByBackdrop < 400) return
          // 自己的浮层开着时不再接管，否则按钮会被这里拦掉。
          if (gallery !== null || review !== null) return
          if (typeof target.closest === 'function' && target.closest('.sp-shot-gallery, .sp-shot-review') !== null) return
          const ids = Array.isArray(attachmentIdsRef.current) ? attachmentIdsRef.current : []
          const urls = draftImageUrls(ids)
          if (urls.length === 0) return
          const ours = ids.some((id) => ownDraftIds.has(id))
          if (urls.length < 2 && !(urls.length === 1 && ours)) return

          const x = typeof event.clientX === 'number' ? event.clientX : Number.NaN
          const y = typeof event.clientY === 'number' ? event.clientY : Number.NaN
          const hasPoint = Number.isFinite(x) && Number.isFinite(y) && (x !== 0 || y !== 0)
            && typeof document.elementFromPoint === 'function'
          let image = null
          if (hasPoint) {
            // 只取指针处最上层的元素：缩略图上的删除叉在它上面，因此不会误判。
            const hit = document.elementFromPoint(x, y)
            // 指针下是预览 / 确认框自己的内容，一律不接管。
            if (hit instanceof Element && typeof hit.closest === 'function'
              && hit.closest('.sp-shot-gallery, .sp-shot-review') !== null) return
            if (hit instanceof HTMLImageElement) image = hit
            else if (hit instanceof Element) {
              const nested = hit.querySelector('img')
              if (nested instanceof HTMLImageElement) image = nested
            }
          } else {
            // 键盘触发的 click 没有坐标，退回目标元素自身。
            const candidate = target instanceof HTMLImageElement ? target : target.querySelector('img')
            if (candidate instanceof HTMLImageElement) image = candidate
          }
          if (image === null || !urls.includes(image.src)) return
          event.preventDefault()
          event.stopPropagation()
          publishGallery({ urls, index: urls.indexOf(image.src) })
        }
        document.addEventListener('click', onClick, true)
        return () => {
          document.removeEventListener('click', onClick, true)
        }
      }, [])

      useEffect(() => {
        closeMenu = () => setMenu(null)
        return () => {
          closeMenu = null
        }
      }, [])

      useEffect(() => {
        if (sessionId === undefined) return undefined
        currentSessionId = sessionId
        return () => {
          if (currentSessionId === sessionId) currentSessionId = undefined
        }
      }, [sessionId])

      useEffect(() => {
        if (sessionId === undefined || inputActions === undefined) return undefined
        handles.set(sessionId, { inputActions })
        return () => {
          const current = handles.get(sessionId)
          if (current !== undefined && current.inputActions === inputActions) handles.delete(sessionId)
        }
      }, [sessionId, inputActions])

      // 悬停某个窗口时拉一张缩略图；带 120ms 防抖和内存缓存。
      useEffect(() => {
        if (hoverWindow === null) {
          setPreview(null)
          setHoverAnchor(null)
          return undefined
        }
        const cached = thumbCache.current.get(hoverWindow)
        if (cached !== undefined) {
          setPreview({ id: hoverWindow, url: cached })
          return undefined
        }
        setPreview({ id: hoverWindow })
        let cancelled = false
        const timer = setTimeout(() => {
          fetch(API + '/thumbnail?id=' + encodeURIComponent(String(hoverWindow)))
            .then((response) => (response.ok ? response.blob() : null))
            .then((blob) => {
              if (cancelled) return
              if (blob === null || blob.size === 0) {
                setPreview({ id: hoverWindow, failed: true })
                return
              }
              const url = URL.createObjectURL(blob)
              thumbCache.current.set(hoverWindow, url)
              setPreview({ id: hoverWindow, url })
            })
            .catch(() => {})
        }, 120)
        return () => {
          cancelled = true
          clearTimeout(timer)
        }
      }, [hoverWindow])

      // 卸载时释放缩略图的 object URL。
      useEffect(() => () => {
        for (const url of thumbCache.current.values()) URL.revokeObjectURL(url)
        thumbCache.current.clear()
      }, [])

      // 列表出现在静止的指针下方时，浏览器不会补发 mouseenter，
      // 所以渲染完成后主动探测指针下的行，把它当成悬停。
      useEffect(() => {
        if (menu === null || menu.view !== 'windows' || menu.loading === true) return
        if (menu.windows.length === 0) return
        const { x, y } = pointerRef.current
        if (!(x > 0 && y > 0)) return
        const element = document.elementFromPoint(x, y)
        const row = element instanceof Element ? element.closest('[data-window-id]') : null
        if (!(row instanceof HTMLElement)) return
        const id = Number(row.dataset.windowId)
        if (!Number.isInteger(id)) return
        const rect = row.getBoundingClientRect()
        setHoverAnchor({ top: rect.top, height: rect.height })
        setHoverWindow(id)
      }, [menu === null ? null : menu.view, menu === null ? null : menu.loading, menu === null ? 0 : menu.windows.length])

      useEffect(() => {
        if (menu === null) return undefined
        const onPointerDown = (event) => {
          const target = event.target
          if (popoverRef.current !== null && popoverRef.current.contains(target)) return
          if (buttonRef.current !== null && buttonRef.current.contains(target)) return
          setHoverWindow(null)
          setMenu(null)
        }
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          setHoverWindow(null)
          setMenu(null)
        }
        document.addEventListener('mousedown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('mousedown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [menu === null])

      if (sessionId === undefined || inputActions === undefined) return null

      const run = (mode, windowId) => {
        if (busy) return
        if (!caps.modes.includes(mode)) {
          showToast(t('error.unsupported', ZH['error.unsupported']))
          return
        }
        setMenu(null)
        setHoverWindow(null)
        setBusy(true)
        startCapture(ctxRef, sessionId, mode, windowId)
          .catch(() => {
            showToast(t('error.capture', ZH['error.capture']))
          })
          .finally(() => setBusy(false))
      }

      const toggleMenu = (event) => {
        if (busy) return
        if (menu !== null) {
          setHoverWindow(null)
          setMenu(null)
          return
        }
        if (event !== undefined && typeof event.clientX === 'number') {
          pointerRef.current = { x: event.clientX, y: event.clientY }
        }
        const rect = buttonRef.current === null ? null : buttonRef.current.getBoundingClientRect()
        const left = rect === null ? 12 : Math.min(Math.max(8, rect.left - 4), Math.max(8, window.innerWidth - 336))
        const bottom = rect === null ? 120 : window.innerHeight - rect.top + 8
        setMenu({ view: 'menu', left, bottom, loading: false, windows: [], failed: false })
      }

      const showWindows = (event) => {
        if (event !== undefined && typeof event.clientX === 'number') {
          pointerRef.current = { x: event.clientX, y: event.clientY }
        }
        setHoverWindow(null)
        setMenu((previous) => previous === null
          ? previous
          : { ...previous, view: 'windows', loading: true, windows: [], failed: false })
        fetch(API + '/windows')
          .then(readJson)
          .then((payload) => {
            const ok = payload !== null && payload.ok === true && Array.isArray(payload.windows)
            setMenu((previous) => previous === null || previous.view !== 'windows'
              ? previous
              : { ...previous, loading: false, windows: ok ? payload.windows : [], failed: ok ? false : true })
          })
          .catch(() => {
            setMenu((previous) => previous === null || previous.view !== 'windows'
              ? previous
              : { ...previous, loading: false, windows: [], failed: true })
          })
      }

      const menuRow = (key, icon, label, onClick, keys, keysTitle) => h('button', {
        key,
        type: 'button',
        role: 'menuitem',
        className: 'sp-shot-menu-row',
        onClick,
      },
        h('span', { key: 'icon', className: 'sp-shot-menu-icon' }, icon),
        h('span', { key: 'label' }, label),
        keys === undefined ? null : h('span', { key: 'keys', className: 'sp-shot-menu-keys', title: keysTitle }, keys),
      )

      const windowRows = menu === null || menu.view !== 'windows'
        ? null
        : menu.loading
          ? h('div', { key: 'loading', className: 'sp-shot-pop-empty' }, t('picker.loading', ZH['picker.loading']))
          : menu.windows.length === 0
            ? h('div', { key: 'empty', className: 'sp-shot-pop-empty' },
              menu.failed === true
                ? t('picker.failed', ZH['picker.failed'])
                : t('picker.empty', ZH['picker.empty']))
            : h('div', { key: 'list', className: 'sp-shot-pop-list' },
              menu.windows.map((item) => h('button', {
                key: String(item.id),
                type: 'button',
                className: 'sp-shot-pop-row',
                'data-window-id': String(item.id),
                title: item.title || item.app,
                onMouseEnter: (event) => {
                  const rect = event.currentTarget.getBoundingClientRect()
                  setHoverAnchor({ top: rect.top, height: rect.height })
                  setHoverWindow(item.id)
                },
                onMouseLeave: () => setHoverWindow(null),
                onFocus: (event) => {
                  const rect = event.currentTarget.getBoundingClientRect()
                  setHoverAnchor({ top: rect.top, height: rect.height })
                  setHoverWindow(item.id)
                },
                onBlur: () => setHoverWindow(null),
                onClick: () => run('window', item.id),
              },
                h('span', { key: 'title', className: 'sp-shot-pop-title' }, item.title || t('picker.untitled', ZH['picker.untitled'])),
                h('span', { key: 'size', className: 'sp-shot-pop-size' }, `${item.w}x${item.h}`),
                h('span', { key: 'app', className: 'sp-shot-pop-app' }, item.app || t('picker.unknownApp', ZH['picker.unknownApp'])),
              )))

      return h(React.Fragment, null,
        h('span', { key: 'group', className: 'sp-shot-group' },
        h('style', { key: 'css' }, BUTTON_CSS),
        h('button', {
          key: 'button',
          ref: buttonRef,
          type: 'button',
          className: 'sp-shot-button',
          'data-busy': busy,
          'aria-haspopup': 'menu',
          'aria-expanded': menu !== null,
          title: shortcutKeysText() === ''
            ? t('menu.hint', ZH['menu.hint'])
            : t('menu.hintKeys', ZH['menu.hintKeys']).replace('{keys}', shortcutKeysText()),
          'aria-label': t('menu.label', ZH['menu.label']),
          disabled: busy || !caps.supported,
          onClick: toggleMenu,
        }, h(CameraIcon, { size: 16 })),
        ),
        menu === null ? null : createPortal(h('div', {
          key: 'popover',
          ref: popoverRef,
          className: 'sp-shot-pop',
          role: 'menu',
          style: { left: menu.left, bottom: menu.bottom, width: menu.view === 'windows' ? 320 : 152 },
          // 键盘走到菜单里：上下键换行，回车触发、Esc 关闭由行内按钮和菜单监听负责。
          onKeyDown: (event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return
            const rows = popoverRef.current === null
              ? []
              : Array.from(popoverRef.current.querySelectorAll('[role="menuitem"], .sp-shot-pop-row'))
            if (rows.length === 0) return
            event.preventDefault()
            const at = rows.indexOf(document.activeElement)
            const next = event.key === 'ArrowDown'
              ? (at < 0 ? 0 : (at + 1) % rows.length)
              : event.key === 'ArrowUp'
                ? (at < 0 ? rows.length - 1 : (at - 1 + rows.length) % rows.length)
                : event.key === 'Home' ? 0 : rows.length - 1
            const target = rows[next]
            if (target instanceof HTMLElement) target.focus()
          },
        },
          menu.view === 'menu'
            ? [
              caps.modes.includes('region')
                ? menuRow('region', h(CameraIcon, { size: 16 }), t('menu.region', ZH['menu.region']), () => run('region'))
                : null,
              caps.modes.includes('window')
                ? menuRow('window', h(WindowIcon, { size: 16 }), t('menu.window', ZH['menu.window']), showWindows)
                : null,
              caps.modes.includes('screen')
                ? menuRow('screen', h(MonitorIcon, { size: 16 }), t('menu.screen', ZH['menu.screen']), () => run('screen'), shortcut.unbound ? undefined : shortcutKeysText(), shortcut.label)
                : null,
            ].filter((row) => row !== null)
            : [
              h('div', { key: 'head', className: 'sp-shot-pop-head' },
                h('button', {
                  key: 'back',
                  type: 'button',
                  className: 'sp-shot-back',
                  title: t('picker.back', ZH['picker.back']),
                  'aria-label': t('picker.back', ZH['picker.back']),
                  onClick: () => {
                    setHoverWindow(null)
                    setMenu((previous) => previous === null ? previous : { ...previous, view: 'menu' })
                  },
                }, h(BackIcon, { size: 16 })),
                h('span', { key: 'title' }, t('picker.title', ZH['picker.title'])),
              ),
              windowRows,
              h('button', {
                key: 'fallback',
                type: 'button',
                className: 'sp-shot-pop-fallback',
                onClick: () => run('window'),
              }, t('picker.fallback', ZH['picker.fallback'])),
            ],
        ), document.body),
        menu === null || menu.view !== 'windows' || preview === null ? null : createPortal(h('div', {
          key: 'preview',
          className: 'sp-shot-preview',
          style: {
            left: menu.left + 320 + 12 + 340 > window.innerWidth
              ? Math.max(8, menu.left - 12 - 340)
              : menu.left + 320 + 12,
            top: hoverAnchor === null
              ? window.innerHeight - menu.bottom - 116
              : Math.min(Math.max(hoverAnchor.top + hoverAnchor.height / 2, 132), window.innerHeight - 132),
            transform: 'translateY(-50%)',
          },
        },
          preview.url === undefined
            ? h('span', { key: 'empty', className: 'sp-shot-preview-empty' },
              preview.failed === true
                ? t('picker.previewUnavailable', ZH['picker.previewUnavailable'])
                : t('picker.previewLoading', ZH['picker.previewLoading']))
            : h('img', { key: 'img', src: preview.url, alt: '' }),
        ), document.body),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctxRef = ctx
        try {
          if (ctx.locale && typeof ctx.locale.register === 'function') {
            ctx.locale.register(NS, 'zh', ZH)
            ctx.locale.register(NS, 'en', EN)
          }
          if (ctx.locale && typeof ctx.locale.bind === 'function') {
            translate = ctx.locale.bind(NS)
          }
        } catch {
          translate = null
        }

        fetch(API + '/probe')
          .then(readJson)
          .then((payload) => {
            if (!payload || payload.ok !== true) return
            const modes = Array.isArray(payload.modes)
              ? payload.modes.filter((mode) => ALL_MODES.includes(mode))
              : ALL_MODES
            publishCapabilities({ supported: payload.supported !== false && modes.length > 0, modes })
          })
          .catch(() => {})

        // 界面先拿到当前设置；菜单发送截图时会带上 hideShell。
        void loadSettings()

        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'screenshot-picker-button',
          order: 0,
        }, ScreenshotControls))

        // 设置 › 截图：一页三个偏好，导航里带相机图标。
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'screenshot',
          order: 40,
          label: () => t('settings.nav', ZH['settings.nav']),
          locale: NS,
        }, SettingsSection))

        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon',
          id: 'screenshot',
        }, function ScreenshotSectionIcon(props) {
          return h(CameraIcon, { size: props && Number.isFinite(props.size) ? props.size : 16 })
        }))

        // 插件管理里的这一行也挂同一个页面（没有描述文本时，摘要留空）。
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: '@joythatway/dsh-screenshot#dsh-screenshot',
        }, function ScreenshotPluginConfig(props) {
          if (props && props.view === 'summary') return null
          return h(SettingsSection, {})
        }))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'screenshot-picker-toast',
          order: 900,
        }, ToastHost))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'screenshot-picker-review',
          order: 901,
        }, ReviewHost))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'screenshot-picker-gallery',
          order: 902,
        }, GalleryHost))

        // 截图快捷键，默认 Control+Shift+S（Windows/Linux 相同）。
        // 走可编辑命令注册：桌面端由原生键盘桥在任何输入区里都能触发，
        // 绑定存在 DSH 自己的 keybindings 里，设置页通过 shortcuts.edit 改。
        ctx.inject(['shortcuts'], (scope) => {
          const shortcuts = scope.shortcuts
          if (shortcuts === undefined || typeof shortcuts.register !== 'function') return
          const catalog = shortcuts.catalog
          if (catalog !== undefined && typeof catalog.subscribe === 'function') {
            scope.effect(() => {
              const off = catalog.subscribe(() => refreshShortcutInfo())
              refreshShortcutInfo()
              return () => { off() }
            }, 'screenshot-picker: shortcut catalog')
          }
          scope.effect(() => {
            try {
              return shortcuts.register({
                id: SHORTCUT_ID,
                label: () => t('menu.label', ZH['menu.label']),
                aliases: ['screenshot', 'capture', 'snip'],
                // 只认桌面壳：Control+Shift+S 在 Web 端不属于允许的浏览器组合，
                // 一并声明会让整次注册失败，所以纯浏览器打开时这条快捷键不绑定。
                defaults: {
                  'desktop:macos': { code: 'KeyS', modifiers: ['control', 'shift'] },
                  'desktop:windows': { code: 'KeyS', modifiers: ['control', 'shift'] },
                  'desktop:linux': { code: 'KeyS', modifiers: ['control', 'shift'] },
                },
                regions: ['page', 'editable', 'terminal'],
                modals: [],
                // 按下就是一次整屏截图（和菜单里的「整屏截图」完全等价），
                // 不经过菜单：快捷键要的是「按了就有图」。
                resolve: () => {
                  if (shortcutRecording) return { status: 'pass' }
                  if (!capabilities.modes.includes('screen')) return { status: 'pass' }
                  const target = currentSessionId
                  if (target === undefined || handles.get(target) === undefined) return { status: 'pass' }
                  return {
                    status: 'handled',
                    run: () => {
                      if (closeMenu !== null) closeMenu()
                      startCapture(ctxRef, target, 'screen').catch(() => {
                        showToast(t('error.capture', ZH['error.capture']))
                      })
                    },
                  }
                },
              })
            } catch {
              // 组合被占用时静默放弃，不影响截图按钮本身。
              return () => {}
            }
          }, 'screenshot-picker: capture shortcut')
        })
      },
    }
  },
})
