/**
 * G5 端到端测试共享设施：真实临时 Git 仓库 + 序列化 Fake Claude + 真实
 * State Store / Reporter / Archiver，经 StartRun 用例驱动完整业务闭环。
 *
 * 与单元/集成测试的关系：G2–G4 已覆盖端口级契约；这里只通过生产路径
 * （StartRun → RunDriver → 各用例 → 适配器 → Fake Claude/Git）做端到端
 * 断言，不替换任何内部模块。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { release } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodeFileSystem } from '../../src/adapters/filesystem/node-file-system.js';
import { createSystemClock } from '../../src/adapters/clock/system-clock.js';
import { createRedactor } from '../../src/adapters/redaction/redactor.js';
import { createGitAdapter } from '../../src/adapters/git/adapter.js';
import { createClaudeRuntime } from '../../src/adapters/claude/client.js';
import { createTestProcessExecutor } from '../process-executor.js';
import { createJsonStateStore } from '../../src/adapters/state/json-state-store.js';
import { createMarkdownReporter } from '../../src/adapters/reporter/markdown-reporter.js';
import { createRunArchiver } from '../../src/adapters/state/run-archiver.js';
import { createInterruptController, type InterruptController } from '../../src/application/interrupt.js';
import { createDebugLogger } from '../../src/adapters/logging/debug-file-logger.js';
import { createNullLogger } from '../../src/application/ports/logger.js';
import type { OutputPort } from '../../src/application/ports/output.js';
import {
  createStartRun,
  type StartRunInput,
  type StartRunResult,
} from '../../src/application/usecases/start-run.js';
import type { RunCommandDeps } from '../../src/application/run-command-deps.js';
import type { EnvironmentFacts } from '../../src/application/usecases/run-runtime-preflight.js';
import {
  createResumeRun,
  type ResumeRunInput,
  type ResumeRunResult,
} from '../../src/application/usecases/resume-run.js';
import type { UseCaseDeps } from '../../src/application/usecase-deps.js';
import type { FileSystemPort } from '../../src/application/ports/file-system.js';
import type { RunJson } from '../../src/domain/schemas/run-json.js';
import type { TasksJson } from '../../src/domain/schemas/tasks-json.js';
import type { SessionRecord } from '../../src/domain/schemas/session-record.js';
import type { PlanRevisionSnapshot } from '../../src/domain/schemas/plan-revision-snapshot.js';
import { PLAN_REVIEW_DIMENSIONS } from '../../src/domain/schemas/review-evidence.js';
import { COMPLETE_HELP, FAKE_VERSION } from '../integration/claude/helpers.js';
import { createTempRepo, type TempRepo } from '../integration/git/helpers.js';

export const FAKE_CLAUDE_PATH = fileURLToPath(
  new URL('../fake-claude/claude.mjs', import.meta.url),
);

export { COMPLETE_HELP, FAKE_VERSION };

/** e2e 注入的 ApexCodingAgent 版本横幅值（生产路径由 bootstrap 从 package.json 读取）。 */
export const E2E_AGENT_VERSION = '0.0.0-e2e';

/**
 * 生成逐维度 Plan Review 证据；调用方可以指定一个不满足维度，
 * 用于证明领域门禁确实依据结构化审核事实作出结论。
 */
export function planReviewChecks(failedDimension: string | null = null): Record<string, unknown>[] {
  return PLAN_REVIEW_DIMENSIONS.map((dimension) => ({
    dimension,
    status: dimension === failedDimension ? 'not_satisfied' : 'satisfied',
    evidence:
      dimension === failedDimension
        ? `${dimension} 存在阻塞缺口`
        : `${dimension} 已由 SPEC、候选计划和仓库事实交叉确认`,
  }));
}

/**
 * 生成可被返工执行直接消费的问题对象；默认值保持 E2E 场景紧凑，
 * overrides 仅用于表达当前场景真正关心的证据差异。
 */
export function reviewIssue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ISSUE-001',
    category: 'correctness',
    summary: '候选结果仍有阻塞问题',
    evidence: '仓库事实与预期结果不一致',
    requiredChange: '修复实现并提供通过的独立验证证据',
    affectedPaths: [],
    criterionIndexes: [],
    ...overrides,
  };
}

/** 序列场景元素（tests/fake-claude/claude.mjs 的契约镜像）。 */
export interface ScenarioElement {
  readonly stdoutLines?: readonly (string | Record<string, unknown>)[];
  readonly writeFiles?: readonly { path: string; content: string; append?: boolean }[];
  readonly commands?: readonly { argv: string[] }[];
  readonly stderrText?: string;
  readonly exitCode?: number;
  readonly sleepMs?: number;
}

