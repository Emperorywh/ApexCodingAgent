/**
 * Cross-state invariants (§6.6) and the conditional rules of run.json,
 * Task Runtime State, Active Session, Intermediate Checkpoint and Session
 * Record (§11.3/§11.4).
 */
import { describe, expect, it } from 'vitest';
import {
  assertActiveSessionRules,
  assertErrorRecordRules,
  assertIntermediateCheckpointRules,
  assertRunInvariants,
  assertRunJsonRules,
  assertSessionRecordRules,
  assertTaskRuntimeStateRules,
} from '../../src/domain/invariants.js';
import type { ActiveSession } from '../../src/domain/schemas/active-session.js';
import type { FinalReviewEpisode } from '../../src/domain/schemas/final-review-episode.js';
import type { IntermediateCheckpoint } from '../../src/domain/schemas/intermediate-checkpoint.js';
import type { RunJson } from '../../src/domain/schemas/run-json.js';
import type { SessionRecord } from '../../src/domain/schemas/session-record.js';
import {
  expectApexError,
  mkErrorRecord,
  mkResult,
  mkRun,
  mkTask,
  mkTaskState,
  OID_B,
  OID_C,
  RUN_ID,
  SHA256_A,
  T0,
  T1,
  UUID_1,
  UUID_2,
} from './fixtures.js';

function runningRun(overrides: Partial<RunJson> = {}): RunJson {
  return mkRun({
    status: 'running',
    planRevision: 1,
    tasksSha256: SHA256_A,
    ...overrides,
  });
}

/**
 * 构造一次已经完成并产出最终 Checkpoint 的 Final Review Episode。
 * reviewedTaskIds 由各用例显式传入，便于验证最终覆盖集合。
 */
function completedFinalReview(reviewedTaskIds: string[]): FinalReviewEpisode {
  return {
    sessionId: UUID_2,
    planRevision: 1,
    specSha256Before: SHA256_A,
    specSha256After: SHA256_A,
    startedAt: T0,
    endedAt: T1,
    decision: 'completed',
    summary: 'Final review completed',
    reviewedTaskIds,
    changedAreas: [],
    checkpointRole: 'final-review-final',
    checkpoint: OID_B,
    checkpointReason: 'Final Review Checkpoint 已确认',
    error: null,
  };
}

describe('run.json conditional rules (§11.3)', () => {
  it('accepts the initial planning shape (planRevision 0, no tasks)', () => {
    expect(() => assertRunJsonRules(mkRun())).not.toThrow();
    expect(() => assertRunInvariants(mkRun(), null)).not.toThrow();
  });

  it('couples planRevision 0 with no committed tasks and only initialization terminal states', () => {
    expect(() =>
      assertRunJsonRules(mkRun({ status: 'failed', terminalAt: T1 })),
    ).not.toThrow();
    expect(() =>
      assertRunJsonRules(mkRun({ status: 'abandoned', terminalAt: T1 })),
    ).not.toThrow();
    expectApexError(
      () => assertRunJsonRules(mkRun({ tasksSha256: SHA256_A })),
      'STATE_VALIDATION_FAILED',
    );
    expectApexError(
      () => assertRunJsonRules(mkRun({ status: 'running' })),
      'STATE_VALIDATION_FAILED',
    );
    expectApexError(
      () => assertRunJsonRules(mkRun({ planRevision: 1 })),
      'STATE_VALIDATION_FAILED',
    );
  });

  it('terminalAt is non-null exactly for terminal statuses', () => {
    expectApexError(
      () => assertRunJsonRules(runningRun({ terminalAt: T1 })),
      'STATE_VALIDATION_FAILED',
    );
    expectApexError(
      () =>
        assertRunJsonRules(
          mkRun({ status: 'failed', terminalAt: null, planRevision: 1, tasksSha256: SHA256_A }),
        ),
      'STATE_VALIDATION_FAILED',
    );
  });

  it('completed requires finalCommit and reportPath; failed/abandoned forbid finalCommit', () => {
    const completedBase: Partial<RunJson> = {
      status: 'completed',
      planRevision: 1,
      tasksSha256: SHA256_A,
      terminalAt: T1,
      finalCommit: OID_B,
      reportPath: 'report.md',
    };
    expect(() => assertRunJsonRules(mkRun(completedBase))).not.toThrow();
    expectApexError(
      () => assertRunJsonRules(mkRun({ ...completedBase, finalCommit: null })),
      'STATE_VALIDATION_FAILED',
    );
    expectApexError(
      () => assertRunJsonRules(mkRun({ ...completedBase, reportPath: null })),
      'STATE_VALIDATION_FAILED',
    );

    for (const status of ['failed', 'abandoned'] as const) {
      const base: Partial<RunJson> = {
        status,
        planRevision: 1,
        tasksSha256: SHA256_A,
        terminalAt: T1,
        finalCommit: null,
      };
      expect(() => assertRunJsonRules(mkRun(base))).not.toThrow();
      expectApexError(
        () => assertRunJsonRules(mkRun({ ...base, finalCommit: OID_B })),
        'STATE_VALIDATION_FAILED',
      );
      expectApexError(
        () =>
          assertRunJsonRules(
            mkRun({
              ...base,
              activeSession: {
                sessionId: UUID_1,
                type: 'planning',
                taskId: null,
                planRevision: 1,
                specSha256: SHA256_A,
                startedAt: T0,
              },
            }),
          ),
        'STATE_VALIDATION_FAILED',
      );
      expectApexError(
        () => assertRunJsonRules(mkRun({ ...base, currentTaskId: 'TASK-001' })),
        'STATE_VALIDATION_FAILED',
      );
    }
  });

  it('rejects lastError records whose errorClass contradicts the errorCode', () => {
    const run = runningRun({
      tasks: {},
      lastError: mkErrorRecord({ errorClass: 'plan_error' }),
    });
    expectApexError(() => assertRunJsonRules(run), 'STATE_VALIDATION_FAILED');
  });
});

