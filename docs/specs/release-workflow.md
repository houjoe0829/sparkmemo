## 发版流程

Spark Memo 已在 Obsidian 社区插件商店上架，每次发新版本都要走完整流程，避免烧版本号。

## 本地准备
1. 先提交已确认的源码与测试，工作区保持干净；本地串行运行 `npm run lint` 和全部回归测试，再在商店对目标代码运行「Review branch」。本次准备以已列出的错误、警告和建议清零为目标，不关闭规则或降低检查级别。
2. 确定发版时同步 `manifest.json`、`package.json`、`package-lock.json` 的版本号，在 `versions.json` 中登记对应的最低 Obsidian 版本。版本号使用纯 `x.y.z`，不带 `v` 前缀。
3. 本地运行 `npm run build` 验证，串行完成后再进行后续操作；构建会更新 `build-number.txt`。本机构建用于验证，不作为带来源证明的正式附件。
4. 在 `release/新版本/RELEASE_NOTES.md` 准备英文发布说明，先展示全文并经用户确认。提交、推送、打标签、运行云端构建和创建 Release 需要明确授权，不因通过本地检查就自动执行。
## 构建与来源证明
`.github/workflows/build-attest.yml` 只允许手动触发，不监听 push、标签推送或 Release 事件。它没有发布 Release 的权限，只构建指定标签、生成来源证明并保存三个附件，后续仍手动发布。
1. 先将发版指引、工作流、打包脚本和版本提交一并推送，再创建并推送新标签。仓库作为 fork 时，如果 Actions 尚未启用，需另经确认后在 GitHub 启用，不能误认为工作流已运行。
2. 用同一个标签指定工作流引用和构建输入，确保 GitHub 记录的来源提交与实际构建提交一致。以下命令仅在获准正式发版后执行：

```bash
gh workflow run build-attest.yml --ref x.y.z -f tag=x.y.z --repo houjoe0829/sparkmemo
gh run list --workflow build-attest.yml --repo houjoe0829/sparkmemo
gh run watch RUN_ID --exit-status --repo houjoe0829/sparkmemo
```

3. 核对运行对应的标签和提交。工作流会拒绝非版本标签、标签引用与输入不一致、检出提交与 GitHub 来源提交不一致的情况，再串行执行锁定依赖安装、零警告检查、全部测试和构建。
4. `scripts/package-release.cjs` 核对所有版本字段和最低 Obsidian 版本，将 `dist/main.js`、`manifest.json`、`styles.css` 原样打包。来源证明与上传工作流产物使用同一组文件；不存在或为空的构建文件、版本不一致和已有输出目录都会阻止打包，不覆盖旧包。
5. 工作流成功后，将该次运行的 `spark-memo-x.y.z` 产物下载到新建的 `release/x.y.z/`，不要重新构建或修改附件。下载前确认目录中没有旧附件，不能使用覆盖参数掩盖冲突。

```bash
gh run download RUN_ID --name spark-memo-x.y.z --dir release/x.y.z --repo houjoe0829/sparkmemo
gh attestation verify release/x.y.z/main.js --repo houjoe0829/sparkmemo
gh attestation verify release/x.y.z/styles.css --repo houjoe0829/sparkmemo
gh attestation verify release/x.y.z/manifest.json --repo houjoe0829/sparkmemo
```

来源证明只有在 GitHub 上实际运行工作流后才会生成。本地工作流检查、SHA256 一致或构建通过，都不能代替真实来源证明验证。当前已发布的版本不回填、不覆盖，改动用于下一个版本。
## 创建发布
使用已验证来源证明的三个文件，手动创建 GitHub Release：

```bash
gh release create x.y.z --repo houjoe0829/sparkmemo --verify-tag \
  --title "x.y.z" --notes-file release/x.y.z/RELEASE_NOTES.md \
  release/x.y.z/main.js release/x.y.z/manifest.json release/x.y.z/styles.css
```

创建后核对 `draft` 和 `prerelease` 都为 false，附件恰好为三个。重新下载正式附件再验证来源证明，不能用本地旧包代替线上验收。推送成功、工作流成功、Release 成功和商店审核通过是独立状态，分别汇报。
## 商店端触发审核
Obsidian 插件商店 admin 页面有两个按钮：
- **Review branch** —— 对 main 分支最新代码跑 lint。不需要 Release 就能跑，用来提前确认代码干净
- **Check for new release** —— 检测到 `manifest.json` 版本 ≠ 上次已审版本时，会自动拉对应 tag 的 Release 跑 lint。发版后点这个

## 推荐顺序
本地检查和测试 → 商店分支预审 → 经确认升版本并写英文发布说明 → 提交版本并推送新标签 → 经授权手动运行标签工作流 → 下载并验证来源证明 → 经授权创建 Release → 商店检查新发布。
先运行 `npm run lint`，使用 ESLint 和 Obsidian 官方检查插件的推荐规则检查 `src/` 源码，再检查 `styles.css`，排除构建产物。CSS 检查禁止所有 `!important` 和 `:has()`，不再保留移动端留白例外；键盘避让改为记录面板自身的局部处理，手机真实键盘仍需真机验证。Moment 的 SDK 间接依赖通过 `overrides` 固定到安全修复版本 2.31.0，并同步锁文件；插件仍使用 Obsidian 提供的运行时实例，不额外打包 Moment，也不替换宿主内置版本。不自动修复、不关闭规则，也不调整错误或警告级别；有 Error 时先核对原因，Warning 不作为本地命令失败条件。本地检查与社区审核可能使用不同的规则版本和环境，因此「Review branch」这一步仍不能省。当前检查工具固定为 ESLint 9.39.5 和 eslint-plugin-obsidianmd 0.4.2；后者依赖的 eslint-plugin-import 2.32.0 尚未声明支持 ESLint 10，ESLint 9 已结束维护，因此该开发工具组合存在维护限制，后续需随上游兼容情况评估升级。0.2.4 就是靠它拦下一个 Error：`chat-pane.ts` 里 `style.height = 'auto'` 违反 `obsidianmd/no-static-styles-assignment`，改用 `setCssStyles({ height: 'auto' })` 才过。因为 tag 还没推，那次没烧掉版本号。

社区 Review 结果里只有 Error 阻断审核，Warning 不阻断。本地推荐规则可能将社区的某些 Warning 记为 Error，因此两边的数量和级别不能直接等同。类型、异步回调及弃用警告需要结合代码和实际行为核实，既不能直接视为故障，也不能一概认定无害；在单独确认范围后处理，不为清空警告批量修改发版代码。

## 铁律：tag 不可回收
Tag 一旦推到远端就别改指向。商店 review 系统会认死第一次看到的 SHA，force-push tag 之后也不会重跑。如果 Release 内容有问题，直接跳下一个版本号重发（例如 0.2.1 出错就跳 0.2.2），别在原版本号上打补丁。历史教训：0.2.1 因为 tag 打在了修复前的 commit 上，改了 tag 指向后审核依然认旧 SHA，最终只能跳到 0.2.2 才通过。
