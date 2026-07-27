# G1：工程骨架 + 内置 Schema + Domain 层

## 会话目标

建立可构建、可测试的 TypeScript 工程骨架，实现全部 15 个内置 Schema 与完整 Domain 层（Run/Task 状态机、Plan Draft 校验与合并、Episode 规则、跨状态不变量、错误码表），单元测试覆盖 §22.1 中全部 Domain 相关条目。

## 建议的 goal 完成判据

```text
完成 docs/sessions/G1-domain-contracts.md 定义的 G1 交付。
判据：
1. `npm run build` 通过（tsc，ESM，strict）。
2. `npm test` 全绿，且包含本文档"测试清单"列出的全部用例。
3. `node scripts/check-architecture.mjs` 通过：src/domain 与 src/application 内不存在任何
   node: 导入或对 adapters/interfaces/bootstrap 的引用。
4. 未实现任何适配器、端口、Prompt 或 CLI（属于后续会话）。
```

## 起手读取

- 本文件、`TRACE.md`
- SPEC §5.1–5.3（技术与模块边界）、§6 全章（状态模型）、§7.3–7.5（TaskPlanDraft 与校验）、§9.4–9.5（TaskExecutionResult）、§11.3–11.6（全部持久化结构）、§14.1（FinalReviewResult 规则）、§15.2–15.3（错误模型）、§16（settings.json 结构）

## 交付物

工程骨架：

- `package.json`（`type: module`、engines `>=22 <23 || >=24 <25`、scripts：build/test；依赖：typescript、vitest、ajv）
- `tsconfig.json`（strict、NodeNext、target ≥ ES2022、outDir dist）
- `vitest.config.ts`、`scripts/check-architecture.mjs`（import 方向扫描，纳入 test 流程）

Domain（`src/domain/`，纯 TS，零 Node API）：

- `errors.ts`：全部 errorCode 常量、errorClass 映射（§15.2/§15.3）、`ApexError` 类型
- `schemas/`：15 个内置 Schema 集中版本化（§11.5 列表）+ ajv 实例与自定义 format（`uuid`、`sha256`、`git-oid`、`rfc3339`）+ 统一 `validate(schemaName, data)` 入口
- `ids.ts` / `time.ts`：ID 与时间**格式校验**纯函数（不做随机生成）
- `run-state.ts`：Run 状态机（§6.1 转换表 + 事件表）
- `task-state.ts`：Task 状态机（§6.2 转换表 + 转换原因）、Ready Task 选择（§9.1）
- `plan.ts`：TaskPlanDraft 语义校验（§7.5）、Plan Revision 合并算法（§6.5）
- `episodes.ts`：Task Execution Episode / Final Review Episode 追加与结束规则
- `invariants.ts`：跨状态不变量断言（§6.6）+ run.json/TaskRuntimeState/Session Record 条件规则校验

## 规范性要点（不可压缩细节）

### Schema 共同规则（§11.5、§11.6）

- `additionalProperties: false`；顶层整数 `schemaVersion`；可选关联字段显式 `null` 不得省略。
- 15 个 Schema：TaskPlanDraft、TaskExecutionResult、FinalReviewResult、Active Session、Task Runtime State、Task Execution Episode、Final Review Episode、Intermediate Checkpoint、Error Record、tasks.json、Plan Revision Snapshot、run.json、Session Record、Run Archive Manifest、settings.json。
- 字段全集以 SPEC §7.3/§9.4/§11.3/§11.4/§11.6/§14.1/§16 的 JSON 示例为**规范字段全集**：实现可增加正则/枚举/条件分支，**不得新增未定义的持久化业务字段**。

### run.json 条件规则（§11.3）

