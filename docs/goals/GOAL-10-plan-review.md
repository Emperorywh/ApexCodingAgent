# GOAL-10：独立 Plan Review 与用户决定

## 目标

实现 Planning → 独立 Plan Review → Plan Revision 的闭环，只有覆盖完整、可验证且不存在隐藏用户决定的 Plan 才能进入 running。

对应 SPEC §6、§7、§8.2、§15、§17.1、§19.1～§19.2、AC-001、AC-011，以及 §22 第 8 步。

## 前置条件

- GOAL-09 已完成。
- Plan 领域模型、Reviewer 只读 Sandbox、Verification 能力和修订身份规则可用。

## 必读

- SPEC §3、§6、§7、§8.2、§15、§16.2、§17.1、§19.1～§19.2。
- requirement ledger。
- Plan/Review/用户批准 ADR。
- 当前 Planning Prompt、Plan Revision 和阶段选择实现。

## 范围

### 1. Planning Session

Planning 必须完整读取 SPEC，并被要求：

- 主动寻找矛盾和不可行数值。
- 不把参考实现当当前 Evidence。
- 按能力结果拆 Task。
- 规划高风险纵向里程碑。
- 为每个 criterion 定义 Evidence Policy。
- 区分 deliverable/global_constraint/user_decision。
- 建立 command catalog、scope graph 和 requirement trace。
- 不创建承担 Final Review 的普通 Task。

Planning 只产生 Plan Draft，不批准。

### 2. Plan Draft 系统校验

启动 Reviewer 前，系统先执行：

- Schema 和领域不变量。
- Requirement Trace 完整性。
- Task/criterion/command/scope ID 唯一性。
- 依赖无环且 owner 合法。
- user decision 是否未解决。
- command 来源和 workspaceProvision 合法性。
- 高风险 reviewProfile 和里程碑约束。

系统校验失败不能包装为 Reviewer finding。

### 3. 独立 Plan Reviewer

必须：

- 新 Session ID。
- 不续接 Planning transcript。
- 使用只读工作区。
- 先读取 SPEC、仓库和系统约束，再读取 assumptions。
- 记录模型、Prompt、policy 和 Session 事实。

Reviewer 必须逐项执行 SPEC §7.2 的 14 类检查。

涉及单位、尺度、容量、性能、金额、速率、采样或误差时，必须使用可复算的结构化计算或受控工具事实，不能只接受口头公式。

### 4. PlanReviewResult

支持：

- `accepted`
- `changes_required`
- `user_input_required`
- `failed`

严格定义并验证：

- summary。
- findings。
- taskAssessments。
- requirementCoverage。
- issues。
- repairInstructions。
- userQuestions。

accepted 必须同时通过系统领域校验和 Reviewer 结论。

### 5. 修订循环

- changes_required 产生新的 Planning Session。
- 新 Draft 必须获得 Findings、coverage、Issue 和 repairInstructions。
- Plan Snapshot 每 revision 不可变。
- ID 保留和替代遵循 GOAL-03 规则。
- 修订次数从显式预算能力读取，不使用隐藏固定轮数。
- 预算耗尽返回 `PLAN_REVIEW_BUDGET_EXCEEDED`。

GOAL-11 将预算解析和所有预算维度统一接线；本 Goal 必须通过显式注入的预算契约消费，不得临时硬编码。

### 6. 用户决定

实现严格的 user-decision 输入 Schema 和 Application Use Case：

- 关联 runId、问题 ID、请求阶段和 Plan revision/Head。
- 只接受 Reviewer 提供的合法选项或符合问题契约的结构化值。
- 系统生成导入时间、producer 和哈希事实。
- 导入不直接接受 Plan 或完成 Task。
- 只有匹配决定存在后，用户执行 resume 才继续准确阶段。
- 不匹配、重复冲突或过期输入稳定失败。

CLI `answer` 的参数解析和帮助文本由 GOAL-12 接线。

### 7. Plan 提交

Plan 只有在独立 accepted 后才：

- 写入 immutable Plan Snapshot。
- 原子更新 state 当前 Plan 引用。
- 初始化或修订 Task runtime。
- 应用合法 skipped/接管规则。
- 使 Run planning→running。

SPEC 哈希变化立即放弃当前 Review 结论并重新 planning。

## 明确不在范围

- 不实现 Final Review。
- 不由 Planning Agent回答用户问题。
- 不把 assumptions 当用户决定。
- 不在本 Goal 完成 CLI/报告整体改版。

## 测试

必须覆盖：

- Planning 与 Plan Review 使用不同 Session。
- accepted 前 Run 不进入 running。
- requirement trace 缺失、错误 owner 和未解决 user decision。
- changes_required 多轮修订和 ID 规则。
- user_input_required 导入前后准确恢复。
- failed 与基础设施错误区分。
- 数量分析的可复算事实。
- command catalog、scope graph、里程碑和 final verification 检查。
- SPEC hash 变化放弃旧 Review。
- 预算耗尽不自动增加。

## 完成定义

- Plan 未通过独立 Review 不可能进入 running。
- Planning 无自我批准能力。
- 用户决定不能被模型 assumptions 替代。
- Plan Snapshot、Review 和 Session 全部不可变并可追踪。
- 修订循环受显式预算契约控制。
- 定向测试与 `npm test` 全绿。
- 需求账本和 `STATUS.md` 已更新。

## 交接给 GOAL-11

交接必须列明：

- Plan Review 预算消费接口。
- accepted Plan/Review 索引。
- Final verification command catalog。
- unresolved user decision 索引。
- Final Review 所需完整 requirement coverage。

