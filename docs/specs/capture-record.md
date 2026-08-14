# 快速记录（Capture）

## 目标与范围

在 Obsidian 侧栏里提供一个「随手记」的输入面板，让用户不需要打开当日 daily note 就能把一段文字（或附件）追加到今天的 Memo section 里，并在同一个面板下方看到已有条目组成的时间线。

**包含：**
- 侧栏「记录」Tab 的输入框、发送逻辑、追加规则
- 当日条目的时间线渲染（连续滚动、按日期分组）
- 已有条目的编辑与删除
- 提及 / 标签候选（`@` / `#`）的补全

**不包含：**
- 图片附件的采集、EXIF、压缩（见 [capture-image.md](capture-image.md)）
- 语音附件的录制（见 [capture-audio.md](capture-audio.md)）
- 时间戳本身的编辑器渲染（见 [memo-timestamp.md](memo-timestamp.md)）

## 用户可感知行为

- 打开右侧栏的 Spark Memo 视图，默认停在「记录」Tab。
- 顶部是一个多行输入框，回车换行、Cmd/Ctrl+Enter 发送。
- 发送后：
  - 定位当天的 daily note（不存在时按 `obsidian-daily-notes-interface` 的模板新建）
  - 在 Memo section 末尾追加一条 `- HH:MM 内容` 的条目
  - 输入框清空，下方时间线立即多出一条
- 时间线下方按天分组，向下滚到底部会懒加载更早的日期。
- 条目支持行内操作：hover 显示编辑 / 删除按钮，编辑后原地保存回文件。
- 输入过程中输入 `@` 或 `#` 会弹出候选框，用于快速补全提及与标签（详见下方「提及与标签补全」）。

## 实现要点

- **视图注册**：[main.ts](../../src/main.ts) 里 `registerView` 注册 `JournalCaptureView`，视图类型常量与 icon 定义在 [capture-view.ts](../../src/capture-view.ts) 顶部。
- **视图主体**：[capture-view.ts](../../src/capture-view.ts) 里的 `JournalCaptureView`（`ItemView` 子类）承载四个 Tab，「记录」是默认 Tab。
- **当日 daily note**：通过 `obsidian-daily-notes-interface` 获取模板、路径、格式化后的日期。
- **条目解析**：[section.ts](../../src/section.ts) 的 `parseJournalEntries()` 把 section 文本拆成 `{ timestamp, content, lineRange }` 结构，供时间线渲染。
- **追加/编辑/删除**：`section.ts` 提供 `appendToJournalSection` / 编辑与删除辅助函数，capture-view 直接调用；写入前先 `findSection` 确保 heading 存在，不存在时会自动补 heading。
- **候选补全**：见下方独立小节。
- **Notice 提示**：所有 toast 走 [notice.ts](../../src/notice.ts) 的封装，图标改用 lucide（见 `12490cf`）。

## 提及与标签补全

一个轻量的 inline 补全器，让用户在输入框里打 `@` 或 `#` 就能快速引用 vault 里已有的笔记或标签，避免手打全名或写成多种变体。`@` 和 `#` 是两个独立的补全器，来源和排序规则都不同。

**触发时机（两者共用）：**
- 光标前一个字符是 `@` / `＠` 或 `#` / `＃`（同时接受半角与全角，iOS 中文键盘默认全角），且该字符位于词首（前面是空白或行首）才弹出。
- 弹出后随后续字符实时缩窄候选；Esc、光标移出触发词范围、或非法字符（`#` 下遇到空格 / 标点）时关闭。
- 候选框位置贴近光标，桌面端与移动端行为一致（移动端首次触发问题在 `e88c889` 修复）。

### `@` 候选（笔记提及）

**来源：** vault 里所有 markdown 文件（`app.vault.getMarkdownFiles()`），首次触发时按 mtime 倒序缓存，vault 或 metadata 变化时失效。

**匹配：**
- 空查询：直接展示全部（按下面的排序取前 8）。
- 有查询：按 basename 小写做前缀 vs 子串二分，**前缀匹配整组排在子串匹配之前**。

**排序规则：**
- **当前打开的 Tab（`workspace.getLeavesOfType('markdown')` 里的文件）优先**，同组内再按 mtime 倒序。
- 每次触发都实时读一遍打开的 Tab（Tab 切换和 vault mtime 无关，缓存反而容易过时）。
- 前缀组和子串组各自独立套用「打开的 Tab 优先 + mtime 倒序」。

**选中行为：** 通过 `metadataCache.fileToLinktext` 生成最短唯一 linktext，插入 `[[linktext]] `（末尾带空格）。

### `#` 候选（标签）

