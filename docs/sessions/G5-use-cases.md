# G5：Application 用例编排 + 内置 Prompt + 归档与报告

## 会话目标

实现全部 7 个 Application 用例、3 个内置 Prompt 模板、Reporter 与前台 Run 驱动器，把 G1–G4 的能力串成完整业务闭环：start → planning → 串行执行 → replan → final review → report，以及归档与 abandon。端到端测试用 Fake Claude + 真实临时 Git 仓库跑通。

## 建议的 goal 完成判据

```text
完成 docs/sessions/G5-use-cases.md 定义的 G5 交付。
判据：
1. `npm test` 全绿，包含本文档"测试清单"全部端到端场景（Fake Claude + 真实临时仓库）。
2. G1–G4 测试保持全绿；架构扫描保持通过。
3. SPEC §23 中除 CLI/发布矩阵外的条目可逐条指认到实现与测试。
```

## 前置条件

G1–G4 门禁全部通过。Fake Claude（G4）支持按场景脚本化；State Store（G2）、Git 适配器（G3）直接可用。

## 起手读取

- 本文件、`TRACE.md` 全部
- SPEC §2.4（中断收尾语义）、§3.2（SPEC 变化流程）、§4.3–4.4（写入职责与归档）、§5.4–5.5（运行模型与数据流）、§6.3–6.6（Session/Episode/Revision/不变量）、§7.1（Planning 上下文）、§8.1–8.2（启动检查与创建顺序）、§9 全章、§13（Replan）、§14 全章（Final Review 与报告）、§16（配置优先级）、§17（abandon/report 语义）、§24–26（内置 Prompt 基线）

## 交付物

- `src/application/usecases/`：`StartRun`、`GeneratePlanRevision`、`ExecuteNextTask`、`ApplyPlanRevision`、`RunFinalReview`、`AbandonRun`、`GenerateReport`
- `src/application/prompts/`：planning/execution/final-review 三个模板（§24–26 为规范性基线，可模板化但不得删除核心职责）
- `src/application/run-driver.ts`：前台串行调度循环 + 中断收尾（应用层部分）
- `src/application/ports/ReporterPort.ts` + `src/adapters/reporter/`：report.md 生成
- `tests/e2e/`：Fake Claude + 临时 Git 仓库端到端场景

## 规范性要点

### StartRun（§8.1、§8.2、§16）

- 启动检查 13 项逐字按 §8.1（Windows 版本、SPEC、Node、`claude --version`、能力探测、git、工作区、HEAD、状态目录未跟踪、SPEC 未 staged、工作区干净（仅 SPEC 例外）、无非终态 Run、目录可写）。工作区不干净：明确诊断并停止，不自动 commit/stash/reset/删除。
- 创建 10 步按 §8.2；失败语义：步骤 1–3 → startup_validation 不建 Run；步骤 4 → `STATE_WRITE_FAILED`；步骤 5 起 → 尽量写诊断、Run → failed。不改 Base Branch 引用、不自动回滚。
- 配置：仅三项可配；优先级 显式 CLI 参数 > settings.json > 内置默认；settings 严格 Schema（未知字段失败，`SETTINGS_INVALID`）；`bypassPermissions` 只能显式启用且必须给风险提示；最终配置快照进 `run.json.runSettings`；Run 期间不重载。

### Session 生命周期（§6.3，7 步）

分配 ID → 写 `activeSession`（含类型/TaskID/Revision/SPEC SHA/开始时间）→ Execution 追加未结束 Episode → **保存成功后才启动进程** → 结束后先写最终 Session Record → 再提交业务结果与 Checkpoint → 清除 `activeSession`。启动失败也尽量写失败 Record 并清槽；写不进时只输出诊断，不伪造成功。

### SPEC SHA-256 边界与变化流程（§3.2）

- 重算边界：start、每个 Session 启动前、Session 正常结束后提交结果前、生成报告前。
- Session 契约失败优先按 §9.6，不进入变化流程。
- Execution 期间变化 6 步、Final Review 期间变化 5 步，逐字按 §3.2（不提交基于旧 SPEC 的结论；中间 Checkpoint 或无变更事实；Task 回 pending 或新增 pending Task；Run → planning）。

### ExecuteNextTask（§9.1–9.5）与 Replan（§13）

- 选择第一个依赖完成且 pending 的 Task；无可执行 Task：全部 completed → final_review；有 failed → Run failed；有无法解释的 pending → Run failed。
- 提示词上下文 11 项按 §9.2；不得注入全部历史日志。
- 完成判定 7 条件按 §9.5（退出 0 ∧ 结构合法 ∧ completed ∧ 证据全 satisfied ∧ Git 不变量 ∧ Checkpoint 成功 ∧ 状态保存）。
- `decision == failed` → `CLAUDE_REPORTED_FAILURE`；结构化非法 → `CLAUDE_RESULT_INVALID`；Git Checkpoint 失败 → 对应 git_error；均 Task+Run failed。
- Replan 10 步按 §13；不属于失败重试、无重试计数；每次执行保留独立 Episode；不得删除或伪造 completed Task。

