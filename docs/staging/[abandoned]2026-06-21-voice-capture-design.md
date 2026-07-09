# 语音快速记录 — 设计文档

**日期**：2026-06-21
**状态**：[abandoned] Path B（Action Button / `obsidian://journal-partner` URL 协议）已从代码中移除，不再推进
**分支**：`feat/voice-capture`

---

## 1. 目标

在移动端给 Journal Partner 加一条**语音 → 文字 → 今日 `## Journal`** 的零阻力路径，覆盖两种使用场景：

1. **App 内场景**：用户已在 Obsidian 里、想随手记一条 → 点 capture view 底部悬浮麦克风。
2. **App 外场景**：手机锁屏 / 在别的 app 里 → 按 iPhone Action Button → 自动听写并落到今天的日记。

两条路径**互相独立、互不依赖**。任何一条单独失败都不影响另一条。

---

## 2. 非目标（YAGNI）

- ❌ 不做实时听写 UI（按住时实时显示文字流）。WKWebView 不开放 `webkitSpeechRecognition`，强行做要么靠流式 STT WebSocket（复杂度爆炸），要么自欺欺人。**方案是「按住录音 → 松手转写 → 文字一次性插入」**。
- ❌ 不做本地模型。Whisper.cpp WASM 在移动端推理性能不够，模型体积也吃不消。
- ❌ 不做语音命令解析（"打开设置"之类）。这是记录工具，不是 Siri。
- ❌ 不做录音文件归档。转写完成即丢弃，不在 vault 里留 `.m4a`。
- ❌ 桌面端不做悬浮麦克风。桌面已有完整键盘体验，加按钮是噪音。

---

## 3. 总体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        Path A：App 内悬浮 mic                    │
│                                                                  │
│  Capture View (mobile)                                           │
│      │                                                           │
│      └── FloatingMicButton (按住录音)                            │
│              │                                                   │
│              ▼                                                   │
│          MediaRecorder (audio/webm or audio/mp4)                 │
│              │                                                   │
│              ▼                                                   │
│          STTClient (OpenAI 兼容层)                               │
│              │                                                   │
│              ├──► OpenAI Whisper                                 │
│              ├──► 火山引擎豆包 (默认推荐)                        │
│              ├──► 阿里云 DashScope                               │
│              └──► 自定义 endpoint                                │
│              │                                                   │
│              ▼                                                   │
│          textarea.value += transcribed_text                      │
│          (用户可编辑后再 NOTE 提交，或自动提交)                  │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                  Path B：iPhone Action Button                    │
│                                                                  │
│  Action Button                                                   │
│      │                                                           │
│      ▼                                                           │
│  Shortcut："听写文本" → "打开 URL"                               │
│      │                                                           │
│      ▼                                                           │
│  obsidian://journal-partner?action=quickcapture&text=<URL编码>   │
│      │                                                           │
│      ▼                                                           │
│  Plugin.handleProtocol() → appendToJournalSection(today, text)   │
│      │                                                           │
│      ▼                                                           │
│  Vault 写入 + Notice 提示                                        │
│  (不打开 capture view，不打断当前流程)                           │
└─────────────────────────────────────────────────────────────────┘
```

两条路径共享 `appendToJournalSection` 的写入逻辑（已存在于 `section.ts`），所以落盘行为完全一致。

---

## 4. Path A：App 内悬浮麦克风

### 4.1 UI

**位置**：capture view 内部右下角，`position: fixed`，距右 16px。

**纵向位置随 mobile toolbar 状态联动**：
- toolbar 显示时（`body` 没有 `jp-hide-mobile-toolbar` 类）：距底部 80px，让出 toolbar 高度。
- toolbar 隐藏时（滚动下滑触发自动隐藏）：距底部 24px，吃掉 toolbar 让出的空间。
- 用 CSS 过渡（`bottom: 0.22s ease`），与工具栏滑动时长保持一致，视觉上同步移动。

**形态**：圆形按钮，48×48px，背景使用强调色 `--jp-tl-dot` 的 14% tint（与 NOTE 按钮同色调），内嵌 `mic` lucide icon。

**状态**：

| 状态 | 视觉 | 触发 |
|---|---|---|
| `idle` | 静态麦克风图标 | 默认 |
| `recording` | 红色填充 + 脉冲呼吸光晕 + 计时（"0:08"） | 按住手指 |
| `transcribing` | 旋转 spinner | 松开手指后等待 STT 返回 |
| `error` | 红色边框 + 警告图标，2 秒后回到 idle | API 失败 / 录音权限拒绝 |

**只在移动端渲染**。`if (!Platform.isMobile) return;` 在 `buildCaptureView` 里短路掉。

### 4.2 交互

- **按住即录音**（PointerDown），**松开即转写**（PointerUp / PointerCancel）。
- 录音中往按钮外**上滑超过 80px 取消**——参考微信"按住说话"。
- 录音最长 60 秒，到时自动停止并转写。
- 转写完成后：
  - 默认行为：把识别文字**追加到 textarea**（用户可手动编辑后再点 NOTE）。
  - 设置项 `voiceAutoSubmit`（默认 false）：转写后自动调 `handleSubmit()`，跳过编辑步骤。

### 4.3 录音技术细节

```ts
// MediaRecorder 在 iOS WKWebView 里的格式支持有限
const mimeType = MediaRecorder.isTypeSupported('audio/mp4')
  ? 'audio/mp4'
  : 'audio/webm';
