/**
 * E2E：abandon 与 report（G5 测试清单 + §17/§14.4）。
 *
 * - abandon --force：十步状态转换断言、风险门禁、零 Git/进程调用、已提交
 *   Session Record 与已结束 Episode 不被覆盖、各类非法状态对应
 *   command_error。
 * - report：completed 重生成失败保持 completed 且终态字段不变；failed Run
 *   的非成功报告内容规则；非终态/缺失对应 command_error。
 */
import { describe, expect, it } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAbandonRun } from '../../src/application/usecases/abandon-run.js';
import { createGenerateReport } from '../../src/application/usecases/generate-report.js';
import { createSystemClock } from '../../src/adapters/clock/system-clock.js';
import { createRedactor } from '../../src/adapters/redaction/redactor.js';
import type { OutputPort } from '../../src/application/ports/output.js';
import type { StateStorePort } from '../../src/application/ports/state-store.js';
import type { RunJson } from '../../src/domain/schemas/run-json.js';
import type { TasksJson } from '../../src/domain/schemas/tasks-json.js';
import type { SessionRecord } from '../../src/domain/schemas/session-record.js';
import type { ApexError } from '../../src/domain/errors.js';
import {
  COMPLETE_HELP,
  createE2EHarness,
  executionCompleted,
  FAKE_VERSION,
  planDraft,
  streamOf,
  type E2EHarness,
} from './helpers.js';
import { seedRepo } from '../integration/git/helpers.js';

const NOW = '2026-07-28T00:00:00.000Z';
const RUN_ID = 'RUN-123e4567-e89b-42d3-a456-426614174000';
const SESSION_ID = '123e4567-e89b-42d3-a456-426614174001';
const REVIEWER_SESSION_ID = '123e4567-e89b-42d3-a456-426614174002';

interface FabricatedState {
  readonly run: RunJson;
  readonly tasks: TasksJson;
}

