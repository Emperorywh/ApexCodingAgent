# ApexCodingAgent 长时间执行 Coding Agent 规格

> 文档状态：Implementation Baseline
>
> 规格版本：4.1.1
>
> 产品定位：Windows 上运行的 TypeScript Coding Agent Orchestrator
>
> 目标运行时：Node.js（TypeScript 编译产物）+ Anthropic Claude Code CLI
>
> 目标平台：Windows 10/11
>
> 默认模式：单前台进程、单活动 Run、顶层 Task 串行、Claude 原生 Agent 能力可用
>
> 兼容策略：不兼容旧版配置、状态、目录和运行数据，不提供迁移、legacy、deprecated 或 fallback 逻辑

---

## 1. 文档职责

本文档定义 `ApexCodingAgent` 的产品目标、用户体验、模块边界、状态模型、任务规划方式、Claude Code 调用方式、Git Checkpoint、持久化格式、错误语义和验收要求。

本文档同时区分两类契约：

- 用户项目契约：用户启动长任务时必须提供和遵守什么；
- 程序内部契约：`ApexCodingAgent` 自身必须内置和实现什么。

本文中的“必须”“不得”“只能”是规范性要求；“建议”不构成验收门禁。

用户项目不得被要求复制 `ApexCodingAgent` 的内部架构文档、Schema、提示词、审批文件或配置模板。内部契约必须随程序版本发布，由程序自行维护。

本文中 Coordinator 与 Orchestrator 同义，均指 `ApexCodingAgent` 前台进程内的编排逻辑。

---

## 2. 产品定义

### 2.1 要解决的问题

用户通常只有一份完整的 `SPEC.md`，希望 Claude Code 围绕该规格持续完成一个较大的软件需求。

单个 Claude Session 不适合一次承担全部工作，原因包括：

- 上下文会逐渐膨胀；
- 不同工作适合按模块或纵向能力拆分；
- 实现过程中可能发现原计划需要调整；
- 每个阶段都需要形成可审查的 Git Checkpoint；
- 最终需要一次整体 Review。

系统需要把规格转换为结构化 Task Plan，按顺序启动多个 Claude Code Session，在 Task 边界保存状态和 Git Checkpoint，并在全部 Task 完成后执行最终 Review。

### 2.2 核心产品承诺

在满足最小前置条件的 Windows Git 项目中，用户执行：

```powershell
ApexCodingAgent start
```

系统必须在当前前台进程中自动完成：

1. 发现并读取 `SPEC.md`。
2. 使用当前用户已经配置的 Claude Code Provider 和鉴权。
3. 启动 Planning Session。
4. 让 Claude 检查规格与当前仓库并生成 Task Plan。
5. 把计划保存为 `.apex-coding-agent/tasks.json`。
6. 逐个调度并执行 Task。
7. 在 Task 边界保存状态和本地 Git Checkpoint。
8. 必要时由 Claude 修订尚未完成的计划。
9. 全部 Task 完成后启动 Final Review Session。
10. 生成 `.apex-coding-agent/report.md`。

### 2.3 核心原则

系统遵循以下原则：

> `ApexCodingAgent` 是 Claude Code 的轻量 Orchestrator。Claude Code 负责理解、规划、编码、工具调用、测试和整体 Review；`ApexCodingAgent` 只负责任务接力、结构化状态、Git Checkpoint 和确定的流程编排。

具体含义：

- 相信 Claude Code 的原生 Agent 能力；
- 不重复实现细粒度工具权限系统；
- 不重复实现 Claude Code 已有的进程恢复、会话内部重试或工具执行逻辑；
- 不把用户项目变成复杂的 Agent 配置仓库；
- 不使用聊天文本作为唯一运行状态；
- 不让 Claude 的自由文本直接覆盖 Coordinator 状态；
- 不建立操作系统级进程沙箱或进程树管理；
- 不追踪、持久化或恢复 PID；
- 不提供 Coordinator 崩溃恢复；
- 不恢复被中断的 Run，但提供显式、不可逆的 Run 废弃流程，避免项目永久阻塞；
- Claude CLI 调用失败时保存错误并直接结束当前 Run；
- 模型规划可以演进，但每次变更都必须显式形成 Plan Revision；
- 已完成 Task 的定义、结果和 Checkpoint 不得被后续重新规划静默改写。

### 2.4 明确的运行边界

本版本采用前台单进程模型：

- `ApexCodingAgent start` 启动一个前台 Node.js 进程；
- 该进程按顺序启动 Claude Code 子进程；
- 系统只等待 Claude Code 的流式输出、结构化结果和退出状态；
- Claude Code 正常退出并返回合法结构化结果时继续；
- Claude Code 启动失败、非零退出、输出流失败或结构化结果非法时，当前 Run 直接进入 `failed`；
- 系统不区分 Claude 崩溃、Provider 故障、网络故障、额度不足和其他非零退出原因来决定自动恢复；
- 系统不自动重启 Claude Session；
- 系统不接管旧 Claude Session；
- 系统不重新连接旧进程；
- 系统不维护进程树。

用户必须保持运行 `start` 的终端和 Apex 进程存活，直到 Run 进入终态。

前台进程必须处理用户从当前终端发出的第一次中断信号：

1. 停止启动新的 Claude Session。
2. 如果存在直接 Claude 子进程，使用 Node.js `ChildProcess.kill()` 请求终止该直接子进程。
3. 最多等待 10 秒，超时后无论子进程是否退出都继续执行后续步骤，不递归发现或终止 Claude 创建的其他进程。
4. 尽可能保存失败 Session Record、结束未完成 Execution Episode，并保留 Git 和错误事实；已写入的 Session Record 不得覆盖。
5. 将原 running Task 转为 `failed`，清除 `activeSession` 和 `currentTaskId`。
6. 在状态仍可写入时把当前 Run 转为 `failed`，错误码为 `RUN_INTERRUPTED`。

第二次中断信号可以立即结束 Apex 进程。该信号处理只属于前台进程的有界退出语义，不构成后台 Stop 协议、进程树管理或崩溃恢复保证。

如果终端、Apex 进程或操作系统被强制关闭：

- 系统不承诺终止 Claude 或 Claude 启动的其他进程；
- 系统不承诺恢复当前 Session、Task 或 Run；
- 系统不承诺当前 `.apex-coding-agent` 状态可继续使用；
- 用户必须自行检查工作区、当前分支和可能仍在运行的进程；
- 如果持久化状态仍为非终态，用户必须在确认旧 Apex 和 Claude 进程均不再写入仓库后，显式执行 `ApexCodingAgent abandon --force`；
- Run 被废弃并进入终态后，用户可以在工作区重新满足启动条件时创建新 Run。

这些限制是本版本的显式产品边界，不属于待实现缺陷。

### 2.5 信任模型

本系统采用 `trust-first` 模型：

- 用户信任当前 Windows 账户下运行的 Claude Code；
- 用户信任自己通过 CC Switch 或 Claude Code 配置启用的 Provider、MCP、Skills、Plugins 和 Hooks；
- Claude 可以在当前 Windows 用户权限允许的范围内访问项目和调用工具；
- `ApexCodingAgent` 不把 Claude 或 Candidate Code 视为恶意租户；
- `ApexCodingAgent` 不声明提供宿主级安全隔离；
- `ApexCodingAgent` 不声明能够阻止 Claude 访问用户账户本来有权访问的文件、网络或进程。

### 2.6 非目标

本版本不负责：

- Linux 或 WSL2 运行；
- 多仓库事务；
- 多个顶层 Task 并行执行；
- 多个 Coordinator 的并发协调；
- 分布式 Coordinator；
- Pause、Resume 或 Stop 控制协议；
- Coordinator 崩溃恢复；
- Claude 进程崩溃恢复；
- PID、进程启动时间或进程树追踪；
- Windows Named Mutex；
- Windows Named Pipe 控制协议；
- Windows Job Object；
- `CreateProcess` 挂起启动；
- `ReplaceFileW`、`MoveFileExW` 等 Win32 专用持久化协议；
- 跨文件事务或 Write-Ahead Log；
- 断电级持久化保证；
- 零信任 Candidate Sandbox；
- 独立 Verification Oracle；
- 复杂审批链；
- 自动创建 PR；
- 自动推送远程仓库；
- 自动合并回 Base Branch；
- 自动执行生产部署、付款或生产数据变更；
- 兼容任何旧版运行状态或目录。

`ApexCodingAgent abandon --force` 只终结已经失去 Coordinator 的持久化 Run，不连接、恢复或终止任何旧进程，因此不属于 Resume、Stop、进程管理或崩溃恢复。

Claude Code 在单个 Task 内使用 Subagents 或 Agent Teams 不属于顶层 Task 并行，系统不得主动禁用这些 Claude 原生能力。

---

## 3. 用户项目契约

### 3.1 最小目录

启动前，用户项目最小只需要：

```text
project/
  SPEC.md
```

首次启动后由系统自动创建：

```text
project/
  SPEC.md
  .apex-coding-agent/
    settings.json        # 可选
    tasks.json
    run.json
    plans/
    sessions/
    logs/
    history/
    report.md            # Run 完成时生成
```

除可选的 `settings.json` 外，`.apex-coding-agent/` 的内容全部由程序管理。用户可以读取，但不得在 Run 期间修改。

系统必须通过 `git rev-parse --git-path info/exclude` 定位当前工作区实际使用的本地 exclude 文件，并把 `.apex-coding-agent/` 幂等加入其中，不得假设 `.git` 一定是目录，也不得自动修改或提交项目的 `.gitignore`。

### 3.2 SPEC 发现

默认命令：

```powershell
ApexCodingAgent start
```

Coordinator 首先通过 Git 确定仓库根目录 `repositoryRoot`。默认发现必须通过 Git 获取已跟踪文件和未跟踪但未被忽略的文件：

```text
git ls-files --cached --others --exclude-standard
```

系统从结果中选择文件名严格等于 `SPEC.md` 的候选文件，并排除 `.git/` 和 `.apex-coding-agent/`。默认发现不得自行遍历被 Git 忽略的依赖目录，不得跟随目录符号链接或 Windows Junction。位于 Git ignored 路径中的 SPEC 只能通过显式路径指定。

也允许显式指定：

```powershell
ApexCodingAgent start .\docs\SPEC.md
```

规则：

- 显式相对路径以命令调用目录解析；
- 路径必须经过绝对路径、真实路径和 Windows 大小写不敏感的包含关系校验；
- 路径随后规范化为 `repositoryRoot` 内使用 `/` 分隔的 Git 相对路径；
- 词法路径和真实路径都必须位于 `repositoryRoot` 内；
- 文件必须是可读取的普通 UTF-8 文本文件，允许 BOM；SHA-256 始终按原始字节计算；
- 默认发现存在多个候选时必须要求用户显式指定；
- SPEC 内容为空时启动失败；
- 系统必须记录 SPEC 的 Git 相对路径和原始字节 SHA-256；
- Planning、Execution 和 Final Review Session 始终从同一权威路径读取 SPEC；
- SPEC 文件可以未跟踪或只有未 staged 的工作区修改；
- SPEC 在启动时不得处于 staged 状态；检测到 staged SPEC 时以 `SPEC_STAGED` 拒绝启动，系统不得自动 unstage；
- 内置提示必须要求 Claude 不得修改、暂存或提交 SPEC；
- SPEC 变化必须触发新 Plan Revision，不得静默继续旧计划。

Coordinator 必须在以下边界重新计算 SPEC SHA-256：

- `start`；
- 每次 Planning、Execution 和 Final Review Session 启动前；
- 每次 Session 正常结束后、提交其结果前；
- 生成最终报告前。

以下两种变化流程只适用于 Session 正常返回且结构化结果合法的情况；Session 契约失败时优先按 9.6 处理，不再进入 SPEC 变化流程。

如果 SPEC 在 Execution Session 期间变化：

1. 保存当前 Session 正常返回的事实；
2. 不提交基于旧 SPEC 的完成结论；
3. 按 12.3 保存中间 Checkpoint 或无变更事实；
4. 当前 Task 转回 `pending`；
5. Run 进入 `planning`；
6. 生成新 Plan Revision，并为中间 Checkpoint 指定接管 Task。

如果 SPEC 在 Final Review Session 期间变化：

1. 保存当前 Session 和 Git 事实；
2. 不提交基于旧 SPEC 的 Final Review 结论；
3. 按 12.3 保存中间 Checkpoint 或无变更事实；
4. Run 进入 `planning`；
5. 通过新增 pending Task 表达新需求并接管中间 Checkpoint，不修改 completed Task。

### 3.3 不要求用户提供的文件

用户不得被要求提供：

- `ARCHITECTURE.md`
- `docs/adr/*.md`
- `CLAUDE.md`
- `agent/config.yaml`
- `agent/tasks.json`
- `agent/baseline-approval.json`
- 外置 Schema Registry
- `scripts/bootstrap.ps1`
- `scripts/verify.ps1`

如果项目本来存在 `CLAUDE.md`、`.claude/`、MCP、Skills、Plugins 或 Hooks，Claude Code 可以按照其原生规则加载。

### 3.4 最小外部前置条件

启动必须满足：

- Windows 10/11；
- 5.1 明确定义的 Node.js 运行时可用；
- `claude` 可执行文件可用；
- Claude Code 支持 Print Mode 和结构化输出；
- `git` 可执行文件可用；
- 当前目录属于非 bare Git 工作区；
- 当前 HEAD 附着于本地分支；
- 当前 Git HEAD 存在；
- 当前工作区干净，唯一例外是 SPEC 文件本身；
- SPEC 可以未跟踪或仅有工作区修改，但不得存在 staged 修改；
- 当前用户对项目目录和 `.git` 具有读写权限；
- 当前用户已经配置可用的 Claude Code Provider 和鉴权；
- 不存在当前目录下尚未终态的 Run；
- 用户没有在同一仓库同时运行另一个 `ApexCodingAgent start`。

