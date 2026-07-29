/**
 * ResumeRun 命令用例（SPEC §17 resume、§2.4 中断恢复）。
 *
 * 本用例只负责顶层编排，具体职责分布如下：
 * - resume-state：状态目录发现、资格判定和纯重开转换；
 * - GitPort.assertResumePosition：首次写入前的完整只读仓库校验；
 * - orphaned-session-reconciler：崩溃残留事实统一收尾；
 * - RunDriver：三类 Session 的一次性续接提示与终态驱动。
 *
 * 恢复点只在全部前置校验成功后的唯一 run.json 提交点被消费。任何可修复
 * 的配置或 Git 冲突发生时，原 Run 与 resumePoint 均保持不变。
 */
import { ApexError, isApexError } from '../../domain/errors.js';
import type { RunJson } from '../../domain/schemas/run-json.js';
import { formatRfc3339Utc } from '../../domain/time.js';
import { createRunDriver } from '../run-driver.js';
import { createNullLogger, type LoggerPort } from '../ports/logger.js';
import type { RunCommandDeps } from '../run-command-deps.js';
import type { UseCaseDeps } from '../usecase-deps.js';
import { sameWindowsPath } from '../windows-path.js';
import { sessionGitFacts } from './claude-session.js';
import { reconcileOrphanedSessionFacts } from './orphaned-session-reconciler.js';
import {
  classifyResumeRun,
  discoverResumeState,
  reopenRun,
  type ResumeClassification,
} from './resume-state.js';
import {
  assertEnvironmentSupported,
  assertStateDirectoryWritable,
  probeClaudeCapabilities,
  reportApexVersion,
  type EnvironmentFacts,
} from './run-runtime-preflight.js';
import {
  createRunHeartbeat,
  readOwnerLiveness,
  type OwnerLiveness,
  type RunHeartbeat,
} from './run-heartbeat.js';
import { loadSettings } from './settings.js';
import { persistRunBestEffort, toTerminalFailedRun } from './run-transitions.js';

export interface ResumeRunInput {
  /** 命令调用目录。 */
  readonly cwd: string;
  /** 原 Run 为 bypassPermissions 时必须再次显式授权。 */
  readonly fullAccess: boolean;
  /** 接管崩溃残留的非终态 Run 时必须显式提供。 */
  readonly force: boolean;
  readonly claudeCliPath: string | null;
  readonly gitCliPath: string | null;
  readonly verbose: boolean;
  readonly environment: EnvironmentFacts;
}

export type ResumeRunResult =
  | { readonly kind: 'completed'; readonly run: RunJson }
  | { readonly kind: 'failed'; readonly run: RunJson }
  | { readonly kind: 'startup-failed'; readonly error: ApexError }
  | { readonly kind: 'command-failed'; readonly error: ApexError };

interface PreparedResume {
  readonly bound: UseCaseDeps;
  readonly run: RunJson;
  readonly classification: ResumeClassification;
  readonly validatedHead: string;
}

function asApexError(error: unknown, stage: string): ApexError {
  return isApexError(error)
    ? error
    : new ApexError({
        code: 'STATE_WRITE_FAILED',
        stage,
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      });
}

/**
 * 接管崩溃残留 Run 时的前台提示：有确切崩溃依据时平铺直叙，其余形态
 * 保持人工确认风险的警告语义（§17 resume、§2.4）。
 */
function takeoverWarning(run: RunJson, liveness: OwnerLiveness | null): string {
  switch (liveness?.kind) {
    case 'presumed_dead':
      return (
        `run ${run.runId} 的属主进程已 ${Math.round(liveness.ageMs / 1000)} 秒未发送存活信号，` +
        '判定为崩溃离场；按崩溃事实接管并继续。resume 不终止任何进程。'
      );
    case 'active':
      return (
        `警告：run ${run.runId} 的属主进程在 ${Math.round(liveness.ageMs / 1000)} 秒前仍有存活信号；` +
        '请确认旧进程已停止，否则两个进程会并发写入仓库。resume 不终止任何进程。'
      );
    case 'unreadable':
      return (
        `警告：run ${run.runId} 的存活信号文件不可读，系统无法判断旧 Apex/Claude 进程是否仍然存在；` +
        '请确认旧进程不再写入仓库后再继续。resume 不终止任何进程。'
      );
    default:
      return (
        `警告：系统无法判断 run ${run.runId} 的旧 Apex/Claude 进程是否仍然存在；` +
        '请确认旧进程不再写入仓库后再继续。resume 不终止任何进程。'
      );
  }
}

