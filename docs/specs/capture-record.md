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

一个轻量的 inline 补全器，让用户在输入框里打 `@` 或 `#` 就能从历史条目里挑一个已用过的提及 / 标签，避免同一个人名或标签写成多种变体。

**触发时机：**
- 光标前一个字符是 `@` 或 `#`，且该字符位于词首（前面是空白、行首、或标点），才弹出候选框。
- 弹出后随后续字符实时缩窄候选；输入空格、Enter 发送、Esc、或光标移出触发词范围时关闭。
- 候选框位置贴近光标，桌面端与移动端行为一致（移动端首次触发问题在 `e88c889` 修复）。

**候选来源：**
- `@` 候选：从历史所有 daily notes 的 Memo 条目里扫出的 `@xxx` 形式提及。
- `#` 候选：同样扫描历史条目，抽出 `#xxx` 形式标签。
- 扫描时机与搜索模块共用一份索引缓存（见 [search.md](search.md)），首次触发时懒加载，后续新增条目增量更新。

**排序规则（`d38d445`）：**
- 按「最近一次在条目里使用」的时间倒序排；最新用过的排最前。
- 相同时间的按字面序作为稳定 tiebreak。
- 未来若加使用频次维度可以再权衡，目前只按最近时间，够用且直觉。

**选中行为：**
- 键盘 ↑ / ↓ 选择，Enter 或 Tab 确认；鼠标 / 触摸点击直接确认。
- 确认后把从触发符起到光标位置的部分替换为完整的 `@name` / `#tag`，光标停在末尾并自动补一个空格。
- 用户不选、直接继续打字并按空格 / 回车，则输入的是原始文本（可以创建新的提及 / 标签）。

**已知约束：**
- 候选只从「历史里出现过的」提及 / 标签里挑，第一次输入某个新名字时列表可能为空，属预期。
- 不做拼音 / 首字母匹配，靠子串。
- 索引仅按 Memo section 内的条目扫描，section 外的 `@` / `#` 不进候选。

## 已知约束与遗留

- **单一 section**：只操作 `settings.targetHeading` 指向的那个 heading；一篇 daily note 里出现多个同名 heading 时只处理第一个。
- **追加位置**：始终追加到 section 末尾，不支持插入到中间；顺序由时间戳自身保证。
- **时间线懒加载**：按日期倒序加载，缓存已渲染的日期集合；如果用户在 Obsidian 里手动改了历史 daily note，需要重开视图才会看到最新内容。
- **命名遗留**：内部类型仍叫 `JournalEntry`、函数仍叫 `appendToJournalSection`，来自 Journal Partner fork，不改。
