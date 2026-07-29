/**
 * Fake Claude 集成测试的共享设施。被测适配器通过当前 Node 运行时启动
 * `tests/fake-claude/claude.mjs`，因此参数数组、环境继承、stdout/stderr
 * 与退出码契约都和真实 CLI 走同一条生产路径。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createClaudeRuntime } from '../../../src/adapters/claude/client.js';
import { createNodeFileSystem } from '../../../src/adapters/filesystem/node-file-system.js';
import { createRedactor } from '../../../src/adapters/redaction/redactor.js';
import type {
  ClaudeInvocationRequest,
  ClaudeRuntimePort,
} from '../../../src/application/ports/ClaudeRuntimePort.js';
import type { FileSystemPort } from '../../../src/application/ports/file-system.js';
import type { SessionType } from '../../../src/domain/schemas/active-session.js';
import { createTestProcessExecutor } from '../../process-executor.js';

export const FAKE_CLAUDE_PATH = fileURLToPath(
  new URL('../../fake-claude/claude.mjs', import.meta.url),
);

export const COMPLETE_HELP = readFileSync(
  fileURLToPath(new URL('../../fixtures/claude-help/complete.help.txt', import.meta.url)),
  'utf8',
);

export const SESSION_ID = '123e4567-e89b-42d3-a456-426614174001';
export const FAKE_VERSION = '9.9.9 (fake-claude-test)';
export const FAKE_CAPABILITY_REPORT = {
  version: FAKE_VERSION,
  capabilities: [
    'print-mode',
    'stream-json',
    'json-schema',
    'session-id',
    'permission-mode plan',
    'permission-mode auto',
    'permission-mode bypassPermissions',
  ],
} as const;

export interface FakeClaudeScenario {
  readonly version?: string;
  readonly versionExitCode?: number;
  readonly help?: string;
  readonly helpExitCode?: number;
  readonly stdoutLines?: readonly (string | Record<string, unknown>)[];
  readonly printEnv?: readonly string[];
  readonly stderrText?: string;
  readonly exitCode?: number;
  readonly sleepMs?: number;
  readonly recordEnv?: readonly string[];
}

export interface RecordedInvocation {
  readonly argv: string[];
  readonly cwd: string;
  readonly env: Record<string, string | null>;
}

export interface FakeClaudeHarness {
  readonly root: string;
  readonly scenarioPath: string;
  readonly recordPath: string;
  writeScenario(scenario: FakeClaudeScenario): Promise<void>;
  readRecords(): Promise<RecordedInvocation[]>;
  readSessionLog(sessionId: string): Promise<string>;
  cleanup(): Promise<void>;
}

export async function createFakeClaudeHarness(): Promise<FakeClaudeHarness> {
  const root = await mkdtemp(join(tmpdir(), 'apex-g4-'));
  const scenarioPath = join(root, 'scenario.json');
  const recordPath = join(root, 'invocations.jsonl');
  return {
    root,
    scenarioPath,
    recordPath,
    async writeScenario(scenario) {
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
    async readSessionLog(sessionId) {
      return readFile(join(root, '.apex-coding-agent', 'logs', `${sessionId}.log`), 'utf8');
    },
    async cleanup() {
      // Windows 上子进程退出滞后时 rmdir 会报 EBUSY，重试吸收
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

/** 把 Fake CLI 指向当前测试文件，并返回恢复环境变量的函数。 */
export function activateHarness(harness: FakeClaudeHarness): () => void {
  const savedScenario = process.env['APEX_FAKE_CLAUDE_SCENARIO'];
  const savedRecord = process.env['APEX_FAKE_CLAUDE_RECORD'];
  process.env['APEX_FAKE_CLAUDE_SCENARIO'] = harness.scenarioPath;
  process.env['APEX_FAKE_CLAUDE_RECORD'] = harness.recordPath;
  return () => {
    if (savedScenario === undefined) delete process.env['APEX_FAKE_CLAUDE_SCENARIO'];
    else process.env['APEX_FAKE_CLAUDE_SCENARIO'] = savedScenario;
    if (savedRecord === undefined) delete process.env['APEX_FAKE_CLAUDE_RECORD'];
    else process.env['APEX_FAKE_CLAUDE_RECORD'] = savedRecord;
  };
}

