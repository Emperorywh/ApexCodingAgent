/**
 * Shared fixtures for adapter tests: builders for the persisted aggregates
 * (tasks.json, Plan Revision Snapshot, Session Record) plus commit helpers.
 * Reuses the deterministic domain fixtures.
 */
import { expect } from 'vitest';
import { ApexError, type ErrorCode } from '../../src/domain/errors.js';
import type { PlanRevisionSnapshot } from '../../src/domain/schemas/plan-revision-snapshot.js';
import type { RunJson } from '../../src/domain/schemas/run-json.js';
import type { SessionRecord } from '../../src/domain/schemas/session-record.js';
import type { PlannedTask } from '../../src/domain/schemas/task-plan-draft.js';
import type { TasksJson } from '../../src/domain/schemas/tasks-json.js';
import {
  mkResult,
  mkRun,
  mkTask,
  mkTaskState,
  RUN_ID,
  SHA256_A,
  T0,
  T1,
  UUID_1,
  UUID_2,
} from '../domain/fixtures.js';

export const STATE_DIR = '/repo/.apex-coding-agent';
export const RUN_PATH = `${STATE_DIR}/run.json`;
export const TASKS_PATH = `${STATE_DIR}/tasks.json`;
export const SNAPSHOT_PATH = (planRevision: number): string =>
  `${STATE_DIR}/plans/${planRevision}.json`;
export const SESSION_PATH = (sessionId: string): string =>
  `${STATE_DIR}/sessions/${sessionId}.json`;

/** Async counterpart of the domain `expectApexError` helper. */
export async function expectApexErrorAsync(
  fn: () => Promise<unknown>,
  code: ErrorCode,
): Promise<ApexError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApexError);
    expect((error as ApexError).errorCode).toBe(code);
    return error as ApexError;
  }
  throw new Error(`expected ApexError with code ${code}, but nothing was thrown`);
}

export const DEFAULT_PLAN_TASKS: PlannedTask[] = [
  mkTask('TASK-001'),
  mkTask('TASK-002', ['TASK-001']),
];

export function mkTasks(planRevision = 1, tasks: PlannedTask[] = DEFAULT_PLAN_TASKS): TasksJson {
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    planRevision,
    specPath: 'docs/SPEC.md',
    specSha256: SHA256_A,
    generatedAt: T0,
    plannerSessionId: UUID_1,
    planReviewerSessionId: UUID_2,
    summary: 'Plan summary',
    assumptions: [],
    retainedCheckpointDispositions: [],
    tasks,
  };
}

export function mkSnapshot(
  planRevision = 1,
  tasks: PlannedTask[] = DEFAULT_PLAN_TASKS,
): PlanRevisionSnapshot {
  /**
   * 首版计划由 initial 触发且没有来源 Session；后续通用夹具使用
   * spec_changed，避免测试数据绕过 Revision 与触发来源的领域约束。
   */
  const trigger: PlanRevisionSnapshot['trigger'] =
    planRevision === 1
      ? { type: 'initial', reason: 'initial planning', sourceSessionId: null }
      : { type: 'spec_changed', reason: 'spec changed', sourceSessionId: null };
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    planRevision,
    parentPlanRevision: planRevision === 1 ? null : planRevision - 1,
    trigger,
    specPath: 'docs/SPEC.md',
    specSha256: SHA256_A,
    generatedAt: T0,
    plannerSessionId: UUID_1,
    planReviewerSessionId: UUID_2,
    summary: 'Plan summary',
    assumptions: [],
    retainedCheckpointDispositions: [],
    tasks,
  };
}

export function mkSessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
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
    claude: { version: '1.2.3', model: 'claude-test-model', provider: null },
    exitCode: 0,
    structuredResult: mkResult(),
    logPath: `logs/${UUID_1}.log`,
    error: null,
    ...overrides,
  };
}

/**
 * The `run` part of a PlanRevisionCommit (tasksSha256 is stamped by the
 * store). Defaults to a `running` run whose plan tasks are all pending.
 */
export function mkCommittedRun(
  planRevision: number,
  stateRevision: number,
  overrides: Partial<RunJson> = {},
): Omit<RunJson, 'tasksSha256'> {
  const run = mkRun({
    status: 'running',
    planRevision,
    stateRevision,
    tasks: Object.fromEntries(
      DEFAULT_PLAN_TASKS.map((task) => [task.id, mkTaskState(task.id, 'pending')]),
    ),
    ...overrides,
  });
  const { tasksSha256: _stampedByStore, ...rest } = run;
  return rest;
}
