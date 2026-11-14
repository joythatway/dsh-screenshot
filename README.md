# 截图 · screenshot-picker

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的输入框加一个截图按钮：**框选 / 窗口 / 整屏**，图片直接变成草稿附件，跟着消息发给模型。

一个 Composer toolbar 插件，用 macOS 原生截图能力实现；窗口列表、悬停缩略图、多图预览都按 Harness 自己的 UI 规范来做。

> A composer-toolbar screenshot plugin for DeepSeek Harness: capture a region, a window, or the whole screen, and drop it straight into the draft.

---

## 功能

- **一个按钮，三种模式**：点输入框工具栏的相机图标 → 菜单里选「框选截图 / 窗口截图 / 整屏截图」。
- **框选**：
  - 调系统原生遮罩拖一块区域；
  - 和豆包一样，**截图前会把 DeepSeek Harness 窗口自动让开**，方便直接框选它后面的内容；截图结束（确认 / 取消 / 失败）后窗口自动回来；
  - 松开鼠标后先弹**确认框**：Enter 确认、Esc 取消、点遮罩空白取消，确认了才进草稿。
- **窗口**：
  - 列出当前屏幕上所有可见窗口（前台在前），鼠标悬停时右侧显示该窗口的**实时缩略图**，预览图会跟随当前行上下移动；
  - 点一行截整窗；对 GPU 渲染、窗口快照读回来是纯色图的窗口（例如 Steam），会做空图检测：未被遮挡时退回按窗口矩形从屏幕合成里截，被遮挡时明确提示「先切到前台」，不会塞一张黑图。
- **整屏**：直接截整个桌面，无遮罩；快捷键 **⌃⇧S**（macOS）/ **Ctrl+Shift+S**（Windows）。
- **草稿多图预览**：草稿里有 2 张及以上图片时，点任意缩略图打开画廊：
  - 左右箭头翻页（第一张只显示右箭头，最后一张只显示左箭头）；
  - ← / → 键盘翻页，Esc 关闭；
  - 底部缩略图条显示全部图片，点一下直接跳转。
- **失败有出口**：没有屏幕录制权限时给出提示 + 「打开设置」按钮，直接跳到系统设置对应面板。

## 平台支持

| 平台 | 框选 | 窗口（列表） | 整屏 | 状态 |
|---|---|---|---|---|
| macOS | 原生遮罩 | CoreGraphics + 悬停缩略图 | 原生截图 | **已实测** |
| Windows | — | Win32 枚举 + 矩形截图 | .NET 截全屏 | 代码已写，**未实测** |
| Linux | — | — | — | 不支持（按钮隐藏） |

Windows 没有系统级的框选遮罩，因此不提供「框选截图」，菜单只会出现「窗口 / 整屏」两项。`/probe` 的 `modes` 字段会驱动 UI 自动隐藏不支持的模式。

## 环境要求

- DeepSeek Harness（桌面版；浏览器里按钮可用，但快捷键只在桌面端绑定）
- macOS 12+（采集层用到 `screencapture`、`sips`、JXA/CoreGraphics）
- Node.js ≥ 20（仅开发/测试需要）

## 安装

本插件是 Harness 的 profile bundle（`package.json` 里带 `dsh.bundle.patch` + `dsh.client`）。

**方式一：插件管理器安装本地目录**

```text
plugin_manager install_bundle /绝对路径/screenshot-picker
```

**方式二：手动放进 profile**

把目录拷到 `$DSH_PROFILE_DIR/node_modules/`，然后在 profile 的 `cordis.patch.yml` 里插入一行：

```yaml
- insert:
    - id: screenshot-picker
      name: '@local/screenshot-picker'
```

安装后重启 Harness（或重新加载插件）；浏览器端代码在刷新页面后生效。

## 权限

| 权限 | 用途 | 缺失时的行为 |
|---|---|---|
| 屏幕录制 | 截图本身 | 提示 + 「打开设置」按钮，不会先铺遮罩再失败 |
| 辅助功能 | 截图时自动隐藏 Harness 窗口 | 截图照常，只是窗口不让开；首次提示一次 |

插件用 `CGPreflightScreenCaptureAccess()` 预检屏幕录制权限——**只问权限，不抓任何像素**。

## 隐私与存储

- **截图不落盘**：截到的 PNG 只在内存和临时目录里（临时文件读完立即删除），页面取走即释放，60 秒未取自动过期。
- **缩略图不落盘**：按窗口号实时截、缩到 480px，最多内存缓存 16 张、30 秒过期。
- **入草稿前会压缩**：长边超过 2560px 的截图等比缩小，减少 token 和上传体积。
- **发送后的图由 Harness 持久化**：点发送后，Harness 的附件存储会写入 `$DSH_HOME/attachments/v1/objects/…`（内容哈希去重，默认不自动清理）。这与插件无关，但需要知情。
- 所有 HTTP 路由只放行同源请求（校验 `sec-fetch-site`）。

## 快捷键

| 动作 | 键位 |
|---|---|
| 整屏截图 | ⌃⇧S / Ctrl+Shift+S |
| 画廊翻页 | ← / → |
| 确认 / 取消截图 | Enter / Esc |

## HTTP 接口（同源，供开发调试）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/screenshot-picker/probe` | 平台能力：`supported` / `platform` / `modes` |
| GET | `/api/screenshot-picker/windows` | 可见窗口列表（z 序，带坐标和尺寸） |
| GET | `/api/screenshot-picker/thumbnail?id=<窗口号>` | 480px 窗口缩略图（PNG） |
| POST | `/api/screenshot-picker/capture` | `{ mode: 'region'\|'window'\|'screen', windowId? }` → `{ ok, id }` |
| GET | `/api/screenshot-picker/image/<id>` | 取一次即删的 PNG |
| POST | `/api/screenshot-picker/settings-screen` | `{ pane: 'screen'\|'accessibility' }` 打开对应设置面板 |

## 项目结构

```text
index.js              Host 入口：HTTP 路由 + 内存暂存
capture/index.js      按平台挑采集后端
capture/macos.js      screencapture / sips / JXA（已实测）
capture/windows.js    PowerShell + .NET（未实测）
lib/util.js           纯函数（可单测）
client.js             浏览器端：按钮、菜单、确认框、画廊、缩略图预览
test/util.test.js     单元测试
```

## 开发

```bash
npm test        # node --test，无第三方依赖
```

CI 在 `.github/workflows/test.yml` 中，push 时自动跑单元测试。

## 已知限制

- 依赖 Harness 的若干扩展点（`conversation.input.left` 槽位、`conversation` 服务的 `createDrafts` / `releaseDraftAttachment`、`shortcuts.register`）。升级 Harness 后建议把三种模式各点一次；出问题通常是静默失效，不会让界面崩溃。
- 快捷键固定为 ⌃⇧S，没有设置界面。
- 自动隐藏窗口依赖「辅助功能」权限；授权后如果窗口仍不让开，重启一次 Harness 再试。
- Windows 实现未经真机验证，路径 / DPI 行为可能需要调整；失败时接口会带 `detail` 返回 PowerShell 的原始报错。
- 菜单没有 ↑/↓ 键导航，确认框没有焦点陷阱（鼠标可用，键盘仅 Enter/Esc）。

## License

MIT
