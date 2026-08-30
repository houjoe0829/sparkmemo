# 标签详情返回后标签列表变空

## 现象

在 Tags 标签页点进某一个具体标签的详情，停留一段时间后点返回，回到的标签列表是空的，一个标签都不显示。不稳定复现，停留越久越容易撞上。
出现后这个空态是粘住的：空列表里没有任何一行可以点击，也就没有任何操作能触发重扫，只能切到别的标签页再切回 Tags 才恢复。

## 根本原因

标签列表不实时计算。插件启动后把整个 vault 扫一遍，把「标签 → 相关 memo」做成一张总账存在 `tagAggIndex` 里。

`onOpen` 注册的 vault 监听器很激进：只要任何一个 `.md` 文件被 modify / create / delete，就把 `tagAggIndex` 整个置为 null，等下次有人来看时再重扫。

问题出在「下次有人来看」。绝大多数入口都做了防护，会先 `await loadTagIndex()` 再渲染，包括 `switchTab`、`ensureTagIndexAndRenderList`、`toggleTagExpand`、`openTagAggregation`、`runTagRewrite`。唯独 `backToTagList` 漏了，它直接调同步的 `renderTagList()`，撞上 `tagAggIndex === null` 就走了「无标签」的空态分支。

不稳定复现的原因也在这里：出不出现完全取决于停留详情页的那段时间里，vault 有没有发生 md 文件变更。变更来源很多：

- 在别的窗格编辑笔记
- Obsidian Sync 拉到远端改动
- 其他插件自动写文件
- 在详情页里直接编辑某条 memo，这个操作本身就会 `vault.modify`

## 修复

两处改动，都在 `src/capture-view.ts`。

一是 `backToTagList` 末尾的 `this.renderTagList()` 换成 `void this.ensureTagIndexAndRenderList()`。后者会先确保总账在手（不在就重扫），扫完再确认用户此刻确实还停在标签列表页，然后才渲染。总账还热着时 `loadTagIndex` 直接 resolve，正常路径没有额外开销。

二是新增 `renderTagStatusMessage`，专门承载扫描期间的「正在扫描」和「扫描失败」文案：

```ts
private renderTagStatusMessage(msg: string) {
  if (this.currentTab !== 'tag' || this.selectedTag !== null) return;
  this.disposeDays();
  this.timelineEl.empty();
  this.renderTopLevelMessage(msg);
}
```

原来 `buildTagIndex` 直接调 `renderTopLevelMessage`，而它只是往当前容器 append 一个 div，既不清空也不看用户在哪个页面。于是有两个副作用：后台扫描的文案会糊在标签详情页或搜索结果底部；从详情页返回触发重扫时，屏幕上残留的详情内容不会被清掉，出现「详情列表下面挂一行正在扫描」的错位。加上视图守卫和清空后，两个问题一起消失。

## 为什么没加 generation token

一开始设想过给异步扫描加一个递增版本号，让结果只在发起时的视图状态未变时才落到 DOM。实际看下来是多余的：

- `buildTagIndex` 是整段循环跑完后一次性 `this.tagAggIndex = index`，不存在半成品写回
- `tagAggLoadPromise` 已经做了并发去重，多个调用方 await 同一次扫描
- 「扫描进行中用户在列表和详情间来回切」这个场景，已经被 `currentTab === 'tag' && selectedTag === null` 守卫覆盖
- `renderTagList` 每次都先 `empty()` 再重画，结果不会叠加

真正的问题从来不是竞态写回，而是「缓存被作废后无人重建」。加版本号只增加复杂度和改坏的风险。

## 残留的一条低概率路径

`buildTagIndex` 开头如果 `appHasDailyNotesPluginLoaded()` 返回 false，会直接 return 且不给 `tagAggIndex` 赋值，同时 `loadTagIndex` 的 promise 正常 resolve，调用方接着渲染同样是空列表。

保持现状没有改：不赋值意味着下次访问会重试，比缓存一个空 Map 更合理。这条路径只在 Daily Notes 核心插件真的没加载时触发，此时提示文案本身就是对的。
