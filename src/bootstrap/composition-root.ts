/**
 * Composition Root（SPEC §5.3 依赖方向、§17 CLI）：创建全部适配器并注入
 * 用例，不含任何业务规则。
 *
 * - start/resume：组装 RunCommandDeps（Git/Claude 路径按 §16 优先级在用例内
 *   解析，本层只提供"按最终生效路径构造端口"的工厂，两个用例共用一份）；
 * - status/report/abandon：从调用目录经 Git 确定 repositoryRoot（§17），
 *   用默认 `git` 入口解析（这三个命令没有 CLI 路径选项），再组装只读后端；
 * - 中断信号：第一次转发中断控制器，第二次立即退出（bootstrap/signals）。
 */
import { createNodeFileSystem } from '../adapters/filesystem/node-file-system.js';
import { createSystemClock } from '../adapters/clock/system-clock.js';
import { createRedactor } from '../adapters/redaction/redactor.js';
import { createGitAdapter } from '../adapters/git/adapter.js';
import { createClaudeRuntime } from '../adapters/claude/client.js';
import { createJsonStateStore } from '../adapters/state/json-state-store.js';
import { createMarkdownReporter } from '../adapters/reporter/markdown-reporter.js';
import { createRunArchiver } from '../adapters/state/run-archiver.js';
import { createDebugLogger } from '../adapters/logging/debug-file-logger.js';
import { createExecaProcessExecutor } from '../adapters/process/execa-process-executor.js';
import { createInterruptController } from '../application/interrupt.js';
import type { ClockPort } from '../application/ports/clock.js';
import type { GitPort } from '../application/ports/GitPort.js';
import type { OutputPort } from '../application/ports/output.js';
import type { RedactionPort } from '../application/ports/redaction.js';
import type { ReporterPort } from '../application/ports/ReporterPort.js';
import type { StateStorePort } from '../application/ports/state-store.js';
import type { RunCommandDeps } from '../application/run-command-deps.js';
import type { UseCaseDeps } from '../application/usecase-deps.js';
import { createAbandonRun } from '../application/usecases/abandon-run.js';
import { createGenerateReport } from '../application/usecases/generate-report.js';
import { createStartRun } from '../application/usecases/start-run.js';
import type { EnvironmentFacts } from '../application/usecases/run-runtime-preflight.js';
import { createResumeRun } from '../application/usecases/resume-run.js';
import type { CliRuntime, SignalHandlerSpec } from '../interfaces/cli/runtime.js';
import { installInterruptSignals } from './signals.js';

const STATE_DIR_NAME = '.apex-coding-agent';
/** §16 内置默认：前台中断有界等待 10 秒。 */
const INTERRUPT_WAIT_MS = 10_000;
/** 内置默认：Claude Session 运行期间的用户心跳行间隔 15 秒。 */
const SESSION_HEARTBEAT_MS = 15_000;

export interface CliRuntimeOptions {
  readonly cwd: string;
  readonly environment: EnvironmentFacts;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly updateStatus: (text: string) => void;
  readonly clearStatus: () => void;
}

/**
 * 仓库级命令的内部装配结果。
 *
 * 该结构只存在于 Composition Root，绝不暴露给 CLI；它负责承接动态
 * repositoryRoot 解析后才能构造的状态、报告与控制用例依赖。
 */
interface RepositoryCommandDeps {
  readonly stateStore: StateStorePort;
  readonly git: GitPort;
  readonly reporter: ReporterPort;
  readonly clock: ClockPort;
  readonly redaction: RedactionPort;
  readonly output: OutputPort;
  readonly repositoryRoot: string;
}

