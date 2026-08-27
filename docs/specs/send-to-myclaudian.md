# 发送至 MyClaudian

## 目标与范围

把某一条 memo 连同一句自定义指令交给 MyClaudian 插件处理，入口是 memo 右键菜单的「发送至 MyClaudian」。Spark Memo 自己不再维护任何对话界面，只负责组织内容并交接。

**包含：**
- 右键菜单入口的显示条件
- 发送弹窗（memo 预览、输入框、一键建议、发送按钮）
- 交给 MyClaudian 的消息正文格式

**不包含：**
- 对话界面本身（全部由 MyClaudian 承担）
- 会话持久化、模型选择、权限控制（同上）
- memo 里的图片（当前只发送文本，图片不随消息走）
- 手机端支持（MyClaudian 是桌面端插件）

## 用户可感知行为

- 功能默认关闭，且设置面板里没有开关。想启用只能改 `src/section.ts` 里 `DEFAULT_SETTINGS.sendToMyClaudianEnabled`，重新构建。这是有意为之：它只在本机同时装了 MyClaudian 时才有意义，不该出现在一个陌生用户的设置页里。
- 三个条件同时满足，右键菜单里才出现「发送至 MyClaudian」：开关已打开、当前是桌面端、本机 MyClaudian 已启用且版本支持 `sendFromPlugin`。任何一条不满足，菜单项直接不出现，而不是出现后点了没反应。
- 点击后弹出发送弹窗，从上到下依次是：memo 只读预览（带日期时间）、输入框、一键建议、发送按钮。
- 输入框留空也能直接发。回车发送，Shift 加回车换行。
- 一键建议共三条，点一下立即发送，不经过输入框。用户一旦在输入框里打字，建议区隐藏；清空后恢复。
- 一键建议固定用中文，不跟随 Obsidian 界面语言。memo 是用中文写的，回复也希望是中文，跟界面语言无关。弹窗其余文案仍跟随界面语言，所以英文界面下这里是中英混排。
- 发送成功后弹窗关闭，MyClaudian 的侧边栏被唤到前台，内容落在一个新开的会话里并已自动发出。

## 实现要点

### 与 MyClaudian 的接口

MyClaudian 在主类上公开了 `sendFromPlugin({ text, startNew })`，Spark Memo 通过 `app.plugins.plugins['myclaudian']` 拿到实例后直接调用。

`src/myclaudian-bridge.ts` 负责识别：插件 id 必须是 `myclaudian`，且 `sendFromPlugin` 必须是函数。检查方法而不是只认 id，是因为旧版 MyClaudian 装着也调不通，这时菜单项应该跟没装一样不出现。

发送时机上还有一次重复检查：弹窗打开期间用户可能把 MyClaudian 禁用掉，所以点发送时会重新解析一次实例。

### 一键建议的写法

memo 是用户已经想完的一个念头，所以三条建议没有一条是「解释这条在说什么」，被告知自己刚写了什么没有价值。三条都朝外推：往下推演、反过来追问、去 vault 里找呼应。

按钮上显示的文案和实际发出去的提示词不是同一句。按钮要短才好看，而短指令在模型看来很容易被当成「总结一下」，所以每条提示词都多带一句限定，比如「不用复述我写的，直接往外推」。这句限定是有用的，不是修辞。

### 消息正文格式

由 `composeMessage()` 拼装，结构是：用户指令、空行、来源行、memo 正文逐行加 `> ` 引号。

引号而不是 XML 标签，是为了让模型能区分「用户的指令」和「被讨论的文本」，同时不引入模型可能试图回答的标签结构。

### 设置项

只有一个 `sendToMyClaudianEnabled: boolean`，默认 `false`，不在设置面板渲染。

## 历史

0.2.x 期间这里曾经是一套自带的对话功能（`chat-pane.ts` / `chat-runtime.ts` / `chat-store.ts`），自己 spawn 本机 `claude` 命令行跑 headless 对话，会话存在 vault 的 `.spark-memo/chats/` 下。这套实现已整体移除，改为交接给 MyClaudian，理由是同一台机器上没必要维护两套对话界面。

移除时不会清理用户 vault 里已有的 `.spark-memo/chats/` 目录，需要用户自行删除。
