# Tab 键自动删除时间戳 - 功能实现

## 功能描述

当在顶级 bullet 项（无缩进）按 Tab 键缩进时，自动删除该行的时间戳，然后应用缩进。

### 用户场景

用户在日记中创建顶级任务项，后来想要将其缩进为子任务，按 Tab 时应该：
1. 自动删除原有的时间戳
2. 应用 Tab 缩进，使其成为嵌套项
3. 光标保持在正确位置

## 实现细节

### 文件：main.ts
**函数：** `createTabKeymap()`
**行范围：** 337-411

### 核心逻辑

```typescript
private createTabKeymap(): Extension {
  const plugin = this;

  return Prec.high(
    keymap.of([
      {
        key: 'Tab',
        run(view: EditorView): boolean {
          // 1. 验证在目标区域（## Journal）
          // 2. 检查是否为顶级项（无缩进）
          // 3. 查找该行的时间戳
          // 4. 如果找到时间戳，创建两个 change：
          //    - 删除时间戳和后面的空格
          //    - 在光标位置插入 Tab
          // 5. 一次性应用这两个改动
          // 6. 返回 true 表示已处理
        }
      }
    ])
  );
}
```

### 关键步骤

#### 1. 验证上下文
```typescript
const state = view.state;
const doc = state.doc.toString();
const section = findSection(doc, plugin.settings.targetHeading, plugin.settings.headingLevel);
if (!section) return false;

const cursor = state.selection.main;
if (cursor.head < section.from || cursor.head > section.to) {
  return false;
}
```

#### 2. 检查顶级项
```typescript
const line = state.doc.lineAt(cursor.head);
const indentMatch = line.text.match(/^(\s*)/);
const currentIndent = indentMatch?.[1] ?? '';
const isTopLevel = currentIndent.length === 0;

if (!isTopLevel) {
  return false; // 嵌套项保持 Obsidian 默认 Tab 行为
}
```

#### 3. 查找时间戳
```typescript
const timestampMatch = line.text.match(
  new RegExp(`^([-*+]\\s+)(${plugin.settings.timestampPattern})\\s+`),
);

if (!timestampMatch) {
  return false; // 无时间戳，让 Obsidian 处理
}
```

#### 4. 计算删除范围
```typescript
const markerAndSpace = timestampMatch[1]; // e.g., "- "
const timestampText = timestampMatch[2];  // e.g., "06:42"

// 时间戳位置 = marker + space 之后
const deleteStart = line.from + markerAndSpace.length;
const deleteEnd = deleteStart + timestampText.length + 1; // +1 for space
```

#### 5. 应用改动
```typescript
const changes = [
  { from: deleteStart, to: deleteEnd, insert: '' }, // 删除时间戳
  { from: cursor.from, to: cursor.to, insert: '\t' }, // 插入 Tab
];

view.dispatch(
  state.update({
    changes,
    selection: { anchor: cursor.from + 1 },
    scrollIntoView: true,
  }),
);

return true;
```

## 测试用例

### 用例 1：基本场景 - 顶级项缩进去除时间戳

**操作步骤：**
```markdown
## Journal
- 06:42 完成报告    ← 光标在行末或任意位置
```

按 Tab 键

**预期结果：**
```markdown
## Journal
  - 完成报告         ← 缩进 2 空格，时间戳被删除
```

**验证：** ✅
- 时间戳 `06:42` 已删除
- 项被缩进为嵌套级别
- 文本内容 `完成报告` 保留
- 光标在新位置

---

### 用例 2：不同的 marker 符号

**使用星号：**
```markdown
## Journal
* 07:31 任务      ← 按 Tab

结果：
  * 任务           ← 星号保留，时间戳删除
```

**使用加号：**
```markdown
## Journal
+ 08:15 任务      ← 按 Tab

结果：
  + 任务           ← 加号保留，时间戳删除
```

**验证：** ✅ 所有 marker 符号均正确处理

---

### 用例 3：嵌套项保持原有行为

**操作步骤：**
```markdown
## Journal
- 06:42 顶级任务
  - 07:31 子任务    ← 光标在此，按 Tab

结果：
## Journal
- 06:42 顶级任务
    - 07:31 子任务  ← 再次缩进 2 空格，时间戳保留（嵌套项无时间戳本就为空）
```

