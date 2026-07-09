# 设置项

## 目标与范围

集中说明插件所有可配置项：字段、默认值、UI 分组、修改后立即生效的机制。是其它 spec 引用的「共同词汇表」。

**包含：**
- 所有 `SparkMemoSettings` 字段及默认值
- 设置项在 UI 上的分组与展示
- 修改后触发的副作用（重算装饰、更新 CSS 变量等）

**不包含：**
- 各功能模块具体如何使用这些设置（见各自 spec）

## 用户可感知行为

- 在 Obsidian 设置 → 第三方插件 → Spark Memo 里能看到一个设置页，按用途分组：
  - **Memo section**：`targetHeading`、`headingLevel`
  - **时间戳外观与行为**：`timestampPattern`、`timestampColor`、`timestampBgColor`、`readonlyTimestamps`、`autoTimestamp`
  - **附件保存位置**：`recordingFolder`、`imageFolder`
  - **图片处理**：`imageTimeCheck`、`imageCompressionEnabled`、`imageCompressionQuality`、`imageCompressionMaxSize`
  - **语音转文字**（暂未启用，UI 注释掉）：`sttEndpoint`、`sttApiKey`、`sttModel`、`sttLanguage`、`sttRealtime`
- 改颜色、改开关、改路径都是即时生效，不用重载 Obsidian。
- 所有文案跟随语言（见 [i18n.md](i18n.md)）。

## 完整字段表

| 字段 | 类型 | 默认值 | 用途 | 修改后的副作用 |
|---|---|---|---|---|
| `targetHeading` | string | `"Memo"` | 激活插件的 heading 文本 | `refreshEditors()` 重新扫描 section |
| `headingLevel` | number | `2` | Heading 级别（1–6，对应 `#`–`######`） | `refreshEditors()` |
| `timestampPattern` | string | `\d{2}:\d{2}` | 时间戳识别正则 | `refreshEditors()` |
| `timestampColor` | string | `#7c3aed` | 时间戳文字颜色 | `applyCSSVariables()` |
| `timestampBgColor` | string | `#ede9fe` | 时间戳背景色 | `applyCSSVariables()` |
| `readonlyTimestamps` | boolean | `true` | 阻止编辑已有时间戳 | `refreshEditors()` |
| `autoTimestamp` | boolean | `true` | Memo section 内 Enter 自动插入时间戳 | 立即生效，无需刷新 |
| `sttEndpoint` | string | `""` | 云端 STT 服务端点 | 无（功能未启用） |
| `sttApiKey` | string | `""` | STT API Key | 无 |
| `sttModel` | string | `"whisper-1"` | STT 模型名 | 无 |
| `sttLanguage` | string | `"zh"` | STT 语言 | 无 |
| `sttRealtime` | boolean | `true` | STT 是否实时 | 无 |
| `recordingFolder` | string | `""` | 录音保存目录（空 = Obsidian 附件目录） | 下次录音生效 |
| `imageFolder` | string | `""` | 图片保存目录（空 = Obsidian 附件目录） | 下次插入生效 |
| `imageTimeCheck` | boolean | `true` | 图片 EXIF 时间/GPS 与当前差异大时弹确认 | 下次插入生效 |
| `imageCompressionEnabled` | boolean | `true` | 图片压缩为 WebP | 下次插入生效 |
| `imageCompressionQuality` | number | `0.8` | WebP 质量（0.1–1.0） | 下次插入生效 |
| `imageCompressionMaxSize` | number | `1920` | 长边最大像素（0 = 不限） | 下次插入生效 |

## 实现要点

- **类型与默认**：[section.ts](../../src/section.ts) 里的 `SparkMemoSettings` interface 与 `DEFAULT_SETTINGS` 常量。
- **持久化**：`this.saveData()` / `this.loadData()`（Obsidian 官方 API），[main.ts](../../src/main.ts) 里封装为 `loadSettings` / `saveSettings`。
- **设置 UI**：[main.ts](../../src/main.ts) 的 `SparkMemoSettingTab.display()` 用 Obsidian 的 `Setting` 构建器渲染；每项 name/desc 都走 [i18n.ts](../../src/i18n.ts) 的 `t()`。
- **副作用触发**：
  - 装饰相关（正则、颜色开关、只读开关）→ `refreshEditors()` 派发 `forceUpdateEffect`
  - 颜色 → `applyCSSVariables()` 更新 CSS 变量
  - 附件与图片相关字段没有全局副作用，下次操作时读到即可

## 已知约束与遗留

- **STT 字段悬空**：字段留着但 UI 注释掉，避免用户误配置；语音模块见 [capture-audio.md](capture-audio.md)。
- **无迁移逻辑**：新增字段依赖 `DEFAULT_SETTINGS` merge，不做版本化迁移；重命名字段会破坏老用户配置，谨慎重命名。
- **正则暴露**：`timestampPattern` 是原始正则字符串，用户填错会静默失效；未来可加校验提示。