工作区不干净时，系统必须给出明确诊断并停止，不得自动 commit、stash、reset 或删除用户改动。

并发启动属于用户契约外行为。本版本不使用进程锁、Mutex 或控制服务检测同时发生的竞态启动。`abandon --force` 同样依赖用户确认不存在仍在写入该仓库的旧 Apex 或 Claude 进程。

---

## 4. 运行目录与事实所有权

### 4.1 存储布局

```text
.apex-coding-agent/
  settings.json
  tasks.json
  run.json
  plans/
    <plan-revision>.json
  sessions/
    <session-id>.json
  logs/
    <session-id>.log
  history/
    <run-id>/
      archive-manifest.json
      tasks.json
      run.json
      plans/
      sessions/
      logs/
      report.md            # 若该 Run 已生成报告
  report.md
```

本版本不创建：

- `journal.jsonl`
- `run.json.previous`
- `tasks.json.previous`
- PID 文件
- Lock 文件
- Pipe 或 Mutex 标识文件

`logs/` 和 `history/` 不设大小上限和自动清理，磁盘占用由用户管理。

### 4.2 唯一事实源

| 信息 | 唯一来源 |
|---|---|
| 产品目标与业务需求 | 用户指定的 `SPEC.md` |
| 当前 Task Plan | `.apex-coding-agent/tasks.json` |
| Plan Revision 历史 | `.apex-coding-agent/plans/<revision>.json` |
| Run 和 Task 当前状态 | `.apex-coding-agent/run.json` |
| Session 调用结果 | `.apex-coding-agent/sessions/<session-id>.json` |
| 代码与 Checkpoint | Run Branch 上的 Git 历史 |
| 最终结果摘要 | `.apex-coding-agent/report.md` |
| 历史终态 Run 的全部程序事实 | `.apex-coding-agent/history/<run-id>/` |

自由文本日志和 Claude 自述是诊断信息，不得反向覆盖结构化状态。

### 4.3 写入职责

- Planner 只返回 `TaskPlanDraft`；
- Execution Session 只返回 `TaskExecutionResult`；
- Final Review Session 只返回 `FinalReviewResult`；
- Coordinator 是 `tasks.json`、`run.json`、`plans/`、`sessions/`、`history/` 和 `report.md` 的唯一程序写者；
- Claude 可以修改当前 Run Branch 的项目文件并使用 Git；
- Git Checkpoint 由 Coordinator 确认和记录；
- Claude 不得修改 `.apex-coding-agent/`。

### 4.4 当前 Run 与历史 Run

根目录中的 `tasks.json`、`run.json`、`plans/`、`sessions/`、`logs/` 和 `report.md` 只表示最近创建的 Run。

创建新 Run 前：

- 不存在旧状态时直接创建；
- 最近 Run 为终态时，先把其结构化状态、计划、Session、日志和报告归档到 `history/<run-id>/`；
- 最近 Run 为非终态时拒绝启动，错误码为 `RUN_ALREADY_ACTIVE_OR_INTERRUPTED`；
- 状态文件无法通过 Schema 校验时拒绝启动，错误码为 `STATE_INVALID`。

本版本不判断非终态 Run 对应的旧进程是否仍然存在，也不自动把非终态 Run 改写为失败。用户必须先自行检查进程和工作区；确认旧进程不再写入后，只能通过 `ApexCodingAgent abandon --force` 终结该 Run，不得手工改写程序状态文件。

归档只复制程序事实，不切换、修改或删除任何 Branch、Checkpoint 或用户文件。

归档必须采用自包含、幂等的目录发布流程：

1. 在 `history/` 下创建仅属于本次归档的 staging 目录。
2. 复制 `tasks.json`、`run.json`、`plans/`、`sessions/`、`logs/` 和存在的 `report.md`。
3. 生成包含相对路径、字节长度和 SHA-256 的 `archive-manifest.json`。
4. 重新读取并校验 staging 目录。
5. 将 staging 目录重命名为最终 `history/<run-id>/`。
6. 如果最终目录已经存在，只能在 Manifest 与当前终态 Run 完全匹配时把该步骤视为幂等成功，否则以 `ARCHIVE_CONFLICT` 失败。

归档发布成功后，Coordinator 必须：

- 保留 `settings.json`；
- 清除旧 Run 的根级 `tasks.json`、`run.json` 和 `report.md`；
- 清空仅属于旧 Run 的根级 `plans/`；
- 清空仅属于旧 Run 的根级 `sessions/` 和 `logs/`；
- 再创建新 Run；
- 归档或清理任一步失败时停止启动，不得暴露半个新 Run；
- staging 目录不属于有效历史 Run，后续启动可以在校验其目标 Run 后幂等覆盖或删除该 staging 目录。

---

## 5. 内部架构

### 5.1 技术边界

主程序必须使用 TypeScript 实现，并运行在 Node.js 上。

MVP 支持的 Node.js 主版本只包括 22.x LTS 和 24.x LTS。`package.json.engines.node` 必须表达为：

```text
>=22 <23 || >=24 <25
```

主程序使用 ESM，TypeScript 编译目标不低于 ES2022。发布 CI 必须分别在 Node.js 22.x 和 24.x 的最新可用补丁版本上执行完整自动化测试；其他 Node.js 主版本明确返回 `ENVIRONMENT_UNSUPPORTED`，不得隐式尝试兼容。

发布物为通过包管理器安装、暴露 `ApexCodingAgent` 命令并运行在用户已有 Node.js 上的 Node.js 包；本版本不提供独立安装器，也不捆绑 Node.js 运行时。

本版本不得引入：

- C# 项目或 .NET Runtime；
- Rust/C++ 原生扩展；
- N-API 原生模块；
- Windows Service；
- PowerShell 常驻控制进程；
- 任何用于 Mutex、Pipe、Job Object 或 PID 管理的原生桥接。

### 5.2 模块边界

系统内部必须按层组织以下高内聚模块：

| 层 | 模块 | 职责 |
|---|---|---|
| Domain | Run、Task、Plan Revision、Checkpoint | 实体、值对象、状态转换和跨状态不变量 |
| Application | StartRun、GeneratePlanRevision、ExecuteNextTask、ApplyPlanRevision、RunFinalReview、AbandonRun、GenerateReport | 编排单一用例，不直接调用 Node.js 或 CLI |
| Application Ports | ClaudeRuntimePort、GitPort、StateStorePort、FileSystemPort、ClockPort、ReporterPort、RedactionPort | 定义 Application 所需的次级端口 |
| Adapters | Claude Runtime、Git、JSON State Store、FileSystem、Clock、Reporter、Redaction | 实现 Application Ports 并集中映射外部错误 |
| Interfaces | CLI | 解析命令、调用 Application 用例并展示结果 |
| Bootstrap | Composition Root | 创建 Adapter 并完成依赖注入，不包含业务规则 |

### 5.3 依赖方向

```text
interfaces -> application -> domain
adapters -> application ports
bootstrap -> interfaces + application + adapters
```

要求：

- Domain 不依赖 Node.js API、PowerShell、Git CLI、Claude CLI 或文件系统；
- Application Ports 归 Application 层所有，不放入 Domain；
- Application 只依赖 Domain 和 Application Ports；
- Adapter 只实现 Application Ports，不被 Domain 反向引用；
- CLI 只解析命令和展示结果；
- Node.js `child_process`、`fs`、`path` 等 API 只能出现在 Adapter 或 Bootstrap；
- 不得使用巨型 Coordinator 函数承载全部用例；
- 不得把 Planning、Git、State 和 Reporter 规则塞入通用 `utils` 或 `helpers`；
- Task Plan 定义和 Task 运行状态必须分离；
- Claude 错误映射必须集中在 Claude Runtime Adapter，不得散落于 Orchestrator。

### 5.4 运行模型

一个存活的 `start` 进程拥有当前 Run 的全部写入职责。只有在用户确认该进程及其 Claude 子进程不再写入仓库后，新的 `abandon --force` 进程才可以接管一次终态写入；两者并发属于明确禁止的用户违约行为。

运行期间：

- 顶层 Task 串行；
- 同一时刻最多一个 Claude Session；
- 所有状态变更在 Node.js 进程内顺序执行；
- 不启用后台 Coordinator；
- 不开放本地 IPC 服务；
- 不允许其他 Apex 进程修改当前 Run；
- `status` 只能读取当前持久化快照。

### 5.5 主数据流

```text
CLI
  -> Application Use Case
  -> Domain 状态转换
  -> Application Port
  -> Adapter
  -> 外部 Claude、Git 或文件系统
  -> 结构化事实
  -> Domain 校验
  -> State Store 提交
  -> CLI 展示
```

约束：

- 外部工具输出必须先由对应 Adapter 转换为结构化事实，才能进入 Domain；
- Domain 只根据显式命令、事件和值对象转换状态；
- State Store 只能持久化已经通过 Domain 不变量校验的聚合；
- Reporter 只读取已提交事实，不读取 Claude 自由文本日志来推断状态；
- CLI 不得绕过 Application 直接修改 State Store 或 Git。

---

## 6. 状态模型

### 6.1 Run 状态

Run 状态只有：

```text
planning
running
final_review
completed
failed
abandoned
```

允许转换：

```text
planning -> running
planning -> failed

running -> planning
running -> final_review
running -> failed

final_review -> planning
final_review -> completed
final_review -> failed

planning -> abandoned
running -> abandoned
final_review -> abandoned
```

领域事件：

| 事件 | 合法源状态 | 目标状态 |
|---|---|---|
| `PLAN_ACCEPTED` | `planning` | `running` |
| `REPLAN_REQUESTED` | `running`、`final_review` | `planning` |
| `SPEC_CHANGED` | `planning` | 保持 `planning`，重新规划 |
| `SPEC_CHANGED` | `running`、`final_review` | `planning` |
| `ALL_TASKS_COMPLETED` | `running` | `final_review` |
| `FINAL_REVIEW_COMPLETED` | `final_review` | `completed` |
| `RUN_ERROR` | 任一非终态 | `failed` |
| `RUN_ABANDONED` | 任一非终态 | `abandoned` |

终态为：

- `completed`
- `failed`
- `abandoned`

终态不得恢复为活动状态。继续工作必须创建新 Run。

本版本没有：

- `waiting_for_claude`
- `pausing`
- `paused`
- `canceled`
- Resume State
- Coordinator Ownership State

### 6.2 Task 状态

Task 运行状态为：

```text
pending
running
completed
failed
skipped
```

Task Plan 中不得保存运行状态；运行状态只存在于 `run.json`。

允许转换：

```text
pending -> running
pending -> skipped

running -> pending
running -> completed
running -> failed
```

| 转换 | 唯一合法原因 |
|---|---|
| `pending -> running` | Orchestrator 已选择该 Task，并在启动 Claude 前保存当前 Session 事实 |
| `pending -> skipped` | 新 Plan Revision 明确省略该旧 pending Task |
| `running -> pending` | Claude 合法返回 `replan_required`，或 SPEC 在 Session 期间变化 |
| `running -> completed` | Claude 合法返回 `completed`，且 Git Checkpoint 成功 |
| `running -> failed` | Claude 调用失败、合法返回 `failed`、结构化结果非法、Git Checkpoint 失败、前台中断或用户废弃 Run |

`completed`、`failed` 和 `skipped` 是当前 Run 内的 Task 终态。

Task 只有在以下条件成立时可以运行：

```text
Run status == running
AND Task status == pending
AND 所有 dependsOn Task == completed
AND 不存在其他 running Task
```

顶层 Task 按 `tasks.json` 中的稳定顺序串行选择。

### 6.3 Session

Planning、Execution 和 Final Review 每次都启动一个新的 Claude Code Session。

Session 与 Claude 进程一一对应：

- 一个 Session 只允许一次进程调用；
- Session 不恢复；
- Session 不关联多个 Invocation；
- Session 不记录 PID；
- Session 不记录进程启动时间之外的 OS 进程事实；
- Session 失败后当前 Run 直接失败；
- Execution Session 不自动重试。

Session 的持久化生命周期必须为：

1. Coordinator 分配 Session ID。
2. 在 `run.json.activeSession` 中保存 Session 类型、Task ID、Plan Revision、SPEC SHA-256 和开始时间。
3. Execution Session 同时在对应 Task 的 `executionEpisodes` 末尾追加一个未结束 Episode。
4. 保存成功后才能启动 Claude 进程。
5. Claude 结束后先写入最终 Session Record，再提交 Task、Plan 或 Final Review 的业务结果。
6. 业务结果和必要 Checkpoint 提交后清除 `activeSession`。
7. 启动失败时也必须尽可能写入失败 Session Record，并清除 `activeSession`；无法写入时只输出诊断，不伪造成功状态。

`activeSession` 表示尚未完成业务提交的 Session 接力槽，不是进程存活探针。Claude 进程退出后到结果、Checkpoint 和状态提交完成前，该字段仍保持非空。

Session Record 至少包含：

- Session ID；
- Session 类型；
- Run ID；
- 可选 Task ID；
- 当前 Plan Revision；
- 开始和结束时间；
- Claude Code 版本；
- 实际模型和可获得的 Provider 信息；
- 退出码；
- 最终结构化结果；
- 日志文件引用；
- 稳定错误码和可读诊断。

### 6.4 Task Execution Episode

每次 Execution Session 都形成一个不可覆盖的 `TaskExecutionEpisode`。同一 Task 因 Replan 或 SPEC 变化可以拥有多个 Episode。

Episode 至少包含：

