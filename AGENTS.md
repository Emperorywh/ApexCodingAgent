# AGENTS.md

本文件面向 AI 编码代理，描述本仓库的架构、命令与约定。阅读本文件前不需要任何项目背景知识。

## 项目概览

- **ApexCodingAgent**（npm 包 `apex-coding-agent`，CLI 命令 `ApexCodingAgent`）：运行在 Windows 终端中的 Claude Code 长任务编排器。用户准备一份 `SPEC.md` 需求文档后，本工具驱动 Claude Code 先制定计划，再逐项执行任务，每一步保存 Git 检查点，最后做整体检查并生成报告。
- 产品形态：全局安装的 CLI，`bin` 指向 `dist/interfaces/cli/main.js`，发布内容仅 `dist/`（package.json `files: ["dist"]`）。
- 权威规格：源码注释以 `SPEC §x.y` 引用外部权威规格文档（该文档不随仓库分发）。当前实现对应 SPEC v4.1.1（见 package.json description），Session Resume 自 SPEC v4.2 起为受支持特性（见 `scripts/scan-forbidden.mjs` 头部注释）。
- 平台约束：**仅支持 Windows**（package.json `os: ["win32"]`），Node.js 22.x 或 24.x（`engines: ">=22 <23 || >=24 <25"`）。
- 文档与注释主要使用**中文**（domain 层部分文件使用英文注释）；仓库制品（代码注释、文档）沿用这一习惯。

## 技术栈

- TypeScript（`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`），target/module 为 ES2022 / NodeNext。
- 纯 ESM（`"type": "module"`）：**相对导入必须带 `.js` 扩展名**（如 `import ... from '../domain/errors.js'`）。
- 运行时依赖：`ajv`（JSON Schema 校验）与 `execa`（无 Shell 子进程执行，封装在 `src/adapters/process/` 内，不向 Application 层暴露其类型）。devDependencies：`typescript`、`vitest`、`@types/node`。
- 无原生扩展、无 postinstall（由 `scan-forbidden` 强制；当前生产依赖闭包 23 个包）。

## 构建与测试命令

| 命令 | 作用 |
| --- | --- |
| `npm run build` | `tsc -p tsconfig.json`，编译 `src/` 到 `dist/`（含 `.d.ts`） |
| `npm run typecheck` | `tsc -p tsconfig.test.json`，类型检查 `src/` + `tests/`（noEmit） |
| `npx vitest run` | 运行全部测试（`tests/**/*.test.ts`） |
| `npm test` | 完整门禁：build → typecheck → vitest → 架构守护 → 禁用项扫描。提交前必须通过 |
| `node scripts/check-architecture.mjs` | 分层架构守护（见下文） |
| `node scripts/scan-forbidden.mjs` | 禁用实现/依赖扫描（见下文） |
| `node scripts/perf-nfr007.mjs [--quick]` | NFR-007 性能验收 harness（P95 阈值），不在 `npm test` 内，按需手动运行 |

发布流程：`npm publish` 触发 `prepublishOnly: npm test`；`files: ["dist"]`。

## 目录结构与分层架构

依赖方向：`interfaces → bootstrap → adapters → application → domain`，内层绝不依赖外层。组合根（Composition Root）集中接线。

