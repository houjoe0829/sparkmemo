# 快速记录侧边栏 — 设计文档

**日期**：2026-06-20
**状态**：Draft，待实现
**作者**：与 Claude 协作 brainstorming

> ⚠️ **本文档已过时，仅供参考。** 输入区自 2026-07-04 起经历多轮重设计（图片/录音改为「+」下拉菜单、支持多图九宫格展示、录音独立成附件、新增图片压缩等），本文档描述的「NOTE 按钮 + 纯文字输入」等设计已不适用于当前实现，请以最新代码和 README 为准。

---

## 背景与目标

Journal Partner 当前在 Obsidian 编辑器内提供时间戳高亮、回车自动插入时间戳、只读保护等能力，但记录入口仍依赖打开当天的 daily note 并定位到 `## Journal` 区块。本设计新增一个**右栏常驻的侧边栏视图**，提供：

- **今日时间线**：以 timeline 形式（左侧竖线 + 圆点节点）展示今天 `## Journal` 区块下的所有记录，只读
- **快速输入框**：多行 textarea + 「NOTE」按钮，按钮提交，写入今天的 daily note
- **零额外配置**：复用用户已有的 Obsidian Daily Notes 核心插件设置（文件夹、日期格式）

目标是让用户在不离开当前笔记的情况下，用语音输入法或键盘快速记一笔，并即时看到当天的时间脉络。

## 非目标

- 不在侧边栏支持编辑/删除已有条目（要改去编辑器）
- 不做跨日（凌晨 0 点）的自动检测，打开或刷新时按当前日期解析即可
- 不集成语音识别 SDK，依赖系统/输入法自带的语音输入
- 不做附件、标签选择器、模板等输入辅助功能（MVP 范围外）

## 用户体验

### 触发方式

- 命令面板：`Journal Partner: 打开快速记录侧边栏`
- 左侧 Ribbon 图标（时钟图标）一键唤起

视图打开后默认贴在右栏，可与编辑器并排使用。

### 视图布局

三段式，从上到下：

1. **顶部工具栏**：仅 ⟳ 刷新 + ↕ 排序（升/降切换）两个图标
2. **输入卡片**：白底圆角卡，多行 textarea + 紫色 NOTE 主按钮
   - placeholder：`What do you think now…`
   - Enter 换行（适合语音连续输入），点 NOTE 提交
   - textarea 为空或仅空白时按钮 disabled
3. **时间线区**：左侧一条淡紫色竖线（`--jp-ts-bg` 系色 `#ddd6fe`）贯穿所有条目；每条记录前一个圆点节点
   - 「最新一条」由 timestamp 字典序决定（最大者），与排序方向无关：升序时实心圆点在底部，降序时在顶部
   - 最新一条：实心紫色圆点（带光晕）
   - 其它：空心紫色圆环
   - 每条卡片：白色圆角 + 浅阴影，时间戳徽标（沿用 `.jp-timestamp`）+ 内容文本

### 排序

默认**降序**（最新在上）。点击 ↕ 图标在升序/降序间切换，状态保存到设置 `captureSortDesc`，下次打开记忆。

### 空状态

- 没装 Daily Notes 核心插件：「请先启用 Obsidian Daily Notes 核心插件后重新打开侧边栏」
- 今天的 daily note 不存在 / 没有 `## Journal` 标题：「今天还没有记录，写点什么吧 →」（指向输入框）

## 架构

### 文件组织

```
main.ts          — 插件 bootstrap、editor extensions、settings tab
                  （重构后从 section.ts 引入共享逻辑）
section.ts       — findSection、getTimestampRanges、generateTimestamp、
                  Rng 类型、JournalPartnerSettings interface
                  （从 main.ts 抽离的共享模块）
capture-view.ts  — JournalCaptureView extends ItemView
                  （时间线渲染 + 输入区 + vault 事件监听）
styles.css       — 追加 .jp-timeline、.jp-timeline-line、
                  .jp-timeline-dot、.jp-capture-card、.jp-capture-input 等
```

### 依赖

新增 npm 依赖：`obsidian-daily-notes-interface`（社区常用包，提供 `getDailyNote` / `getAllDailyNotes` / `createDailyNote` / `appHasDailyNotesPluginLoaded`）。

