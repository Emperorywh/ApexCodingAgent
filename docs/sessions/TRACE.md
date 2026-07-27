# TRACE — 跨会话不可变事实清单

> 每个会话起手必读。本清单从 `docs/SPEC.md` v4.1.1 抽取**跨会话共享的稳定性事实**，
> 用于压缩后恢复注意力。冲突时以 SPEC.md 为准，并回来修正本文件。

## 1. 标识与编码

- Run ID：`RUN-<UUID>`；Task ID：`TASK-001`–`TASK-999`；Session ID：规范小写 UUID。
- Task ID 全 Run 全局唯一、永久保留；skipped 的 ID 不得复用；数字部分 ≤ 999。
- SHA-256：64 位小写十六进制，始终按**原始字节**计算。Git OID：完整小写。
- 时间：程序生成，UTC RFC 3339；模型不得填写时间、哈希、Session ID。
- 项目内路径：`/` 分隔的 Git 相对路径。
- JSON：UTF-8 **无 BOM**；持久化顶层对象含整数 `schemaVersion`；对象默认 `additionalProperties: false`。
- **可选关联字段必须显式写 `null`，不得省略**。未知字段和类型错误必须明确失败。

## 2. 状态机

### Run（6 态）

```text
planning -> running | failed | abandoned
running  -> planning | final_review | failed | abandoned
final_review -> planning | completed | failed | abandoned
```

终态：`completed` / `failed` / `abandoned`，不得恢复。继续工作只能新建 Run。
本版本**没有**：`waiting_for_claude`、`pausing`、`paused`、`canceled`、Resume 状态、Coordinator 所有权状态。

事件：`PLAN_ACCEPTED`（planning→running）、`REPLAN_REQUESTED`（running/final_review→planning）、
`SPEC_CHANGED`（planning→保持 planning；running/final_review→planning）、
`ALL_TASKS_COMPLETED`（running→final_review）、`FINAL_REVIEW_COMPLETED`（final_review→completed）、
`RUN_ERROR`（任一非终态→failed）、`RUN_ABANDONED`（任一非终态→abandoned）。

### Task（5 态）

```text
pending -> running | skipped
running -> pending | completed | failed
```

- `running -> pending` 的唯一合法原因：Claude 合法返回 `replan_required`，或 SPEC 在 Session 期间变化。
- `running -> completed` 要求：合法 `completed` 返回 **且** Git Checkpoint 成功。
- Task 终态：`completed` / `failed` / `skipped`。
- Task 可运行条件：`Run==running` ∧ `Task==pending` ∧ 所有 `dependsOn` 均 `completed` ∧ 不存在其他 running Task。
- 顶层 Task 按 `tasks.json` 稳定顺序串行选择；Task Plan 中**不得**保存运行状态（状态只在 `run.json`）。

## 3. 数值上限

- 当前计划 pending Task ≤ 50；Plan Revision ≤ 50（请求第 51 个 → `PLAN_REVISION_LIMIT_EXCEEDED`）。
- 一致性读取最多立即重试 3 次 → 仍不一致报 `STATE_SNAPSHOT_BUSY`。
- 前台中断等待子进程上限 10 秒，超时照常继续后续收尾，不递归终止其他进程。
- 顶层 Task 并发 = 1；同一时刻最多一个 Claude Session。

## 4. 错误模型（§15，稳定对外契约）

errorClass 行为：

| errorClass | 行为 |
|---|---|
| `startup_validation` | 不创建新 Run，输出诊断 |
| `run_error` | 当前非终态 Run → failed |
| `run_control` | 只由显式 abandon 产生，→ abandoned |
| `claude_error` / `plan_error` / `git_error` | 当前 Task 或 Run → failed |
| `state_error` | Run → failed；状态无法写入时仅输出诊断 |
| `report_error` | 仅在 final_review 首次生成报告时使 Run → failed |
| `command_error` | 当前 CLI 命令失败，不修改已有 Run 状态 |

errorCode → errorClass：

