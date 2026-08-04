/**
 * CLI 命令分发与退出码映射（SPEC §17、§15.2 command_error、§2.4）。
 *
 * 退出码：0 成功；1 start/resume 的 Run 正常持久化为 failed；2 用法错误
 * （CLI_USAGE_INVALID）；3 启动前置校验失败（未创建或修改 Run）；4
 * status/report/abandon/resume 命令级失败；130 第一次中断已处理并结束
 * start/resume（中断导致 Run failed 时优先于 1）。
 *
 * CLI 失败同时输出稳定 errorCode（经脱敏），绝不透传工具原始退出码。
 */
import { ApexError, isApexError } from '../../domain/errors.js';
import type { RunJson } from '../../domain/schemas/run-json.js';
import { parseCliArgs, type CliCommand } from './args.js';
import { HELP_TEXT } from './help.js';
import { renderStatus } from './status-render.js';
import type { CliRuntime } from './runtime.js';

export const CLI_EXIT = {
  ok: 0,
  runFailed: 1,
  usage: 2,
  startup: 3,
  command: 4,
  interrupted: 130,
} as const;

function printError(runtime: CliRuntime, error: ApexError): void {
  /*
   * 错误摘要按“结论 → 分类 → 原因”分层输出。
   * 稳定 errorCode 保持在首行便于搜索，动态详情逐行脱敏，避免单个超长句
   * 同时承担用户提示和机器诊断两种职责。
   */
  for (const line of [
    `✗ 命令失败 · ${error.errorCode}`,
    `  类型 ${error.errorClass} · 阶段 ${error.stage}`,
    `  原因 ${error.message}`,
  ]) {
    runtime.stderr(runtime.redaction.redactText(line));
  }
}

/**
 * start/resume 的统一终态失败摘要。
 *
 * 入参只依赖 ErrorRecord 与 ApexError 共有的稳定字段，避免 CLI 为了打印
 * 已持久化事实而反向构造异常对象。
 */
function printRunFailed(
  runtime: CliRuntime,
  runId: string,
  error: Pick<ApexError, 'errorCode' | 'stage' | 'message'> | null,
): void {
  const errorCode = error?.errorCode ?? 'unknown';
  /*
   * RUN_INTERRUPTED 的持久化状态仍是 failed，但用户主动中断不是执行缺陷。
   * 这里只改变展示语义，不引入新的领域状态或改变既有恢复协议。
   */
  const heading =
    errorCode === 'RUN_INTERRUPTED'
      ? `◇ Run ${runId} 已中断 · ${errorCode}`
      : `✗ Run ${runId} 失败 · ${errorCode}`;
  runtime.stderr(runtime.redaction.redactText(heading));
  if (error !== null) {
    runtime.stderr(
      runtime.redaction.redactText(`  阶段 ${error.stage} · 原因 ${error.message}`),
    );
  }
}

/**
 * 终态失败只有在领域层持久化了恢复点时才展示续接命令。
 *
 * 这同时覆盖用户中断、Claude 回合预算耗尽和已启动进程的非零退出。
 *
 * 提示只表达“可以由用户再次显式执行”；它不会让当前命令自动重试。
 * 即使非零退出来自鉴权、网络或额度，用户也可先修复外部条件再恢复，
 * transcript 不存在时仍由统一的续接不可用协议创建一趟全新会话。
 */
function printRunResumeHint(runtime: CliRuntime, run: Pick<RunJson, 'resumePoint'>): void {
  if (run.resumePoint === null) return;
  runtime.stderr(runtime.redaction.redactText('  恢复 ApexCodingAgent resume'));
}

/**
 * 仓库级命令的错误边界（SPEC §15.2、G6 退出码矩阵）。
 *
 * 已有 command_error 保留其精确稳定码；适配器的 startup/git/state 等
 * 错误不得穿透查询命令边界，否则会错误表达“Run 应进入 failed”。
 */
function asCommandError(
  stage: string,
  error: unknown,
  fallbackCode: 'COMMAND_STATE_INVALID' | 'REPORT_COMMAND_FAILED' = 'COMMAND_STATE_INVALID',
): ApexError {
  if (isApexError(error) && error.errorClass === 'command_error') return error;
  return new ApexError({
    code: fallbackCode,
    stage,
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  });
}

async function runStart(
  command: Extract<CliCommand, { kind: 'start' }>,
  runtime: CliRuntime,
): Promise<number> {
  // §2.4：信号语义只属于前台 start；第一次中断转发给中断控制器。
  const disposeSignals = runtime.installSignals({
    onFirstInterrupt: () => runtime.interrupt.request(),
  });
  try {
    const result = await runtime.startRun.execute({
      cwd: runtime.cwd,
      specPath: command.specPath,
      fullAccess: command.fullAccess,
      claudeCliPath: command.claudeCliPath,
      gitCliPath: command.gitCliPath,
      pushRemote: command.pushRemote,
      verbose: command.verbose,
      environment: runtime.environment,
    });
    if (result.kind === 'completed') {
      /*
       * RunDriver 已在最终状态提交后输出唯一成功摘要。
       * CLI 这里只映射退出码，避免同一个完成事实连续打印两次。
       */
      return CLI_EXIT.ok;
    }
    if (result.kind === 'failed') {
      const lastError = result.run.lastError;
      printRunFailed(runtime, result.run.runId, lastError);
      printRunResumeHint(runtime, result.run);
      // §17：中断导致 Run 持久化为 failed 时退出码 130，优先于 1。
      if (lastError?.errorCode === 'RUN_INTERRUPTED') {
        return CLI_EXIT.interrupted;
      }
      return CLI_EXIT.runFailed;
    }
    printError(runtime, result.error);
    return CLI_EXIT.startup;
  } catch (error) {
    // StartRun 已尽力持久化失败事实；这里只兜底表面化稳定码。
    const apex = isApexError(error)
      ? error
      : new ApexError({
          code: 'STATE_VALIDATION_FAILED',
          stage: 'start',
          message: error instanceof Error ? error.message : String(error),
          cause: error,
        });
    printError(runtime, apex);
    return apex.errorClass === 'startup_validation' ? CLI_EXIT.startup : CLI_EXIT.runFailed;
  } finally {
    disposeSignals();
  }
}

