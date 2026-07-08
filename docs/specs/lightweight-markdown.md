# 轻量 Markdown 渲染（快速记录输入框）

## 生效范围

只在侧边栏"快速记录"输入框（`capture-view.ts` 的 `CaptureEditor`，见 `capture-editor.ts`）生效。**主编辑器（每日笔记正文，`main.ts`）不做任何改动**——Obsidian 的 Live Preview 本身就会原生渲染标准 Markdown（加粗、斜体、标题、列表），在那里再加一层自定义装饰只会跟原生渲染重复甚至冲突（标题字号分级 vs 我们想要的"统一字号"），所以刻意不做。

时间线卡片（提交后展示的每条记录）本来就通过 Obsidian 官方 `MarkdownRenderer.render` 渲染（`capture-view.ts:800`），已经原生支持所有标准 Markdown 语法，同样不需要额外开发。

真正的空白点是输入框本身：原来是一个普通的 HTML `<textarea>`，浏览器原生限制决定了它不可能显示"部分文字加粗、部分文字变色"这种混合样式（这是 HTML 的天然限制，不是 Obsidian 或代码的问题）。要在打字过程中看到格式高亮，必须换成支持富文本渲染的编辑控件——选择了 CodeMirror 6（Obsidian 自带、外部依赖不增加插件体积、已有的解析逻辑可以直接复用），而不是手写 `contentEditable`（那条路线需要自己解决光标恢复、输入法合成等一整套问题）。

## 输入框里的"首行 vs 续行"规则

跟主编辑器的原则一致，但判断依据更简单：输入框里从头到尾只装着"正在写的这一条记录"，还没加上 `- HH:MM` 前缀（这是提交时 `buildEntryLine` 才拼上去的）。所以：

- **第 1 行**：只识别行内格式（加粗/斜体/删除线/高亮/内联代码/纯链接）。不识别标题、列表——因为提交后这一行会被接在 `- HH:MM ` 后面，不会真的出现在物理行首，写了也不会真正生效，索性在输入时也不渲染，避免视觉误导。
- **第 2 行及以后**：会变成缩进续行，行内格式 + 标题（`#`~`###`）+ 列表（`-`/`*`/`+`/`数字.`）全部生效。

判断逻辑：`buildCaptureMarkdownDecorations(doc)`（`section.ts`）里用 `lineIndex === 0` 判断是否为首行，不需要用到时间戳正则。

## 支持的语法

| 语法 | 写法 | 生效范围 | 渲染效果 |
|---|---|---|---|
| 加粗 | `**x**` | 首行 + 续行 | 加粗，符号淡化 |
| 斜体 | `*x*` | 首行 + 续行 | 斜体，符号淡化 |
| 删除线 | `~~x~~` | 首行 + 续行 | 删除线，符号淡化 |
| 高亮 | `==x==`（首尾不能是空格） | 首行 + 续行 | 黄色背景，符号淡化 |
| 内联代码 | `` `x` `` | 首行 + 续行 | 等宽字体 + 背景色，符号淡化 |
| 纯链接 | 自动识别 `https://...` | 首行 + 续行 | 蓝色 |
| 标题 | `#`~`###`（超过 3 级不生效） | 仅续行 | 加粗 + 统一字号，符号淡化，整行按标记宽度做悬挂缩进 |
| 无序列表 | `-`/`*`/`+` | 仅续行 | 前缀加粗淡化，整行按标记宽度做悬挂缩进 |
| 有序列表 | `数字.` | 仅续行 | 同上，Enter 键自动 +1 |

明确不支持：`__x__`/`_x_` 下划线加粗斜体、`[text](url)` 链接语法、表格、围栏代码块、引用块、分割线、自定义列表符号、列表多级缩进（Tab 分级）。所有语法符号保留可见，不隐藏，仅做颜色淡化。

## Enter 键在续行里的列表交互

- **无序列表续写**、**有序列表自动 +1**、**空列表项按 Enter 退出列表**——这三条目前只实现在**主编辑器**（`main.ts` 的 `createEnterKeymap`，处理的是已保存到磁盘的日记正文里、缩进续行的场景），输入框（`CaptureEditor`）目前没有实现同等的 Enter 键接管，纯输入 CM6 实例只做了装饰渲染，没有绑定这一组 keymap。
  - 如果输入框里也需要这三条交互，需要单独在 `capture-editor.ts` 里加一个等价的 keymap 扩展（判断依据变成"当前行号是否 ≥ 1"而不是时间戳正则，跟装饰器判断逻辑一致）。首版未做，标记为后续可选增强。

## 实现落点

- **`section.ts`**：
  - `scanMarkdownLines(text, baseOffset, isHeadLine)` — 共享的核心行扫描逻辑（内联格式 + 块级结构），抽出来给两个场景复用。
  - `buildMarkdownDecorations(doc, settings)` — 主编辑器专用（未被 `main.ts` 实际使用，保留供未来需要时启用；判断依据是时间戳正则）。
  - `buildCaptureMarkdownDecorations(doc)` — 输入框专用，`lineIndex === 0` 判断首行。
  - `scanInlineFormats`/`scanBlockStructure` — 行内 6 种语法 + 块级 2 种语法（标题/列表）的正则扫描，按 code → bold → strike → highlight → italic → link 的顺序做重叠互斥判断。
- **`capture-editor.ts`**（新文件）：`CaptureEditor` 类，包一个 CM6 `EditorView`，对外暴露 `.value`/`.selectionStart`/`.selectionEnd`/`.setSelectionRange()`/`.focus()`/`.placeholder`/`.style`/`.scrollHeight`/`.addEventListener`/`.dispatchEvent`/`.contains()`，让 `capture-view.ts` 里原本绑在 `<textarea>` 上的全部交互（标签/提及自动补全、语音实时转写、图片粘贴拖拽、自适应高度等近 30 处调用点）几乎不用改代码就能继续工作。额外提供 `coordsRelativeTo()`，用 CM6 原生的 `coordsAtPos()` 替换掉原来"隐藏镜像 div 测量光标像素位置"的 hack，标签/提及弹窗定位逻辑因此大幅简化。
- **`capture-view.ts`**：`textareaEl` 字段类型从 `HTMLTextAreaElement` 改为 `CaptureEditor`；创建逻辑改为 `new CaptureEditor(inputWrapper, 'jp-capture-input')`；`positionTagSuggest`/`positionMentionSuggest` 改用 `coordsRelativeTo`。
- **`styles.css`**：新增 `.jp-md-*` 系列类（标记淡化、加粗/斜体/删除线/高亮/代码/链接/标题文字），以及针对 CM6 编辑器根节点的样式重置（去掉 CM6 自带的 gutter/padding/focus 边框，让它看起来还是原来那个无边框输入框）。

## 已验证

- 本地构建通过（`npm run build`：`tsc -noEmit` + esbuild）。
- 部署到 Obsidian 后实测：输入框内实时显示加粗/斜体/删除线/高亮/内联代码/自动链接，随打字触发；提交按钮可用状态、自适应高度均正常；`dev:errors` 无报错。
- 未覆盖：多行场景下"续行标题/列表"的实际按键交互（Enter 自动续写等）因为本节所述原因暂未在输入框实现，只验证了装饰渲染本身（复用同一套 `scanMarkdownLines` 核心逻辑，与主编辑器路径共享，逻辑一致性有保证）。