describe('resumePoint rules (§2.4/§17 resume)', () => {
  const interruptedFailure = mkErrorRecord({
    errorCode: 'RUN_INTERRUPTED',
    errorClass: 'run_error',
    message: 'foreground interrupt requested',
  });

  const failedWithPoint = (overrides: Partial<RunJson> = {}): RunJson =>
    mkRun({
      status: 'failed',
      terminalAt: T1,
      planRevision: 1,
      tasksSha256: SHA256_A,
      lastError: interruptedFailure,
      resumePoint: {
        fromStatus: 'running',
        taskId: 'TASK-001',
        sessionId: UUID_1,
        sessionType: 'execution',
      },
      tasks: {
        'TASK-001': mkTaskState('TASK-001', 'failed', { failure: interruptedFailure }),
      },
      ...overrides,
    });

  it('accepts a resumePoint on a RUN_INTERRUPTED failed run', () => {
    expect(() => assertRunJsonRules(failedWithPoint())).not.toThrow();
    expect(() => assertRunInvariants(failedWithPoint(), { tasks: [mkTask('TASK-001')] })).not.toThrow();
  });

  it('accepts a resumePoint when an Execution Session reaches its configured turn limit', () => {
    const failure = mkErrorRecord({
      errorCode: 'CLAUDE_TURN_LIMIT_REACHED',
      errorClass: 'claude_error',
      message: 'claude reached the configured turn limit before completing the session',
    });
    const run = failedWithPoint({
      lastError: failure,
      tasks: {
        'TASK-001': mkTaskState('TASK-001', 'failed', { failure }),
      },
    });

    expect(() => assertRunJsonRules(run)).not.toThrow();
    expect(() => assertRunInvariants(run, { tasks: [mkTask('TASK-001')] })).not.toThrow();
  });

  it('accepts a resumePoint when a started Claude process exits nonzero', () => {
    const failure = mkErrorRecord({
      errorCode: 'CLAUDE_EXIT_NONZERO',
      errorClass: 'claude_error',
      message: 'claude exited with code 1',
    });
    const run = failedWithPoint({
      lastError: failure,
      tasks: {
        'TASK-001': mkTaskState('TASK-001', 'failed', { failure }),
      },
    });

    /**
     * 非零退出的 Run 仍是终态 failed；这里只验证它可以携带用户后续显式
     * 消费的恢复点，并且 Task 与 Run 必须引用同一个稳定错误码。
     */
    expect(() => assertRunJsonRules(run)).not.toThrow();
    expect(() => assertRunInvariants(run, { tasks: [mkTask('TASK-001')] })).not.toThrow();
  });

  it('accepts a planning resumePoint with a retained candidate after a result-contract failure', () => {
    /**
     * 计划复核结果契约失败：Run 终态 failed，恢复点续接 Reviewer 会话，
     * 候选草稿引用必须保留供 resume 后复核同一份草稿。
     */
    const failure = mkErrorRecord({
      errorCode: 'PLAN_REVIEW_RESULT_INVALID',
      errorClass: 'claude_error',
      stage: 'plan_review',
      taskId: null,
      message: 'approved task assessment TASK-001 requires an empty issues list',
    });
    const run = mkRun({
      status: 'failed',
      terminalAt: T1,
      lastError: failure,
      planCandidate: {
        planRevision: 1,
        plannerSessionId: UUID_1,
        specSha256: SHA256_A,
        trigger: { type: 'initial', reason: '初始计划', sourceSessionId: null },
        reviewAttempt: 1,
      },
      resumePoint: {
        fromStatus: 'planning',
        taskId: null,
        sessionId: UUID_2,
        sessionType: 'plan_review',
      },
    });

    expect(() => assertRunJsonRules(run)).not.toThrow();
    expect(() => assertRunInvariants(run, null)).not.toThrow();
  });

  it('rejects resumePoint on non-failed or differently-failed runs', () => {
    expectApexError(
      () =>
        assertRunJsonRules(
          mkRun({
            status: 'running',
            planRevision: 1,
            tasksSha256: SHA256_A,
            resumePoint: {
              fromStatus: 'running',
              taskId: null,
              sessionId: null,
              sessionType: null,
            },
          }),
        ),
      'STATE_VALIDATION_FAILED',
    );
    expectApexError(
      () =>
        assertRunJsonRules(
          failedWithPoint({
            lastError: mkErrorRecord({
              errorCode: 'GIT_COMMAND_FAILED',
              errorClass: 'git_error',
              message: 'git failed',
            }),
          }),
        ),
      'STATE_VALIDATION_FAILED',
    );
  });

  it('rejects resumePoint whose task is not the interrupted failed task', () => {
    expectApexError(
      () =>
        assertRunJsonRules(
          failedWithPoint({
            tasks: { 'TASK-001': mkTaskState('TASK-001', 'pending') },
          }),
        ),
      'STATE_VALIDATION_FAILED',
    );
    expectApexError(
      () =>
        assertRunJsonRules(
          failedWithPoint({
            resumePoint: {
              fromStatus: 'running',
              taskId: 'TASK-002',
              sessionId: UUID_1,
              sessionType: 'execution',
            },
          }),
        ),
      'STATE_VALIDATION_FAILED',
    );
  });

  it('rejects resumePoint fields that contradict the interrupted Run phase', () => {
    /**
     * Execution 的 Task / Session 是同一 activeSession 事实，不能只保留
     * 一半；Planning 与 Final Review 则从不携带 Task ID。
     */
    expectApexError(
      () =>
        assertRunJsonRules(
          failedWithPoint({
            resumePoint: {
              fromStatus: 'running',
              taskId: 'TASK-001',
              sessionId: null,
              sessionType: null,
            },
          }),
        ),
      'STATE_VALIDATION_FAILED',
    );
    expectApexError(
      () =>
        assertRunJsonRules(
          failedWithPoint({
            resumePoint: {
              fromStatus: 'planning',
              taskId: 'TASK-001',
              sessionId: UUID_1,
              sessionType: 'planning',
            },
          }),
        ),
      'STATE_VALIDATION_FAILED',
    );
  });

  it('accepts a task_review resumePoint without a session when the candidate is persisted', () => {
    /**
     * 中断落在「候选已持久化、Reviewer 尚未启动」的窗口：没有可续接的
     * Reviewer 会话，resumePoint 只携带 taskId 与 sessionType；被中断
     * Task 以 RUN_INTERRUPTED 失败并保留候选，供全新 Reviewer 复核。
     */
    const windowRun = failedWithPoint({
      resumePoint: {
        fromStatus: 'running',
        taskId: 'TASK-001',
        sessionId: null,
        sessionType: 'task_review',
      },
      tasks: {
        'TASK-001': mkTaskState('TASK-001', 'failed', {
          failure: interruptedFailure,
          candidateResult: mkResult(),
          candidateCheckpoint: OID_B,
        }),
      },
    });
    expect(() => assertRunJsonRules(windowRun)).not.toThrow();
    expect(() => assertRunInvariants(windowRun, { tasks: [mkTask('TASK-001')] })).not.toThrow();
  });

  it('rejects a session-less resumePoint unless the sessionType is task_review', () => {
    expectApexError(
      () =>
        assertRunJsonRules(
          failedWithPoint({
            resumePoint: {
              fromStatus: 'running',
              taskId: 'TASK-001',
              sessionId: null,
              sessionType: 'execution',
            },
          }),
        ),
      'STATE_VALIDATION_FAILED',
    );
  });

  it('rejects a task_review resumePoint without a taskId', () => {
    expectApexError(
      () =>
        assertRunJsonRules(
          failedWithPoint({
            resumePoint: {
              fromStatus: 'running',
              taskId: null,
              sessionId: null,
              sessionType: 'task_review',
            },
          }),
        ),
      'STATE_VALIDATION_FAILED',
    );
  });

  it('rejects a task_review resumePoint when the interrupted task lost its candidate', () => {
    expectApexError(
      () =>
        assertRunJsonRules(
          failedWithPoint({
            resumePoint: {
              fromStatus: 'running',
              taskId: 'TASK-001',
              sessionId: null,
              sessionType: 'task_review',
            },
          }),
        ),
      'STATE_VALIDATION_FAILED',
    );
  });
});

