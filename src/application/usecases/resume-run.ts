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
  type EnvironmentFacts,
} from './run-runtime-preflight.js';
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

/** Windows 路径比较只用于验证 Git 与状态发现得到的是同一仓库。 */
function sameWindowsPath(left: string, right: string): boolean {
  const normalize = (value: string): string =>
    value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return normalize(left) === normalize(right);
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

export function createResumeRun(deps: RunCommandDeps): {
  execute(input: ResumeRunInput): Promise<ResumeRunResult>;
} {
  const now = (): string => formatRfc3339Utc(deps.clock.now());
  let logger: LoggerPort = createNullLogger();

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
      classification = classifyResumeRun(run, input.force);
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

  async function drivePrepared(prepared: PreparedResume): Promise<ResumeRunResult> {
    const { bound, run, classification, validatedHead } = prepared;
    let reconciled = run;
    if (classification.requiresOrphanReconciliation) {
      deps.output.writeLine(
        deps.redaction.redactText(
          `警告：系统无法判断 run ${run.runId} 的旧 Apex/Claude 进程是否仍然存在；` +
            '请确认旧进程不再写入仓库后再继续。resume 不终止任何进程。',
        ),
      );
      const orphaned = new ApexError({
        code: 'RUN_INTERRUPTED',
        stage: 'resume',
        message: `run ${run.runId} taken over by resume --force after coordinator loss`,
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
    deps.output.writeLine(
      deps.redaction.redactText(
        `[apex] run ${run.runId} resumed (${run.status} -> ${classification.point.fromStatus})`,
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
        return 'kind' in prepared ? prepared : await drivePrepared(prepared);
      } finally {
        await logger.flush();
      }
    },
  };
}
