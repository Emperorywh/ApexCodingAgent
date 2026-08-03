/**
 * Task state machine (SPEC §6.2): every legal transition with its unique
 * legal reasons, illegal transitions, wrong-reason rejection — plus Ready
 * Task selection (§9.1) and the abandon-time running-task handling.
 */
import { describe, expect, it } from 'vitest';
import {
  assertTaskTransition,
  canTaskTransition,
  legalTaskTransitionReasons,
  selectReadyTask,
  selectTaskAwaitingReview,
  TASK_TRANSITIONS,
  TERMINAL_TASK_STATUSES,
  type TaskStatus,
  type TaskTransitionReason,
} from '../../src/domain/task-state.js';
import { TASK_STATUSES } from '../../src/domain/schemas/task-runtime-state.js';
import { expectApexError, mkResult, mkTask, mkTaskState, OID_B } from './fixtures.js';

const LEGAL: ReadonlyArray<readonly [TaskStatus, TaskStatus, readonly TaskTransitionReason[]]> = [
  ['pending', 'running', ['orchestrator_selected']],
  ['pending', 'skipped', ['plan_revision_omitted']],
  [
    'running',
    'pending',
    ['replan_required', 'spec_changed', 'review_changes_required', 'run_resumed'],
  ],
  ['running', 'completed', ['review_approved']],
  [
    'running',
    'failed',
    [
      'claude_call_failed',
      'reported_failure',
      'result_invalid',
      'checkpoint_failed',
      'run_interrupted',
      'run_abandoned',
    ],
  ],
  // resume 命令专用：被中断/崩溃接管的 Task 复位后重新参与调度。
  ['failed', 'pending', ['run_resumed']],
  ['failed', 'running', ['run_resumed']],
];

const ALL_REASONS: TaskTransitionReason[] = [
  'orchestrator_selected',
  'plan_revision_omitted',
  'replan_required',
  'spec_changed',
  'review_approved',
  'review_changes_required',
  'claude_call_failed',
  'reported_failure',
  'result_invalid',
  'checkpoint_failed',
  'run_interrupted',
  'run_abandoned',
  'run_resumed',
];

describe('Task state machine (§6.2)', () => {
  it('has exactly five statuses and three terminal statuses', () => {
    expect(TASK_STATUSES).toHaveLength(5);
    expect(TERMINAL_TASK_STATUSES).toEqual(['completed', 'failed', 'skipped']);
  });

  it.each(LEGAL)('allows %s -> %s for exactly its legal reasons', (from, to, reasons) => {
    expect(canTaskTransition(from, to)).toBe(true);
    expect(legalTaskTransitionReasons(from, to)).toEqual(reasons);
    for (const reason of reasons) {
      expect(() => assertTaskTransition(from, to, reason)).not.toThrow();
    }
  });

  it('rejects transitions out of terminal statuses (failed 仅有 resume 复位出口)', () => {
    for (const from of TERMINAL_TASK_STATUSES) {
      const expected: readonly TaskStatus[] = from === 'failed' ? ['pending', 'running'] : [];
      expect(TASK_TRANSITIONS[from]).toEqual(expected);
      for (const to of TASK_STATUSES) {
        expect(canTaskTransition(from, to)).toBe(expected.includes(to));
      }
    }
  });

  it('rejects illegal transitions even with a plausible reason', () => {
    const illegal: ReadonlyArray<readonly [TaskStatus, TaskStatus]> = [
      ['pending', 'completed'],
      ['pending', 'failed'],
      ['running', 'skipped'],
      ['completed', 'pending'],
      ['skipped', 'pending'],
      ['failed', 'completed'],
      ['failed', 'skipped'],
    ];
    for (const [from, to] of illegal) {
      for (const reason of ALL_REASONS) {
        expectApexError(() => assertTaskTransition(from, to, reason), 'STATE_VALIDATION_FAILED');
      }
    }
  });

  it('rejects legal transitions carrying a wrong reason', () => {
    const wrongReasonCases: ReadonlyArray<
      readonly [TaskStatus, TaskStatus, TaskTransitionReason]
    > = [
      ['pending', 'running', 'replan_required'],
      ['pending', 'skipped', 'run_abandoned'],
      ['running', 'pending', 'orchestrator_selected'],
      ['running', 'completed', 'spec_changed'],
      ['running', 'failed', 'review_approved'],
      ['running', 'failed', 'plan_revision_omitted'],
      ['running', 'pending', 'run_interrupted'],
      ['failed', 'pending', 'run_interrupted'],
      ['failed', 'pending', 'claude_call_failed'],
    ];
    for (const [from, to, reason] of wrongReasonCases) {
      expectApexError(() => assertTaskTransition(from, to, reason), 'STATE_VALIDATION_FAILED');
    }
  });

  it('abandon handling: run_abandoned fails a running task but nothing else', () => {
    expect(() => assertTaskTransition('running', 'failed', 'run_abandoned')).not.toThrow();
    expectApexError(
      () => assertTaskTransition('pending', 'failed', 'run_abandoned'),
      'STATE_VALIDATION_FAILED',
    );
    expectApexError(
      () => assertTaskTransition('running', 'pending', 'run_abandoned'),
      'STATE_VALIDATION_FAILED',
    );
  });
});