- `src/domain/` — 纯领域层。Run 六态状态机（`planning / running / final_review / completed / failed / abandoned`，见 `run-state.ts`）、Task 五态状态机（`pending / running / completed / failed / skipped`，每次迁移携带合法原因集合，`failed → pending` 仅 resume 可触发，见 `task-state.ts`）、15 个内置 JSON Schema（`schemas/`，统一 `schemaVersion: 1`，经 ajv 校验；`index.ts` 为校验入口，`formats.ts` 为共享格式）、跨字段不变式（`invariants.ts`、`plan.ts`、`plan-documents.ts`、`results.ts`、`episodes.ts`）、稳定错误模型（`errors.ts`：`ApexError` + `errorCode → errorClass` 确定映射，镜像 SPEC §15.3 注册表）。
- `src/application/` — 用例层。`ports/` 定义全部端口接口（`ClaudeRuntimePort`、`GitPort`、`StateStorePort`、`FileSystemPort`、`RedactionPort`、`ClockPort`、`LoggerPort`、`ReporterPort`、`OutputPort`、`RunArchivePort`）；`usecases/` 为业务用例（`start-run`、`resume-run`、`execute-next-task`、`generate-plan-revision`、`apply-plan-revision`、`run-final-review`、`generate-report`、`abandon-run`、`run-heartbeat`、`run-runtime-preflight`、`run-transitions`、`settings`、`claude-session`、`resumable-session`、`orphaned-session-reconciler`、`plan-revision-history`、`plan-revision-trigger`、`resume-state`、`error-record` 等）；`run-driver.ts` 是前台串行调度循环：planning → 逐 Task 执行 → final_review → 终态；`prompts/` 为发给 Claude 的提示词模板（planning / execution / final-review / verification-policy）；`presentation/progress.ts` 输出单行进度摘要；`interrupt.ts` 为中断控制器；`run-command-deps.ts` / `usecase-deps.ts` 为依赖装配类型。
- `src/adapters/` — 端口实现。`process/`（适配器内部统一的 `ProcessExecutor` 契约：execa 实现，**参数数组、无 Shell**，stdin 经管道写入；`windows-command.ts` 把 PATH 中的 .cmd/.bat shim 解析为真实 .exe 或 Node 脚本，无法证明可直接执行时拒绝隐式降级）、`claude/`（经 ProcessExecutor 启动 Claude CLI；解析 stream-json；`--resume --fork-session` 续接会话；`capability.ts` 能力探测；`session-log.ts` 完整流日志）、`git/`（检查点、仓库状态、SPEC 发现、`exclude.ts` 经 `git rev-parse --git-path info/exclude` 幂等排除状态目录）、`state/`（JSON 状态存储，临时文件替换原子写；`run-archiver.ts` 运行归档）、`reporter/`（Markdown 报告）、`redaction/`（秘密脱敏）、`logging/`（debug 文件日志）、`filesystem/`、`clock/`。
- `src/bootstrap/` — `composition-root.ts` 创建全部适配器并注入用例（不含业务规则）；`environment.ts` 收集环境事实；`signals.ts` 处理中断信号（第一次 Ctrl+C 安全收尾，第二次立即退出）。
- `src/interfaces/cli/` — `main.ts` 入口（只做进程级接线）、`args.ts`（`node:util` parseArgs 严格解析）、`run.ts`（命令分发与退出码映射）、`runtime.ts`（CLI 运行时门面类型）、`status-render.ts`、`console-output.ts`（语义颜色，重定向时自动纯文本，支持 `NO_COLOR`）、`help.ts`。
- `tests/` — 见下文「测试策略」。
- `scripts/` — 三个 `.mjs` 守护/验收脚本（见命令表）。
- `spikes/` — 开发期 spike 留下的运行证据存档（如 `s6-evidence/`），不参与构建、测试与发布。

## CLI 命令与退出码

命令（详见 `README.md` 与 `src/interfaces/cli/help.ts`）：`start [--verbose] [--full-access] [--claude-cli-path <路径>] [--git-cli-path <路径>] [spec 路径]`、`resume [--force] [--full-access] [--verbose] [--claude-cli-path <路径>] [--git-cli-path <路径>]`、`status`、`report`、`abandon --force`，以及 `--help` / `-h` / `help`。

退出码（`src/interfaces/cli/run.ts`）：`0` 成功；`1` start/resume 的 Run 正常持久化为 `failed`；`2` 用法错误（`CLI_USAGE_INVALID`）；`3` 启动前置校验失败（未创建或修改 Run）；`4` status/report/abandon/resume 命令级失败（如 `abandon` 缺 `--force` 的 `ABANDON_REQUIRES_FORCE`）；`130` 第一次中断已处理并结束（优先于 `1`）。CLI 失败只输出稳定的、已脱敏的 `errorCode`，绝不透传工具原始退出码。

## 运行时产物（被编排的目标仓库内）

`.apex-coding-agent/` 位于目标 Git 仓库根：

- `run.json`（Run 状态，`stateRevision` 严格递增）、`tasks.json`（任务计划）；
- `plans/<planRevision>.json`（每次 Plan Revision 的不可变快照；提交顺序固定为 Snapshot → tasks.json → SHA-256 复核 → run.json，run.json 替换是提交点）；
- `sessions/<session-id>.json`（会话记录）；
- `logs/apex-debug.log`（结构化调试日志）、`logs/<session-id>.log`（完整 Claude 流）；
- `report.md`（最终报告）；
- `settings.json`（可选用户配置，存在则经 Schema 校验，失败抛 `SETTINGS_INVALID`）；
- `heartbeat.json`（前台运行每 5 秒写入存活信号，超过 30 秒未更新判定旧进程崩溃，`resume` 可自动接管，否则需 `resume --force`）；
- `history/<run-id>/`（Run 终态后的自包含归档：tasks.json、run.json、plans/、sessions/、logs/、report.md 加 `archive-manifest.json` 哈希清单；归档后清理根级状态但保留 `settings.json`）。

每次运行在**单独的 Git 分支**中进行并自动创建本地提交，不改动用户原分支；认证/网络/额度/执行失败**不自动重试**。状态目录经 `git info/exclude` 排除，不触碰用户的 `.gitignore`。

## 代码风格约定

- 不可变数据：接口字段一律 `readonly`；领域层为纯函数 + 显式校验（校验失败抛 `ApexError` 并携带稳定 `errorCode`，不使用临时字符串）。
- 依赖注入统一使用 `createXxx(deps)` 工厂闭包；端口接口命名 `XxxPort`。
- 中文注释为主；公开契约在注释中标注 SPEC 章节号（如 `SPEC §11.2`）。
- 子进程一律经 `src/adapters/process/` 的 `ProcessExecutor`（execa，无 Shell、参数数组）；不读取或缓存凭据；不调用 Claude 私有 API；不自动重启失败进程。
- 新增脱敏规则时，必须同步在 `tests/fixtures/redaction-corpus/corpus.json` 添加回归样本（NFR-006，缺样本会导致语料测试失败）。
- 新增 errorCode 必须先加入 `src/domain/errors.ts` 的 `ERROR_CODE_TO_CLASS` 注册表再使用。

