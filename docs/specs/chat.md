# Memo 对话

## 目标与范围

以某一条 memo 为话题跟 AI 对话，入口是 memo 右键菜单的「聊聊这条」，对话开在侧栏新增的「对话」Tab 里。

**包含：**
- 右键菜单入口、对话 Tab、会话列表与单个会话视图
- 调用本机 `claude` 命令行的运行层、流式输出
- 会话持久化、memo 附件随消息发送、模型切换、上下文用量显示

**不包含：**
- 云端 API 直连（不存 API Key，鉴权完全交给已登录的命令行）
- 让 AI 读写 vault 文件（全程零工具权限）
- 手机端支持（依赖子进程，移动端没有这个能力）

## 用户可感知行为

- 功能**默认关闭**。设置 → 对话 → 打开「启用对话」后，Tab 栏才出现对话图标，右键菜单才出现「聊聊这条」。关闭后两个入口都消失，若当时正停在对话 Tab 会自动退回记录 Tab。
- 右击任意 memo 选「聊聊这条」，跳到对话 Tab 并新开一个会话。memo 显示为顶部的引用卡片，光标落在输入框，**不自动发送**。
- memo 自带的图片显示在引用卡片里，随第一条消息一起发给 AI，之后不再重复发送。
- 输入框是一个圆角卡片：附件缩略图在上、输入区居中、工具栏在下（模型切换、添加图片、上下文用量、发送键）。支持直接粘贴截图。
- 回复逐字流式显示。发送键在流式过程中变为停止键。
- 对话 Tab 默认展示会话列表，按最近更新排序。点进去聊，左上角箭头返回。悬停行右侧出现删除按钮，右键菜单里也有一份。
- 模型选择**按会话独立保存**；设置里的模型只作为新会话的默认值。

## 实现要点

- **运行层**（[chat-runtime.ts](../../src/chat-runtime.ts)）：`spawn` 本机 `claude`，stdout 是 NDJSON，逐行解析后转成统一的 `ChatChunk` 流。
- **精简调用**：默认参数会把用户的 MCP 服务、skill、hooks、CLAUDE.md 全量加载（实测「说三个字」一句要 2.7 万 token）。加上 `--tools ""`、`--strict-mcp-config` + 空 `--mcp-config`、`--setting-sources ""`、自定义 `--system-prompt` 之后降到约 200 token。
- **消息走 stdin**：统一用 `--input-format stream-json`，把消息作为 JSON 写进 stdin。这是附带图片的唯一途径，且让纯文本与带图两条路径不至于分叉。
- **会话续接**：首轮传 `--session-id <uuid>`，之后传 `--resume`，上下文由命令行自己维护，插件不重复发历史。
- **持久化**（[chat-store.ts](../../src/chat-store.ts)）：一个会话一个 JSON，存在 vault 的 `.spark-memo/chats/`。刻意不依赖 Obsidian（同 `stats.ts` / `map-view.ts` 的路子），调用方传入满足 `ChatStorageAdapter` 的对象即可，Obsidian 的 `vault.adapter` 天然符合。
- **发出第一条消息才建档**：只开不聊的会话不落盘、不进列表，避免「0 条消息」的空记录。
- **流式渲染节流**（[chat-pane.ts](../../src/chat-pane.ts)）：文本先累加，用 `requestAnimationFrame` 合并成一帧再整段重渲染 Markdown。不做这个的话每来一个 token 就重新解析一次，长回复会把界面卡死。

## 手机端安全约束

这是最容易翻车的地方：Obsidian 手机版没有 `child_process`，**只要它出现在模块顶层，插件在手机上会直接加载失败**——不是对话不能用，是整个 Spark Memo 打不开。

三道防线：
1. `chat-runtime.ts` 里 Node 模块一律用函数体内的 `require()`，不用顶层 `import`。
2. `scripts/build.js` 把 `fs` / `os` / `path` / `child_process` 列入 `external`，让 esbuild 原样保留这些 `require`，不要打包也不要提升。
3. capture-view 通过动态 `import()` 加载运行层，且所有入口都过 `Platform.isDesktopApp` 判断。

改动这块之后务必检查打包产物：`require` 必须都在函数体内，`init_chat_runtime` 必须是懒调用的。

## 已知约束与遗留

- **依赖本机 Claude Code**：没装或没登录就用不了。命令行路径可在设置里手填，留空则按 `~/.local/bin`、`/opt/homebrew/bin`、`/usr/local/bin` 等常见位置探测。
- **会话可能过期**：命令行侧的会话记录有自己的过期策略，太久之后 `--resume` 会失败，目前表现为该轮报错。**尚未做兜底**（预期做法：检测到失效就开新会话并把已有对话内容重新喂进去）。
- **只发图片**：录音等其它附件不随消息发送。HEIC、SVG 等接口不接受的格式会被跳过。
- **单条消息图片总量上限 12 MB**，超出的部分被丢弃并提示。
- **上下文用量是上一轮的结果**：数字来自每轮结束时命令行返回的真实用量，所以本轮发送前显示的是上一轮的值。

## 相关坑

`.jp-tab-btn` 带 `display: inline-flex !important`，Obsidian 的 `hide()` 写的是行内 `display: none`，**行内样式打不过 `!important`**——DOM 属性设上了但画面照旧。凡是被 `!important` 修饰过的元素，显隐都要靠同样带 `!important` 的类名（这里是 `.jp-tab-btn.is-hidden`）。