export interface SequenceScenario {
  readonly version?: string;
  readonly versionExitCode?: number;
  readonly help?: string;
  readonly helpExitCode?: number;
  readonly sequence?: readonly ScenarioElement[];
  /** 非序列形态时的回退字段（与 G4 单场景相同）。 */
  readonly stdoutLines?: readonly (string | Record<string, unknown>)[];
  readonly stderrText?: string;
  readonly exitCode?: number;
  readonly sleepMs?: number;
  /** 默认测试设施可分别为两个独立 Reviewer 生成批准结果。 */
  readonly autoApprovePlanReviews?: boolean;
  readonly autoApproveTaskReviews?: boolean;
}

export interface RecordedInvocation {
  readonly argv: string[];
  readonly stdin: string;
  readonly cwd: string;
  readonly env: Record<string, string | null>;
}

export interface E2EHarness {
  readonly repo: TempRepo;
  readonly root: string;
  readonly stateDir: string;
  readonly interrupt: InterruptController;
  readonly outputLines: string[];
  /**
   * RunCommandDeps 创建 Git / Claude 端口时收到的路径参数。
   *
   * 该事实只用于验证 resume 的配置优先级；真实进程仍由生产适配器启动，
   * 不以测试替身绕过路径解析。
   */
  readonly gitPortPaths: Array<string | null>;
  readonly claudePortPaths: Array<string | null>;
  readonly fileSystem: FileSystemPort;
  writeScenario(scenario: SequenceScenario): Promise<void>;
  readRecords(): Promise<RecordedInvocation[]>;
  start(input?: Partial<StartRunInput>): Promise<StartRunResult>;
  resume(input?: Partial<ResumeRunInput>): Promise<ResumeRunResult>;
  readRunJson(): Promise<RunJson>;
  readTasksJson(): Promise<TasksJson>;
  readPlanSnapshot(revision: number): Promise<PlanRevisionSnapshot>;
  readSessionRecord(sessionId: string): Promise<SessionRecord>;
  listSessionRecords(): Promise<SessionRecord[]>;
  readReport(): Promise<string>;
  /**
   * 直接布置/清除 heartbeat.json：崩溃现场仿真（绕过前台信号写入器，
   * 等价于进程猝死后磁盘上的实际残留）。
   */
  writeHeartbeat(fact: { runId: string; at: string }): Promise<void>;
  removeHeartbeat(): Promise<void>;
  makeBoundDeps(): UseCaseDeps;
  cleanup(): Promise<void>;
}

export interface E2EOptions {
  readonly interruptWaitMs?: number;
}

