# 语音录制

## 目标与范围

在快速记录 Tab 里支持一键录音，把音频文件保存到 vault 并作为一条 Memo 条目附件插入。当前只做「本地录音 + 附件保存」，语音转文字（STT）暂缓。

**包含：**
- 录音的启动 / 停止 / 取消
- 音频文件保存位置与文件名规则
- 条目里对音频附件的引用格式

**不包含：**
- 云端 STT（`sttEndpoint` / `sttApiKey` / `sttModel` / `sttLanguage` / `sttRealtime` 等设置项已定义，但设置 UI 处于注释状态、功能未启用）
- 图片附件（见 [capture-image.md](capture-image.md)）

## 用户可感知行为

- 记录 Tab 输入框旁有麦克风按钮，点击开始录音，再点结束。
- 录音过程中显示计时；再次点击结束后音频文件保存到 `recordingFolder`（空则用 Obsidian 附件目录）。
- 保存成功后在输入框中插入音频文件的 Markdown 引用，随下一次发送作为条目一部分写入 Memo section。
- 用户在时间线里点击音频条目可原地播放。

## 实现要点

- **录音 API**：使用浏览器 `MediaRecorder`，采集 webm/ogg 音频（具体格式由浏览器决定）。
- **文件命名**：基于当前时间戳，避免同秒冲突时加随机后缀。
- **保存位置**：`recordingFolder` 空时走 Obsidian 附件目录逻辑，与图片附件一致。
- **UI 与状态**：录音相关按钮、计时、错误提示都在 [capture-view.ts](../../src/capture-view.ts) 内，文案走 [i18n.ts](../../src/i18n.ts)。
- **权限处理**：首次录音时 Obsidian（桌面）/ 系统会请求麦克风权限；被拒后走 Notice 提示。

## 已知约束与遗留

- **STT 未启用**：`SparkMemoSettings` 里保留了云端 STT 的字段，但 [main.ts](../../src/main.ts) 的设置 UI 已注释；短期内不做，等有明确的服务商与体验方案再放开。
- **移动端兼容**：iOS Obsidian 上 `MediaRecorder` 支持格式受限，实际保存后缀可能与桌面不同，用户播放时依赖 Obsidian 自身能力。
- **无实时波形**：目前只显示计时，未渲染波形；后续可考虑加。
- **无自动切片**：长录音不做分段，超长文件对同步 / 播放不友好，靠用户自控。
