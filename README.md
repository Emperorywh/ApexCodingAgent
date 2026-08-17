# ApexCodingAgent

ApexCodingAgent 是一款运行在终端中的 Claude Code 长任务助手，支持 Windows、macOS 与 Linux。

## 它能解决什么问题

当一个开发需求太大，难以在单次 Claude Code 会话中稳定完成时，ApexCodingAgent 可以根据一份需求文档持续推进整个任务：

- 先拆分并复核实施计划
- 逐项编写代码、运行验证并独立复核结果
- 为每个阶段创建 Git 检查点，避免长任务失去进度
- 中断或环境故障后从恢复点继续，不重复已完成的工作
- 完成全部任务后进行整体检查并生成报告

它适合多步骤功能开发、大规模重构，以及其他具有明确需求和验收标准的长时间编码任务。

> ApexCodingAgent 会直接修改项目、创建 Git 提交并推送运行分支。请先备份重要内容，并只使用你信任的项目和需求文档。

## 如何使用

### 1. 安装

使用前请准备：

- Windows 10 或更高版本、macOS 或 Linux
- Node.js 22.x 或 24.x
- Git
- 已完成登录或服务商配置的 Claude Code CLI
- 一个配置了可写 Git 远程的项目仓库

在 PowerShell、bash 或 zsh 中安装：

```text
npm install -g apex-coding-agent@latest
ApexCodingAgent --help
```

### 2. 准备需求文档

提交或移除项目中与本次任务无关的修改，然后在仓库内创建未暂存的 `SPEC.md`。文档至少应写清楚目标、具体要求和验收标准，例如：

```markdown
# 用户登录功能

## 目标

为现有网站增加邮箱和密码登录。

## 具体要求

- 用户可以登录和退出
- 登录失败时显示明确提示
- 刷新页面后保留登录状态

## 验收标准

- 正确账号可以成功登录
- 错误密码不能登录
- 退出后无法访问需要登录的页面
```

不要执行 `git add SPEC.md`。如果当前目录及其子目录内只有一份 `SPEC.md`，程序会自动找到它。

### 3. 开始任务

进入项目目录并运行：

```text
# PowerShell：cd C:\你的项目目录
# bash/zsh：  cd /你的项目目录
ApexCodingAgent start
```

也可以显式指定需求文档（正斜杠路径在所有平台都可用）：

```text
ApexCodingAgent start docs/my-spec.md
```

程序会创建独立的 Git 运行分支，并将检查点自动推送到 `origin`，不会修改你原来的分支。如果使用其他远程名称：

```text
ApexCodingAgent start --push-remote upstream
```

任务在前台持续运行，期间请保持终端开启并避免电脑休眠。

五个命令都会先显示版本、命令意图和调用目录；规划、任务切换、候选保存、独立复核、重规划与最终复核使用统一的“标题 + 缩进事实”里程碑，命令结束时再输出唯一成功、失败或中断结果。

在交互式终端中，当前 Claude 活动会固定在底部原位刷新，已完成的工具动作保留在滚动历史中；输出重定向到文件或 CI 时自动改为无控制序列的逐行纯文本。设置 `NO_COLOR` 可关闭颜色，但仍保留动态状态布局。

### 4. 查看、恢复或结束任务

| 命令 | 用途 |
| --- | --- |
| `ApexCodingAgent status` | 查看当前进度或失败原因 |
| `ApexCodingAgent resume` | 从中断、故障或回合上限处继续 |
| `ApexCodingAgent report` | 重新生成最终报告 |
| `ApexCodingAgent abandon --force` | 放弃无法继续的任务 |

运行期间按一次 `Ctrl+C` 会安全结束当前任务并保存恢复点。处理好网络、鉴权、额度或其他环境问题后，执行 `ApexCodingAgent resume` 即可继续。

只有在程序要求强制接管，并且你已确认旧的 ApexCodingAgent 和 Claude 进程不再运行时，才使用：

```text
ApexCodingAgent resume --force
```

最终报告和调试日志分别位于：

```text
.apex-coding-agent/report.md
.apex-coding-agent/logs/apex-debug.log
```

如需在终端同步查看调试日志，可为 `start` 或 `resume` 添加 `--verbose`。

默认情况下 Claude Code 使用自动权限模式。只有在任务确实需要更高权限，并且你完全信任 `SPEC.md` 时，才使用 `--full-access`：

```text
ApexCodingAgent start --full-access
```

项目主页：[GitHub](https://github.com/Emperorywh/ApexCodingAgent) · [npm](https://www.npmjs.com/package/apex-coding-agent) · [问题反馈](https://github.com/Emperorywh/ApexCodingAgent/issues)
