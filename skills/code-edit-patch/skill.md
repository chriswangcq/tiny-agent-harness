# Code Edit Patch Skill

## Description

每次涉及编辑已有代码文件时，优先使用 `git diff` / `git apply` 工作流，避免 `sed` 或脚本化文本替换。

## 工作流

1. **生成 patch**: 在临时分支上完成改动，`git diff > /tmp/fix.patch`
2. **审查 patch**: 检查内容确保只含预期改动
3. **应用 patch**: `git apply /tmp/fix.patch`
4. **验证**: 每步 `npm run build`（或项目对应命令）

## 禁止

- ❌ `python3`/`node` 脚本做 AST 或批量替换 → 容易括号损坏
- ❌ `sed -i` 做多行结构修改
- ❌ 不验证 build 就连续多条编辑

## sed 仅限

单行精确删除（`sed -i '' '/exact-pattern/d'`）或已知行号替换。每次 sed 后立即 `grep -n` 验证。

## 示例

```bash
git checkout -b tmp-fix
# 手动编辑文件...
git diff > /tmp/fix.patch
git checkout main
git apply /tmp/fix.patch
npm run build
```