- `startup_validation`：`ENVIRONMENT_UNSUPPORTED`；`SPEC_NOT_FOUND`、`SPEC_AMBIGUOUS`、`SPEC_EMPTY`、`SPEC_NOT_REGULAR_FILE`、`SPEC_NOT_READABLE`、`SPEC_INVALID_UTF8`、`SPEC_OUTSIDE_REPOSITORY`、`SPEC_STAGED`；`WORKING_TREE_DIRTY`、`STATE_DIRECTORY_TRACKED`、`STATE_DIRECTORY_UNWRITABLE`、`GIT_UNAVAILABLE`、`GIT_WORKTREE_REQUIRED`、`GIT_HEAD_REQUIRED`、`BASE_BRANCH_REQUIRED`；`CLAUDE_CAPABILITY_MISSING`、`CLAUDE_INSTALLATION_UNHEALTHY`、`SETTINGS_INVALID`；`RUN_ALREADY_ACTIVE_OR_INTERRUPTED`、`STATE_INVALID`、`ARCHIVE_FAILED`、`ARCHIVE_CONFLICT`
- `run_error`：`RUN_INTERRUPTED`
- `run_control`：`RUN_ABANDONED_BY_USER`
- `claude_error`：`CLAUDE_START_FAILED`、`CLAUDE_EXIT_NONZERO`、`CLAUDE_STREAM_FAILED`、`CLAUDE_RESULT_INVALID`、`CLAUDE_REPORTED_FAILURE`、`FINAL_REVIEW_RESULT_INVALID`
- `plan_error`：`PLAN_INVALID`、`PLAN_REVISION_CONFLICT`、`PLAN_REVISION_LIMIT_EXCEEDED`
- `git_error`：`GIT_COMMAND_FAILED`、`GIT_FACT_CONFLICT`、`GIT_HISTORY_DIVERGED`、`PLANNING_SIDE_EFFECT_DETECTED`、`PROTECTED_PATH_CHANGED`
- `state_error`：`STATE_WRITE_FAILED`、`STATE_VALIDATION_FAILED`
- `report_error`：`FINAL_REPORT_GENERATION_FAILED`
- `command_error`：`CLI_USAGE_INVALID`、`RUN_NOT_FOUND`、`COMMAND_STATE_INVALID`、`REPORT_NOT_AVAILABLE`、`REPORT_COMMAND_FAILED`、`STATE_SNAPSHOT_BUSY`、`RUN_NOT_ABANDONABLE`、`ABANDON_REQUIRES_FORCE`

Provider/鉴权/网络/额度错误**不设新类别**，统一映射 `CLAUDE_EXIT_NONZERO` 并保留可读诊断。
错误处理通则：稳定 errorCode、经脱敏保留语义、指明阶段、立即停止、不自动重试、不自动恢复、不按自由文本改策略。

## 5. CLI（§17）

命令：`start [spec-path] [--full-access] [--claude-cli-path <path>] [--git-cli-path <path>]`、`status`、`report`、`abandon --force`。
本版本**没有**：`init`、`resume`、`pause`、`stop`、`cancel`、`retry`、`approve`、`resolve`、`cleanup`、后台模式。

退出码：0 成功（status 读 failed/abandoned 仍是成功读取）；1 Run 正常持久化为 failed；2 用法错误；3 启动前置校验失败；4 status/report/abandon 命令失败；130 第一次中断已处理（优先于 1）。CLI 失败必须同时输出稳定 errorCode，不得用工具原始退出码替代。

## 6. Git 事实

- Run Branch：`apex-coding-agent/<run-id>`，从启动时 HEAD 创建；Run 结束后保持 Run Branch 为当前分支。
- `baseBranch` / `baseBranchRef`（完整 `refs/heads/...`）/ `baseCommit` / `runBranch` 写入 `run.json` 后**不得改写**。
- Coordinator 的 Commit 一律 `--no-verify --no-gpg-sign`；必须显式排除 SPEC 与 `.apex-coding-agent/`。
- Commit Message：
  - Task 最终：`apex-coding-agent(<task-id>): <task-title>`
  - Task 中间：`apex-coding-agent(<task-id>): preserve intermediate work`
  - Review 中间：`apex-coding-agent(final-review): preserve intermediate work`
  - Review 最终：`apex-coding-agent(final-review): finalize <run-id>`
- Task Checkpoint Trailer（§12.2）：`ApexCodingAgent-Run` / `ApexCodingAgent-Task` / `ApexCodingAgent-Plan-Revision` / `ApexCodingAgent-Session`。
- Coordinator **永不**：push、改 remote、merge Base Branch、reset 用户工作区、删用户分支、破坏性清理、rebase/stash/自动回滚。
- 状态目录不入库：用 `git rev-parse --git-path info/exclude` 定位 exclude 文件并幂等加入 `.apex-coding-agent/`；不改 `.gitignore`，不假设 `.git` 是目录。

## 7. 持久化铁律

