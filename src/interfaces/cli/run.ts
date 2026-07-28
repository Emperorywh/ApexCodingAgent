/**
 * CLI 命令分发与退出码映射（SPEC §17、§15.2 command_error、§2.4）。
 *
 * 退出码：0 成功；1 start 的 Run 正常持久化为 failed；2 用法错误
 * （CLI_USAGE_INVALID）；3 启动前置校验失败（未创建新 Run）；4
 * status/report/abandon 命令失败；130 第一次中断已处理并结束 start
 * （中断导致 Run failed 时优先于 1）。
 *
 * CLI 失败同时输出稳定 errorCode（经脱敏），绝不透传工具原始退出码。
 */
import { ApexError, isApexError } from '../../domain/errors.js';
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
  runtime.stderr(
    runtime.redaction.redactText(
      `[apex] error ${error.errorCode} (${error.errorClass}, stage ${error.stage}): ${error.message}`,
    ),
  );
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
      verbose: command.verbose,
      environment: runtime.environment,
    });
    if (result.kind === 'completed') {
      runtime.stdout(
        runtime.redaction.redactText(
          `[apex] run ${result.run.runId} completed (report ${result.run.reportPath ?? 'report.md'})`,
        ),
      );
      return CLI_EXIT.ok;
    }
    if (result.kind === 'failed') {
      const lastError = result.run.lastError;
      runtime.stderr(
        runtime.redaction.redactText(
          `[apex] run ${result.run.runId} failed` +
            (lastError === null
              ? ''
              : ` ${lastError.errorCode} (${lastError.stage}): ${lastError.message}`),
        ),
      );
      // §17：中断导致 Run 持久化为 failed 时退出码 130，优先于 1。
      return lastError?.errorCode === 'RUN_INTERRUPTED'
        ? CLI_EXIT.interrupted
        : CLI_EXIT.runFailed;
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
    if (result === null) {
      throw new ApexError({
        code: 'RUN_NOT_FOUND',
        stage: 'status',
        message: 'no run.json exists; nothing to show',
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
    runtime.stdout(runtime.redaction.redactText(`[apex] report written: ${result.reportPath}`));
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
      runtime.redaction.redactText(`[apex] run ${result.run.runId} -> abandoned`),
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
    case 'status':
      return runStatus(runtime);
    case 'report':
      return runReport(runtime);
    case 'abandon':
      return runAbandon(command, runtime);
  }
}
