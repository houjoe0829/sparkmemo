# Journal Partner

一款陪你写日记的 Obsidian 插件。自动识别并高亮 Journal 区域的时间戳，让每一条记录的时间一目了然，同时配套一个快速记录侧边栏，让你随时把想法丢进今天的日记。

![Obsidian plugin](https://img.shields.io/badge/Obsidian-Plugin-7c3aed?style=flat-square&logo=obsidian&logoColor=white)
![License](https://img.shields.io/github/license/zhaohongxuan/journal-partner?style=flat-square)

---

## 效果预览

在 `## Journal` 区域下，每行行首的 `HH:MM` 时间戳会被渲染为醒目的胶囊徽标：

```
## Journal

- 06:42 把我的工作笔记从 Obsidian 工作流中移出去
- 07:31 成功安装并配置了 OpenClaw！
- 08:10 多花点时间做自己的事情，跑步、读书、练字都行
```

↓ 渲染后时间戳高亮显示，颜色可自定义。

<img width="647" height="224" alt="image" src="https://github.com/user-attachments/assets/1ad2df5b-b918-46f5-822f-1fcee89bbf3c" />


## 功能

### ✍️ 时间戳与编辑增强

- **时间戳高亮**：在编辑器（Source / Live Preview）和阅读视图中均生效
- **自定义颜色**：在设置中用拾色器分别设置文字色和背景色，改动实时生效
- **自定义作用范围**：指定目标标题名称（如 `Journal`）和层级（如 `##`），插件只在该区域内生效
- **时间戳只读**：开启后无法在编辑器中修改已有时间戳，防止误删或误改
- **回车自动插入时间戳**：在 Journal 区块内按回车时，新行自动以当前 `HH:MM` 起头
- **Tab 缩进保留时间戳**：在条目首部按 Tab 时，时间戳与内容一起缩进，光标停在新位置
- **自定义正则**：默认匹配 `HH:MM` 格式，可修改为任意正则表达式以适配其他时间格式
- **圆形复选框**：可选地将 Journal 区域内的复选框渲染为圆形而非方形

### 🪶 快速记录侧边栏

点击侧栏羽毛笔图标或调用命令 **「打开快速记录侧边栏」** 即可打开，专为零阻力速记设计：

- **基于 Daily Notes**：自动写入今天日记的 `## Journal` 区段；若文件或区段不存在则自动创建（依赖 Obsidian 内置「Daily Notes」核心插件）
- **多行输入框**：支持系统语音输入法、回车换行；点击 NOTE 写入，自动保留 markdown 软换行结构
- **气泡时间线**：每条记录以「时间胶囊 + 内容气泡」呈现，带有平滑的连接弧线，颜色与时间戳样式同源
- **跨天无限滚动**：今天置顶；向下滚动自动加载更早有内容的日子，直到 365 天前为止
- **实时同步**：在主编辑器里改动当天日记，侧边栏对应日的时间线会就地刷新
- **Markdown 渲染**：支持双向链接、嵌入图片、加粗斜体等，所有原生 Obsidian 渲染特性均可用
- **排序切换**：按当日时间正序 / 倒序展示，自由切换
  
<img width="1783" height="1166" alt="image" src="https://github.com/user-attachments/assets/ad0b758f-d304-4b16-ae81-c2b3afd7aa5e" />

---

## 安装

### 手动安装

1. 前往 [Releases](https://github.com/zhaohongxuan/journal-partner/releases) 下载最新版本的 `main.js`、`manifest.json`、`styles.css`
2. 将三个文件复制到你的 Vault 的 `.obsidian/plugins/journal-partner/` 目录下
3. 在 Obsidian 设置 → 第三方插件 中启用 **Journal Partner**
4. （快速记录功能）确保 Obsidian 内置「Daily Notes」核心插件已启用

---

## 使用快速记录

1. 点击左侧栏的羽毛笔图标，或在命令面板（⌘P）中执行 **「打开快速记录侧边栏」**
2. 在输入框中写下任何想法，按 NOTE 提交
3. 内容会以 `- HH:MM 文字` 的形式追加到今天日记的 `## Journal` 区段
4. 时间线顶端始终是今天，向下滚动可继续浏览历史日记

> 多行输入会被保存为带 markdown 软换行的列表项，渲染时保持段落结构。

---

## 设置说明

打开 Obsidian 设置 → 插件选项 → **Journal Partner**：

### 📍 作用范围

| 设置项 | 说明 | 默认值 |
|---|---|---|
| 目标标题名称 | 插件生效的标题文字（不含 `#`） | `Journal` |
| 标题层级 | 目标标题的层级 | `H2` |

### 🎨 时间戳样式

| 设置项 | 说明 | 默认值 |
|---|---|---|
| 文字颜色 | 时间戳徽标的前景色（同时影响时间线弧线、内容气泡底色） | `#7c3aed` |
| 背景颜色 | 时间戳徽标的背景色 | `#ede9fe` |

### ⚙️ 行为

| 设置项 | 说明 | 默认值 |
|---|---|---|
| 时间戳只读 | 防止在编辑器中修改已有时间戳 | 开启 |
| 回车自动插入时间戳 | 在 Journal 区块内按回车时自动插入当前时间 | 开启 |
| 圆形复选框 | 在日记区域内将 checkbox 渲染为圆形而非方形 | 关闭 |

### 🔧 高级

| 设置项 | 说明 | 默认值 |
|---|---|---|
| 时间戳匹配正则 | 识别时间戳的正则表达式 | `\d{2}:\d{2}` |

---

## 开发

```bash
# 安装依赖
npm install

# 开发模式（保存自动重建）
npm run dev

# 生产构建
npm run build

# 部署到本地 Obsidian Vault（需在 deploy.sh 中配置 VAULT_PATH）
npm run deploy
```

构建产物为 `main.js`，与 `manifest.json`、`styles.css` 一起复制到插件目录即可。

---

## License

MIT