describe('Active Session rules (§11.3/§6.6)', () => {
  const base: ActiveSession = {
    sessionId: UUID_1,
    type: 'execution',
    taskId: 'TASK-001',
    planRevision: 1,
    specSha256: SHA256_A,
    startedAt: T0,
  };

  it('only execution sessions carry a taskId', () => {
    expect(() => assertActiveSessionRules(base)).not.toThrow();
    expectApexError(
      () => assertActiveSessionRules({ ...base, taskId: null }),
      'STATE_VALIDATION_FAILED',
    );
    expect(() =>
      assertActiveSessionRules({ ...base, type: 'planning', taskId: null }),
    ).not.toThrow();
    expectApexError(
      () => assertActiveSessionRules({ ...base, type: 'final_review', taskId: 'TASK-001' }),
      'STATE_VALIDATION_FAILED',
    );
  });

  it('execution activeSession must belong to currentTaskId', () => {
    const run = runningRun({
      currentTaskId: 'TASK-002',
      activeSession: base,
      tasks: {
        'TASK-001': mkTaskState('TASK-001', 'running'),
        'TASK-002': mkTaskState('TASK-002', 'pending'),
      },
    });
    expectApexError(() => assertRunJsonRules(run), 'STATE_VALIDATION_FAILED');

    const consistent = runningRun({
      currentTaskId: 'TASK-001',
      activeSession: base,
      tasks: { 'TASK-001': mkTaskState('TASK-001', 'running') },
    });
    expect(() => assertRunJsonRules(consistent)).not.toThrow();
  });

  it('currentTaskId must reference a running task', () => {
    const run = runningRun({
      currentTaskId: 'TASK-001',
      tasks: { 'TASK-001': mkTaskState('TASK-001', 'pending') },
    });
    expectApexError(() => assertRunJsonRules(run), 'STATE_VALIDATION_FAILED');
  });

  it('task_review activeSession 必须精确关联当前候选与开放复核 Episode', () => {
    const executionEpisode = {
      sessionId: UUID_1,
      taskId: 'TASK-001',
      planRevision: 1,
      specSha256Before: SHA256_A,
      specSha256After: SHA256_A,
      startedAt: T0,
      endedAt: T1,
      outcome: 'awaiting_review' as const,
      summary: '候选实现已产生',
      acceptanceEvidence: mkResult().acceptanceEvidence,
      finalCheckpoint: OID_B,
      intermediateCheckpoint: null,
      checkpointReason: '候选 Checkpoint 已创建',
      error: null,
    };
    const reviewEpisode = {
      sessionId: UUID_2,
      taskId: 'TASK-001',
      executionSessionId: UUID_1,
      candidateCheckpoint: OID_B,
      planRevision: 1,
      specSha256Before: SHA256_A,
      specSha256After: null,
      startedAt: T1,
      endedAt: null,
      outcome: null,
      summary: null,
      tests: [],
      acceptanceEvidence: [],
      issues: [],
      error: null,
    };
    const task = mkTaskState('TASK-001', 'running', {
      executionEpisodes: [executionEpisode],
      taskReviewEpisodes: [reviewEpisode],
      candidateResult: mkResult(),
      candidateCheckpoint: OID_B,
    });
    const consistent = runningRun({
      currentTaskId: 'TASK-001',
      activeSession: {
        ...base,
        sessionId: UUID_2,
        type: 'task_review',
      },
      tasks: { 'TASK-001': task },
    });
    expect(() => assertRunJsonRules(consistent)).not.toThrow();
    expectApexError(
      () =>
        assertRunJsonRules({
          ...consistent,
          tasks: {
            'TASK-001': { ...task, candidateCheckpoint: OID_C },
          },
        }),
      'STATE_VALIDATION_FAILED',
    );
  });
});

