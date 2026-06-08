# 快速参考指南 - Journal Partner 插件

## 🎯 最新功能（已完成）

### ✅ Enter 键 - 自动时间戳（修复完成）

**顶级项：** 新行自动添加时间戳
```
之前：- 06:42 任务
按 Enter
之后：- 06:42 任务
      - HH:MM 新一行 ✅ 自动生成时间戳
```

**嵌套项：** 新行仅保留结构，无时间戳
```
之前：  - 07:31 子任务
按 Enter
之后：  - 07:31 子任务
      -              ✅ 只有缩进和 marker
```

---

### ✅ Tab 键 - 自动删除时间戳（新功能）

**顶级项缩进：** 删除时间戳后缩进
```
之前：- 06:42 任务
按 Tab
之后：  - 任务         ✅ 时间戳被删除
```

**嵌套项缩进：** Obsidian 默认处理
```
之前：  - 07:31 子任务
按 Tab
之后：    - 07:31 子任务 ✅ 再次缩进（无改动）
```

---

## 📊 功能对比表

| 功能 | Enter 键 | Tab 键 |
|-----|---------|--------|
| **作用对象** | 所有项 | 顶级项 |
| **顶级项行为** | 新行自动插入时间戳 | 删除时间戳后缩进 |
| **嵌套项行为** | 新行仅保留缩进和marker | Obsidian 默认处理 |
| **时间戳处理** | 新增 | 删除 |
| **状态** | ✅ 已修复 | ✅ 新增 |
| **编译** | ✅ 通过 | ✅ 通过 |
| **部署** | ✅ 完成 | ✅ 完成 |

---

## 📁 代码位置速查

| 功能 | 文件 | 函数 | 行号 |
|-----|------|------|------|
| Enter 修复 | main.ts | `createEnterKeymap()` | 259-326 |
| Tab 新增 | main.ts | `createTabKeymap()` | 337-411 |
| 集成 | main.ts | `createEditorExtensions()` | 186-250 |

---

## 🔧 使用命令

### 构建项目
```bash
cd /Users/xuan/VSCodeProjects/Journal-partner
npm run build
```

### 部署到 Obsidian
```bash
npm run deploy
```

### 在 Obsidian 中重新加载
按 `Cmd+P` → 输入 `Reload app without saving` → Enter

### 查看最近提交
```bash
git log --oneline -5
```

---

## 🧪 快速测试清单

### Enter 键验证
- [ ] 顶级项 Enter：新行应有时间戳 ✅
- [ ] 嵌套项 Enter：新行无时间戳 ✅
- [ ] 不同 marker（-/*/ +）都正确 ✅

### Tab 键验证
- [ ] 顶级项 Tab：时间戳删除 + 缩进 ✅
- [ ] 嵌套项 Tab：Obsidian 默认处理 ✅
- [ ] 无时间戳项 Tab：正常缩进 ✅

---

## 📖 文档导航

| 文档 | 内容 |
|-----|------|
| `TAB_TIMESTAMP_REMOVAL.md` | Tab 键功能详细说明 |
| `FIX_SUMMARY.md` | Enter 键嵌套列表修复 |
| `TEST_NESTED_LIST_FIX.md` | 完整测试用例 |
| `RECENT_UPDATES.md` | 最近更新总结 |
| `CLAUDE.md` | 代码库架构文档 |

---

## 💡 技术细节速查

### 正则表达式

**Marker 匹配（支持缩进）：**
```javascript
/^\s*([-*+]\s+)/
```

**Tab 时间戳匹配：**
```javascript
new RegExp(`^([-*+]\\s+)(${plugin.settings.timestampPattern})\\s+`)
```

### 缩进检测

```javascript
const indentMatch = line.text.match(/^(\s*)/);
const currentIndent = indentMatch?.[1] ?? '';
const isNested = currentIndent.length > 0;
```

### 事务处理

```javascript
const changes = [
  { from: deleteStart, to: deleteEnd, insert: '' },  // 删除
  { from: cursor.from, to: cursor.to, insert: '\t' }, // 插入
];
view.dispatch(state.update({ changes }));
```

---

## 📊 最新编译状态

✅ **最新编译：** 成功（无 TypeScript 错误）
✅ **最新部署：** 成功 (2026-06-09 07:55)
✅ **部署位置：** `/Users/xuan/Library/Mobile Documents/iCloud~md~obsidian/Documents/xuan/.obsidian/plugins/journal-partner`

---

## 🔍 故障排查

### 问题：Tab 键不删除时间戳

**解决：**
```bash
npm run deploy
# 然后在 Obsidian 中 Reload app without saving
```

### 问题：Enter 键嵌套项仍插入时间戳

**解决：**
```bash
npm run deploy
git log --oneline | head -1  # 确认 f03af0f 在列表中
```

---

## 📋 Git 提交历史

```
47536cc feat: auto-remove timestamp when indenting top-level items with Tab
f03af0f fix: handle nested list items correctly on Enter key
e85f9a1 refactor: extract GitHub image hosting to separate plugin
```

---

**版本：** 2.0.0+
**最后更新：** 2026-06-09
**状态：** ✅ 生产就绪
**所有功能：** ✅ 已完成和部署

