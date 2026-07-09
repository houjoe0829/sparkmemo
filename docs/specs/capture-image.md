# 图片附件

## 目标与范围

在快速记录 Tab 里支持粘贴 / 拖拽 / 上传图片作为条目附件，并在保存前做两件事：一是在图片有 EXIF 时间且明显早于当前时刻时，询问用户是否用图片自带的拍摄时间和 GPS；二是把图片压缩成 WebP 后再落盘，减少 vault 体积。

**包含：**
- 图片的采集入口（粘贴、拖拽、点击上传）
- EXIF 时间与 GPS 的读取及确认弹窗
- WebP 压缩管线（含 iOS/Safari 兼容路径）
- 图片文件保存位置

**不包含：**
- 反向地理编码把坐标变成城市名（见 [locations.md](locations.md)）
- 语音录制（见 [capture-audio.md](capture-audio.md)）

## 用户可感知行为

- 在记录输入框内粘贴 / 拖入图片，或点击附件按钮上传：
  - 若图片带 EXIF 拍摄时间，且和「现在」相差较大（比如相册里翻出几天前的旧照），弹出确认框：「是否使用图片自带的时间 / 位置？」
  - 用户选「是」→ 条目时间戳用 EXIF 时间，GPS 以 `[地点](geo:lat,lon)` 形式附在文本里
  - 用户选「否」→ 用当前时间，忽略 EXIF
  - 关闭 `imageTimeCheck` 后不再弹，永远用当前时间
- 图片默认压缩为 WebP：
  - 质量由 `imageCompressionQuality` 控制（0.1–1.0，默认 0.8）
  - 长边超过 `imageCompressionMaxSize` 的会被等比缩到该值（默认 1920px，0 表示不限）
  - 关闭 `imageCompressionEnabled` 后按原格式保存
- 图片文件写入 `imageFolder`（vault 相对路径，空则用 Obsidian 的附件目录），文件名基于时间戳。
- 条目最终以 Markdown 图片语法插入 Memo section。

## 实现要点

- **EXIF 读取**：[exif.ts](../../src/exif.ts)（无外部依赖，纯手写 JPEG EXIF parser）。返回 `{ dateTimeOriginal?, gps? }`。
- **WebP 编码**：[webp-encoder.ts](../../src/webp-encoder.ts) 封装 `@jsquash/webp`（WASM）。走 WASM 的原因是 Safari / iOS 上 `canvas.toBlob('image/webp')` 不可用。
- **WASM 内联**：esbuild 用 `binary` loader 把 `@jsquash/webp` 的 `.wasm` 二进制打进 `main.js`，运行时无需外部文件。
- **确认弹窗**：capture-view 里对比 `exif.dateTimeOriginal` 与 `Date.now()`，差值超过阈值才弹；文案走 [i18n.ts](../../src/i18n.ts) 的 `capture.*` / `notice.*`。
- **保存路径**：`imageFolder` 为空时调用 Obsidian 的 `getAttachmentFolder()` 得到默认目录；文件名用当前时间戳 + 随机后缀避免冲突。
- **GPS 落地**：坐标写成 `[地名占位](geo:lat,lon)`，先用占位文本（如 `位置`），后续由 [locations.md](locations.md) 描述的地点 Tab 逆地理解码为城市名并可选回填。

## 已知约束与遗留

- **仅 JPEG 有 EXIF**：PNG / HEIC 等格式的时间/GPS 提取不支持；HEIC 目前也不做转码，Obsidian 端可能显示不了。
- **WebP 质量取舍**：默认 0.8 对手机截图友好，对艺术照略偏损；用户可自行调高。
- **压缩阻塞**：WASM 编码在主线程执行，超大图（10MB+）压缩时会短暂卡 UI，未来可考虑 Web Worker。
- **EXIF 时间无时区**：EXIF 里的 `DateTimeOriginal` 没有时区信息，直接当作本地时间使用；跨时区旅拍可能偏差。