describe('Task Runtime State rules (§11.3)', () => {
  it('enforces per-status null rules', () => {
    expect(() => assertTaskRuntimeStateRules(mkTaskState('TASK-001', 'pending'))).not.toThrow();
    expect(() => assertTaskRuntimeStateRules(mkTaskState('TASK-001', 'completed'))).not.toThrow();
    expect(() => assertTaskRuntimeStateRules(mkTaskState('TASK-001', 'failed'))).not.toThrow();
    expect(() => assertTaskRuntimeStateRules(mkTaskState('TASK-001', 'skipped'))).not.toThrow();

    expectApexError(
      () =>
        assertTaskRuntimeStateRules(
          mkTaskState('TASK-001', 'pending', { completedResult: mkResult() }),
        ),
      'STATE_VALIDATION_FAILED',
    );
    expectApexError(
      () => assertTaskRuntimeStateRules(mkTaskState('TASK-001', 'completed', { finalCheckpoint: null })),
      'STATE_VALIDATION_FAILED',
    );
    expectApexError(
      () =>
        assertTaskRuntimeStateRules(
          mkTaskState('TASK-001', 'completed', {
            completedResult: mkResult({ decision: 'failed' }),
          }),
        ),
      'STATE_VALIDATION_FAILED',
    );
    expectApexError(
      () => assertTaskRuntimeStateRules(mkTaskState('TASK-001', 'failed', { failure: null })),
      'STATE_VALIDATION_FAILED',
    );
    expectApexError(
      () => assertTaskRuntimeStateRules(mkTaskState('TASK-001', 'skipped', { skipReason: null })),
      'STATE_VALIDATION_FAILED',
    );
  });

  it('pending tasks may carry execution history after replan', () => {
    const episode = {
      sessionId: UUID_1,
      taskId: 'TASK-001',
      planRevision: 1,
      specSha256Before: SHA256_A,
      specSha256After: SHA256_A,
      startedAt: T0,
      endedAt: T1,
      outcome: 'replan_required' as const,
      summary: 'needs replan',
      acceptanceEvidence: [],
      finalCheckpoint: null,
      intermediateCheckpoint: OID_C,
      checkpointReason: '已创建中间 Checkpoint',
      error: null,
    };
    const state = mkTaskState('TASK-001', 'pending', { executionEpisodes: [episode] });
    expect(() => assertTaskRuntimeStateRules(state)).not.toThrow();
  });
});

