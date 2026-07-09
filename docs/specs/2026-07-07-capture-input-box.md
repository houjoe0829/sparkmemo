# 快速记录输入框 — 当前形态

**日期**：2026-07-07
**状态**：当前实现的定论，随代码演进请同步更新本文档
**范围**：`capture-view.ts` 中「记录」Tab 的输入卡片（`buildInputCard`），不含时间线/搜索/地点/统计其它 Tab

> 本文档替代 [2026-06-20-quick-capture-design.md](2026-06-20-quick-capture-design.md) 里关于输入区的过时描述（NOTE 按钮 + 纯文字输入）。

## 整体结构

输入卡片（`.jp-capture-card`）自上而下四层：

1. **状态 pill 行**（`.jp-capture-top-pill-row`）— 编辑中 / 时间覆盖 / 位置 / "使用图片信息？"提示四个 pill 横排，全部为空时整行不占高度
2. **附件预览条**（`.jp-capture-attachments`）— 有待提交的图片/录音时才显示，为空时靠 `--empty` 类隐藏
3. **文本输入区**（`.jp-capture-input-wrapper` → `.jp-capture-input` textarea）— 多行，随内容自动增高（最高 240px），Enter 换行、不提交
4. **操作行**（`.jp-capture-actions`）— 左侧图标按钮组，右侧提交按钮

```
┌───────────────────────────────────────────────┐
│ [编辑pill][时间pill][位置pill][图片信息pill]     │
├───────────────────────────────────────────────┤
│ [图片缩略图 / 录音条]（可选）                     │
├───────────────────────────────────────────────┤
│ 多行 textarea                                  │
├───────────────────────────────────────────────┤
│ [+] [#] [@] [📍(仅移动端)]              [↑提交]  │
└───────────────────────────────────────────────┘
```

## 左侧图标按钮组（`.jp-capture-button-row`）

三到四个等大（30×30，圆形）图标按钮并排（📍 按钮仅移动端出现）：

### "+" 按钮

点击弹出 `Menu`（Obsidian 原生菜单），两个选项：

- **上传图片**（图标 `image`）— 打开文件选择器；已有录音待提交时置灰（图片和录音互斥）；已达 `MAX_PENDING_IMAGES = 9` 张时也置灰
- **录音**（图标 `mic`）— 点击开始/停止录音；已有图片待提交时置灰；已达 `MAX_PENDING_AUDIO = 1` 段时也置灰

图片支持粘贴（`paste` 事件，全局监听但仅在输入框内聚焦时生效）和拖拽（`drop`/`dragover`）两种额外入口，走同一条 `addImageFiles` 逻辑（EXIF 时间/GPS 检测 → 按设置压缩为 WebP → 存入 vault → `addPendingImage`）。

### "#" 按钮

点击时在光标当前位置插入一个字面的 `#` 字符（等同于手动敲键盘），随后触发一次 `input` 事件——因此会立刻联动弹出下方的标签建议下拉框。按钮本身不做任何标签逻辑判断，纯粹是"帮用户按下这个键"。

### "@" 按钮

点击时在光标当前位置插入一个字面的 `@` 字符，随后触发一次 `input` 事件，联动弹出下方的笔记引用建议下拉框。用法与 "#" 按钮完全对称。

### "📍" 按钮（仅移动端）

`Platform.isMobile` 为真时才创建。点击调用 `navigator.geolocation.getCurrentPosition`，成功后写入 `pendingLocation` 并触发反查地名，走的是和 EXIF GPS 完全一样的 pill / 提交链路，产出 `[地名](geo:lat,lon)`。加载中按钮外圈显示一段带渐隐尾巴的紫色弧形（conic-gradient 圆环 + `mask` 挖空成 2px 细环，`jp-geo-spin` 0.9s 顺时针一圈）；已经有 `pendingLocation` 时按钮自动置灰、`disabled=true`，避免误覆盖，删除位置 pill 后自动恢复。