const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
const recorder = new MediaRecorder(stream, { mimeType });
```

- iOS WKWebView 优先支持 `audio/mp4` (AAC)，Android 上是 `audio/webm` (Opus)。`isTypeSupported` 探测后自动选。
- 首次录音会触发系统权限弹窗。拒绝后写入 `localStorage` 标记，下次按下直接 Notice 提示"已拒绝麦克风权限，请到设置开启"。
- 录音文件**不写盘**，全程内存中以 `Blob` 形式存在，转写完即释放。

### 4.4 STT 抽象层

定义 `STTProvider` 接口，**只做 OpenAI 兼容**：

```ts
interface STTConfig {
  endpoint: string;     // e.g. "https://ark.cn-beijing.volces.com/api/v3"
  apiKey: string;
  model: string;        // e.g. "doubao-..." | "whisper-1" | "qwen-audio-asr"
  language?: string;    // e.g. "zh" — 火山/Whisper 都支持
}

interface STTClient {
  transcribe(audio: Blob, config: STTConfig): Promise<string>;
}
```

**实现**：单一 `OpenAICompatibleSTTClient`，POST 到 `${endpoint}/audio/transcriptions`，`multipart/form-data`，字段：`file`、`model`、`language`、`response_format=json`。响应解析 `{ text: string }`。

设置页**预设三个一键填充按钮**：

| 预设 | endpoint | 默认 model |
|---|---|---|
| 火山引擎豆包（推荐） | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-1.5-pro-audio-asr`（用户填实际模型 ID） |
| 阿里云 DashScope | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-audio-asr` |
| OpenAI Whisper | `https://api.openai.com/v1` | `whisper-1` |

点预设只是预填 endpoint 和 model 字符串，**Key 永远要用户自己填**。

### 4.5 错误处理

| 场景 | 行为 |
|---|---|
| 麦克风权限被拒 | Notice + 按钮 error 状态。设置项里给"打开系统设置"链接（iOS 用 `app-settings:` URL）。 |
| 录音 < 0.5 秒 | 静默丢弃（误触保护），不调 STT。 |
| 网络失败 / API 401 | Notice 显示具体错误（"火山 API Key 无效"），按钮 error 状态。文字**不丢**——把转写失败的录音留在内存里，按钮变成"重试"，点一次重传一次。最多保留 3 次重试，之后丢弃。 |
| API 返回空字符串 | Notice "未识别到内容，请重试"，无副作用。 |

---

## 5. Path B：iPhone Action Button + Shortcuts

### 5.1 URL 协议

注册：
```
obsidian://journal-partner?action=quickcapture&text=<URL编码>[&time=HH:MM]
```

**参数**：

| key | 必填 | 说明 |
|---|---|---|
| `action` | ✅ | 固定 `quickcapture` |
| `text` | ✅ | 要写入的内容（URL 编码） |
| `time` | ❌ | 自定义时间戳，默认用当前时间 |

**行为**：
1. 解析参数。`text` 为空则 Notice 报错，不写入。
2. 调用现有 `appendToJournalSection`（已支持自动建文件 / 建 section）。
3. **Notice 显示**："📝 已记录：<前 20 字>…"
4. **不打开 capture view**，不切走用户当前的视图。
5. 如果 capture view 已打开，触发 `refreshDay(today)` 让今日 section 同步更新。

### 5.2 Shortcut 模板

设置页提供两个东西：

1. **iCloud 一键导入链接**（首选）——把预配置好的 Shortcut 上传到 iCloud，设置页放一个按钮直接打开 `https://www.icloud.com/shortcuts/<id>`，用户点"获取捷径"即用。
2. **手动配置说明**（兜底）：3 步图文教程，给那些 iCloud 链接挂掉或想自定义的用户。

**模板内容**：
- 动作 1：「听写文本」（Apple 自带，免费）
- 动作 2：「打开 URL」→ `obsidian://journal-partner?action=quickcapture&text=[听写文本]`（"听写文本"是上一步的输出变量，URL 编码由 Shortcuts 自动处理）

**托管**：用 `zhaohongxuan` 自己的 iCloud 账户上传一份固定 Shortcut，链接写进 README + 设置页。后续如果协议参数改动，重新上传新版本即可。

### 5.3 与 Action Button 配合

iPhone 15 Pro 起的 Action Button 可绑定单一 Shortcut。用户在 iOS 设置里把上面创建的 Shortcut 选为 Action Button 触发项即可。**插件这边没有任何额外代码**——它就是一个普通的 URL 协议处理器，谁调谁触发。

