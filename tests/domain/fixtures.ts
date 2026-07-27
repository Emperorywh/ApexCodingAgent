/**
 * Shared fixtures and helpers for domain unit tests. Every value is a fixed,
 * deterministic constant; no randomness, no I/O.
 */
import { expect } from 'vitest';
import { ApexError, type ErrorCode } from '../../src/domain/errors.js';
import type { ErrorRecord } from '../../src/domain/schemas/error-record.js';
import type {
  CheckpointDisposition,
  PlannedTask,
  TaskPlanDraft,
} from '../../src/domain/schemas/task-plan-draft.js';
import type { TaskExecutionResult } from '../../src/domain/schemas/task-execution-result.js';
import type { TaskRuntimeState, TaskStatus } from '../../src/domain/schemas/task-runtime-state.js';
import type { RunJson } from '../../src/domain/schemas/run-json.js';

export const UUID_1 = '123e4567-e89b-42d3-a456-426614174000';
export const UUID_2 = '123e4567-e89b-42d3-a456-426614174001';
export const UUID_3 = '123e4567-e89b-42d3-a456-426614174002';
export const RUN_ID = 'RUN-123e4567-e89b-42d3-a456-426614174000';
export const SHA256_A = 'a'.repeat(64);
export const SHA256_C = 'c'.repeat(64);
export const OID_B = 'b'.repeat(40);
export const OID_C = 'c'.repeat(40);
export const OID_D = 'd'.repeat(40);
export const T0 = '2026-01-01T00:00:00Z';
export const T1 = '2026-01-01T01:00:00Z';

/** Asserts that fn throws an ApexError carrying the expected stable error code. */
export function expectApexError(fn: () => unknown, code: ErrorCode): ApexError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApexError);
    expect((error as ApexError).errorCode).toBe(code);
    return error as ApexError;
  }
  throw new Error(`expected ApexError with code ${code}, but nothing was thrown`);
}

export function mkTask(
  id: string,
  dependsOn: string[] = [],
  overrides: Partial<PlannedTask> = {},
): PlannedTask {
  return {
    id,
    title: `Title ${id}`,
    objective: `Objective ${id}`,
    dependsOn,
    acceptanceCriteria: [`AC-1 of ${id}`, `AC-2 of ${id}`],
    verificationHints: [],
    likelyPaths: [],
    estimatedSize: 'medium',
    context: `Context ${id}`,
    ...overrides,
  };
}

export function mkDraft(
  tasks: PlannedTask[],
  dispositions: CheckpointDisposition[] = [],
): TaskPlanDraft {
  return {
    summary: 'Overall implementation goal',
    assumptions: [],
    retainedCheckpointDispositions: dispositions,
    tasks,
  };
}

export function mkResult(overrides: Partial<TaskExecutionResult> = {}): TaskExecutionResult {
  return {
    decision: 'completed',
    summary: 'Work completed',
    tests: [{ command: 'npm test', result: 'passed' }],
    acceptanceEvidence: [
      { criterionIndex: 0, status: 'satisfied', evidence: 'evidence for AC-1' },
      { criterionIndex: 1, status: 'satisfied', evidence: 'evidence for AC-2' },
    ],
    changedAreas: [],
    remainingRisks: [],
    replanReason: null,
    ...overrides,
  };
}

export function mkErrorRecord(overrides: Partial<ErrorRecord> = {}): ErrorRecord {
  return {
    errorCode: 'CLAUDE_EXIT_NONZERO',
    errorClass: 'claude_error',
    stage: 'execution',
    message: 'claude exited with code 1',
    toolSummary: null,
    sessionId: UUID_1,
    taskId: 'TASK-001',
    at: T0,
    ...overrides,
  };
}

/** Builds a Task Runtime State that satisfies the per-status null rules. */
export function mkTaskState(
  taskId: string,
  status: TaskStatus,
  overrides: Partial<TaskRuntimeState> = {},
): TaskRuntimeState {
  const base: TaskRuntimeState = {
    taskId,
    status,
    executionEpisodes: [],
    completedResult: null,
    finalCheckpoint: null,
    skipReason: null,
    failure: null,
  };
  if (status === 'completed') {
    base.completedResult = mkResult();
    base.finalCheckpoint = OID_B;
  } else if (status === 'failed') {
    base.failure = mkErrorRecord({ taskId });
  } else if (status === 'skipped') {
    base.skipReason = 'Omitted by plan revision 2';
  }
  return { ...base, ...overrides };
}

/** Initial-planning run.json (planRevision 0, no tasks committed yet). */
export function mkRun(overrides: Partial<RunJson> = {}): RunJson {
  return {
    schemaVersion: 1,
    stateRevision: 1,
    runId: RUN_ID,
    status: 'planning',
    spec: { path: 'docs/SPEC.md', sha256: SHA256_A },
    planRevision: 0,
    tasksSha256: null,
    runSettings: { executionPermissionMode: 'auto', claudeCliPath: null, gitCliPath: null },
    repository: {
      root: 'C:/repo',
      baseBranch: 'main',
      baseBranchRef: 'refs/heads/main',
      baseCommit: OID_B,
      runBranch: `apex-coding-agent/${RUN_ID}`,
      expectedHead: OID_B,
    },
    currentTaskId: null,
    activeSession: null,
    tasks: {},
    intermediateCheckpoints: [],
    finalReviewEpisodes: [],
    lastError: null,
    finalCommit: null,
    reportPath: null,
    createdAt: T0,
    updatedAt: T0,
    terminalAt: null,
    ...overrides,
  };
}
