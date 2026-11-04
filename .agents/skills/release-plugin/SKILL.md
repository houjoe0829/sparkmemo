---
name: release-plugin
description: 给 Spark Memo 发一个新版本，从商店 lint 预检、升版本号、构建打包、生成 release note，到推 tag 建 GitHub Release、核对结果、提示商店触发审核。当用户说「发版」「发个新版本」「发布插件」「上架新版本」「release 一下」时使用。仅适用于 sparkmemo 这个项目。
---

# 发布 Spark Memo 新版本

只用于当前项目（sparkmemo）。背景、历史踩坑和更详细的解释见 `docs/specs/release-workflow.md`，本文档是可执行的流程，不重复抄背景。

由 Agent 执行全部命令，用户只在两个环节介入：商店 Review branch 的结果，以及 release note 的确认。

## 铁律（先读，违反了只能烧版本号）

- tag 一旦推到远端就不能改指向。商店 review 认死第一次看到的 SHA，force-push 也不会重跑。Release 有问题就跳下一个版本号重发，不要在原版本号上打补丁。
- 三处版本号必须完全一致：`manifest.json`、`package.json`、`versions.json`。tag 名是纯版本号，不带 `v` 前缀。
- 本地先运行 `npm run lint`，按官方推荐规则检查插件源码，不自动修复、不关闭规则或调整级别。步骤一的 Review branch 仍不能省，本地与社区的规则版本和环境可能不同。
- 只有 Error 阻断审核，Warning 不阻断。不要为了消 Warning 在发版里改代码。

## 步骤

### 一、预检
1. 确认在 main 分支、工作区干净、本地与远端同步：
   ```bash
   git status --short && git rev-parse --abbrev-ref HEAD && git fetch -q && git status -sb | head -1
   ```
   有未提交改动就先停下来问用户是要提交还是要丢弃。
2. 列出上一个 tag 到 HEAD 的 commit，作为这次发版的内容清单：
   ```bash
   git log $(git describe --tags --abbrev=0)..HEAD --oneline
   ```
   清单为空说明没有可发的改动，直接告诉用户并停止。
3. 运行 `npm run lint`，核对本地 Error；Warning 不阻断本地命令。
4. 请用户在商店管理页对本次待发布的目标代码运行「Review branch」，并提供结果。在取得结果且确认没有 Error 前，必须停止，不得升版本号、推送版本标签或创建 Release。本地检查、GitHub 构建通过及用户授权发版，均不能替代商店预审。

### 二、确定版本号
根据 commit 清单给出建议（只有修复走 patch，有新功能走 minor），用 AskUserQuestion 让用户确认。确认后检查这个版本号没被用过：
```bash
git tag | grep '^0\.' ; ls release
```
只看 `0.x.y` 序列。仓库里如果混进无关 tag，不要拿它们判断版本。

### 三、升版本号并验证
1. 同步 `manifest.json`、`package.json` 和 `package-lock.json` 的版本号，在 `versions.json` 登记新版本及最低 Obsidian 版本。
2. 串行运行全部测试与 `npm run build`。本地构建会更新 `build-number.txt`，只用于验证，不把本机产物作为正式发布附件。构建失败先修到通过，不部署或重载。
3. `release/` 被 Git 忽略，英文说明和下载的附件保存在 `release/新版本/`。正式附件必须来自后续指定标签的 GitHub 工作流，不能在下载后再次构建或改写。

### 四、写 release note 并请用户过目（人工确认点）
1. 按 commit 清单写 `release/新版本/RELEASE_NOTES.md`，正文用英文，面向社区插件商店的用户，写用户能感知的变化，不要罗列 commit hash 和内部重构。参考上一个版本的 `release/上一版本/RELEASE_NOTES.md` 保持风格一致。
2. 把全文贴给用户看，用 AskUserQuestion 确认，选项为「可以，继续发布」「我要改，等我改完」「不发了」。
3. 商店分支预审和发布说明确认都是不可跳过的人工环节。发布说明未经用户确认，不得提交版本改动、推送版本标签或创建 Release。

### 五、提交版本并准备来源证明
发布说明确认后，按用户明确授权的范围提交、推送、打标签、运行云端工作流和创建 Release。只授权准备下一版时，在本地修改和验证后停止，不自动执行这些外部操作。
1. 精确暂存本次版本文件、`build-number.txt` 及已确认的相关改动，排除 `.Codex/` 和并行会话内容，不使用 `git add -A`。
2. 提交版本并推送新标签，旧标签不可移动。按 `docs/specs/release-workflow.md` 手动触发 `build-attest.yml`，`--ref` 和 `tag` 必须是同一个新版本标签，不能用 main 代替来源引用。
3. 记录对应运行 ID，检查该运行的提交、标签和完成状态。仓库 Actions 未启用时说明阻碍，获得授权后再处理，不通过别的上传路径绕开来源证明。
4. 下载该运行的三个附件到新的 `release/版本/` 目录，分别执行 `gh attestation verify`，再按已授权范围手动创建 GitHub Release。工作流本身只构建和生成证明，不发布 Release。
5. 来源证明验证失败时停止发布并定位，不改规则、不用本机重建包替代，也不覆盖旧发布附件。

### 六、核对
核对正式 Release 为非草稿、非预发布，附件恰好是 `main.js`、`manifest.json`、`styles.css`，英文说明与用户确认版本一致。重新下载线上附件，核对 SHA256、来源证明、标签提交以及工作区状态，分别汇报推送、云端构建、来源证明、发布和社区审核结果。

### 七、收尾
告诉用户去商店 admin 页面点 Check for new release，并说明这一步 Agent 做不了。同时提示：如果插件当前处于被商店移除的状态，发新版不会自动恢复上架，需要另外走 `obsidianmd/obsidian-releases` 的申诉流程。
