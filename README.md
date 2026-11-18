# 截图 · dsh-screenshot

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的输入框加一个截图按钮：**框选 / 窗口 / 整屏**。图片可以直接变成草稿附件跟着消息发给模型，也可以一键**存到磁盘**（默认桌面）。

一个 Composer toolbar 插件，用 macOS 原生截图能力实现；窗口列表、悬停缩略图、多图预览、设置页都按 Harness 自己的 UI 规范来做。

> A composer-toolbar screenshot plugin for DeepSeek Harness: capture a region, a window, or the whole screen, then attach it to the draft or save it to disk.

---

## 功能

- **一个按钮，三种模式**：点输入框工具栏的相机图标 → 菜单里选「框选截图 / 窗口截图 / 整屏截图」，菜单支持 ↑/↓/Home/End + Enter 键盘操作。
- **截图快捷键**：默认 **⌃⇧S**（Windows 上 **Ctrl+Shift+S**），**按下直接整屏截图**（和菜单里的「整屏截图」等价，不经过菜单）；键位可以在设置页里改，也可以在 Harness 自己的快捷键页面改。
- **框选**：
  - 调系统原生遮罩拖一块区域；
  - 和豆包一样，**截图前会把 DeepSeek Harness 窗口自动让开**，方便直接框选它后面的内容；截图结束（确认 / 取消 / 失败）后窗口自动回来；
  - 松开鼠标后先弹**确认框**：Enter 确认入草稿、Esc 取消、点遮罩空白取消；确认框里还有**保存**，存盘后直接关掉（没有打开的会话时只剩「保存 / 取消」）。
- **窗口**：
  - 列出当前屏幕上所有可见窗口（前台在前），鼠标悬停时右侧显示该窗口的**实时缩略图**，预览图会跟随当前行上下移动；列表会过滤掉小于 100×80 的辅助窗口（截出来只有一片纯色）；
  - 点一行截整窗；对 GPU 渲染、窗口快照读回来是纯色图的窗口（例如 Steam），会做空图检测（颜色跨度 + 标准差，低对比的空图也拦得住）：未被遮挡时退回按窗口矩形从屏幕合成里截，被遮挡时明确提示「先切到前台」，不会塞一张黑图或纯色图。
- **整屏**：直接截整个桌面，无遮罩。
- **保存到磁盘**：
  - 框选确认框里点「保存」；或者点开任意一张截图预览，在预览底部点「保存」；
  - 默认保存到**桌面**，设置在「设置 › 截图」里可以换成任意文件夹；
  - PNG 用 `screenshot-YYYYMMDD-HHMMSS.png` 命名，同名自动加 `-2`、`-3`；
  - 保存成功的提示里带路径和「显示」，直接在 Finder / 资源管理器里定位文件；
  - 窗口 / 整屏截图不弹确认框，直接进草稿；它们照样可以在预览里保存。
- **设置页**：「设置 › 截图」（左下角设置 → 截图；插件管理器里这一行的「配置」也打开同一个页面）：
  - **截图快捷键**：点「修改」后按下新组合键即生效（按下就是一次整屏截图），冲突 / 保留键会当场说明；「恢复默认」回到 ⌃⇧S；
  - **保存位置**：可以手输路径，也可以点「选择…」用系统文件夹选择器；「恢复默认」回到桌面；
  - **框选时自动隐藏窗口**：关掉之后框选期间 Harness 窗口不再让开。
  - 改动立即生效，不存在插件重启；设置存在 `$DSH_HOME/dsh-screenshot/settings.json`（默认 `~/.dsh/dsh-screenshot/settings.json`），快捷键绑定则沿用 Harness 自己的 keybindings 存储。
- **图片预览（仿豆包）**：点草稿里的截图缩略图打开自己的预览层——单张也接管（内置灯箱没有保存按钮，也不够黑）：
  - 整屏**近黑遮罩** + 背景模糊，图片浮在中间；
  - 顶部中间一条深色玻璃胶囊：**缩小 · 百分比 · 放大 · 保存**，点百分比回到 100%；
  - 缩放范围 25% – 400%，100% 是「整张图刚好放得下」；放大出视口后可以直接滚动查看；
  - 键盘：← / → 翻页，`+` / `-` 缩放，`0` 回到 100%，Esc 关闭；
  - 多张图时顶部显示 `2 / 5`，底部缩略图条点一下跳转；
  - 「保存」把当前这张存到设置的目录，提示条浮在预览之上（z-index 950）。
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
plugin_manager install_bundle /绝对路径/dsh-screenshot
```

**方式二：手动放进 profile**

把目录拷到 `$DSH_PROFILE_DIR/node_modules/`，然后在 profile 的 `cordis.patch.yml` 里插入一行：

```yaml
- insert:
    - id: dsh-screenshot
      name: '@joythatway/dsh-screenshot'
