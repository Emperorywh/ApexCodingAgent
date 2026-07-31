# GOAL-03：Plan 与核心领域模型

## 目标

定义新系统的 Plan、Requirement Trace、Evidence Policy、Scope Graph、Issue、Review 基础对象以及 Task/Run 状态机，使后续阶段只能通过领域不变量表达完成语义。

对应 SPEC §3、§6、§8、§11、§12.1、§12.6、§22 第 3 步，以及 AC-003、AC-004、AC-007 的领域基础。

## 前置条件

- GOAL-02 已完成。
- `state.json` 聚合和 ErrorRecord 已稳定。

## 必读

- SPEC §3、§6、§8、§11、§12.1、§12.6、§13。
- 需求账本、目标架构、状态 ADR。
- GOAL-02 的 StateAggregate 和 Schema 注册机制。

## 范围

### 1. Plan Snapshot

定义严格、不可变的 Plan Snapshot，至少包含：

- Plan revision 和替代关系。
- PlannedTask。
- AcceptanceCriterion。
- Evidence Policy。
- Verification command catalog。
- `finalVerificationCommandIds`。
- `workspaceProvision`。
- Requirement Trace。
- Scope Graph。
- Planning assumptions。
- SPEC 路径与哈希。
- Planning Session 和生成时间事实。

### 2. PlannedTask 与 criterion

落实 SPEC §6.1～§6.3：

- 稳定唯一 ID。
- 单一 objective。
- `dependsOn` 硬依赖。
- `ownedScopes`、`mayAffectScopes`。
- `riskLevel` 与 `reviewProfile` 耦合。
- `milestoneForScopes`。
- `contextRefs`。
- 每个 Task 至少一个 criterion。
- criterion kind、blocking、scopes 和 Evidence Policy。
- criterion kind 与 Evidence kind 的合法映射。
- command catalog 去重、路径、网络、timeout 和 provider 规则。

Evidence Policy 必须是递归判别结构，支持 `allOf`、`anyOf` 和 `kind`，并能由纯函数判断 Evidence 集合是否满足。

### 3. Requirement Trace

实现：

- 每个规范性 requirement 都有 trace。
- deliverable criterion 唯一 owner。
- global constraint 由 policy、守护或 Final Review 负责。
- user decision 未解决时 Plan 无效。
- source ref 使用稳定 ID 或锚点。

### 4. Scope Graph

实现：

- 显式 scope 节点、paths 和有向影响边。
- 正向传播。
- 不猜测 scope 字符串前缀。
- Windows 大小写不敏感、正斜杠、Git 相对路径规范。
- rename 同时保留旧、新路径事实。
- 未归类全局路径的确定性分类规则。

### 5. Plan Revision

实现纯领域规则：

- 语义不变保留 Task/criterion ID。
- statement、Policy 或 owner 实质变化生成新 ID并记录替代。
- 移除 Task 时 requirement 必须合法接管或由用户决定移除。
- SPEC 哈希变化直接要求 planning。
- 禁止普通 Task 以“最终验收通过”为结果。

### 6. Issue

定义统一 IssueRecord 和不变量：

- finding/risk。
- P0/P1 等 severity。
- blocking、open/resolved/accepted。
- criterion、scope、path、Evidence 关联。
- resolved 的 Head、Evidence 和批准者。
- finding 不得 accepted。
- P0 不得 accepted。
- open blocker 与 open P0/P1 finding 的阻断函数。
- resolution 依赖失效后的重新检查。
- Execution 无关闭/接受权限。

### 7. Review 基础对象

定义：

- Candidate 与 Accepted 身份。
- ReviewSubject 的 initial/revalidation。
- implementationCheckpoint、reviewedHead、baselineCheckpoint 和 trigger。
- ReviewFootprint。
- dependency fact 判别联合。

本 Goal 只定义领域契约和不变量，不调用 Reviewer。

### 8. Task/Run 状态机

Task 七态和全部合法转换必须精确实现：

```text
pending / executing / review_pending / reviewing / completed / failed / skipped
```

Run 六态保持：

```text
planning / running / final_review / completed / failed / abandoned
```

必须保证：

- Execution 无直接完成路径。
- completed 可由 Impact Analyzer 撤销。
- failed 只有 resume 可以恢复。
- 依赖只接受当前有效 completed。
- completed/abandoned Run 不可恢复。

## 明确不在范围

- 不调用 Planning、Plan Reviewer 或 Task Reviewer。
- 不采集真实 Evidence。
- 不执行命令。
- 不实现影响分析算法。
- 不渲染 CLI 或报告。

## 测试

必须覆盖：

- 全部合法和非法 Task/Run 转换。
- Plan Schema 与所有跨字段不变量。
- Evidence Policy 的嵌套 allOf/anyOf。
- criterion kind 映射非法组合。
- requirement coverage、唯一 owner 和 user decision。
- scope graph 环、重复、未知 scope 和路径规范。
- Plan Revision ID 保留、替代和非法复用。
- Issue 阻断、resolution 和 accepted 限制。
- initial/revalidation ReviewSubject。
- Candidate、Accepted、reviewedHead 的区别。
- ReviewFootprint dependency facts。

## 完成定义

- 后续阶段所需领域对象均有严格类型、Schema 和纯不变量。
- 不存在 Execution 直接进入 completed 的状态转换。
- 旧 acceptanceCriteria 字符串数组和自然语言 acceptanceEvidence 已从目标路径删除。
- Domain 不依赖 Application、Adapter 或 `node:*`。
- 定向测试与 `npm test` 全绿。
- 需求账本和 `STATUS.md` 已更新。

## 交接给 GOAL-04

交接必须列明：

- command catalog 与网络策略契约。
- Reviewer/Verification workspace 所需只读和可写能力。
- Scope/Path 规范化公共领域规则。
- Issue 与安全事件的边界。

