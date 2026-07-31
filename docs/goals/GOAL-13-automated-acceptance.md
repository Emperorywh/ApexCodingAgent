# GOAL-13：自动化验收与对抗测试

## 目标

建立覆盖 SPEC §20.1～§20.2、AC 自动化部分和 §23 自动化条件的完整测试体系，证明新架构、安全边界、失败窗口和质量闭环，而不是仅证明代码结构存在。

对应 SPEC §20.1～§20.2、§21、§23 第 1～6、8 项，以及 AC-001～AC-015 的自动化部分。

## 前置条件

- GOAL-12 已完成。
- 全部产品能力和 CLI 已实现。
- requirement ledger 中自动化条目均有 owner。

## 必读

- 完整 SPEC，重点 §20～§23。
- `docs/implementation/test-map.md`。
- requirement ledger。
- 所有 Goal 交接和当前测试目录。

## 原则

- 本 Goal 主要补足测试、fixture、故障注入和可测试性缺口。
- 发现产品缺陷时必须在正确模块修复，不得以测试特例或临时 patch 绕过。
- 发现架构缺口需要大幅返工时，应将对应 Goal 状态重新打开，而不是在测试文件中复制生产逻辑。

## 范围

### 1. Domain 测试

完整覆盖 SPEC §20.1：

- Task/Run 所有合法和非法转换。
- Candidate/Accepted/reviewedHead。
- Evidence Policy。
- Issue。
- ReviewSubject。
- path/scope/dependency invalidation。
- Final 进入条件。
- activeOperation/recovery。
- requirement trace/Plan Revision。

### 2. Application/Adapter 测试

完整覆盖：

- Execution 只能 Candidate。
- 真实 Verification 事实。
- verification_required。
- Review feedback/replan/user input。
- Sandbox/Command Policy/环境/网络。
- Evidence 类型/哈希/预算/脱敏。
- Prompt stdin/长 Prompt。
- operation 协调。

### 3. E2E

使用真实临时 Git 仓库、Fake Claude、真实 State/Evidence/Reporter/Archiver，至少覆盖 SPEC §20.1 的 14 个场景：

1. 完整 happy path。
2. Plan changes_required/user_input_required。
3. Task changes_required/verification_required/replan_required。
4. 模型声称成功但命令失败。
5. 不可读风险与可读 criterion 冲突。
6. 亮色像素不能证明可读。
7. 后续 Task 使历史 Review 失效并重验。
8. Session/Git/Evidence/state 崩溃窗口。
9. Reviewer 写入被预先阻止。
10. 命令、网络、凭据访问拒绝。
11. attestation/decision 后恢复。
12. Final 未接受不显示完成。
13. heartbeat 新鲜拒绝、过期接管。
14. 两级中断。

至少一个 E2E 完整经过：

```text
Plan Review
→ Execution
→ Task Review
→ Invalidation
→ Revalidation
→ Final Review
→ Report
```

### 4. china-3d 回归

建立三类不可删除回归：

- 已知不可读 Issue 不能 completed。
- 亮色像素不能证明文字可读。
- Final Review 未运行不能显示 Run 完成。

fixture 必须描述事实和期望，不依赖真实网络。

### 5. 安全对抗

覆盖：

- Prompt injection 请求扩大权限。
- 仓库脚本尝试写外部路径。
- Reviewer 写入。
- 命令路径替换和 shim。
- Shell 元字符。
- 网络和代理绕过。
- 环境秘密回显。
- reparse point/junction/symlink。
- 超时孙进程。
- Artifact 替换、路径逃逸和超预算。

关键安全门禁不得静默 skip。环境确实无法提供所需 Windows 能力时，测试必须明确失败或要求受控的用户验收步骤。

### 6. 崩溃恢复矩阵

为每个 operation stage 注入：

- activeOperation 提交前。
- 提交后、副作用前。
- 副作用完成后、state 提交前。
- state 提交后、清理前。

重复 resume 必须得到同一业务结果且不重复副作用。

### 7. 测试质量审计

- 删除只证明字符串、常量或行数的伪测试。
- 不复制生产算法作为 expected。
- 失效测试同时含 positive/negative。
- 视觉阈值来自 SPEC 或批准基线。
- Fake Claude 只证明编排，不宣称真实 Review 质量。

### 8. AC 自动化证据矩阵

新增 `docs/implementation/automated-acceptance.md`：

- 每个 AC 对应测试文件和测试名。
- 每项 §23 自动化条件对应命令和结果。
- 标明只能由 GOAL-14 真实评估完成的条目。

## 明确不在范围

- 不调用真实 Claude。
- 不建立发布模型基线。
- 不为通过测试放宽安全或 Evidence 阈值。
- 不删除困难用例。

## 完成定义

- SPEC §20.1、§20.2 全部有可定位测试。
- AC-001～AC-015 的自动化部分全部有证据。
- §23 第 1～6、8 项已闭合；第 7 项明确留给 GOAL-14。
- 完整 E2E 和三类 china-3d 回归通过。
- 安全与崩溃恢复矩阵通过。
- `npm test` 一次完整运行全绿。
- 架构守护和禁用项扫描全绿。
- requirement ledger、自动验收矩阵和 `STATUS.md` 已更新。

## 交接给 GOAL-14

必须交接：

- 自动化验收报告。
- 尚需真实模型 Evidence 的 requirement ID。
- 评估 harness、用例格式和版本。
- 当前模型/Prompt/policy 版本事实。