- Session ID；
- Task ID；
- Session 启动时的 Plan Revision；
- Session 启动前的 Task 定义所在 Revision；
- Session 启动前后的 SPEC SHA-256；
- 开始和结束时间；
- `completed`、`failed`、`replan_required`、`spec_changed` 或 `session_error` 结果；
- 结构化摘要和验收证据；
- 可选的最终 Task Checkpoint；
- 可选的中间 Checkpoint；
- 可选错误。

`executionEpisodes` 只能追加，不得覆盖、删除或重新排序。Replan 不属于失败重试，系统不维护自动重试次数，但这不影响完整保存每次执行 Episode。

### 6.5 Plan Revision

Task Plan 允许演进，但必须显式版本化：

- 初始计划的 `planRevision` 为 1；
- SPEC 变化、Execution 请求重新规划或 Final Review 发现缺口时可以生成新 Revision；
- 新 Revision 只能修改 `pending` Task；
- `completed` Task 的 ID、定义、结果和 Checkpoint 不得修改；
- `running` Task 必须先转回 `pending`；
- 每次 Revision 必须记录触发原因；
- 每个 Revision 的依赖图必须无环；
- 一个 Run 最多提交 50 个 Plan Revision；请求第 51 个 Revision 时 Run 以 `PLAN_REVISION_LIMIT_EXCEEDED` 失败。

Task ID 在整个 Run 内全局唯一：

- 已使用 ID 永久保留；
- completed Task 必须以相同 ID 和完全相同定义保留；
- 旧 pending Task 可以保留 ID 并修改定义；
- 新增 Task 必须使用从未出现过的 ID；
- 被省略的旧 pending Task 在 `run.json` 中转为 `skipped`；
- skipped Task 的 ID 不得复用。

Planner 返回完整的新 `TaskPlanDraft`。Coordinator 必须按以下算法合并：

1. 校验 Schema、ID、依赖和无环性。
2. 确认当前不存在 `running` Task。
3. 确认所有 completed Task 定义逐字段不变。
4. 更新仍存在的旧 pending Task。
5. 把被省略的旧 pending Task 标记为 skipped。
6. 为新增 Task 创建 pending 状态。
7. 校验并记录所有未吸收中间 Checkpoint 的 disposition。
8. 拒绝 ID 复用、completed Task 改写和未吸收中间 Checkpoint 无归属。
9. 写入不可变 Revision Snapshot。
10. 替换 `tasks.json`。
11. 更新 `run.json` 的 Revision 和 Task 状态。

本版本不承诺步骤 9 至 11 跨进程崩溃时可恢复为完整事务；任一步正常返回错误时，当前 Run 进入 `failed`。`status` 必须使用 11.2 定义的一致性读取协议，不得展示跨 Revision 拼接的状态。

### 6.6 跨状态不变量

- `planning` 不得存在 `running` Task；
- `running` 最多存在一个 `running` Task；
- `running` 要求每个未被 completed Task 吸收的中间 Checkpoint 都由 pending Task 或当前 running Task 接管；
- `final_review` 要求当前计划所有 Task 已完成，且每个中间 Checkpoint 的 owner Task 已完成；
- `completed` 要求 Final Review 和报告均已完成；
- `failed` 不得继续调度，且不得存在 `activeSession` 或 `currentTaskId`；
- `abandoned` 不得存在 `activeSession` 或 `currentTaskId`，废弃时原 running Task 必须转为 failed 并记录 `RUN_ABANDONED_BY_USER`；
- 任一时刻最多存在一个活动 Session；
- 活动 Session 只能属于当前 Run；
- Execution Session 必须属于 `run.json.currentTaskId` 指向的 Task。

---

## 7. 自动任务规划

### 7.1 Planning Session

当 `tasks.json` 不存在或需要新 Revision 时，Coordinator 启动 Planning Session。

Planning Session 必须：

- 以 `repositoryRoot` 为当前目录；
- 完整读取 SPEC 权威副本；
- 检查仓库目录、技术栈、模块边界、构建入口和测试入口；
- 只进行分析和规划；
- 不修改项目代码；
- 使用 Claude Code `--permission-mode plan`；
- 使用 Print Mode；
- 使用 Claude Code 原生结构化输出；
- 返回 `TaskPlanDraft`；
- 继承当前用户 Provider、模型和 Claude 配置；
- 允许读取型 Skills、MCP 和 Subagents；
- 不由模型填写系统时间、文件哈希或 Session ID。

生成新 Revision 时，Planning Session 还必须读取：

- 上一 Revision 的完整计划；
- completed Task 的不可变定义、结果摘要和 Checkpoint；
- 当前 pending Task；
- skipped Task 及其原因；
- Replan 的结构化原因；
- 所有尚未被 completed Task 结果吸收的中间 Checkpoint；
- 当前 Run Branch 的仓库事实。

### 7.2 Claude 调用

概念调用为：

```powershell
claude `
  -p `
  --session-id "<程序分配的 UUID>" `
  --permission-mode plan `
  --output-format stream-json `
  --verbose `
  --json-schema "<内置 TaskPlanDraft Schema>" `
  "<内置规划提示词>"
