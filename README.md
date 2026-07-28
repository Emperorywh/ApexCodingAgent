# ApexCodingAgent

围绕 Claude Code 的前台长时运行编码任务编排器（Windows）。

你提供一份 `SPEC.md`，ApexCodingAgent 让 Claude Code 围绕这份规格持续完成一个较大的软件需求：先规划，再按任务逐个执行，每个任务边界保存状态和 Git Checkpoint，全部完成后做一次整体 Review 并生成报告。

> Claude Code 负责理解、规划、编码、工具调用、测试和 Review；ApexCodingAgent 只负责任务接力、结构化状态、Git Checkpoint 和确定的流程编排。

## 工作流程

```
ApexCodingAgent start
        │
        ├─ 1. 启动前置检查（环境 / Git / Claude / SPEC / 工作区）
        ├─ 2. Planning Session：Claude 阅读 SPEC 与仓库，生成 Task Plan
        │     └─ 保存为 .apex-coding-agent/tasks.json
        ├─ 3. 创建 Run 分支 apex-coding-agent/<runId>
        ├─ 4. 逐个调度 Task：Claude 执行 → 保存状态 → 本地 Git Checkpoint
        │     └─ 计划需要调整时，由 Claude 显式形成 Plan Revision
        ├─ 5. 全部 Task 完成后启动 Final Review Session
        └─ 6. 生成 .apex-coding-agent/report.md，Run 进入终态
```

## 环境要求

- **操作系统**：Windows 10 / 11（不支持 Linux / WSL2）
- **Node.js**：>= 22 < 23 或 >= 24 < 25
- **Git**：在 PATH 中可用
- **Claude Code CLI**：已安装并完成鉴权配置（Provider / CC Switch 等由你自己管理），在 PATH 中名为 `claude`

## 安装与构建

```powershell
npm install
npm run build
```

构建产物在 `dist/`，CLI 入口为 `dist/interfaces/cli/main.js`。可以用以下任一方式运行：

```powershell
node dist/interfaces/cli/main.js --help
# 或链接为全局命令
npm link
ApexCodingAgent --help
```

## 快速开始

1. 在你的项目中准备好一份完整的 `SPEC.md`（放在仓库内，ApexCodingAgent 会自动发现；也可以用参数显式指定路径）。
2. 确保工作区干净（除 `SPEC.md` 本身外无未提交改动，且 `SPEC.md` 未被 `git add`）。
3. 运行：

```powershell
ApexCodingAgent start
```

然后保持终端存活，等待 Run 到达终态。运行期间每次状态迁移都会输出一行进度摘要，随时可以另开终端用 `ApexCodingAgent status` 查看快照。

## 命令一览

只有四个命令，没有 init / resume / pause / stop / retry，也没有后台模式。

| 命令 | 作用 |
| --- | --- |
| `ApexCodingAgent start [spec-path] [选项]` | 创建并前台运行一个新 Run 直到终态 |
| `ApexCodingAgent status` | 只读展示最近一次状态快照（查看 failed/abandoned 也算成功读取） |
| `ApexCodingAgent report` | 为已终态的 Run 生成或重新生成 `report.md` |
| `ApexCodingAgent abandon --force` | 将无法继续的非终态 Run 显式废弃（不可逆，必须带 `--force`） |

`start` 选项：

- `[spec-path]` — 显式 SPEC 路径；省略时在仓库内自动发现唯一的 `SPEC.md`
- `--full-access` — Execution / Final Review 阶段使用 `bypassPermissions`（默认为 `auto`；启用时会显示风险提示；Planning 恒为 `plan` 模式）
- `--claude-cli-path <path>` — 指定 Claude CLI 入口（默认：PATH 中的 `claude`）
- `--git-cli-path <path>` — 指定 Git CLI 入口（默认：PATH 中的 `git`）

## 启动前置条件

`start` 在创建 Run 之前会检查（任一失败则以退出码 3 停止，不创建 Run）：

- Windows 10+ 且 Node.js 版本受支持
- Git、Claude CLI 可用，且 Claude 能力探测通过（缺失即停止，不走降级）
- 当前目录在 Git 仓库内
- SPEC 文件唯一、可读、非空，且未被 staged
- 工作区干净（仅 SPEC 文件自身例外）
- 不存在处于非终态的旧 Run；若存在（例如进程曾被强杀），先确认没有旧进程在写仓库，然后执行 `ApexCodingAgent abandon --force` 再重新 `start`

