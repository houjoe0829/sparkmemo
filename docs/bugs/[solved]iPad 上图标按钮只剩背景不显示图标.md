# iPad 上图标按钮只剩背景不显示图标

## 现象

iPad 上打开 Quick Capture，输入框下方那排圆形图标按钮（加号、标签、@、定位）、发送按钮、搜索框右侧的随机按钮等，只显示一个圆形背景，里面的图标不见了。iPhone 上正常。同一批问题还伴随界面元素被压缩、iPad 与 iPhone 布局不一致。

## 根本原因

三层原因叠在一起，其中第一条是图标消失的直接原因。

### 尺寸没钉死，被 Obsidian 移动端样式顶掉

这些按钮是 `<button>` 元素，CSS 里给 `padding`、`display`、`background`、`color` 都加了 `!important`，说明历史上确实和 Obsidian 的按钮样式打过架，但唯独 `width` 和 `height` 没加。

Obsidian 移动端样式表用的是 `.is-mobile button`，特异度 (0,1,1)，高于 `.jp-capture-plus-btn` 的 (0,1,0)，会覆盖掉按钮的 `width` / `height` / `min-height`。按钮被撑成 `--input-height` 之后，`border-radius: 50%` 和带 `!important` 的背景色仍然生效，所以圆圈照样显示；而里面 18px 的 svg 被变形的 flex 盒子挤出可视区，就成了「只剩背景」。

iPhone 上不暴露，是因为 iPhone 的 `--input-height` 数值恰好不产生冲突。

### 插件没有 iPad 这条分支

判断移动端只用了 `Platform.isMobile` 和 CSS 的 `.is-mobile`。但 Obsidian 实际给三个身份：`.is-mobile`、`.is-phone`、`.is-tablet`。iPad 是「is-mobile 加 is-tablet，没有 is-phone」。仓库里 `.is-tablet` 和 `Platform.isTablet` 一次都没出现，所以为 iPhone 写的所有补丁 iPad 全盘照吃，iPad 独有的情况一条都没处理。

### 唯一的断点判断的是窗口宽度

整个 `styles.css` 里只有一个 media query，`min-width: 520px`，匹配窗口视口而非面板宽度。iPhone 约 390px、iPad 约 810px 起，两者永远落在不同分支，这是「长得不一样」的来源。加上 UI 尺寸基本按 300px 宽的右侧栏手调死像素，而 iPad 上视图被挂到主编辑区全宽 tab（`Platform.isMobile ? getLeaf(true) : getRightLeaf(false)`），一套窄栏像素被摊到 700 到 1000px 上，就是「右边留白、内容挤在左边」。

## 修复

给所有固定尺寸的图标按钮补齐尺寸锁定，模板如下，`.jp-day-nav-btn` 和 `.jp-tab-btn` 是最早修好的两个参照样本：

```css
.jp-some-icon-btn {
  display: inline-flex !important;
  box-sizing: border-box !important;
  flex-shrink: 0 !important;
  flex-grow: 0 !important;
  width: 26px !important;
  height: 26px !important;
  min-width: 26px !important;
  min-height: 26px !important;
  max-width: 26px !important;
  max-height: 26px !important;
  padding: 0 !important;
  border-radius: 50% !important;
  -webkit-appearance: none !important;
  appearance: none !important;
}
.jp-some-icon-btn svg {
  width: 15px !important;
  height: 15px !important;
  min-width: 15px !important;
  min-height: 15px !important;
  flex-shrink: 0 !important;
  display: inline-block !important;
}
```

已覆盖的按钮：capture 的加号 / 标签 / @ / 定位 / 发送、搜索框的放大镜与随机按钮、日历翻月、日期标题的定位按钮、定位页返回、录音停止、附件删除叉、时间胶囊清除叉，以及 chat 的发送 / 返回 / 删除会话 / 附件删除 / 工具按钮。

文字类按钮（今天、确认、取消、重试）只锁 `padding` 没有意义，它们本来就该跟随字号伸缩，硬锁会挤掉文字，因此不处理。

## 两个必须一起处理的连带问题

### 带收起动画的按钮，状态规则也要加 !important

`.jp-capture-submit` 在录音时靠 `.jp-capture-actions.is-recording` 的 `max-width: 0` 收起。基础规则加了 `min-width: 34px !important` 之后，CSS 里 `min-width` 优先级高于 `max-width`，按钮就再也收不起来了。收起态必须同步解除下限：

```css
.jp-capture-actions.is-recording .jp-capture-submit {
  min-width: 0 !important;
  max-width: 0 !important;
}
```

保留 `max-width` 参与过渡，动画不受影响。`.jp-recording-stop` 在 `.jp-recording-bar.is-transcribing` 下用 `max-height: 0` 收起，同理处理。

### display 带 !important 的元素不能用 hide() 隐藏

`hide()` 写的是内联 `display: none`，而内联样式打不过 author stylesheet 里的 `!important`。`.jp-tab-btn` 早就遇到过并改用了 `.is-hidden` class，但 `.jp-location-view-btn` 没有，导致标签搜索按钮进详情页后藏不掉（属于本次一并修掉的既存 bug）。

统一改法：CSS 加 `.xxx.is-hidden { display: none !important; }`，JS 侧把 `hide()` / `show()` 换成 `classList.add/remove('is-hidden')`。涉及 `tagAggBackBtn`、`locationBackBtn`、`tagSearchBtn` 共 12 处调用。

## 排查方法

这类问题可以机械化扫描，不必肉眼逐个撞。思路是：取出所有 `createEl('button', { cls: ... })` 的类名，再解析 `styles.css` 的规则，找出「命中这些类名、且有固定像素尺寸属性、且该属性没有 `!important`」的组合。

另有一个反向检查同样重要：找出「CSS 里 `display` 带 `!important`」与「JS 里对该元素调用 `hide()` / `show()`」的交集，这类组合必然是失效的隐藏逻辑。

## 尚未处理

以下属于同一批 iPad 适配问题，本次未动，留待后续：

- 引入 `.is-tablet` / `Platform.isTablet` 分支，把 iPad 从 iPhone 的补丁里分离出来
- 断点从窗口宽度改为面板宽度（container query 或 JS 测量）
- 统计区 KPI 在 iPad 上被强制 4 列，配合 `min-width: 0` 导致数字压扁
- 地图缩放只跟高度算（`worldPx = height * WORLD_ASPECT`），不是等比；且 ResizeObserver 有 8px 阈值，横竖屏切换时高度接近会跳过重绘
- 全屏预览用 `100vw` / `100vh`，在 iPad 分屏下不等于面板实际尺寸
- chat 面板判断的是 `Platform.isDesktopApp`，iPad 上被整块隐藏；标签右键菜单只在非移动端绑定，iPad 上没有重命名 / 合并 / 删除入口
- 把这套尺寸锁定抽成公共 class（如 `.jp-icon-btn`），避免新增按钮再次踩坑