export async function createE2EHarness(options: E2EOptions = {}): Promise<E2EHarness> {
  const repo = await createTempRepo();
  const fakeRoot = await mkdtemp(join(tmpdir(), 'apex-g5-fake-'));
  const scenarioPath = join(fakeRoot, 'scenario.json');
  const recordPath = join(fakeRoot, 'invocations.jsonl');

  /**
   * Fake Claude 的场景定位属于单个 Harness，而不是 Vitest Worker 的全局状态。
   * 每个 Claude 进程执行器持有自己的不可变覆盖，超时后的迟到清理也无法
   * 改写另一个 Harness 正在使用的配置。
   */
  const fakeClaudeEnvironment = {
    APEX_FAKE_CLAUDE_SCENARIO: scenarioPath,
    APEX_FAKE_CLAUDE_RECORD: recordPath,
  } as const;

  const fileSystem = createNodeFileSystem();
  const clock = createSystemClock();
  const redaction = createRedactor();
  const interrupt = createInterruptController();
  // resume 走独立的控制器：start 的中断是一次性事实，恢复执行不得继承。
  const resumeInterrupt = createInterruptController();
  const outputLines: string[] = [];
  /*
   * E2E Harness 模拟非 TTY Sink：临时状态按纯文本行记录，既不引入 ANSI，
   * 也让测试能够观察长 Session 的存活反馈。clearStatus 在非交互模式无输出。
   */
  const output: OutputPort = {
    writeLine: (line) => outputLines.push(line),
    updateStatus: (line) => outputLines.push(line),
    clearStatus: () => {},
  };
  const gitPortPaths: Array<string | null> = [];
  const claudePortPaths: Array<string | null> = [];
  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  const interruptWaitMs = options.interruptWaitMs ?? 10_000;
  const stateDir = `${repo.root.replace(/\\/g, '/')}/.apex-coding-agent`;

  function makeDepsFor(intCtrl: InterruptController): RunCommandDeps {
    const makeBoundDeps: RunCommandDeps['makeBoundDeps'] = ({ stateDir: dir, git, claude, capabilityReport, logger }) => ({
      stateDir: dir,
      stateStore: createJsonStateStore({ stateDir: dir, fs: fileSystem, redaction }),
      git,
      claude,
      clock,
      fileSystem,
      redaction,
      reporter: createMarkdownReporter({ stateDir: dir, fileSystem, redaction }),
      archiver: createRunArchiver({ stateDir: dir, fs: fileSystem, clock }),
      output,
      logger,
      interrupt: intCtrl,
      wait,
      interruptWaitMs,
      sessionHeartbeatMs: 15_000,
      capabilityReport,
    });
    const makeStateStore: RunCommandDeps['makeStateStore'] = (dir) =>
      createJsonStateStore({ stateDir: dir, fs: fileSystem, redaction });
    return {
      fileSystem,
      clock,
      redaction,
      output,
      interrupt: intCtrl,
      wait,
      interruptWaitMs,
      scheduleInterval: (callback, intervalMs) => {
        const timer = setInterval(callback, intervalMs);
        return () => {
          clearInterval(timer);
        };
      },
      makeGitPort: (gitCliPath) => {
        /*
         * 与 Claude 路径记录保持同一层级，只观察工厂输入，不替换真实
         * Git Adapter，确保配置测试仍经过完整仓库校验。
         */
        gitPortPaths.push(gitCliPath);
        return createGitAdapter({
          processExecutor: createTestProcessExecutor(),
          redact: (text) => redaction.redactText(text),
          ...(gitCliPath === null ? {} : { gitPath: gitCliPath }),
        });
      },
      makeClaudePort: (claudeCliPath) => {
        /*
         * 记录端口工厂的输入，而不是推断最终 argv；这样可以直接证明
         * resume 在创建运行时之前已按正确优先级解析原 Run 路径快照。
         */
        claudePortPaths.push(claudeCliPath);
        return createClaudeRuntime({
          claudePath: claudeCliPath ?? FAKE_CLAUDE_PATH,
          processExecutor: createTestProcessExecutor(fakeClaudeEnvironment),
          fileSystem,
          redaction,
          probeTimeoutMs: 15_000,
        });
      },
      makeStateStore,
      makeBoundDeps,
      makeLogger: ({ stateDir: dir, verbose }) =>
        createDebugLogger({
          fileSystem,
          clock,
          redaction,
          logPath: `${dir}/logs/apex-debug.log`,
          mirror: verbose ? (line) => outputLines.push(line) : null,
        }),
    };
  }

  const startDeps = makeDepsFor(interrupt);
  const resumeDeps = makeDepsFor(resumeInterrupt);

  const environment: EnvironmentFacts = {
    platform: process.platform,
    release: release(),
    nodeVersion: process.version,
    agentVersion: E2E_AGENT_VERSION,
  };

  const startRun = createStartRun(startDeps);
  const resumeRun = createResumeRun(resumeDeps);

  return {
    repo,
    root: repo.root,
    stateDir,
    interrupt,
    outputLines,
    gitPortPaths,
    claudePortPaths,
    fileSystem,
    async writeScenario(scenario) {
      // 每个新场景文件重置序列计数器。
      await rm(`${scenarioPath}.counter`, { force: true });
      await writeFile(
        scenarioPath,
        JSON.stringify(
          { autoApprovePlanReviews: true, autoApproveTaskReviews: true, ...scenario },
          null,
          2,
        ),
        'utf8',
      );
    },
    async readRecords() {
      try {
        const text = await readFile(recordPath, 'utf8');
        return text
          .split('\n')
          .filter((line) => line.trim() !== '')
          .map((line) => JSON.parse(line) as RecordedInvocation);
      } catch {
        return [];
      }
    },
    start(input) {
      const base: StartRunInput = {
        cwd: repo.root,
        specPath: null,
        fullAccess: false,
        claudeCliPath: null,
        gitCliPath: null,
        pushRemote: null,
        verbose: false,
        environment,
        ...input,
      };
      return startRun.execute(base);
    },
    resume(input) {
      const base: ResumeRunInput = {
        cwd: repo.root,
        fullAccess: false,
        force: false,
        claudeCliPath: null,
        gitCliPath: null,
        verbose: false,
        environment,
        ...input,
      };
      return resumeRun.execute(base);
    },
    async readRunJson() {
      return JSON.parse(await readFile(join(stateDir, 'run.json'), 'utf8')) as RunJson;
    },
    async readTasksJson() {
      return JSON.parse(await readFile(join(stateDir, 'tasks.json'), 'utf8')) as TasksJson;
    },
    async readPlanSnapshot(revision) {
      return JSON.parse(
        await readFile(join(stateDir, 'plans', `${revision}.json`), 'utf8'),
      ) as PlanRevisionSnapshot;
    },
    async readSessionRecord(sessionId) {
      return JSON.parse(
        await readFile(join(stateDir, 'sessions', `${sessionId}.json`), 'utf8'),
      ) as SessionRecord;
    },
    async listSessionRecords() {
      const { readdir } = await import('node:fs/promises');
      const dir = join(stateDir, 'sessions');
      const records: SessionRecord[] = [];
      for (const name of await readdir(dir)) {
        if (name.endsWith('.json')) {
          records.push(JSON.parse(await readFile(join(dir, name), 'utf8')) as SessionRecord);
        }
      }
      return records.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    },
    async readReport() {
      return readFile(join(stateDir, 'report.md'), 'utf8');
    },
    async writeHeartbeat(fact) {
      await writeFile(join(stateDir, 'heartbeat.json'), JSON.stringify(fact, null, 2), 'utf8');
    },
    async removeHeartbeat() {
      await rm(join(stateDir, 'heartbeat.json'), { force: true });
    },
    makeBoundDeps() {
      return startDeps.makeBoundDeps({
        stateDir,
        /*
         * 直接构造绑定依赖的测试路径也必须保留生产 Git 脱敏边界，避免测试
         * 辅助函数制造一条真实组合根中不存在的旁路。
         */
        git: createGitAdapter({
          processExecutor: createTestProcessExecutor(),
          redact: (text) => redaction.redactText(text),
        }),
        claude: createClaudeRuntime({
          claudePath: FAKE_CLAUDE_PATH,
          processExecutor: createTestProcessExecutor(fakeClaudeEnvironment),
          fileSystem,
          redaction,
          probeTimeoutMs: 15_000,
        }),
        capabilityReport: { version: FAKE_VERSION, capabilities: [] },
        logger: createNullLogger(),
      });
    },
    async cleanup() {
      await repo.cleanup();
      // Windows 上子进程退出滞后时 rmdir 会报 EBUSY，重试吸收
      await rm(fakeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

/**
 * 提取驱动结果的诊断要点：kind、启动错误、终态 Run 状态与 lastError。
 * 完整 RunJson 太大，直接塞进断言消息会淹没真正的原因。
 */
function summarizeDrivingOutcome(outcome: unknown): string {
  if (outcome instanceof Error) return `${outcome.name}: ${outcome.message}`;
  if (typeof outcome !== 'object' || outcome === null) return String(outcome);
  const record = outcome as Record<string, unknown>;
  const summary: Record<string, unknown> = { kind: record['kind'] };
  if ('error' in record) summary['error'] = record['error'];
  const run = record['run'] as { status?: unknown; lastError?: unknown } | undefined;
  if (run !== undefined) {
    summary['status'] = run.status;
    summary['lastError'] = run.lastError ?? null;
  }
  return JSON.stringify(summary);
}

/**
 * 轮询 run.json 直至 predicate 成立；超时响亮失败。
 *
 * 从 start 到首个 Session 落盘要经过多趟子进程接力（preflight 探测、
 * Planning 会话、Plan Revision 提交、Execution 会话）。Windows 全量并发
 * 套件中进程创建竞争激烈，这段路程可能比空闲机器慢一个数量级。默认
 * 预算 60 秒：相对 180 秒的测试超时足够小，又能吸收负载抖动。超时必须
 * 抛错——静默放行只会让慢机器在后续断言里退化成 undefined 误报。
 *
 * 传入 `driving`（start/resume 的 Promise）后，驱动一旦提前结算（例如
 * 启动校验失败从未创建 run.json），立即带着真实结果失败，而不是空等
 * 整个预算把 startup-failed 掩盖成莫名其妙的超时。
 */
export async function waitForRunFact(
  harness: E2EHarness,
  description: string,
  predicate: (run: RunJson) => boolean,
  options: { timeoutMs?: number | undefined; driving?: Promise<unknown> | undefined } = {},
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  let drivingSettled = false;
  let drivingOutcome: unknown;
  options.driving?.then(
    (result) => {
      drivingSettled = true;
      drivingOutcome = result;
    },
    (error: unknown) => {
      drivingSettled = true;
      drivingOutcome = error;
    },
  );
  for (;;) {
    try {
      const run = await harness.readRunJson();
      if (predicate(run)) return;
    } catch {
      // run.json 尚未创建。
    }
    if (drivingSettled) {
      throw new Error(
        `run drive settled before ${description}: ${summarizeDrivingOutcome(drivingOutcome)}`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** 最小 stream-json 事件流：init + 一个 result 终止事件。 */
export function streamOf(
  structuredOutput: Record<string, unknown>,
): (string | Record<string, unknown>)[] {
  return [
    { type: 'system', subtype: 'init', session_id: '{sessionId}', model: 'fake-model' },
    {
      type: 'result',
      subtype: 'success',
      session_id: '{sessionId}',
      structured_output: structuredOutput,
    },
  ];
}

/**
 * 构造合法 TaskPlanDraft 的便捷形式。
 * Replan 测试可只提供 id + disposition，模拟 Planner 对未修改任务的紧凑引用。
 */
export function planDraft(
  tasks: readonly {
    id: string;
    disposition?: 'retain';
    title?: string;
    dependsOn?: string[];
    acceptanceCriteria?: string[];
  }[],
  options: {
    summary?: string;
    dispositions?: readonly { checkpointOid: string; ownerTaskId: string; rationale: string }[];
  } = {},
): Record<string, unknown> {
  return {
    summary: options.summary ?? '计划摘要',
    assumptions: ['假设：仓库可用 npm 构建'],
    retainedCheckpointDispositions: options.dispositions ?? [],
    tasks: tasks.map((task) => {
      if (task.disposition === 'retain') {
        return { id: task.id, disposition: 'retain' };
      }
      return {
        id: task.id,
        title: task.title ?? `实现 ${task.id}`,
        objective: `完成 ${task.id} 的目标`,
        nonGoals: [`不处理 ${task.id} 之外的需求`],
        dependsOn: task.dependsOn ?? [],
        acceptanceCriteria: task.acceptanceCriteria ?? [`${task.id} 的验收条件`],
        verificationPlan: [
          {
            id: 'VERIFY-001',
            kind: 'command',
            criterionIndexes: (task.acceptanceCriteria ?? [`${task.id} 的验收条件`]).map(
              (_criterion, index) => index,
            ),
            procedure: '运行完整测试门禁',
            expectedEvidence: '命令成功退出并覆盖所有验收条件',
            command: 'npm test',
            timeoutSeconds: 900,
          },
        ],
        likelyPaths: ['src/index.ts'],
        budget: {
          targetContextBudget: 200_000,
          hardContextLimit: 600_000,
          maxAgentTurns: 64,
        },
        context: '端到端测试任务',
      };
    }),
  };
}

/**
 * 构造合法的独立 Plan Review 批准结果。
 * 每个草稿 Task 都有且只有一条评估，保证测试数据遵守精确覆盖规则。
 */
export function planReviewApproved(
  taskIds: readonly string[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    decision: 'approved',
    summary: '独立计划复核通过',
    taskAssessments: taskIds.map((taskId) => ({
      taskId,
      decision: 'approved',
      checks: planReviewChecks(),
      issues: [],
    })),
    issues: [],
    ...overrides,
  };
}

/** 合法 TaskExecutionResult（completed）。 */
export function executionCompleted(
  criteriaCount = 1,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    decision: 'completed',
    summary: '任务完成',
    tests: [{ command: 'npm test', result: 'passed' }],
    acceptanceEvidence: Array.from({ length: criteriaCount }, (_, index) => ({
      criterionIndex: index,
      status: 'satisfied',
      evidence: `证据 ${index}`,
    })),
    changedAreas: ['src'],
    remainingRisks: [],
    replanReason: null,
    ...overrides,
  };
}

/** 合法 TaskReviewResult（approved），用于显式复核场景。 */
export function taskReviewApproved(
  criteriaCount = 1,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    decision: 'approved',
    summary: '独立复核通过',
    tests: [{ command: 'npm test', result: 'passed' }],
    verificationEvidence: [
      { verificationId: 'VERIFY-001', status: 'passed', evidence: 'npm test 独立执行通过' },
    ],
    acceptanceEvidence: Array.from({ length: criteriaCount }, (_, index) => ({
      criterionIndex: index,
      status: 'satisfied',
      evidence: `独立复核证据 ${index}`,
    })),
    issues: [],
    replanReason: null,
    ...overrides,
  };
}

/** 合法 FinalReviewResult（completed）。 */
export function finalReviewCompleted(
  reviewedTaskIds: string[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    decision: 'completed',
    summary: '整体复核通过',
    reviewedTaskIds,
    tests: [{ command: 'npm test', result: 'passed' }],
    changedAreas: [],
    remainingRisks: [],
    replanReason: null,
    ...overrides,
  };
}