## 配置文件（可选）

配置优先级：**显式 CLI 参数 > `.apex-coding-agent/settings.json` > 内置默认值**。

```json
{
  "schemaVersion": 1,
  "executionPermissionMode": "auto",
  "claudeCliPath": null,
  "gitCliPath": null
}
```

注意：`settings.json` 不允许把 `executionPermissionMode` 设为 `bypassPermissions`——完全权限必须通过本次命令显式传入 `--full-access`，防止一次历史配置变成后续所有 Run 的隐式授权。

## 状态目录

所有运行状态保存在仓库根的 `.apex-coding-agent/` 下（自动加入 Git exclude，不会被跟踪）：

```
.apex-coding-agent/
├── settings.json     # 可选的用户配置
├── run.json          # 当前 Run 的结构化状态（唯一事实来源）
├── tasks.json        # 当前 Task Plan
├── plans/            # 不可变的 Plan Revision 快照
├── sessions/         # 每次 Claude Session 的记录
├── logs/             # 运行日志
├── report.md         # 最终报告（终态后生成）
└── history/<runId>/  # 已终态 Run 的归档（含 archive-manifest.json 校验清单）
```

下一次 `start` 时，已终态的旧 Run 会先被完整归档到 `history/`（带 SHA-256 清单校验），再创建新 Run。已完成 Task 的定义、结果和 Checkpoint 不会被后续重新规划静默改写。

## 中断与退出码

`start` 是前台进程，请保持终端存活直到终态。运行期间：

- **第一次 Ctrl+C**：执行有界收尾——停止启动新 Session、终止直接 Claude 子进程（最多等 10 秒）、保存事实、Run 转为 `failed`（错误码 `RUN_INTERRUPTED`），以退出码 130 结束。
- **第二次 Ctrl+C**：立即结束进程。此后系统不承诺清理残留进程或状态可用，需人工检查后 `abandon --force`。

| 退出码 | 含义 |
| --- | --- |
| 0 | 命令成功（status 查看 failed/abandoned 仍属成功读取） |
| 1 | start 创建的 Run 正常持久化为 failed |
| 2 | 命令、参数或选项用法错误（`CLI_USAGE_INVALID`） |
| 3 | 启动前置校验失败，未创建新 Run |
| 4 | status / report / abandon 命令失败 |
| 130 | 第一次中断信号已处理并结束当前 start（优先于 1） |

## 需要知道的边界

- Claude 调用失败（崩溃、Provider 故障、网络、额度等非零退出）不会自动重试：保存错误事实后当前 Run 直接进入 `failed`。
- 不提供 Coordinator 崩溃恢复、进程树管理、PID 跟踪或后台模式；这些是本版本的显式产品边界，不是待实现的缺陷。
- 信任模型为 trust-first：Claude 在你的 Windows 账户权限内工作，ApexCodingAgent 不提供宿主级安全隔离。`--full-access` 请只在 SPEC 来源可信时使用。

## 常见问题

**提示 `RUN_ALREADY_ACTIVE_OR_INTERRUPTED`？**
存在非终态的旧 Run。先确认没有旧的 Apex / Claude 进程在写仓库，然后 `ApexCodingAgent abandon --force`，再重新 `start`。

**Run 失败了怎么办？**
用 `ApexCodingAgent status` 查看 `lastError` 与任务状态；Run 已是终态，修复问题（额度、网络、SPEC 表述等）后直接重新 `start`——旧 Run 会被自动归档，不会丢失。

**想看历史 Run？**
已终态的 Run 在 `.apex-coding-agent/history/<runId>/` 中，包含全部状态文件与校验清单。

## 开发

```powershell
npm run build           # 编译（tsc）
npm run typecheck       # 测试代码类型检查
npm test                # build + typecheck + vitest + 架构检查 + 禁用模式扫描
npm run scan-forbidden  # 只跑禁用模式扫描
```

代码结构：`src/` 按整洁架构分为 `domain`（契约与不变量）、`application`（用例与端口）、`adapters`（Claude / Git / 状态存储）、`interfaces`（CLI）、`bootstrap`（组装根）；`tests/` 目录与之镜像。完整产品规格见 [docs/SPEC.md](https://github.com/Emperorywh/ApexCodingAgent/blob/main/docs/SPEC.md)（v4.1.1），各阶段实施记录见 [docs/sessions/](https://github.com/Emperorywh/ApexCodingAgent/tree/main/docs/sessions/)。