/** 通过真实 StateStore 构造“进程死在 Execution 中途”的非终态状态。 */
async function fabricateInterruptedRun(
  harness: E2EHarness,
  options: { readonly withCommittedRecord?: boolean } = {},
): Promise<FabricatedState> {
  const deps = harness.makeBoundDeps();
  const head = await harness.repo.head();
  const spec = await deps.git.readSpecFact(harness.repo.root, 'SPEC.md');
  const store = deps.stateStore;
  // 正常流程由 StartRun 创建状态目录；夹具直接写入前自行创建。
  await harness.fileSystem.mkdir(harness.stateDir, { recursive: true });

  const taskDef = {
    id: 'TASK-001',
    title: '实现功能 A',
    objective: '完成 TASK-001 的目标',
    nonGoals: ['不处理功能 A 之外的需求'],
    dependsOn: [],
    acceptanceCriteria: ['TASK-001 的验收条件'],
    verificationPlan: [
      {
        id: 'VERIFY-001',
        kind: 'command' as const,
        criterionIndexes: [0],
        procedure: '运行测试门禁',
        expectedEvidence: '命令成功退出',
        command: 'npm test',
        timeoutSeconds: 900,
      },
    ],
    likelyPaths: ['src/index.ts'],
    budget: {
      targetContextBudget: 200_000,
      hardContextLimit: 300_000,
      maxAgentTurns: 64,
    },
    context: '端到端测试任务',
  };
  const tasksDoc: TasksJson = {
    schemaVersion: 1,
    runId: RUN_ID,
    planRevision: 1,
    specPath: 'SPEC.md',
    specSha256: spec.sha256,
    generatedAt: NOW,
    plannerSessionId: SESSION_ID,
    planReviewerSessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    summary: '计划摘要',
    assumptions: [],
    retainedCheckpointDispositions: [],
    tasks: [taskDef],
  };
  const tasksSha256 = await store.writeTasks(tasksDoc);

  const run: RunJson = {
    schemaVersion: 1,
    stateRevision: 1,
    runId: RUN_ID,
    status: 'running',
    spec: { path: 'SPEC.md', sha256: spec.sha256 },
    planRevision: 1,
    tasksSha256,
    runSettings: {
      executionPermissionMode: 'auto',
      claudeCliPath: null,
      gitCliPath: null,
      pushRemote: 'origin',
    },
    repository: {
      root: harness.repo.root,
      baseBranch: 'main',
      baseBranchRef: 'refs/heads/main',
      baseCommit: head,
      runBranch: `apex-coding-agent/${RUN_ID}`,
      expectedHead: head,
    },
    currentTaskId: 'TASK-001',
    planCandidate: null,
    planReviewFeedback: null,
    activeSession: {
      sessionId: SESSION_ID,
      type: 'execution',
      taskId: 'TASK-001',
      planRevision: 1,
      specSha256: spec.sha256,
      startedAt: NOW,
    },
    tasks: {
      'TASK-001': {
        taskId: 'TASK-001',
        status: 'running',
        executionEpisodes: [
          {
            sessionId: SESSION_ID,
            taskId: 'TASK-001',
            planRevision: 1,
            specSha256Before: spec.sha256,
            specSha256After: null,
            startedAt: NOW,
            endedAt: null,
            outcome: null,
            summary: null,
            acceptanceEvidence: [],
            finalCheckpoint: null,
            intermediateCheckpoint: null,
            checkpointReason: null,
            error: null,
          },
        ],
        taskReviewEpisodes: [],
        candidateResult: null,
        candidateCheckpoint: null,
        completedResult: null,
        finalCheckpoint: null,
        skipReason: null,
        failure: null,
      },
    },
    intermediateCheckpoints: [],
    finalReviewEpisodes: [],
    lastError: null,
    finalCommit: null,
    reportPath: null,
    resumePoint: null,
    createdAt: NOW,
    updatedAt: NOW,
    terminalAt: null,
  };
  await store.writeRun(run);

  if (options.withCommittedRecord === true) {
    // 已写入的 Session Record（completed）：abandon 不得覆盖。
    const record: SessionRecord = {
      schemaVersion: 1,
      sessionId: SESSION_ID,
      type: 'execution',
      status: 'completed',
      runId: RUN_ID,
      taskId: 'TASK-001',
      planRevision: 1,
      specSha256: spec.sha256,
      startedAt: NOW,
      endedAt: NOW,
      claude: { version: FAKE_VERSION, model: 'fake-model', provider: null },
      exitCode: 0,
      structuredResult: executionCompleted() as unknown as SessionRecord['structuredResult'],
      logPath: `logs/${SESSION_ID}.log`,
      error: null,
    };
    await store.writeSessionRecord(record);
  }
  return { run, tasks: tasksDoc };
}

/**
 * 通过真实 StateStore 构造“进程死在候选已持久化窗口”的非终态状态：
 * status planning、planRevision 0（无 tasks.json）、planCandidate 指向
 * 下一 Revision。可选模拟崩溃在 Plan Review 会话中途（activeSession 仍在）。
 */
async function fabricateCrashedPlanningRun(
  harness: E2EHarness,
  options: { readonly withActiveReview?: boolean } = {},
): Promise<RunJson> {
  const deps = harness.makeBoundDeps();
  const head = await harness.repo.head();
  const spec = await deps.git.readSpecFact(harness.repo.root, 'SPEC.md');
  const store = deps.stateStore;
  await harness.fileSystem.mkdir(harness.stateDir, { recursive: true });

  const run: RunJson = {
    schemaVersion: 1,
    stateRevision: 1,
    runId: RUN_ID,
    status: 'planning',
    spec: { path: 'SPEC.md', sha256: spec.sha256 },
    planRevision: 0,
    tasksSha256: null,
    runSettings: {
      executionPermissionMode: 'auto',
      claudeCliPath: null,
      gitCliPath: null,
      pushRemote: 'origin',
    },
    repository: {
      root: harness.repo.root,
      baseBranch: 'main',
      baseBranchRef: 'refs/heads/main',
      baseCommit: head,
      runBranch: `apex-coding-agent/${RUN_ID}`,
      expectedHead: head,
    },
    currentTaskId: null,
    activeSession:
      options.withActiveReview === true
        ? {
            sessionId: REVIEWER_SESSION_ID,
            type: 'plan_review',
            taskId: null,
            planRevision: 1,
            specSha256: spec.sha256,
            startedAt: NOW,
          }
        : null,
    planCandidate: {
      planRevision: 1,
      plannerSessionId: SESSION_ID,
      specSha256: spec.sha256,
      trigger: { type: 'initial', reason: 'initial plan', sourceSessionId: null },
      reviewAttempt: 1,
    },
    planReviewFeedback: null,
    tasks: {},
    intermediateCheckpoints: [],
    finalReviewEpisodes: [],
    lastError: null,
    finalCommit: null,
    reportPath: null,
    resumePoint: null,
    createdAt: NOW,
    updatedAt: NOW,
    terminalAt: null,
  };
  await store.writeRun(run);
  return run;
}

