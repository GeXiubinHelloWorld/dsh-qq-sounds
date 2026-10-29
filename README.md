# dsh-qq-sounds

**用 QQ 的提示音提醒你 DSH 的状态。** DSH 干完一个任务，响「QQ 好友消息」的「滴滴」；它要你放权限、要你回答问题，响「QQ 系统消息」的那种提示——不用一直盯着屏幕。

![dsh](https://img.shields.io/badge/DSH-plugin-8b5cf6) ![license](https://img.shields.io/badge/license-MIT-green) ![node](https://img.shields.io/badge/node-%3E%3D22-blue)

[English](README.en.md) | 中文

---

## 它做什么

| 时机 | 默认音效 |
|---|---|
| 任务完成（`turn/end` · completed） | QQ 好友消息 `msg.wav` |
| 需要审批 / 放权限（`approval/asked`） | QQ 系统消息 `system.wav`，**未处理会重复响** |
| 需要你回答问题（`ask_user_question`） | QQ 系统消息 `system.wav`，**未处理会重复响** |
| 任务出错（`turn/end` · error） | 内置「下行低鸣」（默认关闭） |

- **直接用你本机 QQ 的音效文件**：自动探测 QQ 安装目录（注册表卸载项 + 常见路径），读 `Misc\Sound\Classic\*.wav`；也能手填目录或任意本机音频。
- **没装 QQ 也不哑**：内置两个「仿 QQ」合成音（好友消息 / 系统提示），版权干净，随包分发。
- **重复提醒**：审批 / 提问没处理时按间隔重响（默认 25–30 秒，最多 4–6 次）；你点一下页面、切回窗口，或达到次数上限就停。
- **不吵你**：静音时段（支持跨午夜）、只在 DSH 不在前台时响、总音量 0–100%。
- **后台也知道**：可选系统通知（点击回窗口）+ 窗口标题加 🔔。
- **四类事件独立配置**：每类都能单独选音效 / 静音 / 关掉。

## 安装

### 方式 1：在 DSH 里点（推荐）

左侧栏 **「插件」→ 添加插件**，粘贴：

```
dsh-qq-sounds
```

装完**重启 DSH**，然后进 **设置 → QQ 提醒音**，点「重新检测」确认找到 QQ 音效，试听一下「完成」和「审批」，就完事了。

### 方式 2：命令行

```sh
dsh plugin --profile <你的 profile> add dsh-qq-sounds
```

`<你的 profile>` 通常是 `web` 或 `desktop`（`~/.dsh/profiles/` 下的目录名）。装完重启。

### 方式 3：从 GitHub 源码

```sh
dsh plugin --profile <你的 profile> add github:gexiubin/dsh-qq-sounds
```

## 首次使用

1. **重启 DSH**（插件进入 profile 的 bundles 列表只在 boot 时读取，无法热插）；
2. 打开 **设置 → QQ 提醒音**，顶部应显示「✓ 音频已解锁」；
   - 如果没解锁，点一下页面任意处（浏览器要求先有用户交互才允许出声）；
3. 「QQ 音效目录」里应看到 `C:\...\Misc\Sound\Classic` 与「已找到 N 个音效」；
4. 点几个 `▶ msg` / `▶ system` 试听，确认是对的声音；
5. 按需调整四类事件的音效、重复提醒、静音时段。

## 配置项

| 分区 | 项 | 说明 |
|---|---|---|
| 总开关 | 启用 QQ 提醒音 | 关掉后宿主不再记录事件，也不会响 |
| | 音量 | 0–100%，作用于合成音与音频文件的播放音量 |
| QQ 音效目录 | 检测 / 手动目录 | 探测顺序：手填目录 → `DSH_QQ_DIR` 环境变量 → 常见路径 → 注册表卸载项 |
| 事件 ×4 | 启用 / 音效下拉 | 选项：QQ 的五种音效、内置七种音、自定义本机路径、静音 |
| | 重复提醒（审批 / 提问） | 间隔 5–600 秒，最多 1–50 次；回到页面即停 |
| 何时提醒 | 只在 DSH 不在前台时响 | `document.hasFocus()` + 可见性判定 |
| | 同时弹系统通知 | 需要浏览器通知权限；点击回到窗口 |
| | 标题前加 🔔 | 有待处理且页面不在前台时加，回来即去掉 |
| | 静音时段 | `HH:MM` 起止，支持跨午夜；该时段内事件不记录、也不补发 |

配置保存在 **`~/.dsh/qq-sounds/config.json`**（可用环境变量 `DSH_QQ_SOUNDS_DATA` 换目录），不写浏览器 localStorage，换浏览器 / 清缓存都不丢。

## 工作原理

```
DSH 宿主进程
  ├─ ctx.on("session/event")  →  识别四类事件（完成 / 审批 / 提问 / 出错）
  │                             →  过滤总开关、单事件开关、静音时段、5s 同会话去抖
  │                             →  写入 64 条环形事件日志（带 id 游标 + bootId）
  └─ ctx.webServer.register("/api/qq-sounds/{config,detect,poll,audio,health}")
                                ↑ 只监听本机回环
浏览器（设置页所在的 GUI 进程）
  └─ 每 1.2s 拉 /api/qq-sounds/poll?since=<cursor>  →  新事件 → 播声音 / 弹通知 / 加角标
```

- **为什么用轮询而不是推送**：DSH 的客户端 RPC 只有单向 request/response，服务端没有下行通道；1.2s 游标增量轮询是当前架构下的最小代价（平时响应就是 `{"events":[]}` 几十字节）。
- **为什么不依赖 `@deepseek-ai/*`**：宿主半只 import `node:` 内置模块，浏览器半侧走同源 HTTP，所以插件装进任何 profile 都不需要额外的 peer 依赖能被解析到。
- **音频怎么过来**：`/api/qq-sounds/audio?path=...` 把本机文件按字节回传（白名单扩展名 + ≤4MB），`<audio>` 直接播；不做 base64 塞配置。

## 隐私与安全

- 插件的五条路由**只接受本机回环请求**（`127.0.0.1` / `::1`），别的机器连上来一律 403。
- 只能读 `wav / mp3 / ogg / m4a / aac / flac / webm` 且 ≤4MB 的文件；其他路径与格式直接拒绝。
- 插件**不发起任何外网请求**，不做 analytics，不上传任何内容。
- 事件日志只存在内存里（最多 64 条），不落盘、不外发。

## 版权

插件代码 MIT。**QQ 的音效文件版权归腾讯**：本插件不打包、不复制、不转发任何 QQ 音频，只在你本机按路径读取你自己安装的 QQ 里的那份。仓库与 npm 包里只有自制合成音。

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 完全没声音 | 页面还没交互过 → 点一下窗口任意处；或总开关没开；或处于静音时段 |
| 提示音是「叮咚」不是 QQ 的 | 没找到 QQ 音效 → 设置里点「重新检测」，或手填 QQ 安装目录（含 `Misc\Sound\Classic` 的那层之上） |
| 找不到 QQ 目录 | QQ 可能装在非标准盘符 → 手动填，例如 `D:\apps\qq`；或安装 QQ 后重启 DSH 再检测 |
| 声音延迟 1 秒多 | 轮询周期 1.2s，属预期 |
| 关闭 DSH 窗口后不响 | 声音由 GUI 页面播放，进程退出就没了；系统通知依赖窗口存活 |
| 审批请求很少触发 | 当前会话可能设了「审批永远放行」；换个允许审批的会话试 |

## 开发

```
dsh-qq-sounds/
├─ package.json        # dsh.bundle.patch + dsh.client（platform: web）
├─ cordis.patch.yml    # profile 补丁层：insert 一行 id=qq-sounds
├─ lib/host.js         # 宿主半：配置、QQ 探测、音频读取、事件检测、HTTP 路由
├─ lib/client.js       # 浏览器半：预构建 ModuleLoader bundle（无构建步骤）
└─ test/               # node --test：宿主逻辑、路由端到端、客户端装载与渲染
```

```sh
node --test test/            # 全部测试
dsh plugin --profile web add ./    # 装本地目录（开发用链接）
```

- 改 `lib/client.js`：DSH 的客户端 HMR 会热替换 bundle，**不用重启**，刷新页面即可看到；
- 改 `lib/host.js` / `package.json` / `cordis.patch.yml`：**必须重启 DSH**；
- 首次安装（进入 bundles 列表）一定需要重启——插件还没运行，无法参与自己的激活。
