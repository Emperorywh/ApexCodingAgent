/**
 * StartRun 用例（SPEC §8.1 启动检查、§8.2 创建顺序、§16 配置优先级、§4.4
 * 归档前置）：从零配置到前台 Run 终态的完整入口（CLI 由 G6 绑定）。
 *
 * 失败语义（§8.2）：
 * - 启动检查与创建步骤 1–3 失败：不创建新 Run（startup-failed）；
 * - 步骤 4（初始 run.json 写入）失败：STATE_WRITE_FAILED，不声称存在新 Run；
 * - 步骤 5 起失败：尽量把诊断写入 run.json，当前 Run 转 failed。
 * 不修改 Base Branch 引用，不自动回滚已完成的文件或 Git 操作。
 *
 * 配置优先级（§16）：显式 CLI 参数 > settings.json > 内置默认；
 * bypassPermissions 只能显式启用且必须显示风险提示；最终配置快照进
 * run.json.runSettings，Run 期间不重载。
 */
import { ApexError, isApexError } from '../../domain/errors.js';
import { formatRfc3339Utc } from '../../domain/time.js';
import type { RunJson } from '../../domain/schemas/run-json.js';
import type { ExecutionPermissionMode } from '../../domain/schemas/settings-json.js';
import type { ClaudeRuntimePort } from '../ports/ClaudeRuntimePort.js';
import type { GitPort } from '../ports/GitPort.js';
import type { LoggerPort } from '../ports/logger.js';
import type { RunCommandDeps } from '../run-command-deps.js';
import { createRunDriver } from '../run-driver.js';
import type { UseCaseDeps } from '../usecase-deps.js';
import { loadSettings } from './settings.js';
import { persistRunBestEffort, toTerminalFailedRun } from './run-transitions.js';
import { createNullLogger } from '../ports/logger.js';
import {
  assertEnvironmentSupported,
  assertStateDirectoryWritable,
  probeClaudeCapabilities,
  type EnvironmentFacts,
} from './run-runtime-preflight.js';

export interface StartRunInput {
  /** 命令调用目录。 */
  readonly cwd: string;
  /** 显式 SPEC 路径；null 表示默认发现。 */
  readonly specPath: string | null;
  /** 显式 --full-access（Execution/Final Review 使用 bypassPermissions）。 */
  readonly fullAccess: boolean;
  /** 显式 --claude-cli-path；null 表示未提供。 */
  readonly claudeCliPath: string | null;
  /** 显式 --git-cli-path；null 表示未提供。 */
  readonly gitCliPath: string | null;
  /** 显式 --verbose：调试日志（恒写 logs/apex-debug.log）同时镜像到 stderr。 */
  readonly verbose: boolean;
  readonly environment: EnvironmentFacts;
}

export type StartRunResult =
  | { readonly kind: 'completed'; readonly run: RunJson }
  /** Run 已持久化为 failed（含 RUN_INTERRUPTED 情形）。 */
  | { readonly kind: 'failed'; readonly run: RunJson }
  /** 启动前置校验失败，未创建新 Run。 */
  | { readonly kind: 'startup-failed'; readonly error: ApexError };

const STATE_DIR_NAME = '.apex-coding-agent';