- `planRevision == 0` ∧ `tasksSha256 == null` 仅允许初始 Planning 未提交 Revision 1 时。
- `terminalAt` 仅终态非空；`completed` 必须有 `finalCommit` + `reportPath`；`failed`/`abandoned` 的 `finalCommit` 必须为 `null`。
- Active Session：`type` ∈ {planning, execution, final_review}；仅 execution 要求非空 `taskId`，其余必须为 `null`。
- Task Runtime State：pending/running 的 `completedResult`/`finalCheckpoint`/`skipReason`/`failure` 全 null；completed 要求合法 `completedResult` + 非空 `finalCheckpoint`；failed 要求非空 Error Record；skipped 要求非空 `skipReason` 且其余为 null；pending 下 `executionEpisodes` 可非空。
- Episode 未结束时全部可空结束字段为 null；结束后 `outcome` ∈ {completed, failed, replan_required, spec_changed, session_error} 且结束时间/结束 SPEC SHA/摘要/`checkpointReason` 非空；`failed`/`session_error` 要求非空 Error Record，其他 outcome 的 `error` 必须为 null。
- Final Review Episode：`decision` ∈ {completed, replan_required, spec_changed, session_error}；completed ⇒ `checkpointRole == final-review-final` + 非空 Checkpoint；replan/spec_changed 有变更 ⇒ `final-review-intermediate`，无变更 ⇒ role 与 checkpoint 均 null；所有情况 `checkpointReason` 非空。
- Intermediate Checkpoint：`task-intermediate` 要求非空 `taskId`；`final-review-intermediate` 的 `taskId` 必须为 null；owner Task 完成即吸收；owner 被省略/skipped 时同 Revision 必须改派。

### Session Record（§11.4）

- `status` ∈ {completed, failed}：completed = 进程 0 退出且结构化结果合法（不代表业务 decision）；failed 要求非空 Error Record 且 `structuredResult == null`；completed 时 `error == null`。
- `exitCode` 仅在启动失败时为 null；Planning/Final Review 的 `taskId` 为 null；写完不可修改。

### Plan Draft 校验（§7.5）与合并（§6.5）

- 校验清单：Schema 合法；≥1 个 Task；pending ≤ 50；ID 唯一且格式正确；依赖引用存在；无环；每 Task 有 objective 与 ≥1 条 acceptanceCriteria；≥1 个无依赖 Task；所有 Task 可从无依赖 Task 到达；不改 completed Task；ID 数字 ≤ 999；revision ≤ 50；每个未吸收中间 Checkpoint 有且仅有一个 pending Task 接管；disposition 引用存在。
- 合并 11 步逐字按 §6.5；`retainedCheckpointDispositions` 初始计划必须为空；Replan 时每个未吸收 Checkpoint 恰好出现一次。
- Draft 不合法 ⇒ 保存错误、Run 直接 failed、**不**做结构修复/删字段/猜依赖/自动重排。

### 结果结构规则

- TaskExecutionResult（§9.4）：`acceptanceEvidence.criterionIndex` 从 0 起与 `acceptanceCriteria` 一一对应，不缺不重不越界；completed ⇒ 全部 `satisfied` 且无 failed 测试；`replan_required` ⇒ 非空 `replanReason`，其他 decision 的 `replanReason` 为 null；failed/replan 也须覆盖全部验收条件。
- FinalReviewResult（§14.1）：completed ⇒ `reviewedTaskIds` 与当前计划全部 completed Task ID 完全一致、无 failed 测试；`reviewedTaskIds` 无重复。

### 错误模型

- `errors.ts` 完整实现 TRACE.md 第 4 节的 code→class 表；Domain 抛出的错误携带稳定 errorCode。

## 明确不做

- 任何 `node:` 导入、文件读写、子进程、网络。
- 任何 Port 接口、适配器、Prompt 模板、CLI、settings 加载逻辑。
- ID 随机生成（Application 层职责，G5 用 `globalThis.crypto.randomUUID()`）。

## 测试清单（§22.1 的 G1 部分）

- 全部 Run 状态转换、全部 Task 状态转换、非法转换、abandoned 转换及废弃时 running Task 处理
- Ready Task 选择（依赖完成度、稳定顺序、并发唯一性）
- TaskPlanDraft Schema；重复 ID、缺失依赖、环、不可达 Task；completed Task 保护；ID 永久唯一；pending 修改与 skipped 合并；Plan Revision 50 上限；disposition 完整性/唯一性/owner 校验
- Episode 追加、结束字段补齐、不可覆盖
- acceptanceEvidence 索引覆盖/重复/缺失/completed 门禁
- Final Review：completed + failed test 拒绝；reviewedTaskIds 缺失/重复/不完整拒绝
- 15 个 Schema 的正反例（含 additionalProperties、显式 null、格式 format）

## 验证门禁

```bash
npm run build && npm test && node scripts/check-architecture.mjs
```

全部通过方可进入 G2/G3/G4。
