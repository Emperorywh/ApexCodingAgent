# GOAL-02：单一状态聚合与幂等协调

## 目标

以 `state.json` 替换旧 `run.json + tasks.json` 双文件模型，建立可变事实唯一提交点、immutable artifact 存储和 operation ID 幂等恢复协议。

对应 SPEC §4.4、§9.3、§10.3、§15.1～§15.4、§18、AC-010 和 §22 第 2 步。

## 前置条件

- GOAL-01 已完成。
- 状态聚合、operation stage 和单实例 ADR 已接受。

## 必读

- SPEC §4.4、§8、§9.3、§10.3、§15、§18。
- 状态与恢复 ADR。
- GOAL-01 的阶段接口。
- 当前 state adapter、archiver、resume 和 invariants 实现。

## 范围

### 1. 定义 `state.json` 聚合

聚合至少包含：

- Run 身份、状态、SPEC 和 Git 事实。
- 当前 Plan Snapshot 引用。
- Task runtime。
- Candidate/Accepted Checkpoint 索引。
- Session、Evidence、Review 和 Issue 索引。
- Invalidation/Revalidation 索引。
- Budget 使用量。
- `activeOperation`。
- 最后 ErrorRecord 和恢复信息。
- 报告、归档和终态事实。

所有字段必须具有严格 Schema 和跨字段不变量。不得使用无约束 `Record<string, unknown>` 逃避契约。

### 2. 删除旧状态协议

必须删除：

- 生产代码中的 `run.json`、`tasks.json` 双读写。
- `tasksSha256` 双文件一致性协议。
- 旧状态兼容读取和迁移函数。
- 旧 `ResumePoint` 自然语言式恢复捷径。
- 任何并行存在的新旧状态双写。

旧状态直接返回 `STATE_FORMAT_INVALID`，不得修复、迁移或猜测。

### 3. 建立 immutable stores

实现：

- `plans/<revision>.json`
- `sessions/<operation-or-session>.json`
- Evidence Record/Artifact 的通用不可变写入基础

Record 写入后不得覆盖。状态只保存 ID、路径、哈希和关键绑定事实。

Evidence 的具体类型在 GOAL-05 实现，本 Goal 只建立可复用的不可变存储与索引提交协议。

### 4. 建立 `activeOperation`

每个可能产生外部副作用的阶段必须：

1. 分配稳定 operation ID。
2. 校验预期状态和 HEAD。
3. 先原子提交 `activeOperation`。
4. 执行外部副作用。
5. 从 Git/文件系统重新读取真实结果。
6. 一次提交新状态并清除 operation。

至少覆盖：

- Plan/Session immutable record。
- Candidate Git commit。
- Evidence Record/Artifact。
- Verification 隔离工作区。
- Report。
- Archive。

### 5. 恢复与协调

实现基于 operation ID 的协调器：

- 已存在唯一匹配副作用：采纳并提交状态。
- 不存在副作用：允许用户 `resume` 后重试准确阶段。
- 存在冲突副作用：`OPERATION_RECONCILIATION_FAILED`。
- orphan immutable 文件不参与业务判断。
- Candidate 已存在时不得重复执行实现。
- Final Review 已接受而报告失败时不得重新调用 Reviewer。

恢复判断必须组合：

- ErrorRecord。
- `activeOperation`。
- Task/Run 状态。
- Git 事实。
- immutable artifact。

### 6. 错误注册表

- 按 SPEC §15.3 重建 ErrorRecord 和静态 `errorCode → errorClass`。
- `recoveryAction` 必须是受控枚举。
- 所有既有错误码逐一决定保留、重命名或删除。
- 新错误码先登记和测试，再使用。
- CLI 暂不在本 Goal 改版，但应用层不得透传原始工具退出码。

## 明确不在范围

- 不实现 Evidence 类型和 Policy。
- 不实现 Sandbox 或 Verification。
- 不实现 Task/Plan/Final Review。
- 不实现最终 CLI 进度和报告内容。
- 不保留旧运行数据兼容路径。

## 测试

必须覆盖：

- 全量 `state.json` Schema 和跨字段不变量。
- 首次写入前验证失败不触碰文件。
- temp→replace→reopen 校验。
- immutable 文件拒绝覆盖。
- 每种 operation 在副作用前、期间、后崩溃的恢复。
- 重复 resume 不重复副作用。
- orphan 不被解释为成功。
- 冲突副作用稳定失败。
- 旧状态格式被直接拒绝。
- 报告失败恢复不重新调用已接受 Final Reviewer。

## 完成定义

- `.apex-coding-agent/` 中只有 `state.json` 是可变业务提交点。
- 生产代码不再读写 `run.json` 或 `tasks.json`。
- 所有已实现外部副作用都进入 operation 协议。
- 状态和 immutable 文件之间不存在第二份可变真相。
- 恢复用例可以从确定性事实重建下一阶段。
- 定向崩溃测试、`npm test`、架构守护和禁用项扫描全绿。
- 需求账本和 `STATUS.md` 已更新。

## 交接给 GOAL-03

必须交接：

- `StateAggregate` 顶层契约。
- State Store 与 immutable store Ports。
- operation stage 注册表。
- ErrorRecord 和 recoveryAction 注册表。
- 后续领域对象应填充的索引和扩展点。

