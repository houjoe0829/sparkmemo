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

- 设置页顶部按顺序显示「通用」「存储位置」「配置」「关于」四个标签，外观参照 RSS Dashboard。
- 首次打开默认进入「通用」，同一个设置页实例记住本次选择，不新增持久化的标签配置。
- 通用：语言、Memo 标题、标题层级。
- 存储位置：每日笔记存放位置说明、图片目录、录音目录。每日笔记存放位置仅作说明，不新增配置：Memo 保存在 Obsidian 的每日笔记（Daily Note）中，存放位置跟随每日笔记的设置。
- 配置：分为「时间戳设置」和「图片处理」两组。前者包含文字颜色、背景颜色、只读保护、自动插入时间戳、匹配正则、效果预览；后者包含图片压缩开关、质量、最大边长和时间与位置校验。
- 关于：参照 RSS Dashboard 居中展示 24px 的插件名称，左侧显示与 Obsidian 侧边栏和标签页相同的星芒图标，以一行浅色小字显示版本号和构建号，版本信息与按钮之间仅展示一段简短介绍，不使用列表，并排放置等尺寸的 GitHub、X 和普通信封图标描边按钮，图标离线可用并跟随主题颜色，保留链接与无障碍名称，不显示按钮文字、重复悬停提示或完整网址。
- 点击信封图标先打开「联系我们」小弹窗，显示「有问题或建议，欢迎发邮件联系我们。」和邮箱 `houqiao829@gmail.com`，不直接打开邮件客户端。「复制邮箱」复制地址并提示「邮箱地址已复制」；「打开邮件客户端」通过 `mailto:` 打开系统默认邮件客户端，仅填写收件人，不自动发送。弹窗沿用 Obsidian 的关闭按钮与 Esc 行为；复制失败时保留可选中的邮箱地址并提示手动复制。
- 语言可选「跟随 Obsidian」「简体中文」「繁體中文」「English」「日本語」，默认跟随 Obsidian，用于 Spark Memo 的界面和新获取地名，不更改 Obsidian 的语言或 Memo 正文。
- 切换语言即时保存并刷新设置页；为避免清空草稿或中断录音，不重新创建已打开的记录面板。既有面板重新打开时更新静态文案，关闭前需先保存草稿或结束录音；命令注册文案在插件下次加载时更新。
- 改颜色、改开关、改路径都是即时生效，不用重载 Obsidian。
- 语言和标题层级选择器使用 Obsidian 主题菜单；原有文件夹选择器和配置字段保持不变。
- 设置页与文件夹选择弹窗不显示重复的悬停提示，文件夹按钮保留无障碍名称。菜单选项文字、键盘操作和错误提示保持不变。

## 完整字段表

| 字段 | 类型 | 默认值 | 用途 | 修改后的副作用 |
|---|---|---|---|---|
| `language` | `system` / `zh` / `zh-TW` / `en` / `ja` | `system` | 插件界面和新地名查询的语言 | 更新翻译语言并刷新设置页 |
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
- **设置 UI**：[main.ts](../../src/main.ts) 注册的 [settings-tab.ts](../../src/settings-tab.ts) 中的 `SparkMemoSettingTab` 用 Obsidian 的 `Setting` 构建器渲染；每项 name/desc 都走 [i18n.ts](../../src/i18n.ts) 的 `t()`。
- **副作用触发**：
  - 装饰相关（正则、颜色开关、只读开关）→ `refreshEditors()` 派发 `forceUpdateEffect`
  - 颜色 → `applyCSSVariables()` 更新 CSS 变量
  - 附件与图片相关字段没有全局副作用，下次操作时读到即可

## 已知约束与遗留

- STT 字段保留但不展示，不增加尚未实现的语音转文字入口；语音模块见 [capture-audio.md](capture-audio.md)。
- **无迁移逻辑**：新增字段依赖 `DEFAULT_SETTINGS` merge，不做版本化迁移；重命名字段会破坏老用户配置，谨慎重命名。
- `timestampPattern` 仍使用原有正则校验，非法输入提示错误且不保存。