### 视图注册与生命周期

`main.ts` 的 `onload`：

```typescript
this.registerView(CAPTURE_VIEW_TYPE, leaf => new JournalCaptureView(leaf, this));
this.addCommand({
  id: 'open-capture-view',
  name: '打开快速记录侧边栏',
  callback: () => this.activateCaptureView(),
});
this.addRibbonIcon('clock', '快速记录', () => this.activateCaptureView());
```

`activateCaptureView()`：

1. 在所有 leaf 中找类型为 `CAPTURE_VIEW_TYPE` 的，找到则 `revealLeaf` 即可
2. 否则 `app.workspace.getRightLeaf(false).setViewState({ type: CAPTURE_VIEW_TYPE, active: true })`

`onunload`：`app.workspace.detachLeavesOfType(CAPTURE_VIEW_TYPE)` 清理视图。

## 数据流

### 读路径（时间线渲染）

1. 视图加载或 vault `modify` 事件触发 → `loadTodayJournal()`
2. 检查 `appHasDailyNotesPluginLoaded()`，false 则进入「未启用 Daily Notes」空状态
3. `getDailyNote(moment(), getAllDailyNotes())` 拿到今天的 `TFile`，不存在则进入「无记录」空状态
4. `vault.cachedRead(file)` 读取内容 → `findSection(content, settings.targetHeading, settings.headingLevel)` 定位区块
5. 区块内逐行 `parseJournalEntries(sectionText)`，得到 `Entry[] = { timestamp: string, text: string, lineIndex: number }[]`
6. 按 `captureSortDesc` 排序后渲染 timeline DOM

### 写路径（提交）

用户在输入框写完点 NOTE：

1. `text = textarea.value`，trim 后为空则中断
2. `now = generateTimestamp()`（沿用 `section.ts` 现有函数，HH:MM 格式）
3. `line = buildEntryLine(text, now)`，多行处理为 markdown 软换行（每行末尾 `  ` 后换行）
4. 定位今天的 daily note：
   - 文件不存在：`createDailyNote(moment())` 创建（按用户的 Daily Notes 模板）
   - 文件存在但没有 `## Journal`：在 `vault.process` 中往末尾追加 `\n## Journal\n`，再追加新条目
   - 文件 + 标题都存在：`vault.process(file, content => appendToJournalSection(content, settings, line))`
5. 写入成功 → 清空 textarea、按钮恢复
6. 写入失败 → Notice 报错，textarea 内容**保留**让用户重试

### 实时同步

- `this.registerEvent(this.app.vault.on('modify', file => { if (file?.path === this.todayFile?.path) this.rerender() }))`
- 提交后由 `vault.process` 触发的 modify 事件自动重渲染，无需手动刷新
- 顶部 ⟳ 按钮提供手动刷新通道（保险/手动场景）

## 关键函数

### `parseJournalEntries(sectionText: string): Entry[]`

逐行扫描区块文本，匹配 `^[-*+]\s+(\d{2}:\d{2})\s+(.*)$`：

- 仅顶层列表项（无缩进）参与解析；嵌套行视为**前一条的延续**，追加到 `text` 后用空格连接
- 缺时间戳的行：跳过
- 返回带 `lineIndex` 的数组（便于将来扩展）

### `buildEntryLine(text: string, ts: string): string`

构造写入行：

- 单行：`- ${ts} ${text}`
- 多行（包含 `\n`）：每行末尾 `  ` 然后用 `\n` 拼接，第一行带前缀 `- ${ts} `，例如：

  ```
  - 16:17 第一行  
    第二行  
    第三行
  ```

  其中续行带 2 空格缩进 + 末尾 2 空格软换行，符合 markdown 标准且保持列表结构

### `appendToJournalSection(content: string, settings, line: string): string`

在 `## Journal` 区块末尾插入 `line`：

- `findSection` 返回的 `section.to` 即区块正文结束位置（不含后续同级标题），在该位置前插入 `${line}\n`
- 区块尾部若已是连续多个 `\n`，不再额外补换行；尾部无 `\n`，补一个
- 区块不存在：`content` 末尾追加 `\n## Journal\n${line}\n`（`content` 末尾无换行时先补 `\n`）

