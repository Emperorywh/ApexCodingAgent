# AGENTS.md

本文件面向 AI 编码代理，描述本仓库的架构、命令与约定。阅读本文件前不需要任何项目背景知识。

## 项目概览

- **ApexCodingAgent**（npm 包 `apex-coding-agent`，CLI 命令 `ApexCodingAgent`）：运行在 Windows 终端中的 Claude Code 长任务编排器。用户准备一份 `SPEC.md` 需求文档后，本工具驱动 Claude Code 先制定计划，再逐项执行任务，每一步保存 Git 检查点，最后做整体检查并生成报告。
- 产品形态：全局安装的 CLI，`bin` 指向 `dist/interfaces/cli/main.js`，发布内容仅 `dist/`。
- 实现基准：`docs/SPEC.md` 是权威目标规格（状态：**待实施**，全量重构，不兼容现有运行状态和报告）。当前 `src/` 实现的仍是旧设计，与 SPEC 存在差异；新开发以 SPEC 为准，差异见下文「目标规格与当前实现的差异」。源码注释中的 `SPEC §x.y` 引述部分指向旧版编号，重构时按新 SPEC 章节更新。
- 平台约束：**仅支持 Windows**（package.json `os: ["win32"]`），Node.js 22.x 或 24.x。
- 文档与注释主要使用**中文**（domain 层部分文件使用英文注释）；仓库制品（代码注释、文档）沿用这一习惯。

## 目标规格与当前实现的差异（docs/SPEC.md）

SPEC 处于待实施状态，以下是相对当前代码的关键变化（实施顺序见 SPEC §22）：

- 运行态聚合为单一 `state.json`（Run、Task runtime、Plan 引用、Evidence/Review 索引、Issue、恢复信息），不再使用 `run.json` + `tasks.json` 双文件；新增 `plans/`、`evidence/`。
- 流程增加独立 Plan Review；Execution 只产出 Candidate Checkpoint，Task 完成必须由独立 Task Review 接受；后续变更经 Impact Analyzer 使历史 Review 失效并在新 HEAD 上重验；Final Review 是 Run 完成的唯一门槛。
- 新增 Evidence Store（类型化 Evidence、Artifact 哈希、预算）与 `SandboxPort` / `CommandPolicyPort` / `VerificationPort` / `VisualEvidencePort` 端口；沙箱机制与降级矩阵见 SPEC §5.2。
- Task 状态机为七态：`pending / executing / review_pending / reviewing / completed / failed / skipped`，其中 `failed → pending` 仅 resume 可触发；Run 六态不变。
- CLI 新增 `attest`（导入人工证据）与 `answer`（导入用户决定）；心跳、单实例与两级中断语义见 SPEC §15.6。
- 错误码集中登记（SPEC §15.3 注册表）：新 errorCode 必须先入表再使用。
- SPEC §2.3 澄清：禁止的是内核对象与自实现进程追踪协议；`spawn` 进程句柄与 `taskkill /T` 等系统工具调用不属于禁用（但 `src/` 实现仍须规避扫描词表的字面命中）。

## 技术栈

- TypeScript（`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`），target/module 为 ES2022 / NodeNext。
- 纯 ESM（`"type": "module"`）：**相对导入必须带 `.js` 扩展名**（如 `import ... from '../domain/errors.js'`）。
- 唯一运行时依赖：`ajv`（JSON Schema 校验）。devDependencies：`typescript`、`vitest`、`@types/node`。
- 无原生扩展、无 postinstall（由 `scan-forbidden` 强制）。

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