**来源：** vault 的 tag 索引（`getVaultTags`），带每个 tag 的使用次数和所在文件 mtime；另有一份可选的 tag 聚合索引（`tagAggIndex`），记录该 tag 最近一次在 Memo 条目里出现的时间戳——只有用户打开过标签浏览器才会建，没建时用 mtime 兜底。

**匹配：** 查询只允许 Obsidian tag 合法字符（unicode 字母数字 + `-` `_` `/`），且不能是纯数字（Obsidian 不识别 `#2026` 这类）。

**排序规则：**
- 空查询：按 `max(entry.lastTs, file.mtime)` 倒序。取 max 是为了兼容回填条目——即使条目写的是"昨天 09:00"，只要今天真的敲过，mtime 就会让它排到最前。tiebreak 依次为使用次数、字面序。
- 有查询：按匹配位置分层打分（低分排前）——完全相等 `0` / 整体前缀 `1` / 任一路径段前缀 `2`（用于嵌套 tag，如打 `child` 匹配 `#parent/child`）/ 普通子串 `3`。同分按使用次数倒序。

**选中行为（两者共用）：**
- 键盘 ↑ / ↓ 选择，Enter 或 Tab 确认；鼠标 / 触摸 mousedown 直接确认（用 mousedown 是为了赶在 textarea blur 之前）。
- 确认后把从触发符起到光标位置替换为完整的 `[[link]]` 或 `#tag`，光标停在末尾并自动补一个空格。
- 用户不选、继续打字并按空格 / Enter，则保留原始文本（可以创建新的 tag 或未链接的 `@name`）。

**已知约束：**
- 不做拼音 / 首字母匹配，靠子串。
- `#` 候选来自 vault 全量 tag，不区分 tag 是否出现在 Memo section 内。
- `@` 候选是 vault 所有 markdown，不做 alias 匹配、不按文件夹权重。

## 多行内容与空行

一条 memo 在文件里是一个列表项：首行 `- HH:MM 内容`，其余行缩进 2 空格挂在同一项下。这个格式决定了空行必须被当成一等公民对待，否则用户写的结构会在存取过程中被悄悄改掉。

**为什么空行不能丢：** 缩进的续行与用户自己写的 `- 甲` 处在同一层级，紧跟其后的普通文字会被 markdown 当作 lazy continuation 吸进最后一个 bullet 里。用户唯一能表达「这是独立段落」的手段就是空一行，所以写入、读回、渲染三个环节都必须原样保留它。

**写入（`buildEntryLine`）：** 保留用户敲的空行，写成真正的空行（不带缩进）。连续多个压成一个，首尾的丢弃。末尾的两空格软换行只加在「上下都是非空行」的位置。

**读取（`isContinuationLine`）：** 判断「这一行是否仍属于上一条 memo」的统一入口。缩进的非空行永远算；空行只有在后面还跟着缩进行时才算，否则 memo 之间和 section 末尾的空行会被吞进上一条，删除时连带消失。`parseJournalEntries` 和所有按行区间改写的函数（删除、删录音、改文本、批量改 tag、改地点名）以及 `parseLooseEntries` 都必须走它，否则解析出的文本和实际切掉的字符区间会对不上。

**填回输入框（`stripAttachmentEmbeds`）：** 只丢弃「因摘掉附件而变空的行」，用户敲的空行保留。两者都丢会让「编辑后原样保存」变成一次静默改写。

**渲染（`renderEntryBody` + `splitMarkdownBlocks`）：** 把 memo 文本按空行切块，每块单独 `MarkdownRenderer.render` 进各自的 `.jp-md-block`，间距加在块之间。必须这么做的原因是 markdown 不保留列表内空行的位置：列表项之间的空行不会把列表拆开，只会把整个列表从 tight 切成 loose（每个 `<li>` 多包一层 `<p>`），且是全局开关，因此 DOM 里分辨不出用户在哪几处空了行，纯 CSS 无解。围栏代码块内的空行是内容不是分隔符，切块时整体保留。

**代价：** 有序列表被空行切成多块时，每块重新从 1 开始编号；无序列表无影响。

## 已知约束与遗留

- **单一 section**：只操作 `settings.targetHeading` 指向的那个 heading；一篇 daily note 里出现多个同名 heading 时只处理第一个。
- **追加位置**：始终追加到 section 末尾，不支持插入到中间；顺序由时间戳自身保证。
- **时间线懒加载**：按日期倒序加载，缓存已渲染的日期集合；如果用户在 Obsidian 里手动改了历史 daily note，需要重开视图才会看到最新内容。
- **命名遗留**：内部类型仍叫 `JournalEntry`、函数仍叫 `appendToJournalSection`，来自 Journal Partner fork，不改。