describe('cross-state invariants (§6.6)', () => {
  it('keeps current plan definitions and runtime states in exact scheduling sync', () => {
    const planned = [mkTask('TASK-001')];
    expectApexError(
      () =>
        assertRunInvariants(
          runningRun({ tasks: {} }),
          { tasks: planned },
        ),
      'STATE_VALIDATION_FAILED',
    );
    expectApexError(
      () =>
        assertRunInvariants(
          runningRun({
            tasks: {
              'TASK-001': mkTaskState('TASK-001', 'pending'),
              'TASK-002': mkTaskState('TASK-002', 'pending'),
            },
          }),
          { tasks: planned },
        ),
      'STATE_VALIDATION_FAILED',
    );
    expect(() =>
      assertRunInvariants(
        runningRun({
          tasks: {
            'TASK-001': mkTaskState('TASK-001', 'pending'),
            'TASK-002': mkTaskState('TASK-002', 'skipped'),
          },
        }),
        { tasks: planned },
      ),
    ).not.toThrow();
  });

  it('validates completed task evidence against its planned acceptance criteria', () => {
    const task = mkTask('TASK-001');
    const incompleteResult = mkResult({
      acceptanceEvidence: [
        { criterionIndex: 0, status: 'satisfied', evidence: 'only first criterion' },
      ],
    });
    const run = runningRun({
      tasks: {
        'TASK-001': mkTaskState('TASK-001', 'completed', {
          completedResult: incompleteResult,
        }),
      },
    });
    expectApexError(
      () => assertRunInvariants(run, { tasks: [task] }),
      'STATE_VALIDATION_FAILED',
    );
  });

  it('validates independent approval evidence against every planned acceptance criterion', () => {
    const task = mkTask('TASK-001');
    const completed = mkTaskState('TASK-001', 'completed');
    const approval = completed.taskReviewEpisodes[0]!;
    const run = runningRun({
      tasks: {
        'TASK-001': {
          ...completed,
          taskReviewEpisodes: [
            {
              ...approval,
              acceptanceEvidence: [
                { criterionIndex: 0, status: 'satisfied', evidence: '只覆盖第一项' },
              ],
            },
          ],
        },
      },
    });

    expectApexError(
      () => assertRunInvariants(run, { tasks: [task] }),
      'STATE_VALIDATION_FAILED',
    );
  });

  it('planning must not have a running task', () => {
    const run = mkRun({
      planRevision: 1,
      tasksSha256: SHA256_A,
      tasks: { 'TASK-001': mkTaskState('TASK-001', 'running') },
    });
    expectApexError(() => assertRunInvariants(run, { tasks: [mkTask('TASK-001')] }), 'STATE_VALIDATION_FAILED');
  });

  it('running allows at most one running task', () => {
    const run = runningRun({
      currentTaskId: 'TASK-001',
      tasks: {
        'TASK-001': mkTaskState('TASK-001', 'running'),
        'TASK-002': mkTaskState('TASK-002', 'running'),
      },
    });
    expectApexError(
      () => assertRunInvariants(run, { tasks: [mkTask('TASK-001'), mkTask('TASK-002')] }),
      'STATE_VALIDATION_FAILED',
    );
  });

  it('running requires unabsorbed checkpoints to be adopted by pending or the running task', () => {
    const checkpoint: IntermediateCheckpoint = {
      oid: OID_C,
      role: 'task-intermediate',
      sourceSessionId: UUID_2,
      taskId: 'TASK-001',
      planRevision: 1,
      summary: 'preserve work',
      ownerTaskId: 'TASK-002',
    };
    const adopted = runningRun({
      tasks: {
        'TASK-001': mkTaskState('TASK-001', 'completed'),
        'TASK-002': mkTaskState('TASK-002', 'pending'),
      },
      intermediateCheckpoints: [checkpoint],
    });
    expect(() =>
      assertRunInvariants(adopted, { tasks: [mkTask('TASK-001'), mkTask('TASK-002')] }),
    ).not.toThrow();

    const ownerless = runningRun({
      tasks: {
        'TASK-001': mkTaskState('TASK-001', 'completed'),
        'TASK-002': mkTaskState('TASK-002', 'pending'),
      },
      intermediateCheckpoints: [{ ...checkpoint, ownerTaskId: null }],
    });
    expectApexError(
      () => assertRunInvariants(ownerless, { tasks: [mkTask('TASK-001'), mkTask('TASK-002')] }),
      'STATE_VALIDATION_FAILED',
    );
  });

  it('final_review requires every plan task completed and checkpoints absorbed', () => {
    const checkpoint: IntermediateCheckpoint = {
      oid: OID_C,
      role: 'task-intermediate',
      sourceSessionId: UUID_2,
      taskId: 'TASK-002',
      planRevision: 1,
      summary: 'preserve work',
      ownerTaskId: 'TASK-002',
    };
    const ok = mkRun({
      status: 'final_review',
      planRevision: 1,
      tasksSha256: SHA256_A,
      tasks: {
        'TASK-001': mkTaskState('TASK-001', 'completed'),
        'TASK-002': mkTaskState('TASK-002', 'completed'),
      },
      intermediateCheckpoints: [checkpoint],
    });
    expect(() =>
      assertRunInvariants(ok, { tasks: [mkTask('TASK-001'), mkTask('TASK-002')] }),
    ).not.toThrow();

    const pendingLeft = mkRun({
      status: 'final_review',
      planRevision: 1,
      tasksSha256: SHA256_A,
      tasks: {
        'TASK-001': mkTaskState('TASK-001', 'completed'),
        'TASK-002': mkTaskState('TASK-002', 'pending'),
      },
      intermediateCheckpoints: [checkpoint],
    });
    expectApexError(
      () => assertRunInvariants(pendingLeft, { tasks: [mkTask('TASK-001'), mkTask('TASK-002')] }),
      'STATE_VALIDATION_FAILED',
    );
  });

  it('failed/abandoned runs must not have a running task', () => {
    for (const status of ['failed', 'abandoned'] as const) {
      const run = mkRun({
        status,
        planRevision: 1,
        tasksSha256: SHA256_A,
        terminalAt: T1,
        tasks: { 'TASK-001': mkTaskState('TASK-001', 'running') },
      });
      expectApexError(
        () => assertRunInvariants(run, { tasks: [mkTask('TASK-001')] }),
        'STATE_VALIDATION_FAILED',
      );
    }
  });

  it('completed requires all current tasks and an exact completed Final Review', () => {
    const plan = { tasks: [mkTask('TASK-001'), mkTask('TASK-002')] };
    const completedBase: Partial<RunJson> = {
      status: 'completed',
      planRevision: 1,
      tasksSha256: SHA256_A,
      terminalAt: T1,
      finalCommit: OID_B,
      reportPath: 'reports/run.md',
      tasks: {
        'TASK-001': mkTaskState('TASK-001', 'completed'),
        'TASK-002': mkTaskState('TASK-002', 'completed'),
      },
      finalReviewEpisodes: [completedFinalReview(['TASK-001', 'TASK-002'])],
    };
    expect(() => assertRunInvariants(mkRun(completedBase), plan)).not.toThrow();

    expectApexError(
      () =>
        assertRunInvariants(
          mkRun({
            ...completedBase,
            tasks: {
              'TASK-001': mkTaskState('TASK-001', 'completed'),
              'TASK-002': mkTaskState('TASK-002', 'pending'),
            },
          }),
          plan,
        ),
      'STATE_VALIDATION_FAILED',
    );
    expectApexError(
      () =>
        assertRunInvariants(
          mkRun({
            ...completedBase,
            finalReviewEpisodes: [completedFinalReview(['TASK-001'])],
          }),
          plan,
        ),
      'STATE_VALIDATION_FAILED',
    );
    expectApexError(
      () =>
        assertRunInvariants(
          mkRun({
            ...completedBase,
            finalReviewEpisodes: [],
          }),
          plan,
        ),
      'STATE_VALIDATION_FAILED',
    );
  });
});

