/**
 * CLI 帮助文本（SPEC §17、§16；DoD：CLI 帮助、默认值和 SPEC 一致）。
 *
 * 本版本提供 start/resume/status/report/abandon 五个命令；不存在 init/
 * pause/stop/cancel/retry/approve/resolve/cleanup 或后台模式。
 */
export const HELP_TEXT = `ApexCodingAgent — 围绕 Claude Code 的前台长时运行编码协调器

用法:
  ApexCodingAgent start [spec-path] [--full-access] [--verbose]
      [--claude-cli-path <path>] [--git-cli-path <path>]
  ApexCodingAgent resume [--full-access] [--force] [--verbose]
      [--claude-cli-path <path>] [--git-cli-path <path>]
  ApexCodingAgent status
  ApexCodingAgent report
  ApexCodingAgent abandon --force
  ApexCodingAgent --help

命令:
  start     创建并前台运行一个新 Run 直到终态，每次状态迁移输出一行进度摘要
  resume    恢复被中断（RUN_INTERRUPTED）的 Run：重开为中断前状态并前台
            运行到终态；Planning、Execution 或 Final Review 会话被中断时
            续接原 Claude 对话上下文。仅确认原 transcript 不可用时回退为
            一趟全新会话。对崩溃残留的非终态 Run 必须显式 --force
  status    只读展示最近成功写入的一致性快照（读取 failed/abandoned 也算成功）
  report    只为终态 Run 生成或重新生成 report.md，失败不修改终态
  abandon   把无法继续的非终态 Run 显式转为 abandoned，必须显式 --force

start 参数与选项:
  spec-path                 显式 SPEC 路径；省略时在调用目录及其子目录内
                            自动发现唯一 SPEC.md（仓库其余位置不纳入发现）
  --full-access             Execution/Final Review 使用 bypassPermissions
                            （默认 auto；启用时显示风险提示；Planning 恒为 plan）
  --claude-cli-path <path>  Claude CLI 入口（默认: PATH 中的 claude）
  --git-cli-path <path>     Git CLI 入口（默认: PATH 中的 git）
  -v, --verbose             把调试日志镜像到 stderr（调试日志始终写入
                            .apex-coding-agent/logs/apex-debug.log 并随 Run 归档）
  -h, --help                显示本帮助

resume 参数与选项:
  --full-access             原 Run 使用 bypassPermissions 时必须再次显式授权
  --force                   恢复崩溃残留的非终态 Run（旧进程可能仍在，
                            请先确认其已停止）
  --claude-cli-path <path>  Claude CLI 入口（默认: 原 Run 记录或 PATH 中的 claude）
  --git-cli-path <path>     Git CLI 入口（默认: 原 Run 记录或 PATH 中的 git）
  -v, --verbose             把调试日志镜像到 stderr
  -h, --help                显示本帮助

start 配置优先级（§16）: 显式 CLI 参数 > .apex-coding-agent/settings.json > 内置默认值
resume CLI 路径优先级: 显式 CLI 参数 > 原 Run 快照 > settings.json > PATH 默认

退出码（§17）:
  0    命令成功（status 查看 failed/abandoned Run 仍属成功读取）
  1    start/resume 运行的 Run 正常持久化为 failed
  2    命令、参数或选项用法错误（CLI_USAGE_INVALID）
  3    启动前置校验失败，未创建或修改 Run
  4    status、report、abandon 或 resume 的命令级失败
  130  第一次中断信号已被处理并结束当前 start/resume（优先于 1）

中断（§2.4）: start/resume 前台运行期间，第一次中断信号执行有界收尾
（停新 Session、终止直接 Claude 子进程、最多等待 10 秒、保存事实、
Run 转 failed 并记录恢复点，以 130 退出）；第二次中断信号立即结束进程。
中断后的 Run 可用 resume 从断点继续，不会重做已完成 Task。
`;
