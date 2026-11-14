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
    const h = React.createElement
    const { useEffect, useRef, useState } = React

    const NS = 'screenshot-picker'
    const API = '/api/dsh-screenshot'
    // 点完按钮先让工具栏恢复常态，再让系统铺框选遮罩。
    const MENU_SETTLE_MS = 260

    const ZH = {
      'menu.label': '截图',
      'menu.hint': '截图：框选 / 窗口 / 整屏（快捷键 Control+Shift+S）',
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
    }
    const EN = {
      'menu.label': 'Screenshot',
      'menu.hint': 'Capture: region / window / whole screen (Control+Shift+S)',
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

    // sessionId -> { inputActions }，由工具栏按钮维护。
    const handles = new Map()

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
        if (state === null) return
        const timer = setTimeout(() => dismissToast(state.seq), state.action === undefined ? 4000 : 12000)
        return () => clearTimeout(timer)
      }, [state])

      if (state === null) return null
      return h('div', { className: 'sp-toast', role: 'status' },
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
      )
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

    function GalleryHost() {
      const [state, setState] = useState(gallery)
      useEffect(() => {
        const listener = () => setState(gallery)
        galleryListeners.add(listener)
        listener()
        return () => {
          galleryListeners.delete(listener)
        }
      }, [])
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
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [state])

      if (state === null || state.urls.length === 0) return null
      const index = Math.min(Math.max(state.index, 0), state.urls.length - 1)
      const current = state.urls[index]
      const total = state.urls.length
      return h('div', {
        className: 'sp-shot-gallery',
        role: 'dialog',
        'aria-modal': 'true',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) publishGallery(null)
        },
      },
        h('style', { key: 'css' }, GALLERY_CSS),
        h('img', { key: 'image', className: 'sp-shot-gallery-image', src: current, alt: '' }),
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
        h('div', {
          key: 'footer',
          className: 'sp-shot-gallery-footer',
          onMouseDown: (event) => event.stopPropagation(),
        },
          h('div', { key: 'counter', className: 'sp-shot-gallery-counter' }, `${index + 1} / ${total}`),
          h('div', { key: 'strip', className: 'sp-shot-gallery-strip' },
            state.urls.map((url, position) => h('button', {
              key: url,
              type: 'button',
              className: position === index ? 'sp-shot-gallery-thumb current' : 'sp-shot-gallery-thumb',
              'aria-current': position === index,
              onClick: () => publishGallery({ ...state, index: position }),
            }, h('img', { src: url, alt: '' })))),
        ),
        h('button', {
          key: 'close',
          type: 'button',
          className: 'sp-shot-gallery-close',
          title: t('gallery.close', ZH['gallery.close']),
          'aria-label': t('gallery.close', ZH['gallery.close']),
          onClick: () => publishGallery(null),
        }, h('span', { 'aria-hidden': true }, '×')),
      )
    }

    const GALLERY_CSS = `
      .sp-shot-gallery {
        position: fixed;
        inset: 0;
        z-index: 82;
        display: grid;
        place-items: center;
        padding: 56px 96px 128px;
        background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, .6));
        backdrop-filter: var(--dsw-mask-blur, blur(6px));
      }
      .sp-shot-gallery-image {
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
        border-radius: var(--dsw-radius-md, 8px);
        box-shadow: var(--dsw-elevation-prominent, 0 24px 64px rgba(0, 0, 0, .4));
      }
      /* 与内置图片灯箱的关闭按钮同一套：36px 圆形 + 实心输入面 + 发丝描边。 */
      .sp-shot-gallery-nav {
        position: absolute;
        top: 50%;
        transform: translateY(-50%);
        width: 36px;
        height: 36px;
        display: grid;
        place-items: center;
        padding: 0;
        border: .5px solid var(--dsw-alias-border-l2-darkmode-thin, var(--dsw-alias-border-l2));
        border-radius: 999px;
        background: var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-2));
        color: var(--dsw-alias-label-primary);
        cursor: pointer;
      }
      .sp-shot-gallery-nav:hover {
        background: var(--dsw-alias-interactive-bg-hover-solid, var(--dsw-alias-bg-layer-2));
      }
      .sp-shot-gallery-nav:focus-visible,
      .sp-shot-gallery-close:focus-visible {
        outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
        outline-offset: 3px;
      }
      .sp-shot-gallery-nav.prev { left: 24px; }
      .sp-shot-gallery-nav.next { right: 24px; }
      .sp-shot-gallery-footer {
        position: absolute;
        left: 50%;
        bottom: 18px;
        transform: translateX(-50%);
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        max-width: 86vw;
      }
      .sp-shot-gallery-counter {
        font-size: 12px;
        color: var(--dsw-alias-label-secondary);
      }
      .sp-shot-gallery-strip {
        display: flex;
        gap: 8px;
        max-width: 100%;
        padding: 6px;
        overflow-x: auto;
        border: .5px solid var(--dsw-alias-border-l2-darkmode-thin, var(--dsw-alias-border-l2));
        border-radius: 12px;
        background: var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-2));
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
        border-color: var(--dsw-alias-label-primary);
      }
      .sp-shot-gallery-close {
        position: absolute;
        top: 20px;
        right: 20px;
        width: 36px;
        height: 36px;
        display: grid;
        place-items: center;
        padding: 0;
        border: .5px solid var(--dsw-alias-border-l2-darkmode-thin, var(--dsw-alias-border-l2));
        border-radius: 999px;
        background: var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-2));
        color: var(--dsw-alias-label-primary);
        font-size: 18px;
        line-height: 1;
        cursor: pointer;
      }
      .sp-shot-gallery-close:hover {
        background: var(--dsw-alias-interactive-bg-hover-solid, var(--dsw-alias-bg-layer-2));
      }
    `

    function ReviewHost() {
      const [state, setState] = useState(review)
      useEffect(() => {
        const listener = () => setState(review)
        reviewListeners.add(listener)
        listener()
        return () => {
          reviewListeners.delete(listener)
        }
      }, [])
      useEffect(() => {
        if (state === null) return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Escape' && event.key !== 'Enter') return
          event.preventDefault()
          event.stopPropagation()
          if (event.key === 'Escape') cancelReview()
          else confirmReview()
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [state])

      if (state === null) return null
      return h('div', {
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
          h('div', { className: 'sp-shot-review-actions' },
            h('button', {
              key: 'cancel',
              type: 'button',
              className: 'sp-shot-review-button',
              onClick: () => cancelReview(),
            }, t('review.cancel', ZH['review.cancel'])),
            h('button', {
              key: 'confirm',
              type: 'button',
              className: 'sp-shot-review-button primary',
              onClick: () => confirmReview(),
            }, t('review.confirm', ZH['review.confirm'])),
          ),
        ),
      )
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

    const TOAST_CSS = `
      .sp-toast {
        position: fixed;
        left: 50%;
        bottom: 108px;
        transform: translateX(-50%);
        z-index: 60;
        display: flex;
        align-items: center;
        gap: 10px;
        max-width: min(560px, calc(100vw - 48px));
        padding: 10px 14px;
        border-radius: 12px;
        border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-overlay);
        color: var(--dsw-alias-label-primary);
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
        font-size: 13px;
        line-height: 1.5;
      }
      .sp-toast-button {
        flex: none;
        padding: 4px 10px;
        border-radius: 8px;
        border: 1px solid var(--dsw-alias-border-l2);
        background: transparent;
        color: var(--dsw-alias-brand-primary);
        font: inherit;
        font-size: 12px;
        cursor: pointer;
      }
      .sp-toast-button:hover { background: var(--dsw-alias-bg-layer-2); }
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
        z-index: 70;
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
        z-index: 71;
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
        z-index: 80;
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
      const added = handle.inputActions.addAttachments(drafts.map((draft) => draft.id))
      if (added === false) {
        try {
          conversation.releaseDraftAttachments(drafts)
        } catch {
          // 释放失败不影响提示。
        }
        showToast(t('error.composer', ZH['error.composer']))
      }
    }

    async function startCapture(ctx, sessionId, mode, windowId) {
      if (sessionId === undefined || inFlight) return
      if (handles.get(sessionId) === undefined) {
        showToast(t('error.composer', ZH['error.composer']))
        return
      }
      inFlight = true
      try {
        await wait(MENU_SETTLE_MS)
        const response = await fetch(API + '/capture', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(windowId === undefined ? { mode } : { mode, windowId }),
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
          publishReview({ url: URL.createObjectURL(blob), blob, sessionId })
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

      // 草稿里有多张图片时，点缩略图打开带左右切换的画廊；单张图仍交给内置 ImageLightbox。
      useEffect(() => {
        const onClick = (event) => {
          const target = event.target
          if (!(target instanceof Element)) return
          const image = target instanceof HTMLImageElement
            ? target
            : target instanceof HTMLButtonElement
              ? target.querySelector('img')
              : null
          if (image === null) return
          const urls = draftImageUrls(attachmentIdsRef.current)
          if (urls.length < 2) return
          const index = urls.indexOf(image.src)
          if (index === -1) return
          event.preventDefault()
          event.stopPropagation()
          publishGallery({ urls, index })
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

      const toggleMenu = () => {
        if (busy) return
        if (menu !== null) {
          setHoverWindow(null)
          setMenu(null)
          return
        }
        const rect = buttonRef.current === null ? null : buttonRef.current.getBoundingClientRect()
        const left = rect === null ? 12 : Math.min(Math.max(8, rect.left - 4), Math.max(8, window.innerWidth - 336))
        const bottom = rect === null ? 120 : window.innerHeight - rect.top + 8
        setMenu({ view: 'menu', left, bottom, loading: false, windows: [], failed: false })
      }

      const showWindows = () => {
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

      return h('span', { className: 'sp-shot-group' },
        h('style', { key: 'css' }, BUTTON_CSS),
        h('button', {
          key: 'button',
          ref: buttonRef,
          type: 'button',
          className: 'sp-shot-button',
          'data-busy': busy,
          'aria-haspopup': 'menu',
          'aria-expanded': menu !== null,
          title: t('menu.hint', ZH['menu.hint']),
          'aria-label': t('menu.label', ZH['menu.label']),
          disabled: busy || !caps.supported,
          onClick: toggleMenu,
        }, h(CameraIcon, { size: 16 })),
        menu === null ? null : h('div', {
          key: 'popover',
          ref: popoverRef,
          className: 'sp-shot-pop',
          role: 'menu',
          style: { left: menu.left, bottom: menu.bottom, width: menu.view === 'windows' ? 320 : 152 },
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
                ? menuRow('screen', h(MonitorIcon, { size: 16 }), t('menu.screen', ZH['menu.screen']), () => run('screen'), isMacKeyboard() ? '⌃⇧S' : 'Ctrl+Shift+S', isMacKeyboard() ? 'Control + Shift + S' : 'Ctrl + Shift + S')
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
        ),
        menu === null || menu.view !== 'windows' || preview === null ? null : h('div', {
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
        ),
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

        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'screenshot-picker-button',
          order: 0,
        }, ScreenshotControls))

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

        // 整屏截图快捷键：⌘⇧S（Windows/Linux 上是 Ctrl+Shift+S）。
        // 走可编辑命令注册，桌面端由原生键盘桥在任何输入区里都能触发。
        ctx.inject(['shortcuts'], (scope) => {
          const shortcuts = scope.shortcuts
          if (shortcuts === undefined || typeof shortcuts.register !== 'function') return
          scope.effect(() => {
            try {
              return shortcuts.register({
                id: 'screenshot-picker.screen',
                label: () => t('menu.screen', ZH['menu.screen']),
                aliases: ['screenshot', 'capture screen'],
                // 只认桌面壳：Control+Shift+S 在 Web 端不属于允许的浏览器组合，
                // 一并声明会让整次注册失败，所以纯浏览器打开时这条快捷键不绑定。
                defaults: {
                  'desktop:macos': { code: 'KeyS', modifiers: ['control', 'shift'] },
                  'desktop:windows': { code: 'KeyS', modifiers: ['control', 'shift'] },
                  'desktop:linux': { code: 'KeyS', modifiers: ['control', 'shift'] },
                },
                regions: ['page', 'editable', 'terminal'],
                modals: [],
                resolve: () => {
                  const target = currentSessionId
                  if (!capabilities.modes.includes('screen')) return { status: 'pass' }
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
          }, 'screenshot-picker: screen shortcut')
        })
      },
    }
  },
})