describe('Intermediate Checkpoint rules (§11.3)', () => {
  const base: IntermediateCheckpoint = {
    oid: OID_C,
    role: 'task-intermediate',
    sourceSessionId: UUID_1,
    taskId: 'TASK-001',
    planRevision: 1,
    summary: 'preserve work',
    ownerTaskId: null,
  };

  it('couples the role with taskId presence', () => {
    expect(() => assertIntermediateCheckpointRules(base)).not.toThrow();
    expectApexError(
      () => assertIntermediateCheckpointRules({ ...base, taskId: null }),
      'STATE_VALIDATION_FAILED',
    );
    expect(() =>
      assertIntermediateCheckpointRules({ ...base, role: 'final-review-intermediate', taskId: null }),
    ).not.toThrow();
    expectApexError(
      () =>
        assertIntermediateCheckpointRules({ ...base, role: 'final-review-intermediate' }),
      'STATE_VALIDATION_FAILED',
    );
  });

  it('run-level: ownerTaskId must reference a known task', () => {
    const run = runningRun({
      tasks: { 'TASK-001': mkTaskState('TASK-001', 'pending') },
      intermediateCheckpoints: [{ ...base, ownerTaskId: 'TASK-099' }],
    });
    expectApexError(() => assertRunJsonRules(run), 'STATE_VALIDATION_FAILED');
  });
});