export function makeRuntime(options?: {
  readonly claudePath?: string;
  readonly fileSystem?: FileSystemPort;
}): ClaudeRuntimePort {
  return createClaudeRuntime({
    claudePath: options?.claudePath ?? FAKE_CLAUDE_PATH,
    processExecutor: createTestProcessExecutor(),
    fileSystem: options?.fileSystem ?? createNodeFileSystem(),
    redaction: createRedactor(),
    probeTimeoutMs: 15_000,
  });
}

export function mkRequest(
  harness: FakeClaudeHarness,
  overrides: Partial<ClaudeInvocationRequest<SessionType>> = {},
): ClaudeInvocationRequest<SessionType> {
  return {
    type: 'execution',
    prompt: 'Implement the task',
    sessionId: SESSION_ID,
    permissionMode: 'auto',
    cwd: harness.root,
    capabilityReport: FAKE_CAPABILITY_REPORT,
    ...overrides,
  };
}

export function validStructuredResult(sessionType: SessionType): Record<string, unknown> {
  switch (sessionType) {
    case 'planning':
      return {
        summary: 'Plan the feature',
        assumptions: ['The repository builds with npm'],
        retainedCheckpointDispositions: [],
        tasks: [
          {
            id: 'TASK-001',
            title: 'Bootstrap module',
            objective: 'Create the module skeleton',
            dependsOn: [],
            acceptanceCriteria: ['npm test passes'],
            verificationHints: ['npm test'],
            likelyPaths: ['src/index.ts'],
            estimatedSize: 'small',
            context: 'Greenfield module with no dependencies',
          },
        ],
      };
    case 'execution':
      return {
        decision: 'completed',
        summary: 'Implemented the task',
        tests: [{ command: 'npm test', result: 'passed' }],
        acceptanceEvidence: [
          { criterionIndex: 0, status: 'satisfied', evidence: 'npm test output green' },
        ],
        changedAreas: ['src'],
        remainingRisks: [],
        replanReason: null,
      };
    case 'final_review':
      return {
        decision: 'completed',
        summary: 'All tasks reviewed',
        reviewedTaskIds: ['TASK-001'],
        tests: [{ command: 'npm test', result: 'passed' }],
        changedAreas: [],
        remainingRisks: [],
        replanReason: null,
      };
  }
}

export function invalidStructuredResult(sessionType: SessionType): Record<string, unknown> {
  switch (sessionType) {
    case 'planning':
      return {
        summary: 'Plan the feature',
        assumptions: [],
        retainedCheckpointDispositions: [],
        tasks: 'not-an-array',
      };
    case 'execution':
      return {
        ...(validStructuredResult('execution') as { decision: string }),
        decision: 'sometimes',
      };
    case 'final_review': {
      const { reviewedTaskIds: _omitted, ...rest } = validStructuredResult('final_review') as {
        reviewedTaskIds: string[];
      };
      return rest;
    }
  }
}

export interface StreamLineOptions {
  readonly model?: string | null;
  readonly provider?: string | null;
  readonly structuredOutput?: Record<string, unknown>;
}

/** 最小合法事件流：一个 init 事件和一个 result 终止事件。 */
export function streamLines(
  sessionType: SessionType,
  options: StreamLineOptions = {},
): (string | Record<string, unknown>)[] {
  const init: Record<string, unknown> = {
    type: 'system',
    subtype: 'init',
    session_id: '{sessionId}',
  };
  const model = options.model === undefined ? 'claude-fake-model' : options.model;
  if (model !== null) init['model'] = model;
  if (options.provider !== undefined && options.provider !== null) {
    init['provider'] = options.provider;
  }
  return [
    init,
    {
      type: 'result',
      subtype: 'success',
      session_id: '{sessionId}',
      structured_output: options.structuredOutput ?? validStructuredResult(sessionType),
    },
  ];
}

export type ScenarioOutcome = 'success' | 'schema-error' | 'nonzero-exit';

export function scenarioFor(
  sessionType: SessionType,
  outcome: ScenarioOutcome,
): FakeClaudeScenario {
  switch (outcome) {
    case 'success':
      return { version: FAKE_VERSION, stdoutLines: streamLines(sessionType), exitCode: 0 };
    case 'schema-error':
      return {
        version: FAKE_VERSION,
        stdoutLines: streamLines(sessionType, {
          structuredOutput: invalidStructuredResult(sessionType),
        }),
        exitCode: 0,
      };
    case 'nonzero-exit':
      return {
        version: FAKE_VERSION,
        stdoutLines: streamLines(sessionType),
        stderrText: `${sessionType} provider failure: out of quota`,
        exitCode: 3,
      };
  }
}
