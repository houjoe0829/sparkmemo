# 🐛 Tab 键光标跳转 Bug 修复 - 快速总结

## 问题
在顶级 bullet 项的时间戳后按 Tab，光标会跳转到编辑器顶部

## 原因
使用多个 change 的事务处理导致光标位置计算错误

## 修复
将多个 change 改为单一 replace change，直接替换时间戳为 Tab

## 代码变化

### 修复前（有 bug）
```typescript
const changes = [
  { from: deleteStart, to: deleteEnd, insert: '' },
  { from: cursor.from, to: cursor.to, insert: '\t' },  // ❌ 错误
];
```

### 修复后（正确）
```typescript
const changes = [
  { from: deleteStart, to: deleteEnd, insert: '\t' },  // ✅ 正确
];
```

## 测试
```markdown
原：- 08:04 |XX
按 Tab
结果：  - |XX       ✅ 无跳转，时间戳已删除
```

## 部署
✅ 编译通过
✅ 已部署
✅ 请在 Obsidian 中重新加载

## 提交
```
9d58c9b fix: prevent cursor jump when Tab pressed on top-level item with timestamp
09a2d20 docs: add TAB cursor jump bug fix explanation
```

---

**现在可以安全使用 Tab 键了！** ✨