describe('Session Record rules (§11.4)', () => {
  function mkSessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
      schemaVersion: 1,
      sessionId: UUID_1,
      type: 'execution',
      status: 'completed',
      runId: RUN_ID,
      taskId: 'TASK-001',
      planRevision: 1,
      specSha256: SHA256_A,
      startedAt: T0,
      endedAt: T1,
      claude: { version: '2.0.0', model: null, provider: null },
      exitCode: 0,
      structuredResult: mkResult(),
      logPath: `logs/${UUID_1}.log`,
      error: null,
      ...overrides,
    };
  }

  it('completed requires exitCode 0, structuredResult and null error', () => {
    expect(() => assertSessionRecordRules(mkSessionRecord())).not.toThrow();
    expectApexError(
      () => assertSessionRecordRules(mkSessionRecord({ error: mkErrorRecord() })),
      'STATE_VALIDATION_FAILED',
    );
    expectApexError(
      () => assertSessionRecordRules(mkSessionRecord({ structuredResult: null })),
      'STATE_VALIDATION_FAILED',
    );
    expectApexError(
      () => assertSessionRecordRules(mkSessionRecord({ exitCode: 1 })),
      'STATE_VALIDATION_FAILED',
    );
  });

  it('failed requires an Error Record and null structuredResult; missing numeric exits are explicit', () => {
    const failed = mkSessionRecord({
      status: 'failed',
      exitCode: null,
      structuredResult: null,
      error: mkErrorRecord({ errorCode: 'CLAUDE_START_FAILED', errorClass: 'claude_error' }),
    });
    expect(() => assertSessionRecordRules(failed)).not.toThrow();
    const signalTerminated = mkSessionRecord({
      status: 'failed',
      exitCode: null,
      structuredResult: null,
      error: mkErrorRecord({ errorCode: 'CLAUDE_EXIT_NONZERO' }),
    });
    expect(() => assertSessionRecordRules(signalTerminated)).not.toThrow();
    const interrupted = mkSessionRecord({
      status: 'failed',
      exitCode: null,
      structuredResult: null,
      error: mkErrorRecord({
        errorCode: 'RUN_INTERRUPTED',
        errorClass: 'run_error',
      }),
    });
    expect(() => assertSessionRecordRules(interrupted)).not.toThrow();
    expectApexError(
      () => assertSessionRecordRules(mkSessionRecord({ status: 'failed', error: mkErrorRecord() })),
      'STATE_VALIDATION_FAILED',
    );
    expectApexError(
      () =>
        assertSessionRecordRules(
          mkSessionRecord({ status: 'failed', structuredResult: null, error: null }),
        ),
      'STATE_VALIDATION_FAILED',
    );
    expectApexError(
      () =>
        assertSessionRecordRules(
          mkSessionRecord({
            status: 'failed',
            exitCode: null,
            structuredResult: null,
            error: mkErrorRecord({ errorCode: 'CLAUDE_RESULT_INVALID' }),
          }),
        ),
      'STATE_VALIDATION_FAILED',
    );
    expectApexError(
      () =>
        assertSessionRecordRules(
          mkSessionRecord({
            status: 'failed',
            exitCode: 1,
            structuredResult: null,
            error: mkErrorRecord({
              errorCode: 'CLAUDE_START_FAILED',
              errorClass: 'claude_error',
            }),
          }),
        ),
      'STATE_VALIDATION_FAILED',
    );
  });

  it('allows exitCode null when the coordinator abandons the session relay', () => {
    /**
     * SPEC abandon 流程要求写入 exitCode 为 null、错误码为
     * RUN_ABANDONED_BY_USER 的失败 Session Record：不声称旧进程已经
     * 退出，也不得伪造退出码。
     */
    const abandoned = mkSessionRecord({
      status: 'failed',
      exitCode: null,
      structuredResult: null,
      error: mkErrorRecord({
        errorCode: 'RUN_ABANDONED_BY_USER',
        errorClass: 'run_control',
      }),
    });
    expect(() => assertSessionRecordRules(abandoned)).not.toThrow();
    expectApexError(
      () =>
        assertSessionRecordRules(
          mkSessionRecord({
            status: 'failed',
            exitCode: 1,
            structuredResult: null,
            error: mkErrorRecord({
              errorCode: 'RUN_ABANDONED_BY_USER',
              errorClass: 'run_control',
            }),
          }),
        ),
      'STATE_VALIDATION_FAILED',
    );
  });

  it('planning/final_review records must have taskId null', () => {
    expectApexError(
      () => assertSessionRecordRules(mkSessionRecord({ type: 'planning' })),
      'STATE_VALIDATION_FAILED',
    );
    expect(() =>
      assertSessionRecordRules(
        mkSessionRecord({
          type: 'final_review',
          taskId: null,
          structuredResult: {
            decision: 'completed',
            summary: 'ok',
            reviewedTaskIds: ['TASK-001'],
            tests: [],
            changedAreas: [],
            remainingRisks: [],
            replanReason: null,
          },
        }),
      ),
    ).not.toThrow();
  });

  it('structuredResult must match the session type', () => {
    // Execution record carrying a TaskPlanDraft-shaped result.
    expectApexError(
      () =>
        assertSessionRecordRules(
          mkSessionRecord({
            structuredResult: {
              summary: 'plan',
              assumptions: [],
              retainedCheckpointDispositions: [],
              tasks: [mkTask('TASK-001')],
            },
          }),
        ),
      'STATE_VALIDATION_FAILED',
    );
  });
});

describe('Error Record rules (§15.3)', () => {
  it('errorClass must be the class derived from errorCode', () => {
    expect(() => assertErrorRecordRules(mkErrorRecord())).not.toThrow();
    expectApexError(
      () => assertErrorRecordRules(mkErrorRecord({ errorClass: 'state_error' })),
      'STATE_VALIDATION_FAILED',
    );
  });
});

