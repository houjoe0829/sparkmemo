# Memo 时间戳

## 目标与范围

在用户指定的 heading section（默认 `## Memo`）内，对 `HH:MM` 格式的时间戳做视觉高亮、只读保护，并在换行时自动补齐新的时间戳，让日记里的时间线看起来更整齐、也更难被误编辑。

**包含：**
- 编辑视图（Source / Live Preview）里的时间戳装饰与只读拦截
- Reading 视图里的时间戳渲染
- Enter 换行自动插入新时间戳、Tab 快速插入
- 目标 heading section 的识别与范围计算

**不包含：**
- 时间戳所在条目的追加 / 编辑 / 删除（由「快速记录」模块负责，见 [capture-record.md](capture-record.md)）
- 侧栏里对时间线的展示（同上）

## 用户可感知行为

- 打开一篇 daily note，只有 `## Memo`（或用户自定义的 heading）以下、下一个同级或更高级 heading 以前的范围会被激活。
- 该范围内所有匹配 `\d{2}:\d{2}` 的时间戳被渲染成带底色的胶囊（颜色与背景色可在设置里改）。
- 时间戳自身不可编辑：光标可以停在旁边，但不能删除或改写其中的数字。
- 在 Memo section 内的列表项里按 Enter 换行时，新行自动插入当前 `HH:MM`（可关闭）。
- 按 Tab 也能在光标处插入一个新的当前时间戳。
- 切到 Reading 视图查看时，时间戳的样式与编辑视图一致。

## 实现要点

- **Section 定位**：[section.ts](../../src/section.ts) 的 `findSection(doc, headingName, headingLevel)` 逐行扫描文档，返回目标 section 的字符范围（找不到返回 `null`）。
- **时间戳范围**：`getTimestampRanges(doc, settings)` 在 section 范围内按行匹配 `settings.timestampPattern`；行内检测要求当前行以列表标记（`-` / `*` / `+`）开头才认作条目时间戳。
- **装饰构建**：`buildDecorations(doc, settings)` 生成 CM6 `DecorationSet`，供 ViewPlugin 消费。
- **编辑器扩展**：[main.ts](../../src/main.ts) 注册 CM6 `ViewPlugin`（渲染装饰）+ `EditorState.transactionFilter`（拦截落在时间戳范围内的编辑）+ `keymap`（Enter / Tab 行为）。
- **Reading 视图**：`main.ts` 里注册的 markdown post-processor 用 `TreeWalker` 遍历渲染后的段落，把匹配文本节点替换成 `<span class="jp-timestamp">`，保留段落里已有的链接、加粗等 DOM 结构。
- **样式驱动**：CSS 变量 `--jp-ts-color` / `--jp-ts-bg` 挂在插件根节点上，由 `applyCSSVariables()` 在设置变更时更新；不需要重载插件即可看到新颜色。
- **强制刷新**：设置里影响装饰的字段变化时，通过 `forceUpdateEffect` 触发一次重算，避免 stale decorations。
- **当前时间**：`generateTimestamp()` 返回本地时区的 `HH:MM`。

## 已知约束与遗留

- **按行检测**：时间戳只在「以列表标记开头的行」被识别为条目起点，正文里散落的 `12:34` 不会被高亮，避免误伤。
- **CSS 类前缀**：仍保留 `jp-` 前缀（`jp-timestamp` 等），来自最早的 Journal Partner fork。仅内部命名，不影响用户，暂不重命名。
- **`readonlyTimestamps` 关闭时**：只读拦截整体失效，但装饰仍会渲染。这是刻意的（用户可能想临时改时间）。
- **多语言 heading**：`targetHeading` 是原文匹配，不做同义词识别；换语言就得手动改设置。
