/**
 * CLI 命令级呈现模型。
 *
 * 本模块只消费参数解析结果、运行时环境事实和用例返回值，不读取仓库、状态
 * 文件或调用任何端口。命令首屏与终态因此拥有统一结构，同时不会让 Interface
 * 为了展示再次执行查询，也不会把终端样式下沉到 Application。
 */
import type { ApexError } from '../../domain/errors.js';
import type { RunJson } from '../../domain/schemas/run-json.js';
import type { CliCommand } from './args.js';

export type ExecutableCommand = Exclude<CliCommand, { readonly kind: 'help' }>;
export type ExecutableCommandKind = ExecutableCommand['kind'];

const COMMAND_TITLES: Readonly<Record<ExecutableCommandKind, string>> = {
  start: '开始新运行',
  resume: '恢复运行',
  status: '查看运行状态',
  report: '生成运行报告',
  abandon: '放弃当前运行',
};

/** 命令名称集中维护，错误和成功终态不得各自发明另一套文案。 */
export function commandTitle(kind: ExecutableCommandKind): string {
  return COMMAND_TITLES[kind];
}

/**
 * 命令首屏只展示用户已经确定的输入事实。
 *
 * settings.json 解析结果、仓库根和 Run ID 必须等对应用例确认后再输出，不能
 * 在 CLI 层猜测。动态路径最终仍由 run.ts 统一经过 RedactionPort。
 */
export function renderCommandHeader(
  command: ExecutableCommand,
  context: { readonly agentVersion: string; readonly cwd: string },
): readonly string[] {
  const lines = [
    `ApexCodingAgent ${context.agentVersion}`,
    '',
    `◆ ${commandTitle(command.kind)}`,
    `  目录 ${context.cwd}`,
  ];

  switch (command.kind) {
    case 'start':
      lines.push(
        `  SPEC ${command.specPath ?? '自动发现'}`,
        `  权限 ${command.fullAccess ? '完全访问（显式启用）' : '自动'}`,
      );
      break;
    case 'resume':
      lines.push(
        `  方式 ${command.force ? '强制接管' : '断点恢复'}`,
        `  权限 ${command.fullAccess ? '完全访问（显式启用）' : '自动'}`,
      );
      break;
    case 'abandon':
      lines.push(`  方式 ${command.force ? '强制放弃' : '等待 --force 确认'}`);
      break;
    case 'status':
    case 'report':
      break;
  }
  return lines;
}

export type CommandSuccess =
  | { readonly kind: 'start' | 'resume'; readonly run: RunJson }
  | { readonly kind: 'status'; readonly run: RunJson }
  | { readonly kind: 'report'; readonly runId: string; readonly reportPath: string }
  | { readonly kind: 'abandon'; readonly run: RunJson };

/**
 * 成功终态依赖领域层已经验证的强不变量，不用占位符掩盖非法返回值。
 *
 * 若未来用例错误地返回非 completed/abandoned Run，异常会留在对应 CLI
 * 命令的既有错误边界内并转成稳定失败，而不会打印相互矛盾的成功摘要。
 */
function completedReportPath(run: RunJson): string {
  if (run.status !== 'completed' || run.reportPath === null) {
    throw new Error(`completed command result has invalid run status/report: ${run.status}`);
  }
  return run.reportPath;
}

function abandonedTerminalAt(run: RunJson): string {
  if (run.status !== 'abandoned' || run.terminalAt === null) {
    throw new Error(`abandon command result has invalid run status/terminalAt: ${run.status}`);
  }
  return run.terminalAt;
}

/** 用例成功后由 CLI 根据已返回事实生成唯一终态块。 */
export function renderCommandSuccess(result: CommandSuccess): readonly string[] {
  switch (result.kind) {
    case 'start':
      return [
        '',
        '✓ 运行完成',
        `  Run ${result.run.runId}`,
        `  报告 ${completedReportPath(result.run)}`,
      ];
    case 'resume':
      return [
        '',
        '✓ 恢复完成',
        `  Run ${result.run.runId}`,
        `  报告 ${completedReportPath(result.run)}`,
      ];
    case 'status':
      return [
        '',
        '✓ 状态读取完成',
        `  Run ${result.run.runId} · 计划版本 ${result.run.planRevision}`,
      ];
    case 'report':
      return [
        '',
        '✓ 报告生成完成',
        `  Run ${result.runId}`,
        `  报告 ${result.reportPath}`,
      ];
    case 'abandon':
      return [
        '',
        '⊘ 运行已放弃',
        `  Run ${result.run.runId}`,
        `  结束时间 ${abandonedTerminalAt(result.run)}`,
      ];
  }
}

/** 未创建或未修改 Run 的命令失败终态。 */
export function renderCommandError(
  kind: ExecutableCommandKind | null,
  error: ApexError,
): readonly string[] {
  const subject = kind === null ? '命令' : commandTitle(kind);
  return [
    '',
    `✗ ${subject}失败 · ${error.errorCode}`,
    `  类型 ${error.errorClass} · 阶段 ${error.stage}`,
    `  原因 ${error.message}`,
  ];
}

/** start/resume 已创建 Run 后的失败或用户中断终态。 */
export function renderRunCommandFailure(input: {
  readonly kind: 'start' | 'resume';
  readonly runId: string;
  readonly error: Pick<ApexError, 'errorCode' | 'stage' | 'message'> | null;
}): readonly string[] {
  const errorCode = input.error?.errorCode ?? 'unknown';
  const subject = input.kind === 'start' ? '运行' : '恢复运行';
  const heading =
    errorCode === 'RUN_INTERRUPTED'
      ? `◇ ${subject}已中断 · ${errorCode}`
      : `✗ ${subject}未完成 · ${errorCode}`;
  const lines = ['', heading, `  Run ${input.runId}`];
  if (input.error !== null) {
    lines.push(`  阶段 ${input.error.stage}`, `  原因 ${input.error.message}`);
  }
  return lines;
}
