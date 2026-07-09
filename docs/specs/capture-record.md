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
- 输入过程中输入 `@` 或 `#` 会弹出候选框：
  - `@`：过往出现过的人名 / 提及
  - `#`：过往出现过的标签
  - 候选按最近使用时间排序（见 commit `d38d445`）

## 实现要点

- **视图注册**：[main.ts](../../src/main.ts) 里 `registerView` 注册 `JournalCaptureView`，视图类型常量与 icon 定义在 [capture-view.ts](../../src/capture-view.ts) 顶部。
- **视图主体**：[capture-view.ts](../../src/capture-view.ts) 里的 `JournalCaptureView`（`ItemView` 子类）承载四个 Tab，「记录」是默认 Tab。
- **当日 daily note**：通过 `obsidian-daily-notes-interface` 获取模板、路径、格式化后的日期。
- **条目解析**：[section.ts](../../src/section.ts) 的 `parseJournalEntries()` 把 section 文本拆成 `{ timestamp, content, lineRange }` 结构，供时间线渲染。
- **追加/编辑/删除**：`section.ts` 提供 `appendToJournalSection` / 编辑与删除辅助函数，capture-view 直接调用；写入前先 `findSection` 确保 heading 存在，不存在时会自动补 heading。
- **候选补全**：capture-view 内部维护一份「历史提及 / 标签」缓存，从已解析的条目里抽取，按最近使用时间排序（commit `d38d445`）。移动端触发问题已在 `e88c889` 修复。
- **Notice 提示**：所有 toast 走 [notice.ts](../../src/notice.ts) 的封装，图标改用 lucide（见 `12490cf`）。

## 已知约束与遗留

- **单一 section**：只操作 `settings.targetHeading` 指向的那个 heading；一篇 daily note 里出现多个同名 heading 时只处理第一个。
- **追加位置**：始终追加到 section 末尾，不支持插入到中间；顺序由时间戳自身保证。
- **时间线懒加载**：按日期倒序加载，缓存已渲染的日期集合；如果用户在 Obsidian 里手动改了历史 daily note，需要重开视图才会看到最新内容。
- **命名遗留**：内部类型仍叫 `JournalEntry`、函数仍叫 `appendToJournalSection`，来自 Journal Partner fork，不改。