### `JournalCaptureView extends ItemView`

- `getViewType()` → `CAPTURE_VIEW_TYPE`
- `getDisplayText()` → `快速记录`
- `getIcon()` → `clock`
- `onOpen()`：构建 DOM 骨架、挂 vault `modify` 监听、首次 `loadTodayJournal()`
- `onClose()`：注销监听、清理 DOM
- `rerender()`：节流 / 简单 debounce 后重读文件并刷新 timeline

## 设置变更

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `captureSortDesc` | boolean | `true` | 时间线排序方向（true=最新在上）。点击工具栏排序图标切换并保存 |

不新增侧边栏开关设置，视图通过命令/Ribbon 图标管理。

## 错误处理

| 场景 | 处理 |
|------|------|
| Daily Notes 核心插件未启用 | Notice + 空状态提示 |
| 今天的 daily note 不存在 | 时间线空状态；提交时调用 `createDailyNote` |
| `## Journal` 标题不存在 | 时间线空状态；提交时追加标题再写内容 |
| `vault.process` 写入失败 | Notice 报错，textarea **不清空** |
| textarea 仅空白 | NOTE 按钮 disabled |
| 用户改了 `targetHeading` / `headingLevel` | 视图监听同一 settings，下次重渲染按新标题查找 |

## 样式（styles.css 追加）

CSS 变量：

- `--jp-timeline-line: var(--jp-ts-bg, #ede9fe)` — 竖线颜色
- `--jp-timeline-dot: var(--jp-ts-color, #7c3aed)` — 节点圆点颜色

关键类：

- `.jp-timeline` — 容器，`position: relative; padding-left: 24px`
- `.jp-timeline::before` — 竖线，`position: absolute; left: 7px; width: 2px; background`
- `.jp-timeline-entry` — 单条目，`position: relative; margin-bottom: 14px`
- `.jp-timeline-dot` — 圆点节点，绝对定位在 `left: -22px`
- `.jp-timeline-dot--latest` — 最新条目实心紫色 + 光晕（`box-shadow: 0 0 0 1px ...`）
- `.jp-capture-card` — 输入卡片白底圆角
- `.jp-capture-input` — textarea
- `.jp-capture-submit` — 紫色 NOTE 按钮，disabled 灰色

支持暗色主题：使用 Obsidian 变量（`--background-primary` / `--background-secondary` / `--text-normal`）。

## 测试

### 单元测试（新增 Jest 配置）

放在 `__tests__/` 目录，跑 `npm test`：

- `parseJournalEntries`：列表标记 `-/*/+` 三种、缺时间戳行（跳过）、嵌套行（合并到前一条）、空区块、纯空白文本
- `buildEntryLine`：单行、多行（验证软换行格式）、首尾空白裁剪
- `appendToJournalSection`：区块存在 / 不存在、文件末尾无换行、区块后有其它同级标题

### 手测清单

- [ ] Ribbon 图标点击 / 命令面板能打开侧边栏
- [ ] 今天有 daily note 时时间线正确展示，最新条目实心圆点
- [ ] 切换排序，圆点 + 顺序同步反转
- [ ] 输入并点 NOTE：文件被追加 `- HH:MM 文字`，时间线立即出现新条目
- [ ] 多行输入：文件里看到正确的软换行格式
- [ ] 在编辑器里改 `## Journal`，侧边栏自动更新
- [ ] 没装 Daily Notes 核心插件 → 看到友好提示
- [ ] 今天还没有 daily note，提交后自动创建文件
- [ ] 文件无 `## Journal` 标题，提交后自动追加标题

## 实现里程碑

1. 抽出 `section.ts` 共享模块，`main.ts` 改为引用（不改行为）
2. 新增 `capture-view.ts` 骨架（空视图 + 注册 + Ribbon 图标）
3. 时间线读路径：`parseJournalEntries` + DOM 渲染 + 静态样式
4. 写路径：`buildEntryLine` + `appendToJournalSection` + 文件创建 fallback
5. 实时同步 + 排序切换 + 设置持久化
6. 单元测试 + 暗色主题样式 + 手测打磨