- `src/domain/` — 纯领域层。Run 六态状态机（`planning / running / final_review / completed / failed / abandoned`，见 `run-state.ts`）、Task 状态机、15 个内置 JSON Schema（`schemas/`，统一 `schemaVersion: 1`，经 ajv 校验）、跨字段不变式（`invariants.ts`、`plan.ts`、`results.ts`）、稳定错误模型（`errors.ts`：`ApexError` + `errorCode → errorClass` 确定映射）。
- `src/application/` — 用例层。`ports/` 定义全部端口接口（`GitPort`、`ClaudeRuntimePort`、`StateStorePort`、`FileSystemPort`、`RedactionPort`、`ClockPort`、`LoggerPort`、`ReporterPort`、`OutputPort` 等）；`usecases/` 为业务用例（`start-run`、`resume-run`、`execute-next-task`、`generate-plan-revision`、`run-final-review`、`generate-report`、`abandon-run` 等）；`run-driver.ts` 是前台串行调度循环：planning → 逐 Task 执行 → final_review → 终态；`prompts/` 为发给 Claude 的提示词模板。
- `src/adapters/` — 端口实现。`claude/`（以 `child_process.spawn` **参数数组**启动 Claude CLI，不拼接 Shell；解析 stream-json；Windows 上将 PATH 中的 npm shim 解引用为真实入口；`--resume --fork-session` 续接会话）、`git/`（检查点、仓库状态、SPEC 发现）、`state/`（JSON 状态存储，临时文件替换原子写；运行归档）、`reporter/`（Markdown 报告）、`redaction/`（秘密脱敏）、`logging/`（debug 文件日志）、`filesystem/`、`clock/`。
- `src/bootstrap/` — `composition-root.ts` 创建全部适配器并注入用例（不含业务规则）；`environment.ts` 收集环境事实；`signals.ts` 处理中断信号（第一次 Ctrl+C 安全收尾，第二次立即退出）。
- `src/interfaces/cli/` — `main.ts` 入口（只做进程级接线）、`args.ts`（`node:util` parseArgs 严格解析）、`run.ts`（命令分发与退出码映射）、`status-render.ts`。
- `tests/` — 见下文「测试策略」。
- `scripts/` — 三个 `.mjs` 守护/验收脚本（见命令表）。

## CLI 命令与退出码

命令（详见 `README.md`）：`start [--verbose] [--full-access] [--claude-cli-path <路径>] [--git-cli-path <路径>] [spec 路径]`、`resume [--force] [--full-access]`、`status`、`report`、`abandon --force`。SPEC §17.1 新增（待实施）：`attest <attestation-json-path>`、`answer <user-decision-json-path>`。

退出码（`src/interfaces/cli/run.ts`）：`0` 成功；`1` start/resume 的 Run 正常持久化为 `failed`；`2` 用法错误（`CLI_USAGE_INVALID`）；`3` 启动前置校验失败（未创建或修改 Run）；`4` status/report/abandon/resume 命令级失败（如 `abandon` 缺 `--force` 的 `ABANDON_REQUIRES_FORCE`）；`130` 第一次中断已处理并结束（优先于 `1`）。CLI 失败只输出稳定的、已脱敏的 `errorCode`，绝不透传工具原始退出码。

## 运行时产物（被编排的目标仓库内）

`.apex-coding-agent/` 位于目标 Git 仓库根：`run.json`（Run 状态）、`tasks.json`（任务计划）、`sessions/`、`logs/apex-debug.log`、`report.md`（最终报告）、`history/`（每次运行结束后的归档）、`heartbeat.json`（前台运行每 5 秒写入存活信号，超过 30 秒未更新判定旧进程崩溃，`resume` 可自动接管）。每次运行在**单独的 Git 分支**中进行并自动创建本地提交，不改动用户原分支；认证/网络/额度/执行失败**不自动重试**。

目标结构（SPEC §4.4，待实施）：单一 `state.json` 聚合 + `plans/`、`sessions/`、`evidence/records`、`evidence/artifacts`、`logs/`、`report.md`、`history/`、`heartbeat.json`。

## 代码风格约定