```

实际实现必须通过 Node.js `child_process.spawn()` 或等价的参数数组 API 传递参数，不得拼接 Shell 命令字符串。

Claude Runtime 必须：

- 从最终结果事件的 `structured_output` 读取 Schema 结果；
- 从稳定的流式事件读取 Session 元数据；
- 记录退出码和 stderr；
- 不从最终自然语言猜测结构化结果；
- 不保存 PID；
- 不调用 `--resume`；
- 不自动重新启动失败的 Claude 进程。

`stream-json` Adapter 契约：

- stdout 按 UTF-8、逐行 JSON 对象解析，空行可以忽略；
- 任一非空行无法解析为 JSON 时返回 `CLAUDE_STREAM_FAILED`；
- 必须且只能存在一个 `type == "result"` 的终止事件；
- 终止事件必须包含与对应内置 Schema 匹配的 `structured_output`；
- 事件中的 Session ID 如果存在，必须与程序传入的 `--session-id` 完全一致；
- 多个终止事件、缺失终止事件、Session ID 冲突或退出码 0 但缺失合法结果时返回 `CLAUDE_RESULT_INVALID`；
- 未知但合法的非终止事件只允许经过脱敏后写入日志，不得据此改变 Domain 状态；
- stderr 只作为已脱敏诊断保存，不参与结构化成功判断；
- 只有进程退出码为 0 且终止事件合法时，Claude Runtime 才能返回成功事实。

上述事件规则由 Claude Runtime Adapter 集中实现，并通过固定 stream Fixture 测试。其他模块不得解析 Claude 原始事件。

### 7.3 TaskPlanDraft

Planner 返回：

```json
{
  "summary": "整体实现目标",
  "assumptions": [
    "明确假设"
  ],
  "retainedCheckpointDispositions": [],
  "tasks": [
    {
      "id": "TASK-001",
      "title": "任务标题",
      "objective": "可交付目标",
      "dependsOn": [],
      "acceptanceCriteria": [
        "可观察的完成结果"
      ],
      "verificationHints": [
        "建议验证方式"
      ],
      "likelyPaths": [
        "可能涉及的路径"
      ],
      "estimatedSize": "medium",
      "context": "后续 Session 必须知道的上下文"
    }
  ]
}
```

字段要求：

- `retainedCheckpointDispositions` 在初始计划中必须为空；
- Replan 时，每个尚未被 completed Task 吸收的中间 Checkpoint 必须且只能出现一次，并指定继续接管它的 pending Task ID 和理由；
- `id` 使用 `TASK-001` 格式；
- `title` 简短且可搜索；
- `objective` 只描述一个主要结果；
- `dependsOn` 只能引用本计划中的 Task；
- `acceptanceCriteria` 至少一项；
- `verificationHints` 可以为空，不得虚构仓库不存在的命令；
- `likelyPaths` 是提示，不是硬权限范围；
- `estimatedSize` 只能是 `small`、`medium`、`large`；
- `context` 包含执行 Task 必须理解的架构或业务约束。

`retainedCheckpointDispositions` 的元素结构为：

```json
{
  "checkpointOid": "<完整 Git OID>",
  "ownerTaskId": "TASK-002",
  "rationale": "该任务负责继续验证、采用或移除中间变更"
}
```

如果中间变更不再需要，Planner 必须创建或指定一个 pending Task 负责显式移除并验证它，不得让中间 Checkpoint 成为无人负责的隐式状态。

### 7.4 tasks.json

Coordinator 校验 Draft 后补充系统事实：

```json
{
  "schemaVersion": 1,
  "runId": "<程序记录>",
  "planRevision": 1,
  "specPath": "SPEC.md",
  "specSha256": "<程序计算>",
  "generatedAt": "<程序生成>",
  "plannerSessionId": "<程序记录>",
  "summary": "整体实现目标",
  "assumptions": [],
  "retainedCheckpointDispositions": [],
  "tasks": []
}
```

模型不得决定：

- `schemaVersion`
- `runId`
- `planRevision`
- `specPath`
- `specSha256`
- `generatedAt`
- `plannerSessionId`

### 7.5 确定性校验

Coordinator 只执行结构和一致性校验，不重新评价 Claude 的产品判断。

必须校验：

- 结构符合内置 Schema；
- 当前计划至少包含一个 Task；
- 当前计划中的 `pending` Task 不超过 50；
- ID 唯一且格式正确；
- 依赖引用存在；
- 依赖图无环；
- 每个 Task 有目标和验收条件；
- 至少一个 Task 无依赖；
- 所有 Task 都可以从某个无依赖 Task 到达；
- Revision 不修改 completed Task；
- 整个 Run 使用的 Task ID 数字部分不得超过 999；
- `planRevision` 不得超过 50；
- 每个尚未被 completed Task 吸收的中间 Checkpoint 都有且只有一个 pending Task 接管；
- disposition 引用的 Checkpoint 和 Task 必须存在。

Draft 不合法时：

1. 保存确定性校验错误；
2. 当前 Run 直接进入 `failed`；
3. 不得启动结构修复 Session；
4. 不得删除未知字段、猜测依赖或自动重排来掩盖 Planner 错误。

### 7.6 任务拆分原则

内置规划提示词必须指导 Claude：

- 按领域能力、模块边界或可验证纵向功能拆分；
- 不按文件数量机械拆分；
- 每个 Task 适合一个顶层 Claude Session 完成；
- 架构基础先于依赖它的业务实现；
- 测试通常与实现放在同一 Task；
- 调查 Task 必须产生明确结论；
- 全新系统不得生成 legacy、迁移、兼容、fallback 或 deprecated 工作；
- 最后包含整体集成与最终验证；
- 不得制造微型 Task；
- 不得把整个系统塞入一个巨型 Task。

---

## 8. Run 创建

### 8.1 启动检查

`ApexCodingAgent start` 必须检查：

1. Windows 版本受支持；
2. SPEC 唯一、可读且非空；
3. Node.js Runtime 可用；
4. `claude --version` 成功；
5. Claude CLI 支持 Print Mode、`stream-json`、`--json-schema`、`plan`、`auto`、`bypassPermissions` 和显式 Session ID；
6. `git` 可用；
7. 当前目录属于 Git 工作区；
8. HEAD 附着于本地分支；
9. `.apex-coding-agent/` 不含 Git 已跟踪路径；
10. SPEC 不存在 staged 修改；
11. 除 SPEC 的未跟踪或工作区修改外，工作区干净；
12. 不存在非终态 Run；
13. 运行目录可创建和写入。

能力探测优先于硬编码 Claude Code 版本号。Claude Runtime Adapter 必须通过参数数组执行 `claude --version` 和 `claude --help`，确认必需选项和枚举值明确存在；帮助输出缺失、含糊或无法解析时视为能力缺失。检测不到必需能力时必须输出缺失能力和实际版本并停止，不得进入兼容或降级路径。能力解析集中在 Claude Runtime Adapter，并使用不同版本的固定 Help Fixture 测试。

### 8.2 创建顺序

Run 创建顺序：

1. 通过 `git rev-parse --git-path info/exclude` 定位实际 exclude 文件，并幂等加入 `.apex-coding-agent/`；
2. 创建 `.apex-coding-agent`；
3. 如果最近 Run 已处于终态，完成历史归档；
4. 创建 `run.json`，状态为 `planning`；
5. 从当前 HEAD 创建并切换到 Run Branch；
6. 启动 Planning Session；
7. 写入 Revision 1 Snapshot；
8. 写入 `tasks.json`；
9. Run 转为 `running`；
10. 开始调度 Task。

任一步正常返回错误时：

- 停止后续步骤；
- 步骤 1 至 3 失败时不创建新 Run，以 `startup_validation` 输出诊断；
- 步骤 4 无法完成初始 `run.json` 写入时以 `STATE_WRITE_FAILED` 输出诊断，不声称存在新 Run；
- 步骤 5 以后失败时尽可能把可用诊断写入 `run.json`，当前 Run 进入 `failed`；
- 不修改 Base Branch 引用；
- 不自动回滚已经完成的文件或 Git 操作。

### 8.3 Run Branch

每个 Run 使用独立本地分支：

```text
apex-coding-agent/<run-id>
```

`baseBranch`、`baseBranchRef`、`baseCommit` 和 `runBranch` 写入 `run.json` 后不得改写。`baseBranchRef` 必须是完整的 `refs/heads/...` 引用。

规则：

- 从启动时的当前 HEAD 创建；旧 Run 结束后工作区通常仍停留在旧 Run Branch，此时重新 `start` 会以该分支为 Base 继续，需要全新起点时用户必须先自行切回原分支；
- 创建后切换工作区到 Run Branch；
- Claude Session 的工作目录始终是 `repositoryRoot`；
- Claude 可以在 Run Branch 中使用 Git；
- Coordinator 不禁止 Claude 创建本地 Commit；
- Task 结束时如果存在未提交变更，Coordinator 创建统一 Checkpoint Commit；
- Claude 已创建 Commit 时，Coordinator 保留这些 Commit，只提交剩余变更；
- Coordinator 不调用 push；
- 不自动创建 PR；
- 不自动切回或合并 Base Branch；
- Run 结束后保持 Run Branch 为当前分支；
- Final Report 必须给出 Run Branch 和最终 Commit。

每次 Session 启动前和正常结束后必须确认：

- 当前 HEAD 附着于预期 Run Branch；
- Session 开始 HEAD 等于 `run.json.expectedHead`；
- `baseBranchRef` 仍精确指向 `baseCommit`；
- 所有 completed Task Checkpoint 都是当前 HEAD 的祖先；
- `.apex-coding-agent/` 不包含任何 Git 已跟踪路径；
- Session 新增的 Commit 不包含 SPEC 或 `.apex-coding-agent/`；
- SPEC 不处于 staged 状态。

Planning Session 还必须在结束后确认：

- HEAD 与 Session 开始时完全相同；
- 除 SPEC 和 `.apex-coding-agent/` 外，index、已跟踪工作区和未跟踪文件集合与 Session 开始时完全相同；
- 检测到任何副作用时以 `PLANNING_SIDE_EFFECT_DETECTED` 失败，不自动回滚。

Git 不变量失败时 Run 进入 `failed`。

---

## 9. Task 执行

### 9.1 调度

Orchestrator 选择 `tasks.json` 中第一个依赖已完成且状态为 `pending` 的 Task。

没有可执行 Task 时：

- 当前计划全部 Task completed：进入 `final_review`；
- 存在 failed Task：Run 进入 `failed`；
- 存在无法解释的 pending Task：Run 进入 `failed`。

### 9.2 Execution Session 上下文

每个 Execution Session 的提示必须包含：

- SPEC 权威路径；
- 当前 SPEC SHA-256；
- 当前 Task 完整定义；
- 当前 Plan Revision；
- completed Task 的简洁摘要和 Checkpoint；
- 当前 Run Branch；
- 仓库根目录；
- 结构化结果格式；
- 允许 Claude 请求 `replan_required`；
- 禁止修改、暂存或提交 SPEC；
- 禁止修改、暂存、提交或删除 `.apex-coding-agent/`。

不得重复注入全部历史日志和所有 Session 原始输出。

Claude 可以按原生规则读取：

- SPEC；
- 项目代码；
- Git 历史；
- `CLAUDE.md`；
- Skills、MCP、Plugins、Hooks 和 Memory。

### 9.3 Claude 原生能力

Execution Session 默认不得传入以下限制型参数：

- `--strict-mcp-config`
- 空 `--tools`
- 禁用 Skills 的参数
- 禁用 Subagents 的参数
- 禁用 Hooks 的参数
- 禁用 MCP 的参数
- 隔离 `CLAUDE_CONFIG_DIR`

默认执行权限模式：

```text
--permission-mode auto
```

用户显式执行：

```powershell
ApexCodingAgent start --full-access
```

时，Execution 和 Final Review 使用：

```text
--permission-mode bypassPermissions
```

`bypassPermissions` 必须在启动时显示明确风险提示。Planning 始终使用 `plan`。

Claude 的浏览器或浏览器扩展能力只按照 Claude Code 用户级和项目级配置继承。Apex 不提供额外浏览器模式配置，也不把未定义的浏览器环境变量或非稳定 CLI 参数纳入自身契约。

### 9.4 TaskExecutionResult

Execution Session 必须返回：

```json
{
  "decision": "completed",
  "summary": "完成内容",
  "tests": [
    {
      "command": "测试命令或验证动作",
      "result": "passed"
    }
  ],
  "acceptanceEvidence": [
    {
      "criterionIndex": 0,
      "status": "satisfied",
      "evidence": "对应验收条件的可观察证据"
    }
  ],
  "changedAreas": [
    "主要变更区域"
  ],
  "remainingRisks": [],
  "replanReason": null
}
```

`decision` 只能是：

- `completed`
- `failed`
- `replan_required`

字段规则：

- `summary` 必须非空；
- `tests` 可以为空；
- 每个测试结果只能是 `passed`、`failed` 或 `not_run`；
- `acceptanceEvidence.criterionIndex` 使用从 0 开始的数组索引，必须与当前 Task 的 `acceptanceCriteria` 一一对应，不得缺失、重复或引用越界；
- 每项验收证据的状态只能是 `satisfied` 或 `not_satisfied`，`evidence` 必须非空；
- `changedAreas` 和 `remainingRisks` 必须是字符串数组；
- `replan_required` 必须提供非空 `replanReason`；
- 其他 decision 的 `replanReason` 必须为 `null`；
- `completed` 不得同时包含失败测试；
- `completed` 要求全部 `acceptanceEvidence.status == satisfied`；
- `failed` 和 `replan_required` 可以包含 `not_satisfied`，但仍必须覆盖全部验收条件。

### 9.5 Task 完成

Task 完成条件：

```text
Claude Code 退出码 == 0
AND TaskExecutionResult 结构合法
AND decision == completed
AND 每项 acceptanceCriteria 都有 satisfied 证据
AND 当前 Git 分支和 HEAD 不变量成立
AND Git Checkpoint 成功
AND Task 状态保存为 completed
```

系统不要求：

- 独立 Verification Oracle；
- 独立 Reviewer；
- 人工 completion approval；
- 外层恶意代码 Sandbox；
- 进程恢复验证。

### 9.6 Claude 调用失败

以下任一情况立即使当前 Task 和 Run 进入 `failed`：

- Claude 可执行文件启动失败；
- stdout 或 stderr 管道发生不可恢复错误；
- Claude 进程返回非零退出码；
- 最终结构化结果缺失；
- 最终结构化结果不符合 Schema；
- `decision == failed`；
- Session 结束后的 SPEC、Git 或 State 校验失败。

系统必须：

- 保存已经获得的日志；
- 保存退出码和稳定错误码；
- 在控制台显示 Claude 返回的可读错误摘要；
- 保留 Run Branch 和当前工作区；
- 不自动重试；
- 不自动切换 Provider；
- 不进入等待状态；
- 不调用 Claude Session Resume；
- 不根据 PID 或进程状态执行补救。

---

## 10. Claude Code 与 CC Switch

### 10.1 鉴权所有权

Claude Code 鉴权由用户环境负责，不属于 `ApexCodingAgent` 的凭据管理职责。

用户可以使用：

- Claude Code 官方登录；
- CC Switch 当前激活 Provider；
- CC Switch 管理的第三方 Anthropic 兼容 Provider；
- Claude Code 原生支持的其他 Provider 配置。

### 10.2 低耦合集成

`ApexCodingAgent` 必须：

- 直接启动配置路径或 `PATH` 中的 `claude`；
- 继承当前 Windows 用户环境；
- 允许 Claude Code 读取用户级和项目级 settings；
- 不调用 CC Switch 私有 API；
- 不读取 CC Switch 数据库；
- 不复制或修改 CC Switch Provider；
- 不读取、缓存或输出 API Key、Auth Token；
- 不创建隔离的 Claude 配置目录。

只要用户在同一环境中直接执行 `claude` 可以正常工作，Apex 就应使用相同环境。

### 10.3 Provider 和网络错误

Provider、鉴权、网络、代理、额度或权限模式错误均按 Claude 调用失败处理：

- 当前 Run 进入 `failed`；
- 控制台显示 Claude 返回的错误；
- 不进入 `waiting_for_claude`；
- 不自动轮询；
- 不自动重试；
- 用户修复环境后执行新的 `start` 创建新 Run。

系统不得通过自由文本猜测错误是否“暂时可恢复”，因为本版本没有自动恢复路径。

### 10.4 Provider 切换

每次新 Claude 进程启动时继承当时的用户环境。

运行期间用户修改 CC Switch 配置时：

- 已运行进程如何响应由 Claude Code 和 CC Switch 决定；
- 后续新 Session 使用启动进程时可见的最新环境；
- Apex 不监听 CC Switch；
- Apex 不保证热切换成功；
- 任何失败仍按 10.3 终止 Run。

---

## 11. 状态持久化

### 11.1 持久化目标

状态持久化用于：

- 让用户和 `status` 查看当前进度；
- 为后续 Task 注入已完成事实；
- 生成最终报告；
- 保存终态 Run 历史；
- 支持测试和诊断。

状态持久化不用于：

- Coordinator 崩溃恢复；
- Claude 进程恢复；
- 多进程并发控制；
- 跨文件事务；
- 断电恢复。

### 11.2 JSON 写入

可变 JSON 文件使用简单的同目录临时文件替换：

```text
serialize
-> write same-directory temp
-> close temp
-> rename temp to target
-> reopen and validate
```

实现必须使用 Node.js `fs` API，不得直接调用 Win32 文件 API。

规则：

- JSON 使用 UTF-8、无 BOM；
- 完整写入临时文件后才能替换目标；
- 替换后重新读取并执行 Schema 校验；
- 正常返回的写入错误必须终止当前 Run；
- 不维护 previous 文件；
- 不通过日志猜测损坏状态；
- 不承诺进程被强制关闭时的持久化结果；
- 不承诺跨文件更新的原子性。

每次成功替换 `run.json` 时，`stateRevision` 必须严格递增。当 `planRevision > 0` 时，`run.json.tasksSha256` 必须保存当前 `tasks.json` 原始字节的 SHA-256；初始 Planning 阶段按下文规则保持为 `null`。

Plan Revision 的提交顺序必须为：

```text
写入并校验不可变 Revision Snapshot
-> 替换并校验 tasks.json
-> 计算 tasks.json 原始字节 SHA-256
-> 最后替换 run.json，作为新 Revision 的提交点
```

`status`、`report` 和 Reporter 必须使用一致性读取协议：

1. 读取并校验第一次 `run.json`。
2. 读取并校验 `tasks.json`。
3. 再次读取并校验 `run.json`。
4. 两次 `run.json.stateRevision` 必须相同。
5. `run.json.planRevision` 必须等于 `tasks.json.planRevision`。
6. `run.json.tasksSha256` 必须等于当前 `tasks.json` 原始字节 SHA-256。
7. 不一致时最多立即重试三次；仍不一致时以 `STATE_SNAPSHOT_BUSY` 结束当前只读命令，不修改 Run。

当 `run.json.planRevision == 0` 且 `tasksSha256 == null` 时，`tasks.json` 必须尚不存在；一致性读取只执行两次 `run.json` 的 `stateRevision` 比较。

该协议只保证正常并发读写时不会展示跨 Revision 拼接的快照，不构成 CAS、多写者协调、崩溃恢复或跨文件事务。

### 11.3 run.json

`run.json` 的顶层字段必须完整符合以下结构，不得增加自由扩展字段：

```json
{
  "schemaVersion": 1,
  "stateRevision": 1,
  "runId": "RUN-<UUID>",
  "status": "planning",
  "spec": {
    "path": "docs/SPEC.md",
    "sha256": "<64 位小写十六进制>"
  },
  "planRevision": 0,
  "tasksSha256": null,
  "runSettings": {
    "executionPermissionMode": "auto",
    "claudeCliPath": null,
    "gitCliPath": null
  },
  "repository": {
    "root": "<Windows 绝对路径>",
    "baseBranch": "main",
    "baseBranchRef": "refs/heads/main",
    "baseCommit": "<完整 Git OID>",
    "runBranch": "apex-coding-agent/<run-id>",
    "expectedHead": "<完整 Git OID>"
  },
  "currentTaskId": null,
  "activeSession": null,
  "tasks": {},
  "intermediateCheckpoints": [],
  "finalReviewEpisodes": [],
  "lastError": null,
  "finalCommit": null,
  "reportPath": null,
  "createdAt": "<UTC RFC 3339>",
  "updatedAt": "<UTC RFC 3339>",
  "terminalAt": null
}
```

规则：

- `planRevision == 0` 和 `tasksSha256 == null` 只允许出现在初始 Planning 尚未提交 Revision 1 时；
- `activeSession` 为 `null` 或严格的 Active Session 对象；
- `tasks` 使用 Task ID 作为键，值为严格的 Task Runtime State；
- `intermediateCheckpoints` 保存尚未成为 completed Task 最终结果的中间提交；
- `finalReviewEpisodes` 只能追加；
- `terminalAt` 只在 `completed`、`failed` 或 `abandoned` 时非空；
- `completed` 必须具有 `finalCommit` 和 `reportPath`；
- `failed` 和 `abandoned` 的 `finalCommit` 必须为 `null`。

Active Session：

```json
{
  "sessionId": "<小写 UUID>",
  "type": "execution",
  "taskId": "TASK-001",
  "planRevision": 1,
  "specSha256": "<64 位小写十六进制>",
  "startedAt": "<UTC RFC 3339>"
}
```

`type` 只能是 `planning`、`execution` 或 `final_review`。只有 `execution` 要求非空 `taskId`，其他类型的 `taskId` 必须为 `null`。

Task Runtime State：

```json
{
  "taskId": "TASK-001",
  "status": "pending",
  "executionEpisodes": [],
  "completedResult": null,
  "finalCheckpoint": null,
  "skipReason": null,
  "failure": null
}
```

条件规则：

- `pending` 和 `running` 的 `completedResult`、`finalCheckpoint`、`skipReason`、`failure` 必须为 `null`；
- `completed` 要求合法 `completedResult` 和非空 `finalCheckpoint`，`failure` 与 `skipReason` 必须为 `null`；
- `failed` 要求非空 Error Record，`completedResult` 和 `finalCheckpoint` 必须为 `null`；
- `skipped` 要求非空 `skipReason`，`completedResult`、`finalCheckpoint` 和 `failure` 必须为 `null`；
- `executionEpisodes` 可以在 pending 状态下非空，用于保留此前 replan_required 或 spec_changed 的执行历史。

Task Execution Episode：

```json
{
  "sessionId": "<小写 UUID>",
  "taskId": "TASK-001",
  "planRevision": 1,
  "specSha256Before": "<64 位小写十六进制>",
  "specSha256After": null,
  "startedAt": "<UTC RFC 3339>",
  "endedAt": null,
  "outcome": null,
  "summary": null,
  "acceptanceEvidence": [],
  "finalCheckpoint": null,
  "intermediateCheckpoint": null,
  "checkpointReason": null,
  "error": null
}
```

未结束 Episode 的上述可空结束字段必须为 `null`。结束后 `outcome` 只能是 `completed`、`failed`、`replan_required`、`spec_changed` 或 `session_error`，并要求结束时间、结束 SPEC SHA-256、摘要和 `checkpointReason` 非空。`checkpointReason` 必须说明 Checkpoint 已创建、只保留 Claude Commit、无仓库变化或因错误未创建。`failed` 和 `session_error` 要求非空 Error Record，其他 outcome 的 `error` 必须为 `null`。Episode 写入后只能补齐尚未产生的结束字段，不得覆盖已经提交的非空事实。

Final Review Episode：

```json
{
  "sessionId": "<小写 UUID>",
  "planRevision": 1,
  "specSha256Before": "<64 位小写十六进制>",
  "specSha256After": "<64 位小写十六进制>",
  "startedAt": "<UTC RFC 3339>",
  "endedAt": "<UTC RFC 3339>",
  "decision": "completed",
  "summary": "整体复核结论",
  "reviewedTaskIds": [],
  "changedAreas": [],
  "checkpointRole": "final-review-final",
  "checkpoint": "<完整 Git OID>",
  "checkpointReason": "Final Review Checkpoint 已确认",
  "error": null
}
```

`decision` 只能是 `completed`、`replan_required`、`spec_changed` 或 `session_error`。completed 要求 `checkpointRole == final-review-final` 和非空 Checkpoint。replan_required 或 spec_changed 有仓库变化时要求 `checkpointRole == final-review-intermediate`，无仓库变化时 `checkpointRole` 和 `checkpoint` 都为 `null`。Session 失败且没有合法 Checkpoint 时两者也为 `null`。所有情况都要求非空 `checkpointReason`；`session_error` 要求非空 Error Record，其他 decision 的 `error` 必须为 `null`。

Intermediate Checkpoint：

```json
{
  "oid": "<完整 Git OID>",
  "role": "task-intermediate",
  "sourceSessionId": "<小写 UUID>",
  "taskId": "TASK-001",
  "planRevision": 1,
  "summary": "保留该中间变更的原因",
  "ownerTaskId": null
}
```

`role` 只能是 `task-intermediate` 或 `final-review-intermediate`。`task-intermediate` 要求非空 `taskId`，`final-review-intermediate` 的 `taskId` 必须为 `null`。新 Plan Revision 提交后，`ownerTaskId` 必须指向负责接管该变更的 pending Task；当该 owner Task completed 后，中间 Checkpoint 视为已吸收。owner Task 被省略或改为 skipped 时，当前 Revision 必须同时把 Checkpoint 重新分配给另一个 pending Task。

本版本不包含：

- `stateVersion` CAS 协议；
- `waitingResumeState`；
- `pausedResumeState`；
- Coordinator 所有权；
- PID；
- Invocation；
- Process Job；
- 已处理控制命令。

### 11.4 Session Record

每次 Session 正常结束后保存一个严格 Schema 的 JSON Record。

Session Record 的完整顶层结构为：

```json
{
  "schemaVersion": 1,
  "sessionId": "<小写 UUID>",
  "type": "execution",
  "status": "completed",
  "runId": "RUN-<UUID>",
  "taskId": "TASK-001",
  "planRevision": 1,
  "specSha256": "<64 位小写十六进制>",
  "startedAt": "<UTC RFC 3339>",
  "endedAt": "<UTC RFC 3339>",
  "claude": {
    "version": "可读版本",
    "model": "可获得的模型标识或 null",
    "provider": "经过允许列表过滤的非敏感 Provider 名称或 null"
  },
  "exitCode": 0,
  "structuredResult": {
    "decision": "completed",
    "summary": "完成内容",
    "tests": [],
    "acceptanceEvidence": [
      {
        "criterionIndex": 0,
        "status": "satisfied",
        "evidence": "可观察证据"
      }
    ],
    "changedAreas": [],
    "remainingRisks": [],
    "replanReason": null
  },
  "logPath": "logs/<session-id>.log",
  "error": null
}
```

规则：

- `status` 只能是 `completed` 或 `failed`；
- `completed` 表示 Claude 进程以 0 退出且返回合法结构化结果，不代表其中的业务 decision 一定为 completed；
- `failed` 表示启动、进程、流或结构化结果契约失败，要求非空 Error Record；
- Planning 和 Final Review 的 `taskId` 必须为 `null`；
- `exitCode` 在进程成功启动后必须为整数，启动失败时为 `null`；
- `structuredResult` 只保存已通过对应 Schema 校验的结果，否则为 `null`；
- `claude.provider` 只能来自 Adapter 明确允许的 Provider 名称字段，不得保存环境变量、端点查询参数、Header 或完整配置对象；
- `error` 使用 11.6 的 Error Record；
- Session status 为 completed 时 `error` 必须为 `null`，status 为 failed 时 `structuredResult` 必须为 `null`；
- Session Record 一旦完成写入便不可修改。

Session 原始输出写入独立日志文件，并在写入前通过 18.4 的统一脱敏边界。

如果 Claude 进程未正常结束，系统保存已经收到的日志，并尝试写入失败 Session Record；该尝试失败不触发额外恢复协议。

### 11.5 Schema

程序必须内置并集中版本化：

- `TaskPlanDraft`；
- `TaskExecutionResult`；
- `FinalReviewResult`；
- Active Session；
- Task Runtime State；
- Task Execution Episode；
- Final Review Episode；
- Intermediate Checkpoint；
- Error Record；
- `tasks.json`；
- Plan Revision Snapshot；
- `run.json`；
- Session Record；
- Run Archive Manifest；
- `settings.json`。

共同规则：

- JSON 对象默认 `additionalProperties: false`；
- 持久化顶层对象包含整数 `schemaVersion`；
- 时间由程序生成，使用 UTC RFC 3339；
- Run ID 使用 `RUN-<UUID>`；
- Task ID 使用 `TASK-001` 到 `TASK-999`；
- Session ID 使用规范小写 UUID；
- SHA-256 使用 64 位小写十六进制；
- Git OID 使用完整小写 OID；
- 项目内路径使用 `/` 分隔的 Git 相对路径；
- 未知字段和类型错误必须明确失败。

### 11.6 其他规范数据结构

Plan Revision Snapshot 的完整顶层结构为：

```json
{
  "schemaVersion": 1,
  "runId": "RUN-<UUID>",
  "planRevision": 1,
  "parentPlanRevision": null,
  "trigger": {
    "type": "initial",
    "reason": "初始计划",
    "sourceSessionId": null
  },
  "specPath": "docs/SPEC.md",
  "specSha256": "<64 位小写十六进制>",
  "generatedAt": "<UTC RFC 3339>",
  "plannerSessionId": "<小写 UUID>",
  "summary": "整体实现目标",
  "assumptions": [],
  "retainedCheckpointDispositions": [],
  "tasks": []
}
```

`trigger.type` 只能是 `initial`、`execution_replan`、`spec_changed` 或 `final_review_replan`。`initial` 的 `sourceSessionId` 必须为 `null`；Execution 和 Final Review 触发时必须为对应 Session ID；在 Session 边界外检测到 SPEC 变化时可以为 `null`。Revision 1 的 `parentPlanRevision` 必须为 `null`，后续 Revision 必须等于前一 Revision 编号。

Error Record 的完整结构为：

```json
{
  "errorCode": "CLAUDE_EXIT_NONZERO",
  "errorClass": "claude_error",
  "stage": "execution",
  "message": "已脱敏的可读说明",
  "toolSummary": null,
  "sessionId": "<小写 UUID>",
  "taskId": "TASK-001",
  "at": "<UTC RFC 3339>"
}
```

所有可选关联字段必须显式写为 `null`，不得省略。

Run Archive Manifest 的完整顶层结构为：

```json
{
  "schemaVersion": 1,
  "runId": "RUN-<UUID>",
  "runStatus": "completed",
  "archivedAt": "<UTC RFC 3339>",
  "files": [
    {
      "path": "run.json",
      "byteLength": 123,
      "sha256": "<64 位小写十六进制>"
    }
  ]
}
```

`files` 必须覆盖归档中的全部普通文件，但不得包含 Manifest 自身；路径必须唯一、排序稳定且不得逃逸归档目录。

`runStatus` 只能是 `completed`、`failed` 或 `abandoned`，并且必须与归档内 `run.json.status` 一致。

本文中的数据结构是规范字段全集。实现内置 JSON Schema 可以增加正则表达式、长度、枚举、条件分支和数值范围，但不得增加未在本文定义的持久化业务字段。需要新增字段时必须先提升本规格和对应 `schemaVersion`。

---

## 12. Git Checkpoint

### 12.1 目标

Git Checkpoint 用于：

- 保存每个 completed Task 的代码结果；
- 为后续 Session 提供稳定上下文；
- 让用户审查 Run Branch；
- 避免自动改写 Base Branch。

它不用于 Coordinator 崩溃恢复。

Coordinator 创建的所有 Checkpoint Commit 一律使用 `--no-verify` 和 `--no-gpg-sign`：Checkpoint 是程序事实而非开发者提交，不得被仓库 hooks 或签名配置阻断。该行为只作用于 Coordinator 自己的 Commit，不修改用户的 hooks 或 Git 配置。

### 12.2 Task Checkpoint

Task 返回 `completed` 后：

1. 确认 TaskExecutionResult 已通过 Schema 和验收证据校验。
2. 读取 Task 开始 HEAD。
3. 确认当前 HEAD 位于预期 Run Branch。
4. 确认 Base Branch 引用未变化且历史 completed Checkpoint 仍可达。
5. 检查 Session 新增 Commit 不包含 SPEC 或 `.apex-coding-agent/`。
6. 记录 Claude 已创建的 Commit。
7. 对剩余跟踪或未跟踪变更创建 Checkpoint Commit。
8. 无变更时记录原因。
9. 保存最终 Commit OID，并把 Checkpoint 角色记录为 `task-final`。
10. Task 转为 `completed`。
11. 更新 `expectedHead`。

SPEC 和 `.apex-coding-agent/` 不是 Checkpoint 目标。Coordinator 创建 Commit 时必须显式排除这两个路径。

Commit Message：

```text
apex-coding-agent(<task-id>): <task-title>
```

Commit Trailer：

```text
ApexCodingAgent-Run: <run-id>
ApexCodingAgent-Task: <task-id>
ApexCodingAgent-Plan-Revision: <revision>
ApexCodingAgent-Session: <session-id>
```

### 12.3 中间 Checkpoint

Execution 返回 `replan_required`、SPEC 在 Execution 期间变化，或者 Final Review 返回 `replan_required` 时，已经产生的仓库变更不得成为隐式状态：

1. 先校验当前分支、Base Branch、受保护路径和历史 Checkpoint 不变量。
2. 保留 Claude 已创建且通过保护校验的 Commit。
3. 对剩余变更创建中间 Checkpoint Commit。
4. 无变更时显式记录 `no_intermediate_changes`。
5. 将 Checkpoint 追加到 `run.json.intermediateCheckpoints` 和对应 Episode。
6. 更新 `expectedHead`。
7. 下一次 Plan Revision 必须通过 `retainedCheckpointDispositions` 把每个中间 Checkpoint 分配给一个 pending Task。

Task 中间 Commit Message：

```text
apex-coding-agent(<task-id>): preserve intermediate work
```

Final Review 中间 Commit Message：

```text
apex-coding-agent(final-review): preserve intermediate work
```

中间 Checkpoint 不表示 Task completed，也不得被报告为成功的最终 Task Checkpoint。

### 12.4 Final Review Checkpoint

Final Review 修改项目文件时：

1. 先确认 FinalReviewResult 结构合法。
2. 记录 Review 开始 HEAD。
3. 校验当前分支、Base Branch、受保护路径和历史 Checkpoint。
4. `decision == replan_required` 时按 12.3 创建中间 Checkpoint，不创建 Final Commit。
5. `decision == completed` 时保留 Claude 已创建的合法 Commit，并对剩余变更创建 Final Review Commit；无任何仓库变更时不创建 Commit。
6. 保存 Final Commit OID；无变更时 Final Commit 为 Review 开始 HEAD。
7. 更新 `expectedHead`。
8. 再提交 Final Review 的 completed 结论。

Commit Message：

```text
apex-coding-agent(final-review): finalize <run-id>
```

### 12.5 Git 错误

任一 Git 命令失败或不变量冲突时：

- 当前 Run 进入 `failed`；
- 保留分支和工作区；
- 输出实际 Git 错误；
- 不自动 reset、rebase、stash、merge、clean 或切换分支；
- 不尝试恢复未完成 Checkpoint。

### 12.6 禁止的 Git 行为

Coordinator 不得：

- force push；
- 修改 remote；
- 合并 Base Branch；
- reset 用户工作区；
- 删除用户 Branch；
- 运行破坏性清理。

内置提示必须禁止 Claude 执行 remote push、生产部署、付款、生产数据变更或破坏其他分支。

上述 Claude 行为限制属于 trust-first 模型下的明确策略，不是宿主级技术隔离保证。Coordinator 可以确定性保证自己不调用 push、部署或生产副作用命令，并通过本地 Git 事实检测 Base Branch 和受保护路径变化；在不提供沙箱的前提下，系统不得声称能够阻止 Claude 绕过提示执行所有外部副作用。

---

## 13. Replan

Execution Session 返回 `replan_required` 时：

1. 保存 Session Record 和结构化原因；
2. 按 12.3 保存当前中间 Checkpoint 或无变更事实；
3. 当前 Task 从 `running` 转回 `pending`；
4. Run 从 `running` 转为 `planning`；
5. Planner 读取当前 SPEC、现有计划、completed Task、仓库、中间 Checkpoint 和 Replan 原因；
6. 生成完整新 Revision；
7. Coordinator 校验每个中间 Checkpoint 都由一个 pending Task 接管；
8. Coordinator 确定性合并 pending Task；
9. 写入 Revision Snapshot、`tasks.json` 和 `run.json`；
10. Run 返回 `running`。

Replan 不属于失败重试，不触发自动重试计数。每次 Execution 仍必须作为独立 `TaskExecutionEpisode` 永久保存。

不得通过 Replan 删除或伪造 completed Task。

---

## 14. Final Review 与完成

### 14.1 Final Review

全部 Task 完成后，Coordinator 启动新的 Final Review Session。

Final Review Session 必须：

- 完整读取 SPEC；
- 检查当前 Run Branch；
- 查看 completed Task 摘要；
- 检查 Claude 已报告的测试结果；
- 自主运行必要的最终测试；
- 可以直接修复问题；
- 可以返回 `completed`；
- 可以返回 `replan_required`；
- 使用 Execution 权限模式；
- 返回结构化 `FinalReviewResult`。

Final Review 是基于 Claude 能力的整体复核，不是独立 Oracle。

```json
{
  "decision": "completed",
  "summary": "整体复核结论",
  "reviewedTaskIds": [
    "TASK-001"
  ],
  "tests": [],
  "changedAreas": [],
  "remainingRisks": [],
  "replanReason": null
}
```

规则：

- `decision` 只能是 `completed` 或 `replan_required`；
- `summary` 必须非空；
- `reviewedTaskIds` 必须无重复；`completed` 时必须与当前计划全部 completed Task ID 完全一致；
- `tests` 使用与 TaskExecutionResult 相同的结构；
- `changedAreas` 必须是字符串数组，记录 Final Review 直接修改的区域；
- `remainingRisks` 必须是字符串数组；
- `replan_required` 必须提供非空 `replanReason`；
- `completed` 的 `replanReason` 必须为 `null`；
- `completed` 不得包含失败测试；
- Final Review 必须检查每个 completed Task 的全部 `acceptanceEvidence`，发现缺失或矛盾时只能返回 `replan_required`。

Final Review 只能直接修复不改变模块边界、数据模型或验收范围的局部问题。需要新增领域能力、跨模块重构或新的独立验收工作时必须返回 `replan_required`，不得把 Task 级工作隐藏在 Final Review Commit 中。

### 14.2 结果处理

1. 保存 Session Record；
2. 创建或确认 Final Review Checkpoint；
3. `replan_required` 时进入 `planning`；
4. `completed` 时从事实源生成 `report.md`；
5. 保存 Final Commit 和报告路径；
6. Run 进入 `completed`。

在 Run 尚处于 `final_review` 时，任一步失败都使 Run 进入 `failed`。首次报告生成失败使用 `FINAL_REPORT_GENERATION_FAILED`。

### 14.3 Run 成功条件

Run 进入 `completed` 必须满足：

1. 当前计划所有 Task completed；
2. 历史省略 Task 已记录为 skipped；
3. 不存在活动 Claude Session；
4. completed Task Checkpoint 均可从 Final Commit 到达；
5. 每个中间 Checkpoint 的 ownerTaskId 都指向 completed Task；
6. 每个 completed Task 的 acceptanceCriteria 都有 satisfied 证据；
7. Final Review 返回 completed 且 reviewedTaskIds 完整；
8. `report.md` 已写入并校验；
9. `run.json` 已记录 Final Commit 和报告路径。

### 14.4 Final Report

completed Run 的报告至少包含：

- SPEC 路径和 SHA-256；
- Run ID；
- Run Branch；
- Base Commit 和 Final Commit；
- Plan Revision 历史；
- completed 和 skipped Task；
- 每个 Task 的全部 Execution Episode、验收证据和最终 Checkpoint；
- 中间 Checkpoint 及其最终接管 Task；
- Claude 报告的测试结果；
- Final Review 总结；
- 剩余风险；
- 用户查看或合并 Run Branch 的方式。

报告不得声称系统完成了不存在证据的独立安全验证或进程恢复验证。

failed 或 abandoned Run 可以由 `ApexCodingAgent report` 生成非成功报告。该报告必须：

- 明确标记 Run 未完成；
- 给出最近错误码和 Claude/Git/State 经统一脱敏但保留原始语义的错误摘要；
- 列出已完成、失败和未执行 Task；
- 给出当前 Run Branch、最后一个已确认 Checkpoint 和当前 Git 状态；
- 不把当前 HEAD 声称为成功的 Final Commit；
- 不改变 Run 的终态。

对已经终态的 Run 执行 `report` 只重新生成报告文件。命令失败使用 `REPORT_COMMAND_FAILED`，不得把 `completed` 改为 `failed`，也不得修改任何终态字段。

---

## 15. 错误模型

### 15.1 原则

错误必须：

- 使用稳定 `errorCode`；
- 保存经统一脱敏但保留原始语义的工具错误摘要；
- 明确指出错误发生阶段；
- 立即停止当前流程；
- 不自动重试；
- 不自动恢复；
- 不根据自由文本改变重试策略。

### 15.2 错误类别

| errorClass | 行为 |
|---|---|
| `startup_validation` | 不创建新 Run，输出诊断 |
| `run_error` | 当前非终态 Run 进入 failed |
| `run_control` | 只由显式 abandon 产生，当前非终态 Run 进入 abandoned |
| `claude_error` | 当前 Task 或 Run 进入 failed |
| `plan_error` | Run 进入 failed |
| `git_error` | Run 进入 failed |
| `state_error` | Run 进入 failed，若状态无法写入则仅输出诊断 |
| `report_error` | 仅在 final_review 首次生成报告时使 Run 进入 failed |
| `command_error` | 当前 CLI 命令失败，不修改已有 Run 状态 |

### 15.3 稳定错误码

至少定义：

| errorCode | errorClass |
|---|---|
| `ENVIRONMENT_UNSUPPORTED` | `startup_validation` |
| `SPEC_NOT_FOUND`、`SPEC_AMBIGUOUS`、`SPEC_EMPTY`、`SPEC_NOT_REGULAR_FILE`、`SPEC_NOT_READABLE`、`SPEC_INVALID_UTF8`、`SPEC_OUTSIDE_REPOSITORY`、`SPEC_STAGED` | `startup_validation` |
| `WORKING_TREE_DIRTY`、`STATE_DIRECTORY_TRACKED`、`STATE_DIRECTORY_UNWRITABLE`、`GIT_UNAVAILABLE`、`GIT_WORKTREE_REQUIRED`、`GIT_HEAD_REQUIRED`、`BASE_BRANCH_REQUIRED` | `startup_validation` |
| `CLAUDE_CAPABILITY_MISSING`、`CLAUDE_INSTALLATION_UNHEALTHY`、`SETTINGS_INVALID` | `startup_validation` |
| `RUN_ALREADY_ACTIVE_OR_INTERRUPTED`、`STATE_INVALID`、`ARCHIVE_FAILED`、`ARCHIVE_CONFLICT` | `startup_validation` |
| `RUN_INTERRUPTED` | `run_error` |
| `RUN_ABANDONED_BY_USER` | `run_control` |
| `CLAUDE_START_FAILED`、`CLAUDE_EXIT_NONZERO`、`CLAUDE_STREAM_FAILED` | `claude_error` |
| `CLAUDE_RESULT_INVALID`、`CLAUDE_REPORTED_FAILURE` | `claude_error` |
| `PLAN_INVALID`、`PLAN_REVISION_CONFLICT`、`PLAN_REVISION_LIMIT_EXCEEDED` | `plan_error` |
| `FINAL_REVIEW_RESULT_INVALID` | `claude_error` |
| `GIT_COMMAND_FAILED`、`GIT_FACT_CONFLICT`、`GIT_HISTORY_DIVERGED`、`PLANNING_SIDE_EFFECT_DETECTED`、`PROTECTED_PATH_CHANGED` | `git_error` |
| `STATE_WRITE_FAILED`、`STATE_VALIDATION_FAILED` | `state_error` |
| `FINAL_REPORT_GENERATION_FAILED` | `report_error` |
| `CLI_USAGE_INVALID`、`RUN_NOT_FOUND`、`COMMAND_STATE_INVALID`、`REPORT_NOT_AVAILABLE`、`REPORT_COMMAND_FAILED`、`STATE_SNAPSHOT_BUSY` | `command_error` |
| `RUN_NOT_ABANDONABLE`、`ABANDON_REQUIRES_FORCE` | `command_error` |

Provider、鉴权、网络、代理、额度和权限错误不建立额外领域错误类别。只要 Claude 调用未成功，统一映射为 `CLAUDE_EXIT_NONZERO`，并保留 Claude 的可读诊断。

---

## 16. 内置默认策略

系统必须开箱即用，不要求用户创建配置文件。

| 项目 | 默认值 |
|---|---|
| 顶层 Task 并发 | 1 |
| 单 Run 最大 Plan Revision | 50 |
| Planning 结构修复次数 | 0 |
| Execution 自动重试 | 0 |
| Session Resume | 禁用 |
| Session 自动超时 | 不设置；用户可通过前台中断信号结束 |
| Execution 权限模式 | `auto` |
| Planning 权限模式 | `plan` |
| 前台中断等待 | 10 秒 |
| Provider 错误 | Run failed |
| Claude Skills/MCP/Plugins/Hooks | 继承用户配置 |
| Coordinator Git remote push | 永不调用 |

可选配置仅限：

- Execution permission mode；
- Claude CLI 路径；
- Git CLI 路径。

`settings.json`：

```json
{
  "schemaVersion": 1,
  "executionPermissionMode": "auto",
  "claudeCliPath": null,
  "gitCliPath": null
}
```

配置优先级：

```text
显式 CLI 参数
> .apex-coding-agent/settings.json
> 程序内置默认值
```

规则：

- 使用严格 Schema；
- 未知字段和错误类型明确失败；
- Planning 权限不可覆盖；
- `bypassPermissions` 只能显式启用；
- 启用时必须显示风险提示；
- `start` 把最终配置写入 `run.json.runSettings`；
- Run 期间不重新加载设置。

---

## 17. CLI

MVP 提供：

```text
ApexCodingAgent start [spec-path] [--full-access]
    [--claude-cli-path <path>] [--git-cli-path <path>]
