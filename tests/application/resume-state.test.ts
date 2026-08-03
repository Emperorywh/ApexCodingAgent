/**
 * resume 的恢复点合成与重开策略（§17 resume + §2.4 崩溃接管）：
 * 「候选已持久化、Reviewer 尚未启动」窗口的非终态 Run 由 classifyResumeRun
 * 合成 sessionId 为 null 的 task_review 恢复点；reopenRun 据此把被中断
 * Task 复位为 running 并保留候选，由全新 Reviewer 复核。
 */
import { describe, expect, it } from 'vitest';
import {
  classifyResumeRun,
  reopenRun,
} from '../../src/application/usecases/resume-state.js';
import type { ResumePoint, RunJson } from '../../src/domain/schemas/run-json.js';
import {
  mkErrorRecord,
  mkResult,
  mkRun,
  mkTaskState,
  OID_B,
  OID_C,
  SHA256_A,
  T1,
} from '../domain/fixtures.js';

const REVIEW_POINT: ResumePoint = {
  fromStatus: 'running',
  taskId: 'TASK-001',
  sessionId: null,
  sessionType: 'task_review',
};

/** 窗口形状：候选已持久化、Reviewer 尚未启动（无 activeSession）。 */
function windowRun(overrides: Partial<RunJson> = {}): RunJson {
  return mkRun({
    status: 'running',
    planRevision: 1,
    tasksSha256: SHA256_A,
    currentTaskId: 'TASK-001',
    activeSession: null,
    tasks: {
      'TASK-001': mkTaskState('TASK-001', 'running', {
        candidateResult: mkResult(),
        candidateCheckpoint: OID_B,
      }),
    },
    ...overrides,
  });
}

describe('classifyResumeRun 预复核窗口（§17 resume）', () => {
  const presumedDead = {
    kind: 'presumed_dead',
    at: '2026-01-01T00:00:00.000Z',
    ageMs: 60_000,
  } as const;

  it('synthesizes a session-less task_review point with --force', () => {
    const classification = classifyResumeRun(windowRun(), true, { kind: 'unknown' });
    expect(classification.point).toEqual(REVIEW_POINT);
    expect(classification.requiresOrphanReconciliation).toBe(true);
  });

  it('synthesizes the same point for a presumed-dead owner without --force', () => {
    const classification = classifyResumeRun(windowRun(), false, presumedDead);
    expect(classification.point).toEqual(REVIEW_POINT);
    expect(classification.liveness).toBe(presumedDead);
  });

  it('keeps a null sessionType when the current task carries no candidate', () => {
    const run = windowRun({
      tasks: { 'TASK-001': mkTaskState('TASK-001', 'running') },
    });
    const classification = classifyResumeRun(run, true, { kind: 'unknown' });
    expect(classification.point).toEqual({
      fromStatus: 'running',
      taskId: 'TASK-001',
      sessionId: null,
      sessionType: null,
    });
  });
});

describe('reopenRun task_review 恢复点', () => {
  it('reopens the interrupted failed task as running and keeps its candidate', () => {
    const interruptedFailure = mkErrorRecord({
      errorCode: 'RUN_INTERRUPTED',
      errorClass: 'run_error',
      message: 'foreground interrupt requested',
    });
    const original = windowRun({
      status: 'failed',
      terminalAt: T1,
      lastError: interruptedFailure,
      resumePoint: REVIEW_POINT,
      tasks: {
        'TASK-001': mkTaskState('TASK-001', 'failed', {
          failure: interruptedFailure,
          candidateResult: mkResult(),
          candidateCheckpoint: OID_B,
        }),
      },
    });
    const reopened = reopenRun(original, original, REVIEW_POINT, OID_C, T1);
    expect(reopened.status).toBe('running');
    expect(reopened.currentTaskId).toBe('TASK-001');
    expect(reopened.activeSession).toBeNull();
    expect(reopened.resumePoint).toBeNull();
    expect(reopened.lastError).toBeNull();
    expect(reopened.terminalAt).toBeNull();
    expect(reopened.stateRevision).toBe(original.stateRevision + 1);
    expect(reopened.repository.expectedHead).toBe(OID_C);
    const task = reopened.tasks['TASK-001']!;
    expect(task.status).toBe('running');
    expect(task.failure).toBeNull();
    expect(task.candidateResult).not.toBeNull();
    expect(task.candidateCheckpoint).toBe(OID_B);
  });

  it('keeps a still-running task with its candidate for a crashed run', () => {
    const crashed = windowRun();
    const reopened = reopenRun(crashed, crashed, REVIEW_POINT, OID_C, T1);
    expect(reopened.status).toBe('running');
    expect(reopened.currentTaskId).toBe('TASK-001');
    const task = reopened.tasks['TASK-001']!;
    expect(task.status).toBe('running');
    expect(task.failure).toBeNull();
    expect(task.candidateResult).not.toBeNull();
    expect(task.candidateCheckpoint).toBe(OID_B);
  });
});