桌面端不出现该按钮，因为 Obsidian Electron 未内置 Google Geolocation Key，`navigator.geolocation` 会静默 timeout；此前调研过用 IP 定位（ipapi.co）兜底，但精度和 VPN 影响综合考虑不做，只留手机端入口。

## 标签（`#`）建议下拉框

触发方式：在 textarea 里手动输入 `#`，或点击上面的"#"按钮插入 `#`。

### 触发判定（`updateTagSuggestions`）

从光标位置向左扫描，找到"当前词"的起点：

- 遇到空白字符就停止 → 说明光标不在标签内，关闭下拉框
- 找到起点为 `#` → 进入标签补全模式，`#` 与光标之间的文本作为查询词 `query`

`query` 合法性规则（与 Obsidian 原生标签识别对齐）：

- 只允许任意语言的字母 `\p{L}`、数字 `\p{N}`、下划线 `_`、连字符 `-`、斜杠 `/`（嵌套标签），出现空格或其它标点立即关闭下拉框
- `query` **全部由数字组成时**（如 `2026`）关闭下拉框——因为 Obsidian 本身不会把纯数字识别成标签

### 候选来源（`getVaultTags`）

- 遍历 `vault.getMarkdownFiles()`，对每个文件用 `metadataCache.getFileCache()` + Obsidian 的 `getAllTags()` 取出该文件的全部标签（正文 `#tag` + frontmatter `tags`）
- 全库汇总去重计数，按使用次数降序（次数相同按字母序）排序
- 结果缓存在 `this.tagCache`；监听 `metadataCache.on('changed')` 事件，任何文件的元数据变化都会让缓存失效，下次弹出时惰性重新计算（不会每次按键都全库扫描）

### 展示与过滤

- `query` 为空 → 展示全部标签里最常用的前 8 个
- `query` 非空 → 在全部标签中做子串匹配（大小写不敏感，匹配标签名去掉 `#` 后的部分），取前 8 个
- 没有任何匹配 → 关闭下拉框（不展示空列表）

### 定位

用一个隐藏的镜像 `<div>`（复制 textarea 的字体/内边距/边框/换行样式，塞入光标前的文本 + 一个 marker span）测量出光标的像素位置，下拉框定位在该行正下方。挂载在 `.jp-capture-input-wrapper`（`position: relative`）下，随文本换行、多行滚动仍然贴着光标。

### 交互

- `↑`/`↓`：在候选列表中移动高亮项（循环）
- `Enter` / `Tab`：确认当前高亮项——把 `#query` 替换成 `#完整标签名 `（末尾带一个空格，方便接着打字），光标移到空格之后
- `Esc`：关闭下拉框，不做替换
- 鼠标点击候选项：效果同 `Enter`（用 `mousedown` 而非 `click` 绑定，确保比 textarea 的 `blur` 更早触发，避免下拉框在点击瞬间被关闭事件抢先销毁）
- textarea 失焦（`blur`）：延迟到下一个事件循环再关闭下拉框，给上面的 `mousedown` 留出窗口期

## 笔记引用（`@`）建议下拉框（本次新增）

触发方式：在 textarea 里手动输入 `@`，或点击上面的 "@" 按钮插入 `@`。UI/交互与标签下拉框同构（同一套定位、键盘导航、`mousedown`/`blur` 时序），仅触发判定、候选来源、插入内容不同。

### 触发判定（`updateMentionSuggestions`）

从光标位置向左扫描"当前词"的起点，但因笔记名可能带空格，判定规则与标签不同：

- 只在遇到换行符或扫描超过 100 字符时停止（不因空格停止），找到起点为 `@` → 进入引用补全模式
- `@` 前一个字符必须是空白或位于文本开头，避免在邮箱地址（`foo@bar`）这类场景里误触发
- 查询词 `query`（`@` 与光标之间的文本）里如果出现换行符，关闭下拉框

### 候选来源（`getVaultFiles`）