ApexCodingAgent status
ApexCodingAgent report
ApexCodingAgent abandon --force
```

命令语义：

- `start`：创建并前台运行一个新 Run 直到终态，运行期间对每次状态迁移输出一行经脱敏的进度摘要；
- `status`：只读 `run.json`、`tasks.json` 和 Git，展示最近持久化状态；
- `report`：只为终态 Run 生成或重新生成报告，失败不修改终态；
- `abandon --force`：在用户确认旧进程已停止后，把无法继续的非终态 Run 显式转为 `abandoned`。

`status` 是只读命令，可以在 Run 期间从其他终端执行，但只保证展示最近成功写入的快照，不保证实时内存状态。

`status`、`report` 和 `abandon` 都从命令调用目录通过 Git 确定 `repositoryRoot`。

`abandon --force` 必须：

1. 要求存在严格 Schema 合法的非终态 `run.json`。
2. 要求显式 `--force`，否则返回 `ABANDON_REQUIRES_FORCE`。
3. 显示“系统无法判断旧进程是否仍然存在”的风险提示。
4. 不调用 Claude、不终止进程、不修改 Git、不生成 Checkpoint。
5. 如果存在未结束 `activeSession` 且对应 Session Record 尚未写入，写入一个 exitCode 为 null、错误码为 `RUN_ABANDONED_BY_USER` 的失败 Session Record；该记录只表示 Coordinator 放弃接力，不声称旧进程已经退出。已写入的 Session Record 保持不可修改，不得覆盖或补写。
6. 如果存在未结束 Execution Episode，将其结束为 `session_error`；已结束 Episode 不得改动。
7. 将原 running Task 转为 `failed` 并记录 `RUN_ABANDONED_BY_USER`。
8. 清除 `activeSession` 和 `currentTaskId`。
9. 将 Run 转为 `abandoned`，保存 `terminalAt`。
10. 保留其余 Task、Session、日志、工作区和分支事实。

终态 Run、缺失 Run 或无法通过 Schema 校验的 Run 不得被 `abandon` 猜测修复；分别返回 `RUN_NOT_ABANDONABLE`、`RUN_NOT_FOUND` 或 `COMMAND_STATE_INVALID`。

CLI 进程退出码：

| Exit Code | 语义 |
|---|---|
| 0 | 命令成功；`status` 查看 failed/abandoned Run 仍属于成功读取 |
| 1 | `start` 创建的 Run 正常持久化为 failed |
| 2 | 命令、参数或选项用法错误 |
| 3 | 启动前置校验失败，未创建新 Run |
| 4 | `status`、`report` 或 `abandon` 命令失败 |
| 130 | 第一次中断信号已被处理并结束当前 `start` |

中断导致 Run 持久化为 failed 时退出码为 130，优先于 1。

CLI 失败时必须同时输出稳定 `errorCode`。不得使用工具原始退出码直接替代上述 Apex Exit Code。

本版本不提供：

- `init`
- `resume`
- `pause`
- `stop`
- `cancel`
- `retry`
- `approve`
- `resolve`
- `cleanup`
- 后台运行模式

用户通过操作系统强制关闭前台进程不属于 CLI 控制语义。

---

## 18. 安全、隐私与风险边界

### 18.1 保留的安全要求

系统必须：

- 不主动读取或记录凭据值；
- 对所有外部字符串经过统一脱敏后再写入日志、JSON、报告或控制台；
- Coordinator 不调用 push；
- Coordinator 不自动 merge Base Branch；
- 不自动清理用户分支；
- 不自动执行 `git reset --hard`；
- 不把 `.apex-coding-agent` 提交进项目；
- `bypassPermissions` 显示风险提示。

### 18.2 不提供的保证

系统不得声称：

- Claude 不能读取宿主凭据；
- Claude 不能访问项目外文件；
- Claude 不能联网；
- Claude 子进程被安全沙箱隔离；
- Apex 可以终止 Claude 的全部子进程；
- Apex 退出后 Claude 一定退出；
- MCP、Plugin、Hook 或 Skill 是可信的；
- Claude 一定不会绕过提示执行 push、部署或其他外部副作用；
- Candidate Code 可以作为恶意代码安全执行；
- Claude 自测等价于独立第三方验证；
- 中断的 Run 可以恢复。

### 18.3 用户责任

用户负责：

- 选择可信的项目和 SPEC；
- 配置可信的 Provider；
- 管理 Claude Code、MCP、Skills、Plugins 和 Hooks；
- 决定是否启用 `bypassPermissions`；
- 保持 Apex 前台进程和终端运行；
- 不在同一仓库并发启动多个 Apex Run；
- 在异常中断后自行检查进程、工作区和分支；
- 审查 Run Branch 后再合并或推送；
- 对生产发布和外部副作用做最终判断。

### 18.4 统一脱敏边界

Claude stdout、stderr、结构化结果、Git 错误、Provider 元数据、测试命令、异常对象和用户可见诊断都属于不可信外部字符串。

所有外部字符串在进入以下任一 Sink 前必须经过同一个 `RedactionPort`：

- `logs/`；
- Session Record；
- `run.json` 和 `tasks.json`；
- Plan Revision Snapshot；
- `report.md`；
- Archive Manifest 中的可读诊断；
- 控制台 stdout 和 stderr。

Redaction 必须：

- 覆盖 Authorization、Proxy-Authorization、Cookie 和 Set-Cookie Header 值；
- 覆盖常见 API Key、Token、Bearer、Basic、私钥块和带凭据 URL；
- 对字段名匹配 `token`、`secret`、`password`、`apiKey`、`authorization` 的值执行不区分大小写脱敏；
- 在文本分块边界保留足够重叠窗口，避免流式 Token 跨块绕过；
- 使用固定占位符，不把原值哈希、编码或部分回显；
- 保持结构化 JSON 的类型和 Schema 合法性。

脱敏是降低意外持久化风险的检测机制，不构成绝对凭据发现保证。Provider 名称等元数据必须使用允许列表提取，不得先保存完整环境或配置后再脱敏。

---

## 19. 功能需求

| ID | 要求 |
|---|---|
| FR-001 | 只依赖一份 SPEC 和最小运行环境一键创建 Run |
| FR-002 | Planning Session 自动生成结构化 Task Plan |
| FR-003 | 校验并保存 tasks.json 和不可变 Plan Revision |
| FR-004 | 创建并切换独立 Run Branch |
| FR-005 | 按依赖顺序串行执行顶层 Task |
| FR-006 | 默认继承 Claude Code 用户配置和原生能力 |
| FR-007 | 兼容 CC Switch 当前 Provider，不接管凭据 |
| FR-008 | 支持 `auto` 和显式 `bypassPermissions` |
| FR-009 | 支持结构化 TaskExecutionResult |
| FR-010 | Claude 调用错误直接使当前 Run failed |
| FR-011 | Replan 只调整 pending Task |
| FR-012 | 在 Task 边界创建或确认 Git Checkpoint |
| FR-013 | 使用 TypeScript 和 Node.js 标准 API 实现主程序 |
| FR-014 | 使用带一致性校验的简单 JSON 快照保存可观察进度 |
| FR-015 | 全部 Task 完成后执行 Final Review |
| FR-016 | 完成后生成 report.md |
| FR-017 | 新 Run 前自包含归档最近终态 Run |
| FR-018 | 不提供进程、Session 或 Coordinator 恢复 |
| FR-019 | 不依赖 Mutex、Named Pipe、Job Object 或原生扩展 |
| FR-020 | 不要求用户准备配置、审批、Oracle 或外置 Schema |
| FR-021 | 保存同一 Task 的全部不可覆盖 Execution Episode |
| FR-022 | 支持显式 `abandon --force` 终结失去 Coordinator 的 Run |
| FR-023 | `status`、`report` 使用跨文件一致性读取协议 |
| FR-024 | 确定性保护 Base Branch、SPEC 和状态目录 Git 不变量 |
| FR-025 | Task completed 必须逐项提供验收证据 |
| FR-026 | Replan 中间 Checkpoint 必须由 pending Task 显式接管 |
| FR-027 | 所有持久化和控制台 Sink 经过统一脱敏边界 |
| FR-028 | 已终态 Run 的 report 重生成失败不得改变终态 |

---

## 20. 非功能需求

### NFR-001 易用性

在 Claude Code 和 Git 可用、工作区干净且存在 SPEC 的情况下，首次运行只需要：

```powershell
ApexCodingAgent start
```

### NFR-002 可维护性

- Domain 不依赖 Node.js、Git 或 Claude CLI；
- Planner、Orchestrator、Runtime、Git、State 和 Reporter 职责分离；
- Task Plan 和运行状态不混写；
- 状态转换集中定义；
- 禁止隐式全局状态和跨层写入；
- 禁止为未承诺的恢复能力引入基础设施。

### NFR-003 AI 可理解性

Task ID、Plan Revision、Run 状态、Task 状态、Session 类型和错误码必须显式、稳定、可搜索。

模块和用例命名必须表达业务语义，不得以 `utils`、`helpers`、`manager` 承载跨领域职责。

### NFR-004 低耦合鉴权

CC Switch 或 Provider 实现变化不应要求修改领域层。Claude Runtime 只依赖 Claude CLI 契约。

### NFR-005 可测试性

Claude、Git、Clock、FileSystem、State、Reporter 和 Redaction 必须通过 Port 替换。状态机、计划校验、Task 调度、快照一致性和错误映射必须独立测试。

### NFR-006 数据安全

自动化测试必须使用固定凭据语料和跨流分块组合，证明日志、状态、Session、计划、报告、归档和控制台输出均不写入或显示已知凭据字段与 Token 模式。测试语料必须集中版本化，新增 Redaction 规则时同步补充回归样例。

### NFR-007 性能

对 50 个 Task：

- 本地 Task 选择 P95 小于 100 ms；
- 本地状态读取 P95 小于 500 ms；
- `status` P95 小于 2 秒；
- 不含 Claude 和 Git 调用的启动检查 P95 小于 2 秒。

性能验收协议：

- 在 Windows 10 和 Windows 11 x64 发布 Runner 上分别执行；
- Runner 至少具有 4 个逻辑 CPU、8 GB 内存和 SSD；
- Node.js 22.x 与 24.x 分别生成结果；
- 使用固定 Fixture：50 个 pending Task、200 个历史 Execution Episode、10 个 Plan Revision；
- 每项先预热 20 次，再连续测量 200 次；
- P95 使用 nearest-rank 方法计算，报告原始样本、Node.js 版本、Windows Build 和硬件摘要；
- Claude 调用不得进入本地性能样本；只有明确标为“不含 Git”的指标才能替换为 Fake Git Port；
- 任一要求的平台和 Node.js 组合不达标即视为 NFR-007 未通过。

### NFR-008 运行时纯度

发布物不得要求安装：

- .NET Runtime；
- C# 工具链；
- Rust 工具链；
- C++ Build Tools；
- Win32 原生扩展依赖。

---

## 21. 验收场景

| ID | 场景 |
|---|---|
| AC-001 | 只有 SPEC.md 的干净 Windows Git 项目可以通过 start 进入 planning |
| AC-002 | 未跟踪或仅有工作区修改的 SPEC 不阻止启动，staged SPEC 被明确拒绝 |
| AC-003 | Planning 生成合法 tasks.json 和 Revision Snapshot |
| AC-004 | 重复 ID、缺失依赖和环被确定性拒绝 |
| AC-005 | CC Switch 当前 Provider 被 Claude 子进程直接使用 |
| AC-006 | Execution 可以使用 Skills、MCP、Subagents、Plugins 和 Hooks |
| AC-007 | 默认使用 auto，显式 full-access 才使用 bypassPermissions |
| AC-008 | Claude 启动失败时 Run 直接 failed |
| AC-009 | Claude 非零退出时 Run 直接 failed 并显示错误 |
| AC-010 | Claude 结构化结果非法时 Run 直接 failed |
| AC-011 | 系统不自动重启、恢复或接管 Claude Session |
| AC-012 | Task completed 后形成可追踪 Git Checkpoint |
| AC-013 | Claude 已创建 Commit 时保留其 Commit，只补充剩余变更 |
| AC-014 | SPEC 变化触发新 Plan Revision，completed Task 不被改写 |
| AC-015 | replan_required 只调整 pending Task |
| AC-016 | Coordinator 不 merge、reset 或 push，且 Base Branch 引用在 Session 前后保持不变 |
| AC-017 | 全部 Task 完成后运行 Final Review 并生成 report.md |
| AC-018 | Final Review 报告失败测试时不得完成 Run |
| AC-019 | 日志、状态、Session、计划、报告、归档和控制台不包含检测到的凭据值 |
| AC-020 | 新 Revision 省略 pending Task 时记录 skipped，拒绝 ID 复用 |
| AC-021 | status 只展示通过 stateRevision、planRevision 和 tasksSha256 一致性校验的快照 |
| AC-022 | 非终态旧 Run 存在时新 start 明确拒绝，用户可显式 abandon |
| AC-023 | 终态 Run 在新 start 前连同 Sessions 和 Logs 自包含归档，Run Branch 保持不变 |
| AC-024 | 发布物在 Node.js 22.x 和 24.x LTS 上通过，不要求 .NET 或原生扩展，其他主版本明确拒绝 |
| AC-025 | 代码库不存在 Mutex、Named Pipe 控制、Job Object、PID 恢复和 Journal 实现 |
| AC-026 | 同一 Task 多次 running -> pending -> running 时保留全部 Episode |
| AC-027 | 第一次终端中断有界结束，无法正常结束的 Run 可通过 `abandon --force` 转为 abandoned |
| AC-028 | `abandon` 不连接旧 Session、不终止进程、不修改 Git |
| AC-029 | status 连续遇到跨文件不一致时返回 `STATE_SNAPSHOT_BUSY` 且不修改 Run |
| AC-030 | Claude Commit 包含 SPEC 或 `.apex-coding-agent/` 时确定失败 |
| AC-031 | Planning 产生代码、index 或未跟踪文件副作用时确定失败 |
| AC-032 | 缺失、重复或 not_satisfied 的 acceptanceEvidence 阻止 Task completed |
| AC-033 | 中间 Checkpoint 无 disposition 或重复归属时拒绝 Plan Revision |
| AC-034 | completed Run 的 report 重生成失败保持 completed |

---

## 22. 强制测试

### 22.1 单元测试

必须覆盖：

- 全部 Run 状态转换；
- 全部 Task 状态转换；
- abandoned 转换和废弃时 running Task 处理；
- 非法转换；
- Ready Task 选择；
- TaskPlanDraft Schema；
- 重复 ID、缺失依赖、环和不可达 Task；
- completed Task 保护；
- ID 永久唯一；
- pending 修改和 skipped 合并；
- Plan Revision 50 上限；
- Execution Episode 追加、结束字段补齐和不可覆盖；
- 中间 Checkpoint disposition 的完整性、唯一性和 owner 校验；
- acceptanceEvidence 的索引覆盖、重复、缺失和 completed 门禁；
- 路径规范化；
- SPEC 发现和目录排除；
- Windows 大小写、符号链接、Junction 和 Git ignored 发现边界；
- JSON 临时文件替换的正常成功与普通 I/O 失败；
- `stateRevision` 双读、`tasksSha256` 不匹配和有限重试；
- Claude 退出码和结构化结果错误映射；
- Final Review 对 completed 加 failed test 的拒绝；
- Final Review 对 reviewedTaskIds 缺失、重复和不完整的拒绝；
- 终态 report 命令错误不改变 Run；
- 凭据在全部 Sink 和跨流分块中的脱敏。

### 22.2 集成测试

必须覆盖：

- Fake Claude Planning 成功、Schema 错误和非零退出；
- Fake Claude Execution completed、failed、replan_required 和非零退出；
- Fake Claude Final Review completed、replan_required 和非法结果；
- CC Switch 风格 environment 继承；
- Claude 参数以参数数组传递；
- 临时 Git 仓库的 Run Branch、Claude Commit 和不受仓库 hooks 与签名配置影响的 Coordinator Checkpoint；
- 普通仓库和 linked worktree 中通过 `git rev-parse --git-path` 更新 exclude；
- Run Branch 被切换、Base Branch 引用变化或历史被改写时确定失败；
- Claude Commit 包含 SPEC 或 `.apex-coding-agent/` 时确定失败；
- Planning Session 产生工作区、index、HEAD 或未跟踪文件副作用时确定失败；
- SPEC 修改后的 Replan；
- 未跟踪、工作区修改和 staged SPEC；
- Replan 中间 Checkpoint 的保存与接管；
- 同一 Task 的多 Episode 保留；
- auto 与 bypassPermissions；
- 第一次中断信号的有界退出；
- `abandon --force` 的状态转换、风险门禁、零 Git/进程调用和已提交 Session Record 的幂等；
- CLI Exit Code 与稳定 errorCode 的映射；
- 跨文件快照并发读取和 `STATE_SNAPSHOT_BUSY`；
- 包含 Sessions 与 Logs 的幂等自包含终态归档；
- Final Report；
- completed Run 报告重生成失败时终态不变。

### 22.3 明确不要求的测试

本版本不得把以下内容列为 DoD：

- Coordinator 崩溃注入；
- Claude 进程崩溃恢复；
- PID 复用；
- 进程树终止；
- Job Object；
- Mutex 单写者；
- Named Pipe 控制；
- Pause、Resume、Stop；
- 断电恢复；
- Journal 重放；
- current/previous 回退；
- Windows 原生 API 集成。

真实验收必须在 Windows 10 和 Windows 11 上完成。

### 22.4 需求追踪矩阵

每个 FR 必须由下表中的 AC 和自动化证据共同覆盖：

| FR | AC | 主要自动化证据 |
|---|---|---|
| FR-001、FR-020 | AC-001、AC-002 | 启动检查、SPEC 发现和零配置集成测试 |
| FR-002、FR-003 | AC-003、AC-004 | Planning Fixture、Schema 和 Revision 合并测试 |
| FR-004、FR-012、FR-024 | AC-012、AC-013、AC-016、AC-030、AC-031 | 临时 Git 仓库与保护不变量集成测试 |
| FR-005 | AC-004、AC-012 | Ready Task 选择和串行调度测试 |
| FR-006、FR-007、FR-008 | AC-005、AC-006、AC-007 | Claude 参数数组、环境继承和权限模式测试 |
| FR-009、FR-010 | AC-008、AC-009、AC-010 | Fake Claude Execution 结果与错误映射测试 |
| FR-011、FR-021、FR-026 | AC-014、AC-015、AC-020、AC-026、AC-033 | Replan、Episode 和中间 Checkpoint 测试 |
| FR-013、FR-019 | AC-024、AC-025 | 发布物依赖扫描和运行时矩阵测试 |
| FR-014、FR-023 | AC-021、AC-029 | JSON 替换、双读和并发快照测试 |
| FR-015、FR-016、FR-025、FR-028 | AC-017、AC-018、AC-032、AC-034 | Final Review、验收证据和报告命令测试 |
| FR-017 | AC-023 | 自包含幂等归档测试 |
| FR-018、FR-022 | AC-011、AC-022、AC-027、AC-028 | 中断和 abandon 测试 |
| FR-027 | AC-019 | 全 Sink 凭据语料测试 |

NFR 追踪：

| NFR | 验收证据 |
|---|---|
| NFR-001 | AC-001、CLI 端到端测试 |
| NFR-002、NFR-003 | 架构依赖测试、命名规则扫描、Domain 单元测试 |
| NFR-004 | AC-005、Fake Claude Runtime Adapter 测试 |
| NFR-005 | Port 替换测试、状态机和错误映射单元测试 |
| NFR-006 | AC-019、固定凭据语料回归测试 |
| NFR-007 | NFR-007 定义的性能验收协议 |
| NFR-008 | AC-024、AC-025、发布物依赖扫描 |

---

## 23. Definition of Done

系统达到 MVP Ready 必须满足：

- 全部 FR 对应验收场景通过；
- 全部 NFR 有自动化证据；
- 用户项目只需 SPEC 和最小外部环境；
- 一条 start 命令生成计划并开始执行；
- 主程序使用 TypeScript；
- Claude Code 和 Git 通过低耦合 Adapter 调用；
- Claude 调用错误直接、清晰地结束 Run；
- 状态机中不存在 waiting、pausing、paused 或 canceled；
- CLI 中不存在 resume、pause 或 stop，存在显式且不可逆的 abandon；
- Plan Revision 不破坏 completed Task；
- Replan 不遗留无人负责的中间 Checkpoint；
- 每次 Task Execution 都保留不可覆盖 Episode；
- Run Branch 和 Checkpoint 可追溯；
- Base Branch 引用和受保护路径经过确定性校验；
- status 和 report 不展示跨 Revision 撕裂快照；
- Final Review 和报告闭环通过；
- completed 结果逐项覆盖 Task acceptanceCriteria；
- 已终态 Run 不因报告重生成失败而改变终态；
- 状态、日志、Session、计划、报告、归档和控制台不包含检测到的凭据；
- Node.js 22.x 和 24.x LTS 发布矩阵通过；
- 不存在 C#、.NET、Rust、C++ 或 N-API 运行时依赖；
- 不存在 Mutex、Named Pipe 控制、Job Object、PID、Invocation、Journal、崩溃恢复或 Session Resume 实现；
- 内置 Planning、Execution 和 Final Review Prompt 与对应 Schema 一致；
- CLI 帮助、默认值和本文一致。

---

## 24. 内置 Planning Prompt

以下提示词是 Planning 模块的规范性基线。实现可以模板化，但不得删除核心职责和拆分原则。

```text
你是 ApexCodingAgent 的规划器。ApexCodingAgent 是一个围绕完整软件需求持续执行的 Coding Agent。