function makeAbandon(harness: E2EHarness): {
  execute(force: boolean): Promise<{ run: RunJson }>;
  lines: string[];
} {
  const lines: string[] = [];
  /*
   * abandon 用例只产生持久风险提示；仍提供完整 OutputPort 契约，确保测试
   * 替身不会掩盖未来误用临时状态能力的问题。
   */
  const output: OutputPort = {
    writeLine: (line) => lines.push(line),
    updateStatus: (line) => lines.push(line),
    clearStatus: () => {},
  };
  const deps = harness.makeBoundDeps();
  const abandon = createAbandonRun({
    stateStore: deps.stateStore,
    clock: createSystemClock(),
    redaction: createRedactor(),
    output,
  });
  return { execute: (force) => abandon.execute({ force }), lines };
}

async function expectApexError(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    expect((error as ApexError).errorCode).toBe(code);
    return;
  }
  throw new Error(`expected ApexError ${code}, but nothing was thrown`);
}

describe('e2e abandon --force (§17)', () => {
  it(
    'ten-step transition: failed record with null exitCode, episode session_error, task failed, slots cleared, abandoned',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await fabricateInterruptedRun(harness);
        const { execute, lines } = makeAbandon(harness);

        const { run } = await execute(true);

        // 第 3 步：风险提示。
        expect(lines.some((line) => line.includes('无法判断'))).toBe(true);
        // 第 8–9 步：清槽 + abandoned + terminalAt。
        expect(run.status).toBe('abandoned');
        expect(run.activeSession).toBeNull();
        expect(run.currentTaskId).toBeNull();
        expect(run.terminalAt).not.toBeNull();
        expect(run.lastError?.errorCode).toBe('RUN_ABANDONED_BY_USER');
        // 第 7 步：原 running Task 转 failed。
        const task = run.tasks['TASK-001']!;
        expect(task.status).toBe('failed');
        expect(task.failure?.errorCode).toBe('RUN_ABANDONED_BY_USER');
        // 第 6 步：未结束 Episode 结束为 session_error。
        expect(task.executionEpisodes[0]!.outcome).toBe('session_error');
        expect(task.executionEpisodes[0]!.error?.errorCode).toBe('RUN_ABANDONED_BY_USER');
        expect(task.executionEpisodes[0]!.endedAt).not.toBeNull();
        // 第 5 步：补写的失败 Session Record exitCode=null。
        const record = await harness.readSessionRecord(SESSION_ID);
        expect(record.status).toBe('failed');
        expect(record.exitCode).toBeNull();
        expect(record.error?.errorCode).toBe('RUN_ABANDONED_BY_USER');
        expect(record.structuredResult).toBeNull();
        // 第 10 步：其余事实保留（tasks.json 不变、无 Git 改动）。
        const branch = await harness.repo.git('branch', '--show-current');
        expect(branch).toBe('main');
        const head = await harness.repo.head();
        expect(head).toBe(run.repository.baseCommit);
        // 持久化值与返回值一致。
        const persisted = await harness.readRunJson();
        expect(persisted.stateRevision).toBe(run.stateRevision);
        expect(persisted.status).toBe('abandoned');
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  it(
    'an already-written session record is never overwritten',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await fabricateInterruptedRun(harness, { withCommittedRecord: true });
        const before = await harness.readSessionRecord(SESSION_ID);

        const { execute } = makeAbandon(harness);
        const { run } = await execute(true);
        expect(run.status).toBe('abandoned');

        const after = await harness.readSessionRecord(SESSION_ID);
        expect(after).toEqual(before);
        expect(after.status).toBe('completed');
        expect(after.exitCode).toBe(0);
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  it(
    'gate matrix: requires force, non-terminal, existing and schema-valid run',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);

        // 无 run.json → RUN_NOT_FOUND（优先于 force 检查）。
        await expectApexError(() => makeAbandon(harness).execute(false), 'RUN_NOT_FOUND');

        await fabricateInterruptedRun(harness);
        // 缺 --force → ABANDON_REQUIRES_FORCE。
        await expectApexError(() => makeAbandon(harness).execute(false), 'ABANDON_REQUIRES_FORCE');

        // 终态 Run → RUN_NOT_ABANDONABLE。
        await makeAbandon(harness).execute(true);
        await expectApexError(() => makeAbandon(harness).execute(true), 'RUN_NOT_ABANDONABLE');

        // run.json 无法通过 Schema 校验 → COMMAND_STATE_INVALID。
        await writeFile(join(harness.stateDir, 'run.json'), '{"schemaVersion":1,"bogus":true}', 'utf8');
        await expectApexError(() => makeAbandon(harness).execute(true), 'COMMAND_STATE_INVALID');
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  it(
    'abandon 丢弃崩溃在候选窗口的 Run 的瞬态 Planning 事实，持久化结果仍通过领域校验',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await fabricateCrashedPlanningRun(harness);
        const { execute } = makeAbandon(harness);

        const { run } = await execute(true);
        expect(run.status).toBe('abandoned');
        expect(run.planCandidate).toBeNull();
        expect(run.planReviewFeedback).toBeNull();
        expect(run.lastError?.errorCode).toBe('RUN_ABANDONED_BY_USER');

        // readRun 走完整 Schema + 领域不变量：abandoned 不得残留候选/反馈。
        const persisted = await harness.makeBoundDeps().stateStore.readRun();
        expect(persisted?.status).toBe('abandoned');
        expect(persisted?.planCandidate).toBeNull();
        expect(persisted?.planReviewFeedback).toBeNull();
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  it(
    'abandon 收尾崩溃在 Plan Review 会话中的 Run：补写失败 Record 并丢弃候选',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await fabricateCrashedPlanningRun(harness, { withActiveReview: true });
        const { execute } = makeAbandon(harness);

        const { run } = await execute(true);
        expect(run.status).toBe('abandoned');
        expect(run.activeSession).toBeNull();
        expect(run.planCandidate).toBeNull();

        // 孤儿 Reviewer 会话按不可变协议补写 exitCode=null 的失败 Record。
        const record = await harness.readSessionRecord(REVIEWER_SESSION_ID);
        expect(record.type).toBe('plan_review');
        expect(record.status).toBe('failed');
        expect(record.exitCode).toBeNull();
        expect(record.error?.errorCode).toBe('RUN_ABANDONED_BY_USER');

        const persisted = await harness.makeBoundDeps().stateStore.readRun();
        expect(persisted?.status).toBe('abandoned');
        expect(persisted?.planCandidate).toBeNull();
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );
});

describe('e2e report command (§14.4, §17)', () => {
  function makeReport(harness: E2EHarness, reporterOverride?: { generateReport: () => Promise<string> }) {
    const deps = harness.makeBoundDeps();
    return createGenerateReport({
      stateStore: deps.stateStore,
      git: deps.git,
      reporter: reporterOverride ?? deps.reporter,
    });
  }

  it(
    'regenerating the report of a completed run keeps every terminal field unchanged',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          sequence: [
            { stdoutLines: streamOf(planDraft([{ id: 'TASK-001' }])) },
            {
              writeFiles: [{ path: 'src/feature-a.ts', content: 'export const a = 1;\n' }],
              stdoutLines: streamOf(executionCompleted()),
            },
            { stdoutLines: streamOf((await import('./helpers.js')).finalReviewCompleted(['TASK-001'])) },
          ],
        });
        const started = await harness.start();
        expect(started.kind).toBe('completed');
        if (started.kind !== 'completed') return;
        const before = await harness.readRunJson();

        // 删除报告后重生成。
        await rm(join(harness.stateDir, 'report.md'));
        const result = await makeReport(harness).execute();
        expect(result.reportPath).toBe('report.md');
        const report = await harness.readReport();
        expect(report).toContain(before.runId);
        expect(report).toContain('TASK-001');

        const after = await harness.readRunJson();
        expect(after).toEqual(before);
      } finally {
        await harness.cleanup();
      }
    },
    240_000,
  );

  it(
    'a failing regeneration maps to REPORT_COMMAND_FAILED and keeps the run completed',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          sequence: [
            { stdoutLines: streamOf(planDraft([{ id: 'TASK-001' }])) },
            {
              writeFiles: [{ path: 'src/feature-a.ts', content: 'export const a = 1;\n' }],
              stdoutLines: streamOf(executionCompleted()),
            },
            { stdoutLines: streamOf((await import('./helpers.js')).finalReviewCompleted(['TASK-001'])) },
          ],
        });
        const started = await harness.start();
        expect(started.kind).toBe('completed');
        if (started.kind !== 'completed') return;
        const before = await harness.readRunJson();

        await expectApexError(
          () =>
            makeReport(harness, {
              generateReport: () => Promise.reject(new Error('disk full')),
            }).execute(),
          'REPORT_COMMAND_FAILED',
        );

        const after = await harness.readRunJson();
        expect(after).toEqual(before);
        expect(after.status).toBe('completed');
      } finally {
        await harness.cleanup();
      }
    },
    240_000,
  );

  it(
    'report of a failed run marks the run unfinished and never claims HEAD as a final commit',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          sequence: [
            { stdoutLines: streamOf(planDraft([{ id: 'TASK-001' }])) },
            { stderrText: 'provider down', exitCode: 3, stdoutLines: streamOf(executionCompleted()) },
          ],
        });
        const started = await harness.start();
        expect(started.kind).toBe('failed');
        const failedRun = await harness.readRunJson();

        const result = await makeReport(harness).execute();
        expect(result.reportPath).toBe('report.md');
        const report = await harness.readReport();
        // 明确标记未完成 + 最近错误码 + 任务三分类 + 分支与最后确认 Checkpoint。
        expect(report).toContain('未完成');
        expect(report).toContain('CLAUDE_EXIT_NONZERO');
        expect(report).toContain('TASK-001');
        expect(report).toContain(failedRun.repository.runBranch);
        expect(report).toContain(failedRun.repository.expectedHead);
        // 不把 HEAD 当 Final Commit。
        expect(report).not.toMatch(/Final Commit[：:]\s*`?[0-9a-f]{40}/);
        // 终态字段不变。
        const after = await harness.readRunJson();
        expect(after).toEqual(failedRun);
      } finally {
        await harness.cleanup();
      }
    },
    240_000,
  );

  it(
    'report on a non-terminal or missing run fails with the stable command error',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await expectApexError(() => makeReport(harness).execute(), 'RUN_NOT_FOUND');

        await fabricateInterruptedRun(harness);
        await expectApexError(() => makeReport(harness).execute(), 'REPORT_NOT_AVAILABLE');
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  it(
    '缺失已提交的 Plan Revision Snapshot 时拒绝生成不完整报告',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          sequence: [
            { stdoutLines: streamOf(planDraft([{ id: 'TASK-001' }])) },
            {
              writeFiles: [{ path: 'src/feature-a.ts', content: 'export const a = 1;\n' }],
              stdoutLines: streamOf(executionCompleted()),
            },
            {
              stdoutLines: streamOf(
                (await import('./helpers.js')).finalReviewCompleted(['TASK-001']),
              ),
            },
          ],
        });
        const started = await harness.start();
        expect(started.kind).toBe('completed');
        if (started.kind !== 'completed') return;
        const before = await harness.readRunJson();

        await rm(join(harness.stateDir, 'plans', '1.json'));
        await expectApexError(() => makeReport(harness).execute(), 'COMMAND_STATE_INVALID');

        const after = await harness.readRunJson();
        expect(after).toEqual(before);
      } finally {
        await harness.cleanup();
      }
    },
    240_000,
  );
});