describe('Planning 瞬态事实规则（planCandidate/planReviewFeedback）', () => {
  const OTHER_SHA256 = 'c'.repeat(64);
  const candidate = {
    planRevision: 1,
    plannerSessionId: UUID_1,
    specSha256: SHA256_A,
    trigger: { type: 'initial' as const, reason: 'initial plan', sourceSessionId: null },
    reviewAttempt: 1,
  };
  const feedback = {
    planRevision: 1,
    plannerSessionId: UUID_1,
    reviewerSessionId: UUID_2,
    reviewAttempt: 1,
  };
  const interruptedPlanning = {
    status: 'failed' as const,
    terminalAt: T1,
    lastError: mkErrorRecord({
      errorCode: 'RUN_INTERRUPTED',
      errorClass: 'run_error',
      stage: 'planning',
      sessionId: null,
      taskId: null,
    }),
  };

  it('planning 状态允许携带指向下一个 Revision 的候选或反馈', () => {
    expect(() => assertRunJsonRules(mkRun({ planCandidate: candidate }))).not.toThrow();
    expect(() => assertRunJsonRules(mkRun({ planReviewFeedback: feedback }))).not.toThrow();
  });

  it('候选与反馈互斥，不得同时存在', () => {
    expectApexError(
      () =>
        assertRunJsonRules(
          mkRun({ planCandidate: candidate, planReviewFeedback: feedback }),
        ),
      'STATE_VALIDATION_FAILED',
    );
  });

  it('planning 与 RUN_INTERRUPTED 终态之外不得携带瞬态 Planning 事实', () => {
    expectApexError(
      () => assertRunJsonRules(runningRun({ planCandidate: candidate })),
      'STATE_VALIDATION_FAILED',
    );
    expectApexError(
      () =>
        assertRunJsonRules(
          mkRun({ status: 'abandoned', terminalAt: T1, planReviewFeedback: feedback }),
        ),
      'STATE_VALIDATION_FAILED',
    );
    expectApexError(
      () =>
        assertRunJsonRules(
          mkRun({
            status: 'failed',
            terminalAt: T1,
            planCandidate: candidate,
            lastError: mkErrorRecord({
              errorCode: 'PLAN_INVALID',
              errorClass: 'plan_error',
              stage: 'planning',
              sessionId: null,
              taskId: null,
            }),
          }),
        ),
      'STATE_VALIDATION_FAILED',
    );
  });

  it('RUN_INTERRUPTED 终态且恢复点为 planning 时可携带候选供 resume 消费', () => {
    expect(() =>
      assertRunJsonRules(
        mkRun({
          ...interruptedPlanning,
          planCandidate: candidate,
          resumePoint: {
            fromStatus: 'planning',
            taskId: null,
            sessionId: null,
            sessionType: null,
          },
        }),
      ),
    ).not.toThrow();
  });

  it('候选与反馈必须指向下一个尚未提交的 Revision', () => {
    expectApexError(
      () => assertRunJsonRules(mkRun({ planCandidate: { ...candidate, planRevision: 2 } })),
      'STATE_VALIDATION_FAILED',
    );
    expectApexError(
      () =>
        assertRunJsonRules(mkRun({ planReviewFeedback: { ...feedback, planRevision: 3 } })),
      'STATE_VALIDATION_FAILED',
    );
  });

  it('plan_review 活动会话必须精确匹配已持久化候选', () => {
    const session: ActiveSession = {
      sessionId: UUID_2,
      type: 'plan_review',
      taskId: null,
      planRevision: 1,
      specSha256: SHA256_A,
      startedAt: T0,
    };
    expect(() =>
      assertRunJsonRules(mkRun({ planCandidate: candidate, activeSession: session })),
    ).not.toThrow();
    expectApexError(
      () =>
        assertRunJsonRules(
          mkRun({
            planCandidate: candidate,
            activeSession: { ...session, specSha256: OTHER_SHA256 },
          }),
        ),
      'STATE_VALIDATION_FAILED',
    );
    expectApexError(
      () => assertRunJsonRules(mkRun({ activeSession: session })),
      'STATE_VALIDATION_FAILED',
    );
  });

  it('planning 活动会话不得与已持久化候选共存', () => {
    const session: ActiveSession = {
      sessionId: UUID_1,
      type: 'planning',
      taskId: null,
      planRevision: 1,
      specSha256: SHA256_A,
      startedAt: T0,
    };
    expect(() => assertRunJsonRules(mkRun({ activeSession: session }))).not.toThrow();
    expectApexError(
      () => assertRunJsonRules(mkRun({ planCandidate: candidate, activeSession: session })),
      'STATE_VALIDATION_FAILED',
    );
  });

  it('planning resumePoint 允许 planning 或 plan_review 会话类型', () => {
    expect(() =>
      assertRunJsonRules(
        mkRun({
          ...interruptedPlanning,
          planCandidate: candidate,
          resumePoint: {
            fromStatus: 'planning',
            taskId: null,
            sessionId: UUID_2,
            sessionType: 'plan_review',
          },
        }),
      ),
    ).not.toThrow();
    expectApexError(
      () =>
        assertRunJsonRules(
          mkRun({
            ...interruptedPlanning,
            resumePoint: {
              fromStatus: 'planning',
              taskId: null,
              sessionId: UUID_2,
              sessionType: 'final_review',
            },
          }),
        ),
      'STATE_VALIDATION_FAILED',
    );
  });
});