你当前只负责理解需求并生成可执行任务计划，不得修改、暂存或提交任何项目文件，不得执行实现，不得创建 Git Commit，不得修改 .apex-coding-agent。

项目根目录是当前工作目录，也是系统提供的 REPOSITORY_ROOT。
主要需求来源由系统提供为 SPEC_PATH。完整读取该文件，但不要修改它。

请完成以下工作：

1. 完整读取 SPEC_PATH，不得只读取局部或根据标题猜测。
2. 检查当前仓库的目录结构、技术栈、模块边界、构建入口和测试入口。
3. 判断项目是全新系统还是已有系统。
4. 理解需求涉及的数据流、状态流、核心实体和模块依赖。
5. 将需求拆分为一组可以按顺序执行、独立判断是否完成的编码任务。
6. Replan 时检查系统提供的 RETAINED_INTERMEDIATE_CHECKPOINTS，为每个尚未被 completed Task 吸收的 Checkpoint 指定一个负责继续采用、验证或移除其变更的 pending Task。
7. 在返回最终结果前，自行检查任务是否遗漏规格中的关键要求。

任务拆分原则：

- 每个任务只承担一个清晰的主要目标。
- 优先按领域能力、模块边界或可验证的纵向功能拆分。
- 不要按文件数量机械拆分。
- 每个任务完成后，仓库应处于可理解、可继续开发的状态。
- 任务粒度应适合一个顶层 Claude Code Session 完成。
- 不要制造大量微型任务。
- 测试通常包含在对应实现任务中。
- 架构基础必须先于依赖它的业务实现。
- 依赖关系必须明确且无环。
- 无法判断的信息记录为 assumption，不要发明业务需求。
- 调查任务必须产生具体结论或设计决策。
- Replan 时返回完整新计划，不要返回局部补丁。
- Replan 时原样保留所有 completed Task 的 ID 和完整定义。
- Replan 时可以修改 pending Task。
- 省略旧 pending Task 表示将其标记为 skipped。
- 新增 Task 使用从未出现过的 ID。
- 当前计划中的 pending Task 不得超过 50 个。
- 整个 Run 的 Task ID 数字部分不得超过 999。
- 每个保留的中间 Checkpoint 必须由且只能由一个 pending Task 接管。
- 全新系统不得添加 legacy、兼容、迁移、fallback 或 deprecated 任务。
- 最后包含必要的整体集成与最终验证。
- 所有 Task ID 使用 TASK-001、TASK-002 这样的稳定格式。
- dependsOn 只能引用本计划内存在的 Task ID。
- acceptanceCriteria 必须是可观察、可判断的完成结果。
- verificationHints 不得虚构仓库中不存在的命令。
- likelyPaths 只是提示，不是强制文件范围。