export function createCliRuntime(options: CliRuntimeOptions): CliRuntime {
  const fileSystem = createNodeFileSystem();
  const clock = createSystemClock();
  const redaction = createRedactor();
  /*
   * Git 与 Claude 共享同一个无状态进程执行器。
   *
   * Execa 的具体类型被限制在 Adapter 内部，Application 用例只接触各自
   * 的 GitPort 与 ClaudeRuntimePort，避免跨层耦合。
   */
  const processExecutor = createExecaProcessExecutor();
  const interrupt = createInterruptController();
  /*
   * OutputPort 只承载单行、已脱敏文本（§18.4 控制台 Sink）。
   *
   * 持久事实与瞬时活动在端口上显式分离；Composition Root 只转接能力，
   * 不判断 TTY，也不包含动画或终端控制规则。
   */
  const output: OutputPort = {
    writeLine: (line) => options.stdout(line),
    updateStatus: (line) => options.updateStatus(line),
    clearStatus: () => options.clearStatus(),
  };
  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      // unref：会话结束后遗留的心跳定时器不得拖延进程退出。
      setTimeout(resolve, ms).unref();
    });
  // 属主存活信号的周期调度；unref 同理：定时器不得拖延进程退出。
  const scheduleInterval: RunCommandDeps['scheduleInterval'] = (callback, intervalMs) => {
    const timer = setInterval(callback, intervalMs);
    timer.unref();
    return () => {
      clearInterval(timer);
    };
  };

  const makeGitPort: RunCommandDeps['makeGitPort'] = (gitCliPath) =>
    createGitAdapter({
      processExecutor,
      /*
       * Git stderr 必须在离开 Adapter 前进入统一脱敏边界；后续 ErrorRecord
       * 和控制台仍可重复执行幂等脱敏，但不再承接第一道防线的职责。
       */
      redact: (text) => redaction.redactText(text),
      ...(gitCliPath === null ? {} : { gitPath: gitCliPath }),
    });
  const makeClaudePort: RunCommandDeps['makeClaudePort'] = (claudeCliPath) =>
    createClaudeRuntime({
      ...(claudeCliPath === null ? {} : { claudePath: claudeCliPath }),
      processExecutor,
      fileSystem,
      redaction,
    });
  const makeStateStore: RunCommandDeps['makeStateStore'] = (stateDir) =>
    createJsonStateStore({ stateDir, fs: fileSystem, redaction });
  const makeBoundDeps: RunCommandDeps['makeBoundDeps'] = ({
    stateDir,
    git,
    claude,
    capabilityReport,
    logger,
  }): UseCaseDeps => ({
    stateDir,
    stateStore: createJsonStateStore({ stateDir, fs: fileSystem, redaction }),
    git,
    claude,
    clock,
    fileSystem,
    redaction,
    reporter: createMarkdownReporter({ stateDir, fileSystem, redaction }),
    archiver: createRunArchiver({ stateDir, fs: fileSystem, clock }),
    output,
    logger,
    interrupt,
    wait,
    interruptWaitMs: INTERRUPT_WAIT_MS,
    sessionHeartbeatMs: SESSION_HEARTBEAT_MS,
    capabilityReport,
  });
  const makeLogger: RunCommandDeps['makeLogger'] = ({ stateDir, verbose }) =>
    createDebugLogger({
      fileSystem,
      clock,
      redaction,
      logPath: `${stateDir}/logs/apex-debug.log`,
      mirror: verbose ? (line) => options.stderr(line) : null,
      /*
       * 调试日志落盘失败属于需要用户立即关注的降级事实。
       * 统一使用警告语义，不再恢复已经移除的重复产品前缀。
       */
      onWriteFailure: (detail) => options.stderr(`⚠ 调试日志写入失败 · ${detail}`),
    });

  const startRun = createStartRun({
    fileSystem,
    clock,
    redaction,
    output,
    interrupt,
    wait,
    interruptWaitMs: INTERRUPT_WAIT_MS,
    scheduleInterval,
    makeGitPort,
    makeClaudePort,
    makeStateStore,
    makeBoundDeps,
    makeLogger,
  });

  // resume 复用 start 的端口工厂与绑定装配（同一份 §16 优先级与 UseCaseDeps）。
  const resume = createResumeRun({
    fileSystem,
    clock,
    redaction,
    output,
    interrupt,
    wait,
    interruptWaitMs: INTERRUPT_WAIT_MS,
    scheduleInterval,
    makeGitPort,
    makeClaudePort,
    makeStateStore,
    makeBoundDeps,
    makeLogger,
  });

  /**
   * 从命令调用目录解析仓库，并在组合根内部绑定仓库级适配器。
   *
   * status/report/abandon 没有 CLI 路径覆盖项，因此先使用默认 Git
   * 入口定位仓库；业务用例只能获得各自命令门面传入的最小依赖。
   */
  async function createRepositoryCommandDeps(): Promise<RepositoryCommandDeps> {
    const git = createGitAdapter({
      processExecutor,
      redact: (text) => redaction.redactText(text),
    });
    const root = (await git.resolveRepositoryRoot(options.cwd)).replace(/\\/g, '/');
    const stateDir = `${root}/${STATE_DIR_NAME}`;
    return {
      stateStore: createJsonStateStore({ stateDir, fs: fileSystem, redaction }),
      git,
      reporter: createMarkdownReporter({ stateDir, fileSystem, redaction }),
      clock,
      redaction,
      output,
      repositoryRoot: root,
    };
  }

  /**
   * 命令门面集中完成动态依赖装配。
   *
   * CLI 只调用 execute 并渲染结果，不再创建 Application 用例，也不会
   * 直接持有可写 StateStore 或完整 GitPort。
   */
  const status: CliRuntime['status'] = {
    async execute() {
      const deps = await createRepositoryCommandDeps();
      const snapshot = await deps.stateStore.readConsistentSnapshot();
      /**
       * 空状态不能丢弃仓库定位事实。显式返回 not_found 结果，让 CLI 能指出
       * 实际查询的仓库，同时保持跨仓库搜索、提示文案等展示决策不进入组合根。
       */
      if (snapshot === null) {
        return { kind: 'not_found', repositoryRoot: deps.repositoryRoot };
      }
      const git = await deps.git.readRepositoryStatus(deps.repositoryRoot);
      return { kind: 'found', snapshot, git };
    },
  };
  const report: CliRuntime['report'] = {
    async execute() {
      const deps = await createRepositoryCommandDeps();
      return createGenerateReport({
        stateStore: deps.stateStore,
        git: deps.git,
        reporter: deps.reporter,
      }).execute();
    },
  };
  const abandon: CliRuntime['abandon'] = {
    async execute(input) {
      const deps = await createRepositoryCommandDeps();
      return createAbandonRun({
        stateStore: deps.stateStore,
        clock: deps.clock,
        redaction: deps.redaction,
        output: deps.output,
      }).execute(input);
    },
  };

  function installSignals(handlers: SignalHandlerSpec): () => void {
    return installInterruptSignals({ onFirstInterrupt: handlers.onFirstInterrupt });
  }

  return {
    cwd: options.cwd,
    environment: options.environment,
    stdout: options.stdout,
    stderr: options.stderr,
    redaction,
    interrupt,
    startRun,
    resume,
    status,
    report,
    abandon,
    installSignals,
  };
}