- `vault.getMarkdownFiles()` 取全部笔记文件，按 `mtime` 降序（最近修改的排最前）
- 结果缓存在 `this.mentionCache`；监听 `metadataCache.on('changed')` 及 `vault` 的 `create`/`delete`/`rename` 事件使缓存失效

### 展示与过滤

- `query` 为空 → 按缓存的"最近修改优先"顺序展示前 8 个
- `query` 非空 → 先取「笔记名前缀匹配」的结果，再补「笔记名中间包含」的结果（两组内部各自保持最近修改优先），合并后取前 8 个
- 没有任何匹配 → 关闭下拉框（不展示空列表）

### 插入内容

确认候选项时，用 Obsidian 的 `metadataCache.fileToLinktext(file, '', true)` 计算「同名笔记消歧后的最短链接文本」，插入 `[[链接文本]] `（末尾带空格）。这是标准的 Obsidian wiki 链接语法，落盘后可以正常点击跳转，也会被 Obsidian 的反向链接/图谱识别。

## 状态 pill（`.jp-capture-top-pill-row`，textarea 顶部）

四个可选 pill，同放在输入框上方的横向 flex 行里，全部为空时整行折叠不占高度：

| Pill | 出现条件 | 内容 | 可关闭 |
|---|---|---|---|
| 编辑中 pill | 从时间线条目的右键菜单进入编辑模式 | "编辑中"文案 | ✕ 取消编辑，清空输入框 |
| 时间覆盖 pill | 图片 EXIF 拍摄时间与"现在"不一致，用户选择使用拍摄时间 | 时钟图标 + `HH:MM`（跨天则加 `MM-DD`） | ✕ 恢复为"现在" |
| 位置 pill | 图片 EXIF 带 GPS 坐标 / 移动端点击 📍 | 定位图标 + 反查到的地名（反查失败显示原始坐标 + 重试按钮） | ✕ 移除坐标 |
| "使用图片信息？"提示 pill | 用户在 EXIF 确认弹窗里选择"不使用"后，仍保留一个 hint，允许后悔重新应用 | 提示图标 + 文案 | ✕ 关闭 |

时间覆盖 pill 和位置 pill 都在最后一张待提交图片被移除时自动清空；位置 pill 存在时会顺带把移动端的 📍 按钮置灰（见上）。

## 提交按钮

`.jp-capture-submit`（紫色圆形，图标 `arrow-up`）。

启用条件（`refreshSubmitState`）：textarea 内容非空白 **或** 存在待提交图片 **或** 存在待提交录音，三者任一满足即可提交，否则置灰禁用。

提交（`handleSubmit`）后：清空 textarea、清空待提交图片/录音、清空三个状态 pill 及 `editingEntry`，写入目标日期（`pendingCaptureOverride` 指定的日期，否则今天）的 daily note。

## 涉及的 i18n key

`capture.add`、`capture.addTag`、`capture.addMention`、`capture.addLocation`、`capture.uploadImage`、`capture.recordAudio`、`capture.submit`、`capture.removeImage`、`capture.removeAudio`、`capture.revertToNow`、`capture.editing`、`capture.cancelEdit`、`location.retryGeocode`、`location.remove`、`notice.locating`、`notice.geolocationUnsupported`、`notice.geolocationFailed` 等，均在 `i18n.ts` 的 `dictionaries.en` / `dictionaries.zh` 里成对维护。

## 已知限制

- 标签建议下拉框只读取"已存在于库中的标签"，不支持在弹窗里直接新建从未出现过的标签——但这不影响手动打完整标签名，落盘后 Obsidian 会正常识别
- 笔记引用下拉框只能引用"已存在的笔记"，不支持像 Obsidian 原生双链那样"输入不存在的笔记名会新建一篇笔记"
- 这是一个自制的纯文本框（非 Obsidian 正式 CM6 编辑器），Obsidian 原生的标签/双链自动补全不会自动出现在这里；本文档描述的两个下拉框（`#` 标签、`@` 笔记引用）是插件自己实现的等效功能