请返回结构化任务计划，包含：

- summary
- assumptions
- retainedCheckpointDispositions
- tasks

每个任务包含：

- id
- title
- objective
- dependsOn
- acceptanceCriteria
- verificationHints
- likelyPaths
- estimatedSize
- context

不要返回 Markdown。
不要在结构化结果之外输出解释。
```

---

## 25. 内置 Execution Prompt

以下提示词是 Execution 模块的规范性基线。实现可以模板化，但不得删除核心职责、安全边界、验收证据和 Replan 语义。

```text
你是 ApexCodingAgent 当前 Task 的执行 Agent。你只负责系统提供的 CURRENT_TASK，但可以读取完整仓库来理解架构和依赖。

项目根目录是 REPOSITORY_ROOT，当前分支必须是 RUN_BRANCH。权威需求文件是 SPEC_PATH，其启动哈希是 SPEC_SHA256。完整读取 SPEC，但不得修改、暂存或提交 SPEC。

系统还会提供：
- CURRENT_PLAN_REVISION
- CURRENT_TASK 的完整定义和 acceptanceCriteria
- completed Task 的摘要与 Checkpoint
- 当前 Task 接管的中间 Checkpoint
- 结构化结果 Schema

执行要求：
1. 先理解现有架构、数据流、状态流和模块边界，再实现 CURRENT_TASK。
2. 如果架构无法正确承载需求，优先在当前 Task 边界内完成必要重构，不叠加临时 patch。
3. 保持高内聚、低耦合、单一职责、分层设计和显式状态。
4. 不添加 legacy、兼容、迁移、fallback 或 deprecated 逻辑。
5. 不修改、暂存、提交或删除 .apex-coding-agent。
6. 不执行 remote push、生产部署、付款、生产数据变更或破坏其他分支。
7. 可以使用 Claude Code 原生 Skills、MCP、Subagents、Plugins 和 Hooks。
8. 运行与当前 Task 验收条件相称的测试或验证。
9. 对每一项 acceptanceCriteria 按原索引返回一条 acceptanceEvidence，说明 satisfied 或 not_satisfied 及可观察证据。
10. 只有全部 acceptanceCriteria 均 satisfied 且不存在 failed test 时才能返回 completed。
11. 如果仓库事实、架构前置条件或需求变化使当前计划不再正确，返回 replan_required 和非空原因，不要伪造完成。
12. 无法完成且不需要重新规划时返回 failed，并保留准确诊断。