describe('Ready Task selection (§9.1, §6.2 run conditions)', () => {
  it('returns null when the Run is not running', () => {
    const plan = [mkTask('TASK-001')];
    const states = { 'TASK-001': mkTaskState('TASK-001', 'pending') };
    expect(selectReadyTask('planning', plan, states)).toBeNull();
    expect(selectReadyTask('final_review', plan, states)).toBeNull();
    expect(selectReadyTask('failed', plan, states)).toBeNull();
  });

  it('returns null while another task is running (top-level concurrency is 1)', () => {
    const plan = [mkTask('TASK-001'), mkTask('TASK-002')];
    const states = {
      'TASK-001': mkTaskState('TASK-001', 'running'),
      'TASK-002': mkTaskState('TASK-002', 'pending'),
    };
    expect(selectReadyTask('running', plan, states)).toBeNull();
  });

  it('selects the first runnable task in stable tasks.json order', () => {
    const plan = [mkTask('TASK-001'), mkTask('TASK-002'), mkTask('TASK-003')];
    const states = {
      'TASK-001': mkTaskState('TASK-001', 'pending'),
      'TASK-002': mkTaskState('TASK-002', 'pending'),
      'TASK-003': mkTaskState('TASK-003', 'pending'),
    };
    expect(selectReadyTask('running', plan, states)).toBe('TASK-001');
  });

  it('requires every dependsOn task to be completed', () => {
    const plan = [mkTask('TASK-001'), mkTask('TASK-002', ['TASK-001']), mkTask('TASK-003')];
    const pendingStates = {
      'TASK-001': mkTaskState('TASK-001', 'pending'),
      'TASK-002': mkTaskState('TASK-002', 'pending'),
      'TASK-003': mkTaskState('TASK-003', 'pending'),
    };
    expect(selectReadyTask('running', plan, pendingStates)).toBe('TASK-001');

    const firstCompleted = {
      ...pendingStates,
      'TASK-001': mkTaskState('TASK-001', 'completed'),
    };
    expect(selectReadyTask('running', plan, firstCompleted)).toBe('TASK-002');

    const chainBlocked = {
      ...firstCompleted,
      'TASK-003': mkTaskState('TASK-003', 'completed'),
    };
    expect(selectReadyTask('running', plan, chainBlocked)).toBe('TASK-002');
  });

  it('skips pending tasks with unmet dependencies and keeps stable order', () => {
    const plan = [mkTask('TASK-001', ['TASK-002']), mkTask('TASK-002'), mkTask('TASK-003')];
    const states = {
      'TASK-001': mkTaskState('TASK-001', 'pending'),
      'TASK-002': mkTaskState('TASK-002', 'pending'),
      'TASK-003': mkTaskState('TASK-003', 'pending'),
    };
    // TASK-001 is blocked on TASK-002; TASK-002 is the first runnable.
    expect(selectReadyTask('running', plan, states)).toBe('TASK-002');
  });

  it('a skipped dependency does not satisfy dependsOn', () => {
    const plan = [mkTask('TASK-001', ['TASK-002'])];
    const states = {
      'TASK-001': mkTaskState('TASK-001', 'pending'),
      'TASK-002': mkTaskState('TASK-002', 'skipped'),
    };
    expect(selectReadyTask('running', plan, states)).toBeNull();
  });

  it('returns null when everything is completed', () => {
    const plan = [mkTask('TASK-001')];
    const states = { 'TASK-001': mkTaskState('TASK-001', 'completed') };
    expect(selectReadyTask('running', plan, states)).toBeNull();
  });
});

describe('selectTaskAwaitingReview（候选复核选择）', () => {
  const withCandidate = (taskId: string) =>
    mkTaskState(taskId, 'running', {
      candidateResult: mkResult(),
      candidateCheckpoint: OID_B,
    });

  it('returns the only running task carrying a complete candidate', () => {
    const states = {
      'TASK-001': mkTaskState('TASK-001', 'pending'),
      'TASK-002': withCandidate('TASK-002'),
    };
    expect(selectTaskAwaitingReview(states)).toBe('TASK-002');
  });

  it('returns null when no task carries a candidate', () => {
    const states = { 'TASK-001': mkTaskState('TASK-001', 'running') };
    expect(selectTaskAwaitingReview(states)).toBeNull();
  });

  it('returns null when more than one candidate exists (serial scheduling fact broken)', () => {
    const states = {
      'TASK-001': withCandidate('TASK-001'),
      'TASK-002': withCandidate('TASK-002'),
    };
    expect(selectTaskAwaitingReview(states)).toBeNull();
  });

  it('ignores candidates carried by non-running tasks', () => {
    // 候选只允许出现在 running Task；选择器对越界形状保持防御，不选中。
    const states = {
      'TASK-001': mkTaskState('TASK-001', 'pending', {
        candidateResult: mkResult(),
        candidateCheckpoint: OID_B,
      }),
    };
    expect(selectTaskAwaitingReview(states)).toBeNull();
  });
});
