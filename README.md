# ApexCodingAgent

ApexCodingAgent 是一款运行在 Windows 终端中的 Claude Code 长任务助手。

当一个软件需求很大、无法在一次 Claude Code 会话中完成时，你只需要准备一份 `SPEC.md`。ApexCodingAgent 会让 Claude Code 先制定计划，再逐项完成任务，保存每一步的 Git 记录，最后检查整体结果并生成报告。

它适合：

- 开发一个包含多个步骤的新功能
- 对现有项目进行较大规模的重构
- 按照明确的需求文档持续完成一个软件项目

> ApexCodingAgent 会直接操作你的项目和 Git 仓库。请先备份重要内容，并只在你信任的项目和需求文档中使用。

## 下载安装

### 环境准备

- Windows 10 或 Windows 11
- [Node.js](https://nodejs.org/) 22.x 或 24.x
- [Git](https://git-scm.com/downloads/win)
- Claude Code CLI，并已完成登录或服务商配置

在 PowerShell 中确认这些命令可以正常运行：

```powershell
node --version
git --version
claude --version
```

### 安装

在 PowerShell 中运行：

```powershell
npm install -g apex-coding-agent@latest
```

安装完成后检查：

```powershell
ApexCodingAgent --help
```

以后需要更新时，再次执行安装命令即可。

## 使用

### 1. 准备项目

你的项目必须是一个 Git 仓库。进入项目目录，并确认除了本次需求文档以外，没有尚未提交的修改：

```powershell
cd C:\你的项目目录
git status
```

如果项目还不是 Git 仓库，可以先执行：

```powershell
git init
git add .
git commit -m "项目初始版本"
```

### 2. 编写需求文档

在项目中创建一个 `SPEC.md`，写清楚要完成什么。推荐至少包含目标、具体要求和验收标准，例如：

```markdown
# 用户登录功能

## 目标

为现有网站增加邮箱和密码登录。

## 具体要求

- 用户可以登录和退出
- 登录失败时显示明确提示
- 登录状态在刷新页面后仍然保留

## 验收标准

- 正确账号可以成功进入首页
- 错误密码不能登录
- 退出后无法访问需要登录的页面
```

`SPEC.md` 必须位于当前 Git 仓库内、内容不能为空，并且不要执行 `git add SPEC.md`。默认情况下 ApexCodingAgent 只在你执行命令的目录及其子目录内查找 `SPEC.md`，因此一个仓库容纳多个项目（monorepo）也没有问题——其他目录里的 `SPEC.md` 不会互相干扰；只要当前目录子树内保持唯一即可。

### 3. 开始运行

在项目目录中执行：

```powershell
ApexCodingAgent start
```

ApexCodingAgent 会在当前目录及其子目录内自动找到唯一的 `SPEC.md` 并开始工作。运行期间请保持这个终端窗口开启。

如果需求文档使用了其他文件名，或者当前目录子树内有多份 `SPEC.md`，可以直接指定文件（仍可指向仓库内任意位置）：

```powershell
ApexCodingAgent start .\docs\my-spec.md
```

### 4. 查看进度和结果

运行期间，终端会按层级输出精简进度：阶段开始与结果、实际模型、关键工具动作，以及长时间静默时的存活心跳。思考过程、成功工具结果和底层系统事件不会逐条冲刷终端，但完整 Claude 流仍保存在 `.apex-coding-agent\logs\<session-id>.log`，结构化运行诊断保存在 `.apex-coding-agent\logs\apex-debug.log`。使用 `--verbose` 可把结构化诊断同步输出到 stderr。

交互式终端会使用克制的语义颜色；重定向到文件或管道时自动保持纯文本。可设置 `NO_COLOR` 环境变量关闭颜色。

另开一个 PowerShell 窗口，进入同一个项目目录，然后运行：

```powershell
ApexCodingAgent status
```

全部完成后，最终报告位于：

```text
.apex-coding-agent\report.md
```

如需重新生成报告：

```powershell
ApexCodingAgent report
```

每次运行结束后，本次运行的完整记录（状态、计划、会话、日志、报告）会自动归档到 `.apex-coding-agent\history\` 下，方便日后查阅。

### 5. 中断与恢复

运行期间按一次 `Ctrl+C` 会安全结束当前任务并将其标记为失败，但会记录恢复点。之后在项目目录中运行：

```powershell
ApexCodingAgent resume
```

即可从中断的步骤继续，已经完成的步骤不会重做；计划、执行或最终检查中断时都会尽量续接原来的 Claude 对话。如果原任务使用了 `--full-access`，恢复时也需要加上同一个选项。

如果程序不是通过 `Ctrl+C` 正常结束（例如直接关闭了终端），任务会停在"正在运行"的状态。前台运行每 5 秒会写入一次存活信号（`heartbeat.json`），进程消失后信号停止更新——超过 30 秒未更新即判定旧进程已崩溃，此时直接运行 `resume` 即可自动接管（无需 `--force`），`start` 也会给出同样的提示；信号仍在更新、缺失或不可读时才需要 `resume --force` 接管，执行前请先确认没有旧的 ApexCodingAgent 或 Claude 进程仍在工作。

如果确定任务无法继续，可以放弃它并重新开始：

```powershell
ApexCodingAgent abandon --force
ApexCodingAgent start
```

### 6. 排查问题

每次运行都会把详细的调试日志写入下面的文件（随本次任务一同归档到 `history` 目录）：

```text
.apex-coding-agent\logs\apex-debug.log
```

如果想在运行时同步查看这些日志，可以加 `--verbose`：

```powershell
ApexCodingAgent start --verbose
```

`--verbose` 会把调试日志同时输出到终端，不影响任务本身。

## 命令一览

| 命令 | 用途 |
| --- | --- |
| `ApexCodingAgent start` | 使用当前目录及子目录内的 `SPEC.md` 开始任务 |
| `ApexCodingAgent start <文件路径>` | 使用指定的需求文档开始任务 |
| `ApexCodingAgent start --verbose` | 开始任务，并把调试日志同步输出到终端 |
| `ApexCodingAgent resume` | 从中断点继续一个被中断的任务（不重做已完成步骤）；旧进程已崩溃的残留任务自动接管 |
| `ApexCodingAgent resume --force` | 旧进程可能仍在运行时，人工确认后接管残留的任务 |
| `ApexCodingAgent status` | 查看当前进度或失败原因 |
| `ApexCodingAgent report` | 重新生成最终报告 |
| `ApexCodingAgent abandon --force` | 放弃一个已经无法继续的任务 |

`start` 和 `resume` 还支持 `--claude-cli-path <路径>` 与 `--git-cli-path <路径>`，用于指定 Claude 或 Git 命令的位置（默认使用 PATH 中的 `claude` 和 `git`）。

## 使用时需要注意

- `start` 会一直在前台运行，请不要关闭终端或让电脑休眠。
- 开始前请提交或移除与本次任务无关的修改；`SPEC.md` 本身不要暂存。
- 每次运行都会在单独的 Git 分支中进行，并自动创建本地 Git 提交，不会改动你原来的分支。
- Claude Code、网络或额度出现问题时，任务会停止。使用 `ApexCodingAgent status` 查看原因，解决问题后重新运行 `ApexCodingAgent start`。
- 认证、网络、额度或普通执行失败不会自动重试，需要人工处理后重新开始或恢复。

## 完全权限模式

默认情况下，Claude Code 会使用自动权限模式。如果任务确实需要更高权限，并且你完全信任 `SPEC.md` 的内容，可以运行：

```powershell
ApexCodingAgent start --full-access
```

完全权限模式会扩大 Claude Code 可以执行的操作范围，请谨慎使用。

## 卸载

```powershell
npm uninstall -g apex-coding-agent
```

项目主页：[GitHub](https://github.com/Emperorywh/ApexCodingAgent) · [npm](https://www.npmjs.com/package/apex-coding-agent) · [问题反馈](https://github.com/Emperorywh/ApexCodingAgent/issues)
