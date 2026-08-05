## 发版流程

Spark Memo 已在 Obsidian 社区插件商店上架，每次发新版本都要走完整流程，避免烧版本号。

## 一、本地准备
1. 改代码 + 提交到 main（普通 commit，不涉及版本号）
2. 决定发版时，改三处版本号：
   - `manifest.json` → `"version"`
   - `package.json` → `"version"`
   - `versions.json` → 加一行 `"新版本": "1.8.7"`（值是最低 Obsidian 版本）
3. 构建：`npm run build`
4. 打包：把 `dist/main.js`、`manifest.json`、`styles.css` 拷到 `release/新版本/`，同时写一份 `RELEASE_NOTES.md` 放在同目录
5. 提交 + 推送：`chore(release): x.y.z`

## 二、创建 GitHub Release
到 `github.com/houjoe0829/sparkmemo/releases/new`：
- Tag：填 `x.y.z`（纯数字，不带 `v` 前缀，必须和 `manifest.json` 里的版本完全一致）
- Target：选最新的 main commit
- Title：`x.y.z`
- Description：贴 `release/x.y.z/RELEASE_NOTES.md` 的内容
- Assets：上传 `main.js`、`manifest.json`、`styles.css` 三个文件（必须挂在 Release 里，仓库里有还不够）

## 三、商店端触发审核
Obsidian 插件商店 admin 页面有两个按钮：
- **Review branch** —— 对 main 分支最新代码跑 lint。不需要 Release 就能跑，用来提前确认代码干净
- **Check for new release** —— 检测到 `manifest.json` 版本 ≠ 上次已审版本时，会自动拉对应 tag 的 Release 跑 lint。发版后点这个

## 推荐顺序
```
改代码 → push → 商店点 "Review branch" 确认代码干净
                    ↓
                升版本号 + 构建 + 打包
                    ↓
                push commit + 建 GitHub Release
                    ↓
                商店点 "Check for new release"
```
这样把「代码问题」和「发版流程问题」拆开处理。

## 铁律：tag 不可回收
Tag 一旦推到远端就别改指向。商店 review 系统会认死第一次看到的 SHA，force-push tag 之后也不会重跑。如果 Release 内容有问题，直接跳下一个版本号重发（例如 0.2.1 出错就跳 0.2.2），别在原版本号上打补丁。历史教训：0.2.1 因为 tag 打在了修复前的 commit 上，改了 tag 指向后审核依然认旧 SHA，最终只能跳到 0.2.2 才通过。
