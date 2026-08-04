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
import {
  renderCommandError,
  renderCommandHeader,
  renderCommandSuccess,
  renderRunCommandFailure,
  type ExecutableCommandKind,
} from './command-presentation.js';

export const CLI_EXIT = {
  ok: 0,
  runFailed: 1,
  usage: 2,
  startup: 3,
  command: 4,
  interrupted: 130,
} as const;

/** 所有命令级文本逐行脱敏后写入指定 Sink。 */
function printLines(
  runtime: CliRuntime,
  sink: 'stdout' | 'stderr',
  lines: readonly string[],
): void {
  for (const line of lines) {
    runtime[sink](runtime.redaction.redactText(line));
  }
}

function printError(
  runtime: CliRuntime,
  kind: ExecutableCommandKind | null,
  error: ApexError,
): void {
  /*
   * 命令失败同样经过统一终态呈现模型；稳定 errorCode 保持在标题行，
   * 分类、阶段与原因作为次级事实，不再由每个命令独立拼接。
   */
  printLines(runtime, 'stderr', renderCommandError(kind, error));
}

/**
 * start/resume 的统一终态失败摘要。
 *
 * 入参只依赖 ErrorRecord 与 ApexError 共有的稳定字段，避免 CLI 为了打印
 * 已持久化事实而反向构造异常对象。
 */
function printRunFailed(
  runtime: CliRuntime,
  kind: 'start' | 'resume',
  runId: string,
  error: Pick<ApexError, 'errorCode' | 'stage' | 'message'> | null,
): void {
  /*
   * RUN_INTERRUPTED 的持久化状态仍是 failed；呈现模型只改变用户语义，
   * 不引入领域状态。Run ID 与失败阶段来自同一次用例返回值。
   */
  printLines(
    runtime,
    'stderr',
    renderRunCommandFailure({ kind, runId, error }),
  );
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
      printLines(runtime, 'stdout', renderCommandSuccess({ kind: 'start', run: result.run }));
      return CLI_EXIT.ok;
    }
    if (result.kind === 'failed') {
      const lastError = result.run.lastError;
      printRunFailed(runtime, 'start', result.run.runId, lastError);
      printRunResumeHint(runtime, result.run);
      // §17：中断导致 Run 持久化为 failed 时退出码 130，优先于 1。
      if (lastError?.errorCode === 'RUN_INTERRUPTED') {
        return CLI_EXIT.interrupted;
      }
      return CLI_EXIT.runFailed;
    }
    printError(runtime, 'start', result.error);
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
    printError(runtime, 'start', apex);
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
      printLines(runtime, 'stdout', renderCommandSuccess({ kind: 'resume', run: result.run }));
      return CLI_EXIT.ok;
    }
    if (result.kind === 'failed') {
      const lastError = result.run.lastError;
      printRunFailed(runtime, 'resume', result.run.runId, lastError);
      printRunResumeHint(runtime, result.run);
      if (lastError?.errorCode === 'RUN_INTERRUPTED') {
        return CLI_EXIT.interrupted;
      }
      return CLI_EXIT.runFailed;
    }
    printError(runtime, 'resume', result.error);
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
    printError(runtime, 'resume', apex);
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
    printLines(
      runtime,
      'stdout',
      renderCommandSuccess({ kind: 'status', run: result.snapshot.run }),
    );
    return CLI_EXIT.ok;
  } catch (error) {
    printError(runtime, 'status', asCommandError('status', error));
    return CLI_EXIT.command;
  }
}

async function runReport(runtime: CliRuntime): Promise<number> {
  try {
    const result = await runtime.report.execute();
    printLines(
      runtime,
      'stdout',
      renderCommandSuccess({
        kind: 'report',
        runId: result.runId,
        reportPath: result.reportPath,
      }),
    );
    return CLI_EXIT.ok;
  } catch (error) {
    printError(
      runtime,
      'report',
      asCommandError('report', error, 'REPORT_COMMAND_FAILED'),
    );
    return CLI_EXIT.command;
  }
}

async function runAbandon(
  command: Extract<CliCommand, { kind: 'abandon' }>,
  runtime: CliRuntime,
): Promise<number> {
  try {
    const result = await runtime.abandon.execute({ force: command.force });
    printLines(
      runtime,
      'stdout',
      renderCommandSuccess({ kind: 'abandon', run: result.run }),
    );
    return CLI_EXIT.ok;
  } catch (error) {
    printError(runtime, 'abandon', asCommandError('abandon', error));
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
      null,
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

  if (command.kind !== 'help') {
    /*
     * 参数成功解析后立即输出统一首屏；后续即使环境门禁拒绝，用户仍能看到
     * 确切版本、命令意图和调用目录。动态内容逐行经过同一脱敏边界。
     */
    printLines(
      runtime,
      'stdout',
      renderCommandHeader(command, {
        agentVersion: runtime.environment.agentVersion,
        cwd: runtime.cwd,
      }),
    );
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
