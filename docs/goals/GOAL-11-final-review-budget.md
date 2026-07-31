# GOAL-11：Final Review、Context 与 Run Budget

## 目标

实现独立 Final Review、索引化 Context Bundle 和统一 Run Budget，使 Final Review accepted 成为 Run 完成的唯一质量结论，但报告与归档成功前仍不提交 completed。

对应 SPEC §14、§16、§19.5、AC-007、AC-009、AC-012，以及 §22 第 9 步。

## 前置条件

- GOAL-10 已完成。
- Plan Review、Task Review、Revalidation、Verification 和 Evidence 闭环可用。

## 必读

- SPEC §3.3、§8.2、§13、§14、§15.4、§16、§19.5。
- Context/预算/评估 ADR。
- 当前有效 Task Review、Issue、Evidence 和 Plan 索引。

## 范围

### 1. Final Review 进入条件

代码必须验证：

- 当前 Plan Task 均有效 completed 或合法 skipped。
- 不存在 executing/review_pending/reviewing。
- 全部 ReviewFootprint 在当前 HEAD 有效。
- 无 open blocking Issue 或 open P0/P1 finding。
- Plan、state、Evidence 和 Git HEAD 一致。
- Budget 允许启动。

任一条件不满足都不能启动 Reviewer。

### 2. Final Context Bundle

Final Reviewer 必须完整读取 SPEC，但 Prompt 只注入索引：

- SPEC、Plan、仓库、分支、HEAD。
- Task、Accepted Checkpoint、Review ID、reviewedHead。
- criterion 和 Evidence Record 路径。
- Issue。
- final command catalog。
- invalidation/revalidation。
- 权限和预算事实。

Reviewer 按需读取文件，不复制所有历史正文。

Execution/Task Review 也统一使用 Context Bundle 服务，默认只注入当前相关上下文。

### 3. Final Verification

- 运行 Plan 的 finalVerificationCommandIds。
- 通过 GOAL-06 的隔离 Verification。
- 结果形成当前 HEAD command Evidence。
- 阻断失败、缺失人工 Evidence 或预算阻止 Final accepted。

### 4. Final Reviewer

必须：

- 新独立 Session。
- 当前 HEAD 只读工作区。
- 不续接 Task/Execution transcript。
- 检查整体架构、数据流、状态流、模块边界。
- 检查 requirement trace 闭包。
- 抽查高风险 Evidence 和 Revalidation。
- 检查跨 Task 组合和默认用户路径。
- 检查人工 criterion、Issue 和发布约束。
- 不修改代码。

### 5. FinalReviewResult

只支持：

- `accepted`
- `replan_required`
- `user_input_required`

不允许 changes_required。

accepted 必须：

- 列出全部有效 completed Task 和 Review ID。
- 引用 final verification Evidence。
- 绑定当前 HEAD。
- 无阻断命令、人工证据缺口或阻断 Issue。

Final Review 不创建 Git commit。

replan_required：

- 保存 Issue。
- Run 回 planning。
- 由 Plan Revision 创建修复 Task。
- 按 path/scope 处理相关 Review。

基础设施错误进入可恢复 failed，不伪装为产品不通过。

### 6. Run Budget

从严格 `settings.json.budget` 和 CLI 单次覆盖解析，至少覆盖：

- Plan repair 次数。
- 每 Task Candidate 次数。
- 额外 Verification 轮次。
- Session 总数。
- 单 Session timeout。
- Verification 总时间。
- Evidence 字节数。
- Run 总时长。
- 可用时的 Token/成本。

要求：

- 未知字段和类型错误为 `SETTINGS_INVALID`。
- 使用量写入 state。
- 预算检查集中实现。
- 不静默增加、不自动循环。
- 耗尽时保存准确恢复点。
- status/report 可读取限制、消耗和最后结果。

### 7. accepted 后状态

Final accepted 后保存不可变 Review 和当前 Head，但 Run 只有在 GOAL-12 报告及归档成功后才能变为 completed。

报告失败恢复时不得重跑 Final Reviewer。

## 明确不在范围

- 不渲染最终 Markdown Report。
- 不实现 archive adapter。
- 不直接修复 Final finding。
- 不用 Prompt 代替进入条件或 accepted 门禁。

## 测试

必须覆盖：

- 每项进入条件的正反例。
- Final Review 推翻历史 Task Review。
- final verification 成功/失败。
- accepted 精确 Task/Review/Evidence/Head。
- 不支持 changes_required。
- replan_required 和 user_input_required。
- Reviewer 写操作被阻止。
- Final accepted 后报告失败不重审。
- Context Bundle 只包含索引并可按需读取完整 SPEC。
- 所有预算维度、覆盖、耗尽和恢复。
- Token/成本事实可用与不可用。

## 完成定义

- 没有 Final Review accepted 时不存在质量层面的 Run 完成。
- Final Reviewer 只读、独立且不能直接修复。
- 全部循环受统一显式预算控制。
- Context 交接不依赖 transcript。
- Final accepted 事实可供报告/归档阶段幂等消费。
- 定向测试与 `npm test` 全绿。
- 需求账本和 `STATUS.md` 已更新。

## 交接给 GOAL-12

交接必须列明：

- Final accepted 后待报告/归档状态。
- Budget 查询模型。
- status/report 所需全部索引。
- user input 和 manual evidence 恢复指令。