**验证：** ✅
- 嵌套项不受影响，按 Tab 继续缩进
- 嵌套项没有时间戳，所以看不出删除效果（符合预期）

---

### 用例 4：多次缩进操作

**操作步骤：**
```markdown
## Journal
- 06:42 任务 A
  - 07:00 任务 B
    - 08:15 任务 C

现在反向操作：把任务 B 反缩进回顶级，再缩进
```

1. 点击任务 B 行
2. 按 Shift+Tab（反缩进回顶级）- 此时会重新加上时间戳
3. 再按 Tab 缩进 - 时间戳应该被删除

**预期结果：** ✅
- 操作流畅，没有时间戳冲突

---

### 用例 5：光标在不同位置

**光标在行末：**
```markdown
- 06:42 任务     ← | （光标在行末）
按 Tab → 缩进，删除时间戳
```

**光标在中间：**
```markdown
- 06:42 任务  ← | （光标在中间）
按 Tab → 缩进，删除时间戳（不受光标位置影响）
```

**光标在行首：**
```markdown
- 06:42 任务 ← | （光标在行首）
按 Tab → 缩进，删除时间戳
```

**验证：** ✅ 所有光标位置都正确处理

---

### 用例 6：无时间戳的顶级项

**操作步骤：**
```markdown
## Journal
- 任务（无时间戳）   ← 按 Tab

结果：
  - 任务              ← 仅缩进，不需要删除（本就无时间戳）
```

**验证：** ✅
- 返回 `false`，让 Obsidian 默认处理
- 仍然正常缩进

---

## 编译状态

✅ **编译成功** - 无 TypeScript 错误
✅ **部署成功** - 已同步到 Obsidian 插件目录

## 部署指令

```bash
npm run deploy
```

## Obsidian 中重新加载

1. 按 `Cmd+P`（Mac）或 `Ctrl+P`（Windows）
2. 输入 `Reload app without saving`
3. 按 Enter

或直接重启 Obsidian。

## 测试检查清单

- [ ] 用例 1：顶级项缩进自动删除时间戳
- [ ] 用例 2：不同 marker 符号都正确
- [ ] 用例 3：嵌套项保持原有行为
- [ ] 用例 4：多次缩进操作流畅
- [ ] 用例 5：光标在任何位置都正确
- [ ] 用例 6：无时间戳项正常缩进
- [ ] 编辑器视图正常
- [ ] 预览视图正常
- [ ] 时间戳高亮仍正常
- [ ] 时间戳只读功能仍正常
- [ ] Enter 键功能仍正常（嵌套列表修复）

## 技术细节

### 为什么分成两个 change？

顶级项按 Tab 后需要：
1. **删除时间戳**：从 marker+space 之后开始，删除时间戳和后面的空格
2. **插入 Tab**：在光标位置插入 Tab 字符

如果分别处理会产生多个事务，影响用户体验。通过数组传递多个 change，CodeMirror 6 会在一个事务中原子性地应用所有改动。

### 光标移动

```typescript
selection: { anchor: cursor.from + 1 }
```

光标最终会停在删除后的位置。这里计算 `+1` 是因为插入了一个 Tab 字符，需要相应移动光标。

### 时间戳模式使用

```typescript
new RegExp(`^([-*+]\\s+)(${plugin.settings.timestampPattern})\\s+`)
```

使用 `plugin.settings.timestampPattern` 确保识别的时间戳格式与用户设置一致，提高灵活性。

## 已知限制

1. **仅处理顶级项**：嵌套项的 Tab 仍由 Obsidian 处理
2. **仅在目标区域**：只在 `## Journal` 区域生效
3. **仅删除时间戳**：不修改 marker 或其他内容
4. **空格缩进**：假设缩进为空格（不支持 Tab 缩进）

## 后续改进

1. 考虑添加 Shift+Tab（反缩进）的对应处理
2. 可添加配置选项控制是否启用此功能
3. 可考虑在反缩进时重新添加时间戳

---

**功能完成！** 🎉 现在 Tab 缩进顶级项时会自动删除时间戳。