```

安装后重启 Harness（或重新加载插件）；浏览器端代码在刷新页面后生效。

## 权限

| 权限 | 用途 | 缺失时的行为 |
|---|---|---|
| 屏幕录制 | 截图本身 | 提示 + 「打开设置」按钮，不会先铺遮罩再失败 |
| 辅助功能 | 框选 / 窗口点选时自动隐藏 Harness 窗口（可在设置里关闭） | 截图照常，只是窗口不让开；首次提示一次 |

插件用 `CGPreflightScreenCaptureAccess()` 预检屏幕录制权限——**只问权限，不抓任何像素**。

## 隐私与存储

- **截图默认不落盘**：截到的 PNG 只存在宿主进程内存里，页面取走即删除，60 秒未取自动释放；只有**点了「保存」**才会写进你选的目录。
- **入草稿不等于保存**：图片加入输入框后只存在页面内存（`File` + blob），点发送才会写入附件库；没发送就关掉 App，这张图不会在磁盘上留下任何文件。
- **缩略图不落盘**：按窗口号实时截、缩到 480px，最多内存缓存 16 张、30 秒过期。
- **入草稿前会压缩**：长边超过 2560px 的截图等比缩小，减少 token 和上传体积。
- **发送后的图由 Harness 持久化**：点发送后，Harness 的附件存储会写入 `$DSH_HOME/attachments/v1/objects/…`（内容哈希去重，默认不自动清理）。这与插件无关，但需要知情。
- **设置文件**：`$DSH_HOME/dsh-screenshot/settings.json`，只有两个字段（保存目录、是否自动隐藏窗口）；坏文件按默认值处理，不会让插件起不来。
- 所有 HTTP 路由只放行同源请求（校验 `sec-fetch-site`），并先过 Harness 自己的 `connection.requestRejection`（Host/Origin 围栏 + 浏览器登录态）；保存只接受 PNG，文件名会去掉路径分隔符。

## 快捷键

| 动作 | 键位 |
|---|---|
| 整屏截图 | ⌃⇧S / Ctrl+Shift+S（**可在设置页改**） |
| 菜单里换行 / 触发 / 关闭 | ↑ ↓ Home End / Enter / Esc |
| 框选确认框：确认 / 取消 | Enter / Esc |
| 框选确认框没有会话时：保存 / 取消 | Enter / Esc |
| 预览翻页 / 缩放 / 关闭 | ← → / + − / 0 / Esc |

## HTTP 接口（同源，供开发调试）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/dsh-screenshot/probe` | 平台能力：`supported` / `platform` / `modes` |
| GET | `/api/dsh-screenshot/windows` | 可见窗口列表（z 序，带坐标和尺寸） |
| GET | `/api/dsh-screenshot/thumbnail?id=<窗口号>` | 480px 窗口缩略图（PNG） |
| POST | `/api/dsh-screenshot/capture` | `{ mode: 'region'\|'window'\|'screen', windowId?, hideShell? }` → `{ ok, id }` |
| GET | `/api/dsh-screenshot/image/<id>` | 取一次即删的 PNG |
| GET | `/api/dsh-screenshot/settings` | 当前设置 + 生效的保存目录 + 默认（桌面）目录 |
| POST | `/api/dsh-screenshot/settings` | `{ saveDir?, hideOnCapture? }` → 写盘并回显 |
| POST | `/api/dsh-screenshot/save?name=<文件名>` | 请求体是 PNG 原始字节 → `{ path, dir, name }` |
| POST | `/api/dsh-screenshot/reveal` | `{ path }` 在文件管理器里定位（只认本次写出的文件） |
| POST | `/api/dsh-screenshot/settings-screen` | `{ pane: 'screen'\|'accessibility' }` 打开对应设置面板 |

## 项目结构

```text
index.js              Host 入口：HTTP 路由 + 内存暂存 + 保存 / 设置
capture/index.js      按平台挑采集后端
capture/macos.js      screencapture / sips / JXA（已实测）
capture/windows.js    PowerShell + .NET（未实测）
lib/util.js           纯函数（可单测）
lib/settings.js       设置的默认值 / 校验 / JSON 持久化
client.js             浏览器端：按钮、菜单、确认框、画廊、缩略图预览、设置页
test/util.test.js     采集工具函数单测
test/settings.test.js 设置校验单测
test/host.test.js     Host 路由集成测试（临时目录写盘）
test/client.test.js   客户端冒烟测试（模块加载 / 槽位注册 / 页面渲染）
```

## 开发

```bash
npm test        # node --test，无第三方依赖
```

CI 在 `.github/workflows/test.yml` 中，push 时自动跑单元测试。

## 已知限制

- 依赖 Harness 的若干扩展点（`conversation.input.left` 槽位、`conversation` 服务的 `createDrafts` / `releaseDraftAttachment`、`shortcuts.register`）。升级 Harness 后建议把三种模式各点一次；出问题通常是静默失效，不会让界面崩溃。
- 快捷键只声明桌面端（`desktop:*`）：浏览器里 Ctrl+Shift+S 不是允许的浏览器组合，所以在网页版这条命令不绑定，但设置页仍可修改桌面端的绑定。
- 「框选时自动隐藏窗口」目前在 macOS 生效；Windows 后端本来就不隐藏宿主窗口。
- 自动隐藏窗口依赖「辅助功能」权限；授权后如果窗口仍不让开，重启一次 Harness 再试。
- Windows 实现未经真机验证，路径 / DPI 行为可能需要调整；失败时接口会带 `detail` 返回 PowerShell 的原始报错。
- 确认框和画廊没有焦点陷阱（鼠标可用；键盘支持 Enter/Esc 与画廊的 ←/→）。
- 设置页的保存目录只做「绝对路径」校验，是否可写要等第一次保存才会知道（失败会提示检查目录）。

## License

MIT