export function createStartRun(deps: RunCommandDeps): {
  execute(input: StartRunInput): Promise<StartRunResult>;
} {
  const now = (): string => formatRfc3339Utc(deps.clock.now());

  /**
   * 调试日志在 stateDir 确定后由 makeLogger 装配；此前的失败由 CLI 错误面
   * 输出。注意上一终态 Run 归档会清空 logs/，归档前写入的行随旧 Run 归档。
   */
  let logger: LoggerPort = createNullLogger();

  async function executeInner(input: StartRunInput): Promise<StartRunResult> {
    // ---- §8.1 启动检查 + §8.2 步骤 1–4：任何失败都不创建新 Run ----
    let prepared: {
      readonly root: string;
      readonly stateDir: string;
      readonly git: GitPort;
      readonly claude: ClaudeRuntimePort;
      readonly bound: UseCaseDeps;
      readonly runId: string;
      readonly run: RunJson;
    };
    try {
      assertEnvironmentSupported(input.environment);

      // 先用 CLI 提供（或默认）的 Git 入口解析仓库与设置，再按 §16 优先级
      // 计算最终生效端口。
      const bootstrapGit = deps.makeGitPort(input.gitCliPath);
      await bootstrapGit.assertAvailable();
      const root = (await bootstrapGit.resolveRepositoryRoot(input.cwd)).replace(/\\/g, '/');
      const head = await bootstrapGit.readHead(root);
      const stateDir = `${root}/${STATE_DIR_NAME}`;

      const settings = await loadSettings(deps.fileSystem, stateDir);
      /**
       * TRACE §8 将完全权限绑定到“本次命令显式传入 --full-access”这一事实。
       * settings.json 可以保存默认 auto，但不得把一次历史配置升级成本次
       * Run 的隐式完全权限；发现该值时明确拒绝并指导用户重新显式授权。
       */
      if (!input.fullAccess && settings?.executionPermissionMode === 'bypassPermissions') {
        throw new ApexError({
          code: 'SETTINGS_INVALID',
          stage: 'settings',
          message:
            'settings.json cannot enable bypassPermissions; pass --full-access explicitly for this run',
        });
      }
      const executionPermissionMode: ExecutionPermissionMode = input.fullAccess
        ? 'bypassPermissions'
        : 'auto';
      const claudeCliPath = input.claudeCliPath ?? settings?.claudeCliPath ?? null;
      const gitCliPath = input.gitCliPath ?? settings?.gitCliPath ?? null;
      logger = deps.makeLogger({ stateDir, verbose: input.verbose });
      logger.log('debug', 'startup.settings_resolved', {
        settingsFound: settings !== null,
        executionPermissionMode,
        claudeCliPath,
        gitCliPath,
        verbose: input.verbose,
      });
      if (executionPermissionMode === 'bypassPermissions') {
        // §16：bypassPermissions 只能显式启用且必须显示风险提示。
        deps.output.writeLine(
          deps.redaction.redactText(
            '风险提示：已显式启用 bypassPermissions（--full-access）；Claude 将在无权限确认下直接修改仓库，请确保 SPEC 来源可信。',
          ),
        );
      }

      const git = gitCliPath === input.gitCliPath ? bootstrapGit : deps.makeGitPort(gitCliPath);
      if (git !== bootstrapGit) await git.assertAvailable();
      const claude = deps.makeClaudePort(claudeCliPath);

      // §8.1 第 4–5 项：版本与能力探测，缺失即停止，不走降级路径。
      const capabilityReport = await probeClaudeCapabilities(
        claude,
        deps.output,
        deps.redaction,
        logger,
        'startup',
        claudeCliPath,
      );

      // §8.1 第 2、9–11 项：SPEC 唯一可读非空、状态目录未跟踪、SPEC 未
      // staged、工作区干净（仅 SPEC 例外）。
      const spec = await git.resolveSpec(root, input.cwd, input.specPath);
      logger.log('debug', 'startup.spec_resolved', { path: spec.gitPath, sha256: spec.sha256 });
      await git.assertStateDirectoryUntracked(root);
      await git.assertSpecNotStaged(root, spec.gitPath);
      await git.assertWorkingTreeClean(root, spec.gitPath);

      const bound = deps.makeBoundDeps({ stateDir, git, claude, capabilityReport, logger });

      // §8.1 第 12 项 + §4.4：不存在非终态 Run；状态文件非法拒绝启动。
      let existing: RunJson | null;
      try {
        existing = await bound.stateStore.readRun();
      } catch (error) {
        if (isApexError(error) && error.errorCode === 'STATE_VALIDATION_FAILED') {
          throw new ApexError({
            code: 'STATE_INVALID',
            stage: 'startup',
            message: `existing state files failed validation: ${error.message}`,
            cause: error,
          });
        }
        throw error;
      }
      if (existing !== null && (existing.status === 'planning' || existing.status === 'running' || existing.status === 'final_review')) {
        throw new ApexError({
          code: 'RUN_ALREADY_ACTIVE_OR_INTERRUPTED',
          stage: 'startup',
          message:
            `run ${existing.runId} is ${existing.status}; inspect old processes and ` +
            'use resume --force to continue it or abandon --force before starting a new run',
        });
      }

      // §8.2 步骤 1：幂等排除状态目录（用真实 exclude 文件，不改 .gitignore）。
      await git.ensureStateDirectoryExcluded(root);

      // §8.2 步骤 2 + §8.1 第 13 项：创建运行目录并探测可写。
      await assertStateDirectoryWritable(deps.fileSystem, stateDir);

      // §8.2 步骤 3：最近 Run 已终态时先归档（失败即停止，不暴露半个新 Run）。
      if (existing !== null) {
        await bound.archiver.archiveTerminalRun(existing);
        logger.log('debug', 'startup.previous_run_archived', {
          runId: existing.runId,
          status: existing.status,
        });
      }

      // §8.2 步骤 4：创建 planning 状态的 run.json。
      const runId = `RUN-${globalThis.crypto.randomUUID()}`;
      const baseBranch = head.branch!;
      const initialRun: RunJson = {
        schemaVersion: 1,
        stateRevision: 1,
        runId,
        status: 'planning',
        spec: { path: spec.gitPath, sha256: spec.sha256 },
        planRevision: 0,
        tasksSha256: null,
        runSettings: { executionPermissionMode, claudeCliPath, gitCliPath },
        repository: {
          root,
          baseBranch,
          baseBranchRef: `refs/heads/${baseBranch}`,
          baseCommit: head.oid,
          runBranch: `apex-coding-agent/${runId}`,
          expectedHead: head.oid,
        },
        currentTaskId: null,
        activeSession: null,
        tasks: {},
        intermediateCheckpoints: [],
        finalReviewEpisodes: [],
        lastError: null,
        finalCommit: null,
        reportPath: null,
        resumePoint: null,
        createdAt: now(),
        updatedAt: now(),
        terminalAt: null,
      };
      try {
        await bound.stateStore.writeRun(initialRun);
      } catch (error) {
        // 步骤 4：STATE_WRITE_FAILED，不声称存在新 Run。
        throw isApexError(error)
          ? error
          : new ApexError({
              code: 'STATE_WRITE_FAILED',
              stage: 'startup',
              message: error instanceof Error ? error.message : String(error),
              cause: error,
            });
      }
      logger.log('debug', 'run.created', {
        runId,
        specPath: initialRun.spec.path,
        baseBranch: initialRun.repository.baseBranch,
        runBranch: initialRun.repository.runBranch,
      });
      prepared = { root, stateDir, git, claude, bound, runId, run: initialRun };
    } catch (error) {
      const startupError = isApexError(error)
        ? (error as ApexError)
        : new ApexError({
            code: 'STATE_WRITE_FAILED',
            stage: 'startup',
            message: error instanceof Error ? error.message : String(error),
            cause: error,
          });
      logger.log('error', 'startup.failed', {
        errorCode: startupError.errorCode,
        stage: startupError.stage,
        message: startupError.message,
      });
      return {
        kind: 'startup-failed',
        error: startupError,
      };
    }

    // ---- §8.2 步骤 5 起：失败时尽量写诊断，Run 转 failed ----
    const { root, bound, runId } = prepared;
    let run = prepared.run;
    try {
      const runBranch = await prepared.git.createRunBranch(root, runId);
      run = {
        ...run,
        repository: { ...run.repository, runBranch },
        stateRevision: run.stateRevision + 1,
        updatedAt: now(),
      };
      await bound.stateStore.writeRun(run);
      logger.log('debug', 'run.branch_created', { runId, runBranch });
    } catch (error) {
      const apex = isApexError(error)
        ? (error as ApexError)
        : new ApexError({
            code: 'GIT_COMMAND_FAILED',
            stage: 'startup',
            message: error instanceof Error ? error.message : String(error),
            cause: error,
          });
      logger.log('error', 'run.branch_failed', {
        runId,
        errorCode: apex.errorCode,
        message: apex.message,
      });
      const terminal = toTerminalFailedRun(run, apex, now(), deps.redaction);
      await persistRunBestEffort(bound, terminal);
      return { kind: 'failed', run: terminal };
    }

    // §8.2 步骤 6–10 由 Run 驱动器执行（Planning → 逐 Task → Final Review）。
    const driver = createRunDriver(bound);
    try {
      const terminal = await driver.driveToTerminal();
      return terminal.status === 'completed'
        ? { kind: 'completed', run: terminal }
        : { kind: 'failed', run: terminal };
    } catch (error) {
      // 驱动器兜底失败（例如 run.json 已不可写）：表面化稳定错误码。
      const apex = isApexError(error)
        ? (error as ApexError)
        : new ApexError({
            code: 'STATE_VALIDATION_FAILED',
            stage: 'driver',
            message: error instanceof Error ? error.message : String(error),
            cause: error,
          });
      logger.log('error', 'run.driver_error', {
        runId,
        errorCode: apex.errorCode,
        message: apex.message,
        stack: apex.stack ?? null,
      });
      const latest = await bound.stateStore.readRun().catch(() => null);
      if (latest !== null && (latest.status === 'planning' || latest.status === 'running' || latest.status === 'final_review')) {
        const terminal = toTerminalFailedRun(latest, apex, now(), deps.redaction);
        await persistRunBestEffort(bound, terminal);
        return { kind: 'failed', run: terminal };
      }
      if (latest !== null && latest.status === 'completed') return { kind: 'completed', run: latest };
      if (latest !== null) return { kind: 'failed', run: latest };
      throw apex;
    }
  }

  return {
    async execute(input: StartRunInput): Promise<StartRunResult> {
      try {
        return await executeInner(input);
      } finally {
        // 进程收尾与下次归档前确保尾部调试事件落盘，不丢失诊断。
        await logger.flush();
      }
    },
  };
}