返回 TaskExecutionResult 结构化结果。不要返回 Markdown，不要在结构化结果之外输出解释。
```

---

## 26. 内置 Final Review Prompt

以下提示词是 Final Review 模块的规范性基线。

```text
你是 ApexCodingAgent 的最终整体 Reviewer。你需要基于权威 SPEC 和当前 Run Branch 判断整个交付是否完整、一致并可验证。

系统会提供：
- REPOSITORY_ROOT、RUN_BRANCH、SPEC_PATH 和 SPEC_SHA256
- 当前完整 Plan Revision
- 全部 completed Task 的定义、acceptanceEvidence、Session 摘要和最终 Checkpoint
- skipped Task 及原因
- 中间 Checkpoint 的最终归属
- 已报告测试结果
- FinalReviewResult Schema

Review 要求：
1. 完整读取 SPEC，不得只依赖 Task 摘要。
2. 检查当前架构、数据流、状态流、模块边界和实现是否一致。
3. 检查每个 completed Task 的全部 acceptanceEvidence 是否存在、可信且与仓库事实相符。
4. 自主运行必要的最终测试和集成验证。
5. 只能直接修复不改变模块边界、数据模型或验收范围的局部问题；需要 Task 级工作时返回 replan_required。
6. 不得修改、暂存或提交 SPEC。
7. 不得修改、暂存、提交或删除 .apex-coding-agent。
8. 不执行 remote push、生产部署、付款、生产数据变更或破坏其他分支。
9. 只有全部 completed Task 均已复核、没有 failed test、没有未处理规格缺口时才能返回 completed。
10. 发现仍需独立编码任务、架构调整或需求变化时返回 replan_required，并给出非空原因。
11. reviewedTaskIds 必须无重复；completed 时必须精确列出当前计划的全部 completed Task ID。

返回 FinalReviewResult 结构化结果。不要返回 Markdown，不要在结构化结果之外输出解释。
```

---

## 27. 最终结论

系统的最小闭环是：

```text
SPEC.md
  -> Claude Planning Session
  -> Plan Revision Snapshot
  -> tasks.json
  -> Claude Execution Session
  -> Git Checkpoint
  -> run.json
  -> 必要时 Replan
  -> 中间 Checkpoint 显式接管
  -> 下一个 Task
  -> Claude Final Review
  -> Final Review Checkpoint
  -> report.md
```

运行模型是：

```text
一个前台 TypeScript/Node.js 进程
  -> 顺序启动 Claude Code
  -> 成功则推进状态
  -> 报错则保存诊断并结束 Run
```

用户只负责提供规格、准备可用的 Claude Code/CC Switch 环境、保持前台进程运行、在异常中断后确认旧进程并显式 abandon，以及在完成后审查 Run Branch。

`ApexCodingAgent` 不建设进程管理平台，不处理 PID，不提供崩溃恢复，也不引入 Windows 原生控制基础设施。它通过显式废弃而不是隐式恢复处理中断 Run，并以最小、清晰、可测试的 TypeScript 架构完成规划、任务接力、Git Checkpoint、Final Review 和交付报告。
