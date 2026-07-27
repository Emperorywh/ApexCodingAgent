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

describe('run.json conditional rules (§11.3)', () => {
  it('accepts the initial planning shape (planRevision 0, no tasks)', () => {
    expect(() => assertRunJsonRules(mkRun())).not.toThrow();
    expect(() => assertRunInvariants(mkRun(), null)).not.toThrow();
  });

  it('couples planRevision 0 with tasksSha256 null and planning status', () => {
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

  it('failed requires an Error Record and null structuredResult; exitCode may be null on start failure', () => {
    const failed = mkSessionRecord({
      status: 'failed',
      exitCode: null,
      structuredResult: null,
      error: mkErrorRecord({ errorCode: 'CLAUDE_START_FAILED', errorClass: 'claude_error' }),
    });
    expect(() => assertSessionRecordRules(failed)).not.toThrow();
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
