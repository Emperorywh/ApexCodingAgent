# GOAL-12：CLI、进度、报告与运行控制

## 目标

完成 CLI、进度展示、确定性报告、终态归档、heartbeat 单实例和两级中断，使用户能够安全启动、观察、恢复、提供输入并取得可审计结果。

对应 SPEC §15.6、§17、§18、AC-009、AC-011、AC-013，以及 §22 第 10 步。

## 前置条件

- GOAL-11 已完成。
- 所有业务阶段、恢复点、预算和 Final accepted 状态可用。

## 必读

- SPEC §4.4、§8、§10.7、§14、§15.4、§15.6、§16.2、§17、§18。
- 单实例、批准和归档 ADR。
- CLI 当前 args/run/status/help 实现。
- Reporter、archiver、signals 和 heartbeat 实现。

## 范围

### 1. CLI 命令

完整支持：

```text
start
resume
status
report
abandon --force
attest <attestation-json-path>
answer <user-decision-json-path>
```

要求：

- 严格参数解析。
- 未知参数和缺失参数为 `CLI_USAGE_INVALID`。
- `--full-access` 只在 start 单次显式启用并显示风险。
- budget CLI 覆盖字段与 GOAL-11 契约一致。
- attest/answer 调用既有 Use Case，导入不直接完成状态。

### 2. 退出码

精确映射：

- completed：0。
- start/resume 后 Run failed：1。
- usage：2。
- 启动前置失败：3。
- 查询、attest、answer 或命令级失败：4。
- 前台中断：130。

不得透传 Claude、Git、Verification 或系统工具原始退出码。

### 3. 进度与 status

至少显示：

- Candidate 数量。
- Task Review 数量。
- 待 revalidation。
- 等待用户输入。
- Final Review。
- Run 状态。
- Budget 使用。

Task 行显示：

- 状态。
- Candidate。
- Accepted Checkpoint。
- reviewedHead。
- Review 次数。
- 最新 Issue。
- 失效原因。

Final accepted 前不得显示整体完成或 100%。

### 4. Report

Reporter 只渲染持久化事实，至少包含 SPEC §17.3 的十类内容。

必须：

- 每个 criterion 可定位 Evidence、ReviewSubject、Issue 和 verdict。
- 显示被拒 Candidate 和修复历史。
- 显示 Invalidation/Revalidation。
- 显示人工证据、用户决定和预算。
- pending/not_run/缺失人工/非阻断失败不得写成通过。
- 外部文本全部脱敏。
- 同一状态确定性生成相同报告。

### 5. 完成与归档

Final accepted 后：

1. 通过 operation 协议生成 report。
2. 归档 state、Plan、Evidence、Artifact 索引、Session 和 report。
3. 校验归档完整性。
4. 原子提交 Run completed。

报告或归档失败进入准确可恢复 failed；恢复不得重跑 Final Reviewer。

completed/abandoned 为终态。系统不自动 merge、push 或修改用户原分支。

### 6. heartbeat 与单实例

按 ADR 实现无竞态租约：

- 每 5 秒原子更新 heartbeat。
- 包含进程启动时间、Run ID、阶段和租约身份事实。
- 30 秒内新鲜租约拒绝新的 start/resume，退出码 3。
- 过期租约允许确定性接管。
- status/report 只读并可并存。
- 两个并发启动者只能有一个获得所有权。

不得以自实现 PID 追踪/复活协议替代租约。

### 7. 两级中断

- 第一次：停止新阶段，当前阶段到最近提交点或安全取消，写 ErrorRecord，以 130 退出。
- 第二次：立即退出。
- 130 优先于 1。
- 中断不得把 Candidate、Evidence、Session 或 archive 留作伪成功。
- resume 从 operation 协议恢复。

### 8. README 和帮助

更新用户文档：

- 新流程和完成语义。
- 全部命令、参数和退出码。
- Sandbox 强/弱边界和批准。
- Evidence、attest、answer。
- Budget。
- Run 分支、报告、归档和用户后续合并选择。

## 明确不在范围

- 不建立真实模型评估基线。
- 不自动 merge/push/deploy。
- 不为旧状态、旧报告或旧 CLI 字段提供兼容。

## 测试

必须覆盖：

- 命令和参数完整矩阵。
- 所有退出码。
- status 的 Candidate/Review/Revalidation/Final/Budget。
- Final 未 accepted 不显示完成。
- report 的完整内容和确定性。
- report/archive 每个崩溃窗口恢复。
- attest/answer 输入与退出码。
- heartbeat 新鲜、过期、损坏和两个并发启动者。
- 第一次/第二次中断和 130 优先级。
- status/report 并发只读。
- 不修改原分支、不 push/merge。

## 完成定义

- 用户可通过 CLI 完成所有显式输入和恢复操作。
- Run completed 只有 Final accepted + report + archive 成功一条路径。
- status/report 不制造完成假象。
- 单实例和中断由可测试协议保证。
- README、help 和实现一致。
- 定向测试与 `npm test` 全绿。
- 需求账本和 `STATUS.md` 已更新。

## 交接给 GOAL-13

交接必须列明：

- 全流程 Fake Claude 场景接口。
- 故障注入点。
- 所有 CLI 进程入口和 Windows 集成边界。
- AC 自动化覆盖现状和缺口。

