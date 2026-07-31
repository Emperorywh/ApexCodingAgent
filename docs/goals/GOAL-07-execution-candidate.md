# GOAL-07：Execution 与 Candidate

## 目标

重建 Task Execution，使执行者只能实现或修复当前 Task，并通过 operation 协议产生 Candidate Checkpoint；Execution 永远不能完成 Task。

对应 SPEC §8、§9、§15、§18、§19.3、AC-002 和 §22 第 6 步的 Candidate 部分。

## 前置条件

- GOAL-06 已完成。
- 新状态机、operation 协议、Sandbox、Evidence 和 Verification 可用。

## 必读

- SPEC §3.3、§8、§9、§10.6、§15、§18、§19.3。
- Candidate/Accepted/ReviewSubject 领域契约。
- Run Driver 阶段接口。
- Git checkpoint adapter。

## 范围

### 1. Execution Context Bundle

Execution 默认获得：

- 当前 Task。
- 相关 requirement 和 criterion。
- 必要全局约束摘要。
- contextRefs 指向的架构资料。
- 最新 Review Findings 和开放 Issue。
- 未满足 criterion。
- 上次 Candidate、当前 HEAD 和 ReviewSubject。

不得默认内联完整历史或把自然语言摘要作为唯一交接事实。

### 2. Execution Session

- 只能处理一个 Task。
- 允许修改当前 Execution 工作区内业务文件。
- Claude 工具权限由 Claude Code 权限系统裁决。
- `--full-access` 只在用户显式启用时传递。
- Session 前后校验 SPEC、Plan、分支、HEAD 和保护路径。
- 发现计划错误返回 replan_required。
- 失败不自动重试。

### 3. TaskExecutionResult

严格实现：

- `implementation_ready`
- `failed`
- `replan_required`

结果包含：

- 非空 summary。
- proposedEvidence。
- issues。
- changedScopes。
- replanReason。

不得出现 completed、accepted、satisfied 总裁决。proposedEvidence 只是采集建议，不进入 Evidence Store。

### 4. Candidate operation

`implementation_ready` 后严格执行 SPEC §9.3：

1. 重校验 SPEC、Plan、分支和工作树。
2. 分配 operation ID。
3. 提交 activeOperation。
4. 创建带 `Apex-Operation` trailer 的 Candidate。
5. 从 Git OID 差异计算 normalized changedPaths。
6. 保存 Session Record。
7. 提交 Task 为 review_pending 并清除 operation。
8. 产生待影响分析阶段事实。

Checkpoint 消息和状态字段必须明确使用 candidate 语义。

### 5. Candidate 历史

- 被拒 Candidate 不删除。
- 后续修复 Candidate 与前一 Candidate、baseline 和 operation 关联。
- Accepted 只是 Review 后的状态身份，不创建空提交。
- 无变更 Candidate 的规则必须由目标架构 ADR 明确，不得用虚假提交制造进度。
- changedScopes 只能作为模型报告；确定性 changedPaths 必须来自 Git。

### 6. 停滞输入

为后续 Review 循环保存可计算事实：

- Candidate 序列。
- 每轮 Findings/Issue 差异。
- 未满足 criterion 集合。
- Evidence 集合变化。

本 Goal 不判定 `TASK_REVIEW_STALLED`，但不得丢失所需输入。

## 明确不在范围

- 不接受 Candidate。
- 不进入 completed。
- 不由 Execution 关闭 Issue。
- 不实现 Impact Analyzer 算法。
- 不实现 Task Reviewer Prompt。

## 测试

必须覆盖：

- Execution 结果 Schema 不接受 completed/accepted。
- implementation_ready 只进入 review_pending。
- Candidate 前所有不变量重校验。
- operation 在 Git/Session/state 各崩溃窗口幂等恢复。
- Candidate trailer、消息和 changedPaths。
- 模型 changedScopes 不覆盖 Git 事实。
- protected path、SPEC/Plan 变化和分支冲突。
- failed/replan_required 不创建完成事实。
- `--full-access` 不影响 Reviewer/Verification 策略。

## 完成定义

- 源码和 Prompt 中不存在 Execution 直接完成 Task 的路径。
- Candidate 的 Git、Session、state 通过同一 operation ID 关联。
- Task 在 Candidate 后只能为 review_pending。
- Git changedPaths 是影响分析的权威输入。
- 定向测试与 `npm test` 全绿。
- 需求账本和 `STATUS.md` 已更新。

## 交接给 GOAL-08

交接必须列明：

- Candidate 索引和 baseline 事实。
- Review 前 Verification 所需 criterion/command 集合。
- Task Review Context Bundle 输入。
- Findings/Issue 修复反馈的持久化位置。

