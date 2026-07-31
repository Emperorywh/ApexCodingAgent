# GOAL-08：独立 Task Review

## 目标

实现独立、只读、基于当前 HEAD Evidence 的 Task Review，使 Candidate 只有在全部阻断 criterion 和 Issue 门禁满足时才获得 Accepted 身份并完成 Task。

对应 SPEC §7 独立性原则、§8、§9.4、§10.4、§11、§12、§19.4、AC-002～AC-007，以及 §22 第 6 步的 Review 部分。

## 前置条件

- GOAL-07 已完成。
- Candidate、Verification、Evidence、Issue、Reviewer 只读 Sandbox 可用。

## 必读

- SPEC §3.3、§8～§12、§19.4。
- TaskReviewResult、ReviewSubject、ReviewFootprint 领域契约。
- Reviewer 认证/只读 ADR。
- Candidate 和 Verification 交接。

## 范围

### 1. Review 前准备

- 创建 initial ReviewSubject。
- reviewedHead 为当前 Candidate HEAD。
- implementationCheckpoint 为当前 Task Candidate。
- baselineCheckpoint 明确。
- 运行当前 blocking criterion 要求的 Plan commands。
- 收集当前 Head Evidence。
- 汇总开放 Issue 和历史 Findings。

缺少人工 Evidence 时进入准确可恢复失败，不启动一个注定伪判的 Reviewer。

### 2. 独立 Reviewer Session

必须：

- 新 Session ID。
- 不续接 Execution transcript。
- 使用 reviewedHead 的只读隔离工作区。
- 先提供 requirement、diff、Evidence，再提供 Execution summary。
- 保存模型、Prompt、policy 和时间事实。
- Reviewer 写操作由技术边界阻止并形成安全事件。

### 3. Reviewer 输入

完整提供：

- SPEC/Plan 路径和哈希。
- Task、criterion、requirement。
- ReviewSubject。
- baseline 到 reviewedHead 的 Git diff 事实。
- Verification Evidence 索引。
- 开放 Issue。
- 受影响历史 criterion。
- 历史 Findings。
- 权限策略。

长正文通过路径和索引按需读取。

### 4. TaskReviewResult

支持：

- `accepted`
- `changes_required`
- `verification_required`
- `replan_required`
- `user_input_required`

结果必须包含严格类型的：

- summary。
- subject。
- criterionVerdicts。
- issues。
- reviewFootprint。
- verificationRequests。
- replanReason。
- userQuestions。

### 5. Accepted 门禁

代码必须独立验证：

- 所有 blocking criterion satisfied。
- 每个 verdict 满足 Evidence Policy。
- 所有阻断 Verification 成功。
- 无 open blocking Issue 或 open P0/P1 finding。
- Evidence Head 与 subject 一致。
- Reviewer 工作区保持只读。

模型返回 accepted 不能绕过这些门禁。

### 6. 决策处理

- accepted：Candidate 获得 Accepted 身份，Task reviewing→completed。
- changes_required：保存 Findings/Issue，Task reviewing→pending。
- verification_required：执行受控请求，保存无结论 Review，使用新 Session 重审。
- replan_required：保存原因和 Issue，Run 回 planning。
- user_input_required：保存结构化问题，Run 可恢复 failed。

非阻断 criterion/Verification 失败必须形成非阻断 Issue并进入报告事实。

### 7. 反馈和停滞

下一次 Execution 必须获得结构化反馈全量。

每轮比较：

- 新 Findings。
- 开放 Issue。
- 未满足 criterion。
- 新 Evidence。

连续 Candidate 未缩小开放问题时返回 `TASK_REVIEW_STALLED`，不得机械循环。

## 明确不在范围

- 不实现后续 Task 对历史 Review 的失效。
- 不实现 Final Review。
- Reviewer 不修改或提交业务代码。
- 不把测试数量、源码字符串或 Execution summary 当作充分 Evidence。

## 测试

必须覆盖：

- 独立新 Session、不续接 Execution。
- 只读 workspace 写操作被阻止。
- accepted 的全部正反门禁。
- Evidence Policy、Head 和 Issue 冲突。
- changes_required 反馈完整进入下一 Execution。
- verification_required 新 Evidence 后使用新 Session。
- 未授权新命令要求用户批准。
- replan_required 和 user_input_required。
- 非阻断失败报告 Issue。
- stalled 检测只基于结构化进展，不使用固定空循环。
- 不可读 Issue 与可读 criterion 冲突时不能 accepted。
- 亮色像素不能证明文字可读。

## 完成定义

- Task completed 只有 Task Review accepted 一条路径。
- Accepted 身份、Review ID、Evidence 和 reviewedHead 可完整追踪。
- Reviewer 无代码写能力。
- Execution 自述不能覆盖命令或 Issue 事实。
- Review 反馈可供下一轮结构化消费。
- 定向测试与 `npm test` 全绿。
- 需求账本和 `STATUS.md` 已更新。

## 交接给 GOAL-09

交接必须列明：

- 有效 ReviewFootprint 索引。
- completed Task 的 implementationCheckpoint 和 reviewedHead。
- dependency facts 重新采集 API。
- Candidate 后尚待影响分析的状态事实。

