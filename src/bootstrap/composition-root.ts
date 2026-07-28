/**
 * Composition Root（SPEC §5.3 依赖方向、§17 CLI）：创建全部适配器并注入
 * 用例，不含任何业务规则。
 *
 * - start：组装 StartRunDeps（Git/Claude 路径按 §16 优先级在用例内解析，
 *   本层只提供"按最终生效路径构造端口"的工厂）；
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
import { createInterruptController } from '../application/interrupt.js';
import type { ClockPort } from '../application/ports/clock.js';
import type { GitPort } from '../application/ports/GitPort.js';
import type { OutputPort } from '../application/ports/output.js';
import type { RedactionPort } from '../application/ports/redaction.js';
import type { ReporterPort } from '../application/ports/ReporterPort.js';
import type { StateStorePort } from '../application/ports/state-store.js';
import type { UseCaseDeps } from '../application/usecase-deps.js';
import { createAbandonRun } from '../application/usecases/abandon-run.js';
import { createGenerateReport } from '../application/usecases/generate-report.js';
import {
  createStartRun,
  type EnvironmentFacts,
  type StartRunDeps,
} from '../application/usecases/start-run.js';
import type { CliRuntime, SignalHandlerSpec } from '../interfaces/cli/runtime.js';
import { installInterruptSignals } from './signals.js';

const STATE_DIR_NAME = '.apex-coding-agent';
/** §16 内置默认：前台中断有界等待 10 秒。 */
const INTERRUPT_WAIT_MS = 10_000;

export interface CliRuntimeOptions {
  readonly cwd: string;
  readonly environment: EnvironmentFacts;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
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
  const interrupt = createInterruptController();
  // OutputPort 只承载单行、已脱敏文本（§18.4 控制台 Sink）。
  const output = { writeLine: (line: string) => options.stdout(line) };
  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  const makeGitPort: StartRunDeps['makeGitPort'] = (gitCliPath) =>
    createGitAdapter(gitCliPath === null ? {} : { gitPath: gitCliPath });
  const makeClaudePort: StartRunDeps['makeClaudePort'] = (claudeCliPath) =>
    createClaudeRuntime({
      ...(claudeCliPath === null ? {} : { claudePath: claudeCliPath }),
      fileSystem,
      redaction,
    });
  const makeBoundDeps: StartRunDeps['makeBoundDeps'] = ({
    stateDir,
    git,
    claude,
    capabilityReport,
  }): UseCaseDeps => ({
    stateDir,
    stateStore: createJsonStateStore({ stateDir, fs: fileSystem }),
    git,
    claude,
    clock,
    fileSystem,
    redaction,
    reporter: createMarkdownReporter({ stateDir, fileSystem, redaction }),
    archiver: createRunArchiver({ stateDir, fs: fileSystem, clock }),
    output,
    interrupt,
    wait,
    interruptWaitMs: INTERRUPT_WAIT_MS,
    capabilityReport,
  });

  const startRun = createStartRun({
    fileSystem,
    clock,
    redaction,
    output,
    interrupt,
    wait,
    interruptWaitMs: INTERRUPT_WAIT_MS,
    makeGitPort,
    makeClaudePort,
    makeBoundDeps,
  });

  /**
   * 从命令调用目录解析仓库，并在组合根内部绑定仓库级适配器。
   *
   * status/report/abandon 没有 CLI 路径覆盖项，因此先使用默认 Git
   * 入口定位仓库；业务用例只能获得各自命令门面传入的最小依赖。
   */
  async function createRepositoryCommandDeps(): Promise<RepositoryCommandDeps> {
    const git = createGitAdapter({});
    const root = (await git.resolveRepositoryRoot(options.cwd)).replace(/\\/g, '/');
    const stateDir = `${root}/${STATE_DIR_NAME}`;
    return {
      stateStore: createJsonStateStore({ stateDir, fs: fileSystem }),
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
      if (snapshot === null) return null;
      const git = await deps.git.readRepositoryStatus(deps.repositoryRoot);
      return { snapshot, git };
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
    status,
    report,
    abandon,
    installSignals,
  };
}