- 写协议：serialize → 同目录临时文件 → close → rename → 重读并 Schema 校验。正常返回的写入错误终止当前 Run。
- 每次成功替换 `run.json`，`stateRevision` 严格递增。
- Plan Revision 提交顺序：写并校验不可变 Snapshot → 替换并校验 `tasks.json` → 计算其原始字节 SHA-256 → 最后替换 `run.json`（提交点）。
- `planRevision == 0` 且 `tasksSha256 == null` 只允许出现在初始 Planning 未提交 Revision 1 时；此时 `tasks.json` 必须不存在。
- 一致性读取：读 `run.json` → 读 `tasks.json` → 再读 `run.json`；两次 `stateRevision` 相同 ∧ `planRevision` 相等 ∧ `tasksSha256` 匹配；不一致最多重试 3 次 → `STATE_SNAPSHOT_BUSY`。`planRevision == 0` 时只做两次 `run.json` 比较。
- `executionEpisodes` / `finalReviewEpisodes` **只追加**；Episode 写入后只能补齐仍为 null 的结束字段，不得覆盖已有非空事实。
- Session Record 一旦完成写入不可修改。`activeSession` 是接力槽，不是进程探针；Claude 退出到业务提交完成前保持非空。
- 不创建：`journal.jsonl`、`*.previous`、PID 文件、Lock 文件、Pipe/Mutex 标识文件。不承诺跨文件原子性、崩溃恢复、断电恢复。

## 8. Claude 调用铁律

- 参数数组 spawn：`-p --session-id <程序分配UUID> --permission-mode <mode> --output-format stream-json --verbose --json-schema <内置Schema> <提示词>`。
- 成功 ⇔ 退出码 0 ∧ 恰好一个合法 `type=="result"` 终止事件 ∧ `structured_output` 通过对应 Schema ∧ 事件 Session ID 与传入一致。
- stdout 逐行 JSON，空行可忽略；非空行非 JSON → `CLAUDE_STREAM_FAILED`；多/缺终止事件、Session ID 冲突、退出 0 但缺合法结果 → `CLAUDE_RESULT_INVALID`（Final Review 的 Schema 失败用 `FINAL_REVIEW_RESULT_INVALID`）。
- 未知但合法的非终止事件：脱敏后只写日志，不改变 Domain 状态；stderr 只作脱敏诊断。
- **不**重试、**不** `--resume`、**不**接管/重启旧 Session、**不**保存 PID。`decision == "failed"` 是合法结果，由 Application 映射 `CLAUDE_REPORTED_FAILURE`。
- 权限模式：Planning 恒 `plan`（不可覆盖）；Execution/Final Review 默认 `auto`，仅显式 `--full-access` 用 `bypassPermissions` 且必须显示风险提示。
- Execution 默认**不得**传限制型参数：`--strict-mcp-config`、空 `--tools`、禁用 Skills/Subagents/Hooks/MCP 的参数、隔离 `CLAUDE_CONFIG_DIR`。
- 环境继承：直接启动 `claude`，继承用户环境；不读/缓存/输出 API Key、Token；不调用 CC Switch 私有 API；Provider 元数据只从允许列表字段提取（先允许列表，后脱敏）。
- 能力探测优先于版本号：`claude --version` + `claude --help` 确认 Print Mode、`stream-json`、`--json-schema`、`plan`、`auto`、`bypassPermissions`、显式 Session ID；缺失即停止并列出缺失能力，不走降级路径。

## 9. 永不出现清单（DoD 反向校验）

代码库与 CLI 中不得存在：Mutex、Named Pipe 控制、Job Object、PID 追踪/恢复、Invocation、Journal/重放、
`run.json.previous` 类回退文件、崩溃恢复、Session Resume、Pause/Stop/Cancel、`waiting_*`/`paus*` 状态、
C#/.NET/Rust/C++/N-API 依赖、自动 push/PR/merge/部署、legacy/迁移/兼容/fallback/deprecated 逻辑。

## 10. 顺序敏感流程（实现时逐字对照 SPEC）

- Run 创建 10 步：§8.2（步骤 1–3 失败 = startup_validation；步骤 4 = `STATE_WRITE_FAILED`；步骤 5 起失败 = Run failed）。
- Session 生命周期 7 步：§6.3（先存 `activeSession` 事实再启动进程；先写 Session Record 再提交业务结果）。
- SPEC SHA-256 重算边界：§3.2（start；每个 Session 启动前；Session 正常结束后提交结果前；生成报告前）。
- Task Checkpoint 11 步：§12.2；中间 Checkpoint 7 步：§12.3；Final Review Checkpoint 8 步：§12.4。
- Replan 10 步：§13；Plan 合并 11 步：§6.5；归档 6 步 + 清理规则：§4.4；abandon 10 步：§17。
- 中断收尾 6 步：§2.4。