export function createResumeRun(deps: RunCommandDeps): {
  execute(input: ResumeRunInput): Promise<ResumeRunResult>;
} {
  const now = (): string => formatRfc3339Utc(deps.clock.now());
  let logger: LoggerPort = createNullLogger();
  /** 接管成功后的前台属主存活信号；进程收尾前停止。 */
  let heartbeat: RunHeartbeat | null = null;

  function commandError(error: ApexError): ResumeRunResult {
    logger.log('error', 'resume.command_failed', {
      errorCode: error.errorCode,
      stage: error.stage,
      message: error.message,
    });
    return { kind: 'command-failed', error };
  }

  function startupError(error: unknown): ResumeRunResult {
    const apex = asApexError(error, 'startup');
    logger.log('error', 'resume.startup_failed', {
      errorCode: apex.errorCode,
      stage: apex.stage,
      message: apex.message,
    });
    return { kind: 'startup-failed', error: apex };
  }

  /**
   * 读取原 Run 后再绑定运行时端口。
   *
   * 路径优先级为：本次显式参数 > 原 Run 快照 > 当前 settings.json >
   * PATH 默认。这样自定义 CLI 启动的 Run 无需重复传参，同时仍允许用户
   * 显式修复已失效的可执行路径。
   */
  async function prepare(input: ResumeRunInput): Promise<PreparedResume | ResumeRunResult> {
    // 与 start 一致：横幅先行，环境门禁拒绝时也保留版本事实。
    reportApexVersion(deps.output, deps.redaction, input.environment.agentVersion);
    try {
      assertEnvironmentSupported(input.environment);
    } catch (error) {
      return startupError(error);
    }

    let discovered;
    try {
      discovered = await discoverResumeState(
        deps.fileSystem,
        deps.makeStateStore,
        input.cwd,
      );
    } catch (error) {
      const apex = asApexError(error, 'resume');
      return apex.errorClass === 'command_error' ? commandError(apex) : startupError(apex);
    }
    const { root, stateDir, run } = discovered;
    logger = deps.makeLogger({ stateDir, verbose: input.verbose });

    let classification: ResumeClassification;
    try {
      // §2.4：先判定属主存活性，再决定接管是否需要显式 --force。
      const liveness = await readOwnerLiveness(discovered.stateStore, deps.clock, run.runId);
      logger.log('debug', 'resume.owner_liveness', {
        runId: run.runId,
        status: run.status,
        liveness: liveness.kind,
        force: input.force,
      });
      classification = classifyResumeRun(run, input.force, liveness);
    } catch (error) {
      return commandError(asApexError(error, 'resume'));
    }
    if (run.runSettings.executionPermissionMode === 'bypassPermissions' && !input.fullAccess) {
      return commandError(
        new ApexError({
          code: 'SETTINGS_INVALID',
          stage: 'resume',
          message:
            'run settings carry bypassPermissions; pass --full-access explicitly to resume this run',
        }),
      );
    }

    let bound: UseCaseDeps;
    try {
      const settings = await loadSettings(deps.fileSystem, stateDir);
      const claudeCliPath =
        input.claudeCliPath ?? run.runSettings.claudeCliPath ?? settings?.claudeCliPath ?? null;
      const gitCliPath =
        input.gitCliPath ?? run.runSettings.gitCliPath ?? settings?.gitCliPath ?? null;
      logger.log('debug', 'resume.settings_resolved', {
        settingsFound: settings !== null,
        claudeCliPath,
        gitCliPath,
        force: input.force,
        verbose: input.verbose,
      });

      const git = deps.makeGitPort(gitCliPath);
      await git.assertAvailable();
      const resolvedRoot = await git.resolveRepositoryRoot(input.cwd);
      if (!sameWindowsPath(resolvedRoot, root)) {
        throw new ApexError({
          code: 'COMMAND_STATE_INVALID',
          stage: 'resume',
          message:
            `configured Git resolved repository root ${resolvedRoot}, ` +
            `but run.json belongs to ${root}`,
        });
      }

      const claude = deps.makeClaudePort(claudeCliPath);
      const capabilityReport = await probeClaudeCapabilities(
        claude,
        deps.output,
        deps.redaction,
        logger,
        'resume',
        claudeCliPath,
      );
      await assertStateDirectoryWritable(deps.fileSystem, stateDir);
      bound = deps.makeBoundDeps({
        stateDir,
        git,
        claude,
        capabilityReport,
        logger,
      });
    } catch (error) {
      const apex = asApexError(error, 'startup');
      return apex.errorCode === 'COMMAND_STATE_INVALID'
        ? commandError(apex)
        : startupError(apex);
    }

    /**
     * 完整 Git 预检必须发生在任何 Session Record 或 run.json 写入之前。
     * Planning 严格只读；Execution/Final Review 的活动 Session 可以保留
     * expectedHead 之上的安全提交。
     */
    try {
      if (
        classification.point.fromStatus === 'planning' &&
        classification.point.sessionId !== null
      ) {
        await bound.git.assertWorkingTreeClean(root, run.spec.path);
      }
      const position = await bound.git.assertResumePosition(
        root,
        sessionGitFacts(run),
        {
          allowAdvancedHead:
            classification.point.sessionId !== null &&
            classification.point.fromStatus !== 'planning',
        },
      );
      return {
        bound,
        run,
        classification,
        validatedHead: position.currentHead,
      };
    } catch (error) {
      return commandError(asApexError(error, 'resume'));
    }
  }

  async function drivePrepared(
    prepared: PreparedResume,
    force: boolean,
  ): Promise<ResumeRunResult> {
    const { bound, run, classification, validatedHead } = prepared;
    let reconciled = run;
    if (classification.requiresOrphanReconciliation) {
      /**
       * 免 --force 接管完全依赖"崩溃离场"判定；判定之后经历了能力探测与
       * Git 预检（秒级窗口），一个恰好苏醒的旧进程可能已重新发送信号。
       * 写入任何接管事实前复核一次，发现新鲜/不可读信号立即退回人工确认。
       * 显式 --force 是用户的人工断言，跳过复核。
       */
      if (!force) {
        const recheck = await readOwnerLiveness(bound.stateStore, deps.clock, run.runId);
        if (recheck.kind === 'active' || recheck.kind === 'unreadable') {
          return commandError(
            new ApexError({
              code: 'RESUME_REQUIRES_FORCE',
              stage: 'resume',
              message:
                `run ${run.runId} sent a fresh heartbeat while resume was preparing; ` +
                'a live process may have taken over — resume requires the explicit --force flag',
            }),
          );
        }
      }
      deps.output.writeLine(
        deps.redaction.redactText(takeoverWarning(run, classification.liveness)),
      );
      const orphaned = new ApexError({
        code: 'RUN_INTERRUPTED',
        stage: 'resume',
        message:
          `run ${run.runId} taken over by resume${force ? ' --force' : ''} after coordinator loss`,
        sessionId: run.activeSession?.sessionId ?? null,
        taskId: run.currentTaskId,
      });
      try {
        reconciled = await reconcileOrphanedSessionFacts(bound, run, orphaned);
      } catch (error) {
        return commandError(asApexError(error, 'resume'));
      }
    }

    let reopened: RunJson;
    try {
      reopened = reopenRun(run, reconciled, classification.point, validatedHead, now());
      await bound.stateStore.writeRun(reopened);
    } catch (error) {
      return commandError(asApexError(error, 'resume'));
    }
    // 接管提交点落盘后，本进程成为新的前台属主，开始发送存活信号。
    heartbeat = createRunHeartbeat({
      stateStore: bound.stateStore,
      clock: deps.clock,
      runId: run.runId,
      logger,
      scheduleInterval: deps.scheduleInterval,
    });
    heartbeat.start();
    deps.output.writeLine(
      deps.redaction.redactText(
        `↻ Run ${run.runId} 已恢复 · ${run.status} → ${classification.point.fromStatus}`,
      ),
    );
    logger.log('debug', 'resume.reopened', {
      runId: run.runId,
      from: run.status,
      to: classification.point.fromStatus,
      resumeTaskId: classification.point.taskId,
      resumeSessionId: classification.point.sessionId,
      expectedHead: validatedHead,
    });

    const driver = createRunDriver(bound, { resume: classification.point });
    try {
      const terminal = await driver.driveToTerminal();
      return terminal.status === 'completed'
        ? { kind: 'completed', run: terminal }
        : { kind: 'failed', run: terminal };
    } catch (error) {
      const apex = asApexError(error, 'driver');
      logger.log('error', 'resume.driver_error', {
        runId: run.runId,
        errorCode: apex.errorCode,
        message: apex.message,
        stack: apex.stack ?? null,
      });
      const latest = await bound.stateStore.readRun().catch(() => null);
      if (latest !== null && latest.status !== 'completed' && latest.status !== 'failed' && latest.status !== 'abandoned') {
        const terminal = toTerminalFailedRun(latest, apex, now(), deps.redaction);
        await persistRunBestEffort(bound, terminal);
        return { kind: 'failed', run: terminal };
      }
      if (latest?.status === 'completed') return { kind: 'completed', run: latest };
      if (latest !== null) return { kind: 'failed', run: latest };
      throw apex;
    }
  }

  return {
    async execute(input: ResumeRunInput): Promise<ResumeRunResult> {
      try {
        const prepared = await prepare(input);
        return 'kind' in prepared ? prepared : await drivePrepared(prepared, input.force);
      } finally {
        // 存活信号随前台进程收尾停止；文件保留为最后一次已知存活时间。
        heartbeat?.close();
        heartbeat = null;
        await logger.flush();
      }
    },
  };
}
