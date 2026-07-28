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
import { createJsonStateStore } from '../../src/adapters/state/json-state-store.js';
import { createMarkdownReporter } from '../../src/adapters/reporter/markdown-reporter.js';
import { createRunArchiver } from '../../src/adapters/state/run-archiver.js';
import { createInterruptController, type InterruptController } from '../../src/application/interrupt.js';
import { createDebugLogger } from '../../src/adapters/logging/debug-file-logger.js';
import { createNullLogger } from '../../src/application/ports/logger.js';
import {
  createStartRun,
  type EnvironmentFacts,
  type StartRunDeps,
  type StartRunInput,
  type StartRunResult,
} from '../../src/application/usecases/start-run.js';
import type { UseCaseDeps } from '../../src/application/usecase-deps.js';
import type { FileSystemPort } from '../../src/application/ports/file-system.js';
import type { RunJson } from '../../src/domain/schemas/run-json.js';
import type { TasksJson } from '../../src/domain/schemas/tasks-json.js';
import type { SessionRecord } from '../../src/domain/schemas/session-record.js';
import type { PlanRevisionSnapshot } from '../../src/domain/schemas/plan-revision-snapshot.js';
import { COMPLETE_HELP, FAKE_VERSION } from '../integration/claude/helpers.js';
import { createTempRepo, type TempRepo } from '../integration/git/helpers.js';

export const FAKE_CLAUDE_PATH = fileURLToPath(
  new URL('../fake-claude/claude.mjs', import.meta.url),
);

export { COMPLETE_HELP, FAKE_VERSION };

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
}

export interface RecordedInvocation {
  readonly argv: string[];
  readonly cwd: string;
  readonly env: Record<string, string | null>;
}

export interface E2EHarness {
  readonly repo: TempRepo;
  readonly root: string;
  readonly stateDir: string;
  readonly interrupt: InterruptController;
  readonly outputLines: string[];
  readonly fileSystem: FileSystemPort;
  writeScenario(scenario: SequenceScenario): Promise<void>;
  readRecords(): Promise<RecordedInvocation[]>;
  start(input?: Partial<StartRunInput>): Promise<StartRunResult>;
  readRunJson(): Promise<RunJson>;
  readTasksJson(): Promise<TasksJson>;
  readPlanSnapshot(revision: number): Promise<PlanRevisionSnapshot>;
  readSessionRecord(sessionId: string): Promise<SessionRecord>;
  listSessionRecords(): Promise<SessionRecord[]>;
  readReport(): Promise<string>;
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

  const fileSystem = createNodeFileSystem();
  const clock = createSystemClock();
  const redaction = createRedactor();
  const interrupt = createInterruptController();
  const outputLines: string[] = [];
  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  const interruptWaitMs = options.interruptWaitMs ?? 10_000;
  const stateDir = `${repo.root.replace(/\\/g, '/')}/.apex-coding-agent`;

  const makeBoundDeps: StartRunDeps['makeBoundDeps'] = ({ stateDir: dir, git, claude, capabilityReport, logger }) => ({
    stateDir: dir,
    stateStore: createJsonStateStore({ stateDir: dir, fs: fileSystem }),
    git,
    claude,
    clock,
    fileSystem,
    redaction,
    reporter: createMarkdownReporter({ stateDir: dir, fileSystem, redaction }),
    archiver: createRunArchiver({ stateDir: dir, fs: fileSystem, clock }),
    output: { writeLine: (line) => outputLines.push(line) },
    logger,
    interrupt,
    wait,
    interruptWaitMs,
    sessionHeartbeatMs: 15_000,
    capabilityReport,
  });

  const startDeps: StartRunDeps = {
    fileSystem,
    clock,
    redaction,
    output: { writeLine: (line) => outputLines.push(line) },
    interrupt,
    wait,
    interruptWaitMs,
    makeGitPort: (gitCliPath) => createGitAdapter(gitCliPath === null ? {} : { gitPath: gitCliPath }),
    makeClaudePort: (claudeCliPath) =>
      createClaudeRuntime({
        claudePath: claudeCliPath ?? FAKE_CLAUDE_PATH,
        fileSystem,
        redaction,
        probeTimeoutMs: 15_000,
      }),
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

  const environment: EnvironmentFacts = {
    platform: process.platform,
    release: release(),
    nodeVersion: process.version,
  };

  const savedScenario = process.env['APEX_FAKE_CLAUDE_SCENARIO'];
  const savedRecord = process.env['APEX_FAKE_CLAUDE_RECORD'];
  process.env['APEX_FAKE_CLAUDE_SCENARIO'] = scenarioPath;
  process.env['APEX_FAKE_CLAUDE_RECORD'] = recordPath;

  const startRun = createStartRun(startDeps);

  return {
    repo,
    root: repo.root,
    stateDir,
    interrupt,
    outputLines,
    fileSystem,
    async writeScenario(scenario) {
      // 每个新场景文件重置序列计数器。
      await rm(`${scenarioPath}.counter`, { force: true });
      await writeFile(scenarioPath, JSON.stringify(scenario, null, 2), 'utf8');
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
        verbose: false,
        environment,
        ...input,
      };
      return startRun.execute(base);
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
    makeBoundDeps() {
      return makeBoundDeps({
        stateDir,
        git: createGitAdapter({}),
        claude: createClaudeRuntime({
          claudePath: FAKE_CLAUDE_PATH,
          fileSystem,
          redaction,
          probeTimeoutMs: 15_000,
        }),
        capabilityReport: { version: FAKE_VERSION, capabilities: [] },
        logger: createNullLogger(),
      });
    },
    async cleanup() {
      if (savedScenario === undefined) delete process.env['APEX_FAKE_CLAUDE_SCENARIO'];
      else process.env['APEX_FAKE_CLAUDE_SCENARIO'] = savedScenario;
      if (savedRecord === undefined) delete process.env['APEX_FAKE_CLAUDE_RECORD'];
      else process.env['APEX_FAKE_CLAUDE_RECORD'] = savedRecord;
      await repo.cleanup();
      // Windows 上子进程退出滞后时 rmdir 会报 EBUSY，重试吸收
      await rm(fakeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
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

/** 构造合法 TaskPlanDraft 的便捷形式。 */
export function planDraft(
  tasks: readonly {
    id: string;
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
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title ?? `实现 ${task.id}`,
      objective: `完成 ${task.id} 的目标`,
      dependsOn: task.dependsOn ?? [],
      acceptanceCriteria: task.acceptanceCriteria ?? [`${task.id} 的验收条件`],
      verificationHints: ['npm test'],
      likelyPaths: ['src/index.ts'],
      estimatedSize: 'small',
      context: '端到端测试任务',
    })),
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