### Final Review 与报告（§14）

- Review 上下文按 §14.1；completed 判定含 reviewedTaskIds 精确匹配与无失败测试。
- 结果处理 6 步按 §14.2；final_review 期间任一步失败 → Run failed；首次报告失败 → `FINAL_REPORT_GENERATION_FAILED`。
- Run 成功 9 条件按 §14.3。
- report.md：completed 报告 12 项内容按 §14.4；failed/abandoned 报告 5 条规则（标记未完成、错误摘要、任务清单、分支与最后 Checkpoint、不把 HEAD 当 Final Commit）；报告不得声称无证据的独立验证。
- Reporter 只读已提交事实，不从 Claude 自由文本推断状态（§5.5）。

### 归档（§4.4）

6 步：建 staging → 复制（tasks/run/plans/sessions/logs/存在的 report）→ 生成 Manifest（相对路径+字节长度+SHA-256，唯一、稳定排序、不含自身、不逃逸）→ 重读校验 staging → 重命名为 `history/<run-id>/` → 已存在时仅当 Manifest 与当前终态 Run 完全匹配才算幂等成功，否则 `ARCHIVE_CONFLICT`。
发布后：保留 settings.json；清除根级 tasks.json/run.json/report.md；清空 plans/sessions/logs；再创建新 Run。任一失败停止启动，不暴露半个新 Run。

### AbandonRun（§17，10 步）

严格 Schema 合法的非终态 run.json（否则 `RUN_NOT_ABANDONABLE`/`RUN_NOT_FOUND`/`COMMAND_STATE_INVALID`）；必须 `--force`（否则 `ABANDON_REQUIRES_FORCE`）；显示"系统无法判断旧进程是否仍然存在"风险提示；不调用 Claude、不终止进程、不改 Git、不建 Checkpoint；未写入的 Session 补 exitCode=null 的失败 Record（`RUN_ABANDONED_BY_USER`），已写入的 Record 不动；未结束 Episode 结束为 `session_error`；running Task → failed；清 `activeSession`/`currentTaskId`；Run → abandoned + `terminalAt`。

### Run 驱动器与中断（应用层部分，§2.4）

- 串行循环：planning → 逐 Task → final_review → 终态；每次状态迁移输出一行经脱敏的进度摘要。
- `requestInterrupt()`：停止启动新 Session → 经 ClaudeRuntimePort.abort() 杀直接子进程 → 最多等 10 秒（ClockPort 注入）→ 尽量保存失败 Record、结束未结束 Episode（已写入 Record 不覆盖）→ 原 running Task → failed → 清槽 → Run → failed（`RUN_INTERRUPTED`）。第二次中断的处理在 G6。
- ID 生成在 Application 层：`globalThis.crypto.randomUUID()`（见 README 全局决策）。

## 明确不做

- CLI 参数解析、进程信号绑定、退出码、bin 与发布（G6）。
- 崩溃恢复、PID、Session Resume、自动重试（永不出现，见 TRACE.md 第 9 节）。

## 测试清单（§22.2 的用例部分 + §22.1 余项）

端到端（Fake Claude 按场景编程 + 真实临时仓库）：

- Happy path：planning → 2 个 Task（含依赖序）→ final review → report.md → Run completed；run.json/tasks.json/plans/sessions/report 字段逐项断言
- Execution 返回 replan_required：中间 Checkpoint 保存 → Task 回 pending → 新 Revision 接管 → 继续执行；同一 Task 多 Episode 全保留
- SPEC 在 Execution 期间变化（Fake Claude 改写 SPEC 文件）：6 步流程断言；Final Review 期间变化：5 步断言
- 新 Revision 省略 pending Task → skipped 且拒绝 ID 复用；disposition 缺失/重复归属 → 拒绝 Revision
- acceptanceEvidence 缺失/重复/not_satisfied → 阻止 completed；Final Review 带失败测试 → 不得完成 Run
- Fake Claude 非零退出 / 非法结果 / decision=failed → Run failed 且错误码正确、不自动重试
- auto 与 bypassPermissions 的参数断言；bypass 风险提示输出
- Planning 副作用 / Claude Commit 含受保护路径 → Run failed（与 G3 不变量联动）
- 归档：终态 Run 后新 start → `history/<run-id>/` 自包含、Manifest 校验、幂等重归档、Manifest 不匹配 → `ARCHIVE_CONFLICT`；归档后半新 Run 不存在
- abandon：状态转换 10 步断言、风险门禁、零 Git/进程调用、已提交 Session Record 不被覆盖、非终态缺失/非法 → 对应 command_error
- report：completed 重生成失败保持 completed 且终态字段不变；failed Run 的非成功报告内容规则
- 一致性读取并发写入 → `STATE_SNAPSHOT_BUSY` 且不修改 Run
- 中断：执行中长睡眠 Fake Claude + requestInterrupt → 10 秒内有界收尾、Episode/Record/状态正确、退出语义交给 G6

## 验证门禁

```bash
npm run build && npm test && node scripts/check-architecture.mjs
```