---

## 6. 设置项新增

```ts
interface JournalPartnerSettings {
  // ... 现有字段
  voiceEnabled: boolean;             // 默认 true，关闭后悬浮按钮不渲染
  voiceAutoSubmit: boolean;          // 默认 false，转写后自动提交
  sttEndpoint: string;               // 默认 "" — 用户必须填
  sttApiKey: string;                 // 默认 ""
  sttModel: string;                  // 默认 ""
  sttLanguage: string;               // 默认 "zh"
  voiceMaxSeconds: number;           // 默认 60
}
```

**API Key 存储**：用 Obsidian 的 `loadData` / `saveData`（即 `data.json`）。注意——Obsidian 的 data.json **不加密**。

**显示策略**：设置页里 Key 字段使用 `<input type="password">` 打码显示，旁边放一个眼睛图标按钮可临时切换为明文（`type="text"`）便于核对，焦点离开自动恢复打码。同时在字段下方红字提示："API Key 以明文保存在 vault 配置中（`data.json`），请勿将本 vault 公开同步"。

---

## 7. 文件改动

| 文件 | 改动 |
|---|---|
| `voice/recorder.ts` | **新建**。MediaRecorder 封装 + 权限处理 + Blob 输出 |
| `voice/stt-client.ts` | **新建**。`OpenAICompatibleSTTClient`，单一实现 |
| `voice/floating-mic.ts` | **新建**。悬浮按钮组件 + 状态机 + 手势处理 |
| `capture-view.ts` | 在 `onOpen` 里挂载 `FloatingMicButton`（仅移动端），`onClose` 卸载 |
| `main.ts` | `registerObsidianProtocolHandler('journal-partner', handleProtocol)` + 设置页扩展（4 个新增分组） |
| `section.ts` | 不动。已有的 `appendToJournalSection` 直接复用。 |
| `styles.css` | 新增 `.jp-floating-mic` + 状态变体 + 脉冲动画 |
| `manifest.json` | `isDesktopOnly: false` 已是 false，无需改 |

新增 `voice/` 子目录是为了让语音相关代码自成一组，方便后续扩展（流式 STT、本地模型等）。

---

## 8. 实施顺序

按可独立验证的最小切片排：

1. **Path B 全套**（最快见效，无外部依赖）
   - `registerObsidianProtocolHandler` + URL 解析 + 调 `appendToJournalSection`
   - 设置页教程图文
   - 桌面端可用 `open "obsidian://..."` 命令测试

2. **悬浮按钮 UI（不接 STT）**
   - 移动端渲染 + 状态机 + 录音权限请求
   - 录音后只 console.log Blob 大小，验证手势和状态切换

3. **STT 客户端 + 接火山**
   - 实现 `OpenAICompatibleSTTClient`
   - 设置页填 endpoint/key/model
   - 端到端跑通：按住 → 录音 → 转写 → textarea

4. **错误处理 + 重试 + 取消手势**
   - 上滑取消、超时、网络重试

5. **抛光**
   - 脉冲动画、计时显示、过渡

每个切片都能 commit + deploy 一次，每次都能在真机上验证。

---

## 9. 风险与开放问题

- **iOS WKWebView 的 `getUserMedia` 实测**：理论上 iOS 14.3+ 在 WKWebView 里支持 `getUserMedia`，但 Obsidian 的 WebView 配置（`allowsInlineMediaPlayback`、`mediaTypesRequiringUserActionForPlayback` 等）我们无法控制。**第一步切片要在真机上验证录音可用**，如果不行，这个方案的 Path A 整个翻车，需要回退到"只做 Path B"。
- **火山豆包语音模型 ID**：模型 ID 可能会变，文档建议设置页给"模型 ID 找不到？查文档"链接，不写死任何 ID。
- **录音文件大小**：60 秒 AAC 大约 500KB-1MB，4G 上传 1-2 秒可接受，弱网下需要 timeout 处理（默认 30 秒）。
- **iCloud Shortcut 链接的人工动作**：实施切片 #1 完成后，**zhaohongxuan 需要手动**：(a) 在自己的 iPhone 上按设计 5.2 创建 Shortcut，(b) 「分享 → 拷贝 iCloud 链接」，(c) 把链接填入 README 和设置页对应位置。这一步无法在代码里自动化。

---

## 10. 验收标准

- [ ] iPhone Action Button 按一下 → 5 秒内今天的 `## Journal` 多一条 `- HH:MM <听写内容>`
- [ ] 移动端 Obsidian 打开 capture view → 右下角出现麦克风按钮
- [ ] 按住 mic → 看到录音状态 + 计时 → 松开 → 看到转写状态 → 文字出现在 textarea
- [ ] 上滑取消手势能正确中止录音不发请求
- [ ] 桌面端不显示悬浮按钮
- [ ] 错误场景（无 Key / Key 错 / 网络断）都有清晰的 Notice
- [ ] 关闭 voice 设置后，按钮消失，URL 协议依然有效（两条路径独立）
