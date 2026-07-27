# G6：CLI + Composition Root + 中断信号 + 发布骨架

## 会话目标

实现 `ApexCodingAgent` 四命令 CLI、Composition Root 依赖组装、前台中断信号的有界退出、CLI 退出码映射、环境与 Node 版本门禁、发布骨架与 AC-025 禁用项扫描。

## 建议的 goal 完成判据

```text
完成 docs/sessions/G6-cli-bootstrap.md 定义的 G6 交付。
判据：
1. `npm test` 全绿（含 CLI 进程级测试：退出码矩阵、信号、help 快照）。
2. `npm run build` 产物可经 bin 直接执行 `ApexCodingAgent --help`。
3. `node scripts/scan-forbidden.mjs` 通过（AC-025 禁用项与原生依赖扫描）。
4. 全量回归绿；架构扫描通过。
```

## 前置条件

G1–G5 门禁全部通过。

## 起手读取

- 本文件、`TRACE.md` 第 4/5/8/9 节
- SPEC §2.4（中断信号语义）、§8.1 第 1/3 项（Windows 与 Node 版本）、§16（配置与风险提示）、§17 全章（CLI）、§15.2–15.3（command_error）、§23（DoD 中 CLI 相关条目）

## 交付物

- `src/interfaces/cli/`：`parseArgs` 解析、`start`/`status`/`report`/`abandon` 命令、help 文本、输出渲染
- `src/bootstrap/`：Composition Root（创建全部适配器并注入用例，无业务规则）
- `src/bootstrap/signals.ts`：SIGINT 两次信号语义
- `scripts/scan-forbidden.mjs`：AC-025 扫描
- `package.json` 发布字段：`bin`（`ApexCodingAgent` → dist 入口）、`files`、engines；无 postinstall

## 规范性要点

### 命令语义（§17）

- `start [spec-path] [--full-access] [--claude-cli-path <path>] [--git-cli-path <path>]`：创建并前台运行至终态；每次状态迁移输出一行脱敏进度摘要。
- `status`：只读，经一致性读取协议展示最近持久化快照；查看 failed/abandoned Run 退出码仍为 0。
- `report`：只为终态 Run 生成/重生成报告；失败用 `REPORT_COMMAND_FAILED`，不改终态（completed 不得变 failed）。
- `abandon --force`：缺 `--force` → `ABANDON_REQUIRES_FORCE`；显示"系统无法判断旧进程是否仍然存在"风险提示。
- 所有命令从调用目录经 Git 确定 repositoryRoot。CLI 失败必须同时输出稳定 errorCode；不得用工具原始退出码替代 Apex 退出码。

### 退出码（§17）

| 码 | 语义 |
|---|---|
| 0 | 成功（含 status 读 failed/abandoned） |
| 1 | start 的 Run 正常持久化为 failed |
| 2 | 用法/参数错误（`CLI_USAGE_INVALID`） |
| 3 | 启动前置校验失败（startup_validation 各码），未创建新 Run |
| 4 | status/report/abandon 命令失败（command_error 各码） |
| 130 | 第一次中断已处理并结束 start（优先于 1） |

### 中断信号（§2.4）

- 第一次 SIGINT：调用 G5 驱动器的 `requestInterrupt()`（停新 Session → 杀直接子进程 → ≤10s → 保存事实 → Task/Run failed）→ 退出码 130。
- 第二次 SIGINT：立即结束进程。
- 信号处理只属于前台进程有界退出语义：不实现后台 Stop 协议、进程树管理、崩溃恢复。

### 环境门禁（§8.1、§5.1）

- 非 Windows、Windows 版本低于 10、Node 主版本非 22/24 → `ENVIRONMENT_UNSUPPORTED`（退出码 3），不隐式兼容。
- Composition Root 负责把 CLI 路径解析、settings 加载（G5 的合并逻辑）、适配器构造接线；`claude`/`git` 可执行文件缺失 → 对应 startup_validation 码。

### 发布骨架与 AC-025

- `bin` 暴露 `ApexCodingAgent`；发布物只含 dist 与必要资产；不捆绑 Node、无原生依赖（NFR-008）。
- `scan-forbidden.mjs`：扫描源码与依赖，命中 Mutex/NamedPipe/JobObject/PID 恢复/journal/resume/pause/stop 等禁用实现痕迹或 `.node` 原生模块即失败。
- CLI help、默认值与 §16/§17 一致（DoD 条目）。

## 明确不做

- 新业务能力（全部在 G5 或之前）；Windows 原生 API；任何安装器。

## 测试清单

- CLI 进程级（spawn `node dist/...`）：用法错误 → 2 + `CLI_USAGE_INVALID`；各类启动校验失败 → 3 + 对应码；Run failed → 1；status 读 failed/abandoned → 0；status/report/abandon 失败 → 4 + 对应码；中断 → 130
- help 输出快照（命令、选项、默认值与 §17 一致）
- 第一次 SIGINT 有界退出 + 第二次立即退出（子进程信号测试）
- bypassPermissions 风险提示出现在 stderr/stdout
- ENVIRONMENT_UNSUPPORTED 路径（mock platform/版本探测）
- `scan-forbidden.mjs` 通过；`npm pack` 产物内容检查（无原生模块、无多余文件）

## 验证门禁

```bash
npm run build && npm test && node scripts/check-architecture.mjs && node scripts/scan-forbidden.mjs
```

全部通过后进入 G7（发布/CI 阶段）。