- 不可变数据：接口字段一律 `readonly`；领域层为纯函数 + 显式校验（校验失败抛 `ApexError` 并携带稳定 `errorCode`，不使用临时字符串）。
- 依赖注入统一使用 `createXxx(deps)` 工厂闭包；端口接口命名 `XxxPort`。
- 中文注释为主；公开契约在注释中标注 SPEC 章节号（如 `SPEC §11.2`）。
- 子进程一律 `spawn` + 参数数组；不读取或缓存凭据；不调用 Claude 私有 API；不自动重启失败进程。
- 新增脱敏规则时，必须同步在 `tests/fixtures/redaction-corpus/corpus.json` 添加回归样本（NFR-006，缺样本会导致语料测试失败）。

## 架构与约束守护（修改代码时必须通过）

`npm test` 包含两道强制门禁，违反即失败：

1. **`check-architecture`**（SPEC §5.3）：`src/domain` 与 `src/application` 禁止 `import node:*`，也禁止以任何路径引用 `adapters` / `interfaces` / `bootstrap` 层。内层需要的能力一律通过 `ports/` 接口注入。
2. **`scan-forbidden`**（AC-025 / NFR-008）：`src/` 源码（剥离注释后）禁止出现 Mutex、Named Pipe、Job Object、Journal、PID 追踪、Pause/Stop/Cancel/waiting_for 类状态协议，以及原生扩展加载（`dlopen`、`napi`、`node-gyp`、`.node`）；生产依赖闭包（按 `package-lock.json` 精确路径遍历）禁止原生模块和 C#/.NET/Rust/C++ 运行时包名；`package.json` 禁止 `postinstall`。**注意**：扫描基于正则，在 `src/` 中即使语义无关的命名（如变量名含 `pid`、`stopped`）也会误伤，请主动规避这些词；`tests/` 与 `scripts/` 不在源码扫描范围。

## 测试策略

- 框架：vitest 2，环境 `node`，`globals: false`。`testTimeout: 15s`、`hookTimeout: 30s`——Windows 上 git 子进程开销大，集成/端到端测试的 `beforeEach` 会建真实临时 Git 仓库，余量是刻意留的，不要调小。
- 分层组织（共 52 个测试文件）：
  - `tests/domain/`、`tests/application/`、`tests/adapters/`：单元测试；
  - `tests/integration/`（`git/`、`claude/`）：真实临时 Git 仓库与 fake claude 进程边界的端口契约测试；
  - `tests/e2e/`：真实临时仓库 + 序列化 Fake Claude + 真实 State Store/Reporter/Archiver，经 `StartRun` 用例驱动完整业务闭环（happy-path、中断、恢复、归档、失败等场景），不替换任何内部模块；
  - `tests/interfaces/`：CLI 层测试。
- `tests/fake-claude/claude.mjs`：可编程 Fake Claude CLI。行为由环境变量 `APEX_FAKE_CLAUDE_SCENARIO` 指向的场景 JSON 控制（支持单场景与按调用顺序消费的 `sequence` 序列场景，可模拟写文件、执行命令、stdout 行、退出码、睡眠等）。测试**不联网、不调用真实 Claude**。
- `tests/fixtures/`：`claude-help`、`claude-streams`（stream-json 样本）、`redaction-corpus`（脱敏语料）。
- 跑单个测试文件：`npx vitest run tests/domain/run-state.test.ts`。

## 安全注意事项

- 所有可能含秘密的外部文本（Claude stdout/stderr、日志、控制台输出行）必须经过 `RedactionPort` 脱敏：命中即整体替换为固定占位符，不做哈希、编码或部分回显；流式脱敏有"危险尾部"hold-back 机制防止跨 chunk 绕过（SPEC §18.4）。
- 文件访问边界：`src/domain/paths.ts` 的 `isGitRelativePath` 要求项目内路径使用正斜杠，拒绝绝对路径、盘符路径及 `.`/`..` 段；持久化契约与运行时校验复用同一纯函数。
- 状态写入全部走临时文件替换协议（原子替换），且所有领域校验在第一次写入前完成——校验失败不触碰任何文件。
- `--full-access`（bypassPermissions）只能由用户显式启用，且必须显示风险提示；默认使用 Claude Code 自动权限模式。
- 凭据处理：子进程原样继承用户环境，但代码不读取、不缓存凭据，不创建隔离配置目录。