## 架构与约束守护（修改代码时必须通过）

`npm test` 包含两道强制门禁，违反即失败：

1. **`check-architecture`**（SPEC §5.3）：用 TypeScript AST 收集模块引用，`src/domain` 与 `src/application` 禁止 `import node:*`，也禁止以任何路径引用 `adapters` / `interfaces` / `bootstrap` 层。内层需要的能力一律通过 `ports/` 接口注入。
2. **`scan-forbidden`**（AC-025 / NFR-008）：`src/` 源码（经 TypeScript 打印机剥离注释后）禁止出现 Mutex、Named Pipe、Job Object、Journal、PID 追踪、Pause/Stop/Cancel/waiting_for 类状态协议，以及原生扩展加载（`dlopen`、`napi`、`node-gyp`、`.node`）；生产依赖闭包（按 `package-lock.json` 精确路径遍历）禁止原生模块和 C#/.NET/Rust/C++ 运行时包名；`package.json` 禁止 `postinstall`。Session Resume 自 SPEC v4.2 起是受支持特性，不属于禁用痕迹。**注意**：源码扫描基于正则，在 `src/` 中即使语义无关的命名（如变量名含 `pid`、`stopped`）也会误伤，请主动规避这些词；`tests/` 与 `scripts/` 不在源码扫描范围。脚本支持 `--root <目录>` 用于隔离 Fixture 与发布流水线。

## 测试策略

- 框架：vitest 2，环境 `node`，`globals: false`。`testTimeout: 15s`、`hookTimeout: 30s`——Windows 上 git 子进程开销大，集成/端到端测试的 `beforeEach` 会建真实临时 Git 仓库，余量是刻意留的，不要调小。
- 分层组织（共 56 个测试文件）：
  - `tests/domain/`（10）、`tests/application/`（8）、`tests/adapters/`（14）、`tests/bootstrap/`（1）、`tests/interfaces/`（7，含 CLI 快照 `__snapshots__/`）：单元测试；
  - `tests/integration/`（7；`git/`、`claude/`）：真实临时 Git 仓库与 fake claude 进程边界的端口契约测试；
  - `tests/e2e/`（9）：真实临时仓库 + 序列化 Fake Claude + 真实 State Store/Reporter/Archiver，经 `StartRun` 用例驱动完整业务闭环（happy-path、中断、恢复、归档、失败、replan/SPEC 变更、心跳、调试日志、abandon/report 等场景），不替换任何内部模块。
- `tests/process-executor.ts`：测试装配共享的进程执行器工厂，让每个 Adapter 夹具显式获得独立执行器，与生产组合根保持相同的依赖方向。
- `tests/fake-claude/claude.mjs`：可编程 Fake Claude CLI。行为由环境变量 `APEX_FAKE_CLAUDE_SCENARIO` 指向的场景 JSON 控制（支持单场景与按调用顺序消费的 `sequence` 序列场景，可模拟写文件、执行命令、stdout 行、stderr、退出码、睡眠等；`APEX_FAKE_CLAUDE_RECORD` 记录每次调用的 argv/stdin/cwd/env 供断言）。测试**不联网、不调用真实 Claude**。
- `tests/fixtures/`：`claude-help`、`claude-streams`（stream-json 样本）、`process`（进程执行器夹具）、`redaction-corpus`（脱敏语料）。
- 跑单个测试文件：`npx vitest run tests/domain/run-state.test.ts`。

## 安全注意事项

- 所有可能含秘密的外部文本（Claude stdout/stderr、Git stderr、日志、控制台输出行）必须经过 `RedactionPort` 脱敏：命中即整体替换为固定占位符，不做哈希、编码或部分回显；流式脱敏有"危险尾部"hold-back 机制防止跨 chunk 绕过（SPEC §18.4）。
- 文件访问边界：`src/domain/paths.ts` 的 `isGitRelativePath` 要求项目内路径使用正斜杠，拒绝绝对路径、盘符路径及 `.`/`..` 段；持久化契约与运行时校验复用同一纯函数。
- 状态写入全部走临时文件替换协议（原子替换），且所有领域校验在第一次写入前完成——校验失败不触碰任何文件。
- `--full-access`（bypassPermissions）只能由用户显式启用，且必须显示风险提示；默认使用 Claude Code 自动权限模式。
- 凭据处理：子进程原样继承用户环境，但代码不读取、不缓存凭据，不创建隔离配置目录。
- 中断语义（SPEC §2.4）：第一次 Ctrl+C 停止启动新 Session、经执行器终止直接子进程并有界等待（10 秒）收尾，当前 Run 持久化为 `failed`（`RUN_INTERRUPTED`，退出码 130）；第二次立即退出进程。
