## 发版流程

Spark Memo 已在 Obsidian 社区插件商店上架，每次发新版本都要走完整流程，避免烧版本号。

## 一、本地准备
1. 改代码 + 提交到 main（普通 commit，不涉及版本号）
2. 决定发版时，改三处版本号：
   - `manifest.json` → `"version"`
   - `package.json` → `"version"`
   - `versions.json` → 加一行 `"新版本": "1.8.7"`（值是最低 Obsidian 版本）
3. 构建：`npm run build`
4. 打包：把 `dist/main.js`、`manifest.json`、`styles.css` 拷到 `release/新版本/`，同时写一份 `RELEASE_NOTES.md` 放在同目录（**正文用英文**，面向的是社区插件商店的用户）
5. 提交 + 推送：`chore(release): x.y.z`

## 二、创建 GitHub Release
本项目不做自动化发布，Release 一律手动建。原因是仓库是 `zhaohongxuan/journal-partner` 的 fork，GitHub 对 fork 仓库默认不跑 Actions，要在 Actions 页面手动点一次启用才会开。原先仓库里有一个 `release.yml`，从上架至今一次都没触发过，已在 0.2.4 时删掉，避免误以为推 tag 就会自动出 Release。

推荐用命令行建，比网页手动传文件快：
```bash
git tag x.y.z <commit>
git push origin x.y.z
gh release create x.y.z -R houjoe0829/sparkmemo \
  --title "x.y.z" \
  --notes-file release/x.y.z/RELEASE_NOTES.md \
  release/x.y.z/main.js release/x.y.z/manifest.json release/x.y.z/styles.css
```
建完用 `gh api repos/houjoe0829/sparkmemo/releases/tags/x.y.z` 核对一遍：`draft` 必须是 false，`assets` 必须是那三个文件。

也可以到 `github.com/houjoe0829/sparkmemo/releases/new` 手动建：
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
                有 Error 就修完再 push，重新点一次 Review
                    ↓
                升版本号 + 构建 + 打包
                    ↓
                push commit + 推 tag + 建 GitHub Release
                    ↓
                商店点 "Check for new release"
```
这样把「代码问题」和「发版流程问题」拆开处理。

「Review branch」这一步不能省。本地没有 eslint 环境（项目里没有任何 eslint 配置和依赖），商店那次 review 是唯一的 lint 检查。0.2.4 就是靠它拦下一个 Error：`chat-pane.ts` 里 `style.height = 'auto'` 违反 `obsidianmd/no-static-styles-assignment`，改用 `setCssStyles({ height: 'auto' })` 才过。因为 tag 还没推，那次没烧掉版本号。

Review 结果里只有 Error 阻断审核，Warning 不阻断。当前 main 上还有几十处 `@typescript-eslint/no-unsafe-assignment` 的 Warning，主要来自 Obsidian 的 `moment` 类型退化成 any、`requestUrl` 的 json 返回 any、以及 `chat-runtime.ts` 里刻意的动态 `require`，不是真实缺陷，留待单独一轮处理，不要混在发版里改。

## 铁律：tag 不可回收
Tag 一旦推到远端就别改指向。商店 review 系统会认死第一次看到的 SHA，force-push tag 之后也不会重跑。如果 Release 内容有问题，直接跳下一个版本号重发（例如 0.2.1 出错就跳 0.2.2），别在原版本号上打补丁。历史教训：0.2.1 因为 tag 打在了修复前的 commit 上，改了 tag 指向后审核依然认旧 SHA，最终只能跳到 0.2.2 才通过。