async function runResume(
  command: Extract<CliCommand, { kind: 'resume' }>,
  runtime: CliRuntime,
): Promise<number> {
  // §2.4 中断语义对 resume 同样生效：第一次中断转发给中断控制器。
  const disposeSignals = runtime.installSignals({
    onFirstInterrupt: () => runtime.interrupt.request(),
  });
  try {
    const result = await runtime.resume.execute({
      cwd: runtime.cwd,
      fullAccess: command.fullAccess,
      force: command.force,
      claudeCliPath: command.claudeCliPath,
      gitCliPath: command.gitCliPath,
      verbose: command.verbose,
      environment: runtime.environment,
    });
    if (result.kind === 'completed') {
      return CLI_EXIT.ok;
    }
    if (result.kind === 'failed') {
      const lastError = result.run.lastError;
      printRunFailed(runtime, result.run.runId, lastError);
      printRunResumeHint(runtime, result.run);
      if (lastError?.errorCode === 'RUN_INTERRUPTED') {
        return CLI_EXIT.interrupted;
      }
      return CLI_EXIT.runFailed;
    }
    printError(runtime, result.error);
    if (result.kind === 'startup-failed') return CLI_EXIT.startup;
    // command-failed：按错误类别映射（startup_validation 视为前置校验失败）。
    return result.error.errorClass === 'startup_validation' ? CLI_EXIT.startup : CLI_EXIT.command;
  } catch (error) {
    const apex = isApexError(error)
      ? error
      : new ApexError({
          code: 'COMMAND_STATE_INVALID',
          stage: 'resume',
          message: error instanceof Error ? error.message : String(error),
          cause: error,
        });
    printError(runtime, apex);
    return CLI_EXIT.command;
  } finally {
    disposeSignals();
  }
}

async function runStatus(runtime: CliRuntime): Promise<number> {
  try {
    let result;
    try {
      result = await runtime.status.execute();
    } catch (error) {
      if (isApexError(error) && error.errorCode === 'STATE_VALIDATION_FAILED') {
        throw new ApexError({
          code: 'COMMAND_STATE_INVALID',
          stage: 'status',
          message: `run state is not a strictly valid consistent snapshot: ${error.message}`,
          cause: error,
        });
      }
      throw error;
    }
    /**
     * status 严格限定在当前 Git 仓库内，不跨目录猜测其他 Run。未找到时把组合根
     * 已解析出的仓库根带入诊断，直接消除“状态丢失”和“查错仓库”的歧义。
     */
    if (result.kind === 'not_found') {
      throw new ApexError({
        code: 'RUN_NOT_FOUND',
        stage: 'status',
        message:
          `仓库 ${result.repositoryRoot} 中不存在 .apex-coding-agent/run.json；` +
          '请切换到目标 Run 所在的仓库后重试',
      });
    }
    for (const line of renderStatus(result.snapshot, result.git)) {
      runtime.stdout(runtime.redaction.redactText(line));
    }
    return CLI_EXIT.ok;
  } catch (error) {
    printError(runtime, asCommandError('status', error));
    return CLI_EXIT.command;
  }
}

async function runReport(runtime: CliRuntime): Promise<number> {
  try {
    const result = await runtime.report.execute();
    runtime.stdout(runtime.redaction.redactText(`✓ 报告已生成 · ${result.reportPath}`));
    return CLI_EXIT.ok;
  } catch (error) {
    printError(runtime, asCommandError('report', error, 'REPORT_COMMAND_FAILED'));
    return CLI_EXIT.command;
  }
}

async function runAbandon(
  command: Extract<CliCommand, { kind: 'abandon' }>,
  runtime: CliRuntime,
): Promise<number> {
  try {
    const result = await runtime.abandon.execute({ force: command.force });
    runtime.stdout(
      runtime.redaction.redactText(`✓ Run ${result.run.runId} 已放弃`),
    );
    return CLI_EXIT.ok;
  } catch (error) {
    printError(runtime, asCommandError('abandon', error));
    return CLI_EXIT.command;
  }
}

export async function runCli(argv: readonly string[], runtime: CliRuntime): Promise<number> {
  let command: CliCommand;
  try {
    command = parseCliArgs(argv);
  } catch (error) {
    printError(
      runtime,
      isApexError(error)
        ? error
        : new ApexError({
            code: 'CLI_USAGE_INVALID',
            stage: 'cli',
            message: error instanceof Error ? error.message : String(error),
            cause: error,
          }),
    );
    runtime.stderr(HELP_TEXT);
    return CLI_EXIT.usage;
  }

  switch (command.kind) {
    case 'help':
      runtime.stdout(HELP_TEXT);
      return CLI_EXIT.ok;
    case 'start':
      return runStart(command, runtime);
    case 'resume':
      return runResume(command, runtime);
    case 'status':
      return runStatus(runtime);
    case 'report':
      return runReport(runtime);
    case 'abandon':
      return runAbandon(command, runtime);
  }
}
