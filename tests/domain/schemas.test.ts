/**
 * The 15 built-in schemas (SPEC §11.5): positive and negative examples,
 * including additionalProperties rejection, explicit-null required fields,
 * custom formats (uuid/sha256/git-oid/rfc3339) and schemaVersion constants.
 */
import { describe, expect, it } from 'vitest';
import { ApexError } from '../../src/domain/errors.js';
import {
  assertSchemaValid,
  getSchemaJson,
  getSchemaVersion,
  SCHEMA_NAMES,
  validate,
  type SchemaName,
} from '../../src/domain/schemas/index.js';
import { mkDraft, mkResult, mkRun, mkTask } from './fixtures.js';
import {
  OID_B,
  OID_C,
  RUN_ID,
  SHA256_A,
  T0,
  T1,
  UUID_1,
  UUID_2,
} from './fixtures.js';

function expectValid(name: SchemaName, data: unknown): void {
  const result = validate(name, data);
  expect(result.valid, JSON.stringify(result.valid ? {} : result.issues)).toBe(true);
}

function expectInvalid(name: SchemaName, data: unknown): void {
  expect(validate(name, data).valid).toBe(false);
}

const VALID: Record<SchemaName, () => unknown> = {
  TaskPlanDraft: () => mkDraft([mkTask('TASK-001'), mkTask('TASK-002', ['TASK-001'])]),
  TaskExecutionResult: () => mkResult(),
  FinalReviewResult: () => ({
    decision: 'completed',
    summary: '整体复核通过',
    reviewedTaskIds: ['TASK-001'],
    tests: [{ command: 'npm test', result: 'passed' }],
    changedAreas: [],
    remainingRisks: [],
    replanReason: null,
  }),
  ActiveSession: () => ({
    sessionId: UUID_1,
    type: 'execution',
    taskId: 'TASK-001',
    planRevision: 1,
    specSha256: SHA256_A,
    startedAt: T0,
  }),
  TaskRuntimeState: () => ({
    taskId: 'TASK-001',
    status: 'pending',
    executionEpisodes: [],
    completedResult: null,
    finalCheckpoint: null,
    skipReason: null,
    failure: null,
  }),
  TaskExecutionEpisode: () => ({
    sessionId: UUID_1,
    taskId: 'TASK-001',
    planRevision: 1,
    specSha256Before: SHA256_A,
    specSha256After: null,
    startedAt: T0,
    endedAt: null,
    outcome: null,
    summary: null,
    acceptanceEvidence: [],
    finalCheckpoint: null,
    intermediateCheckpoint: null,
    checkpointReason: null,
    error: null,
  }),
  FinalReviewEpisode: () => ({
    sessionId: UUID_2,
    planRevision: 1,
    specSha256Before: SHA256_A,
    specSha256After: SHA256_A,
    startedAt: T0,
    endedAt: T1,
    decision: 'completed',
    summary: '整体复核通过',
    reviewedTaskIds: ['TASK-001'],
    changedAreas: [],
    checkpointRole: 'final-review-final',
    checkpoint: OID_B,
    checkpointReason: 'Final Review Checkpoint 已确认',
    error: null,
  }),
  IntermediateCheckpoint: () => ({
    oid: OID_C,
    role: 'task-intermediate',
    sourceSessionId: UUID_1,
    taskId: 'TASK-001',
    planRevision: 1,
    summary: 'preserve intermediate work',
    ownerTaskId: 'TASK-002',
  }),
  ErrorRecord: () => ({
    errorCode: 'CLAUDE_EXIT_NONZERO',
    errorClass: 'claude_error',
    stage: 'execution',
    message: 'claude exited 1',
    toolSummary: null,
    sessionId: UUID_1,
    taskId: 'TASK-001',
    at: T0,
  }),
  TasksJson: () => ({
    schemaVersion: 1,
    runId: RUN_ID,
    planRevision: 1,
    specPath: 'docs/SPEC.md',
    specSha256: SHA256_A,
    generatedAt: T0,
    plannerSessionId: UUID_1,
    summary: 'Overall goal',
    assumptions: [],
    retainedCheckpointDispositions: [],
    tasks: [mkTask('TASK-001')],
  }),
  PlanRevisionSnapshot: () => ({
    schemaVersion: 1,
    runId: RUN_ID,
    planRevision: 2,
    parentPlanRevision: 1,
    trigger: { type: 'execution_replan', reason: 'needs replan', sourceSessionId: UUID_1 },
    specPath: 'docs/SPEC.md',
    specSha256: SHA256_A,
    generatedAt: T0,
    plannerSessionId: UUID_2,
    summary: 'Overall goal',
    assumptions: [],
    retainedCheckpointDispositions: [],
    tasks: [mkTask('TASK-001')],
  }),
  RunJson: () => mkRun(),
  SessionRecord: () => ({
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
  }),
  RunArchiveManifest: () => ({
    schemaVersion: 1,
    runId: RUN_ID,
    runStatus: 'completed',
    archivedAt: T0,
    files: [{ path: 'run.json', byteLength: 123, sha256: SHA256_A }],
  }),
  SettingsJson: () => ({
    schemaVersion: 1,
    executionPermissionMode: 'auto',
    claudeCliPath: null,
    gitCliPath: null,
  }),
};

describe('schema registry (§11.5)', () => {
  it('registers exactly the 15 built-in schemas, all at version 1', () => {
    expect(SCHEMA_NAMES).toHaveLength(15);
    for (const name of SCHEMA_NAMES) {
      expect(getSchemaVersion(name)).toBe(1);
      expect(getSchemaJson(name)).toBeTypeOf('object');
    }
  });

  it('validate throws ApexError for an unknown schema name', () => {
    expect(() => validate('Nope' as never, {})).toThrow(ApexError);
  });

  it('assertSchemaValid passes valid data and throws the caller-supplied code otherwise', () => {
    expect(() =>
      assertSchemaValid('TaskPlanDraft', VALID.TaskPlanDraft(), {
        code: 'PLAN_INVALID',
        stage: 'planning',
      }),
    ).not.toThrow();
    try {
      assertSchemaValid('TaskPlanDraft', { nope: 1 }, { code: 'PLAN_INVALID', stage: 'planning' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ApexError);
      expect((error as ApexError).errorCode).toBe('PLAN_INVALID');
    }
  });
});

describe('valid examples for all 15 schemas', () => {
  it.each(SCHEMA_NAMES.map((name) => [name] as const))('%s accepts its normative example', (name) => {
    expectValid(name, VALID[name]());
  });
});

describe('additionalProperties: false everywhere', () => {
  it.each(SCHEMA_NAMES.map((name) => [name] as const))('%s rejects unknown top-level fields', (name) => {
    expectInvalid(name, { ...(VALID[name]() as object), extraField: 1 });
  });

  it('rejects unknown nested fields (run.json spec/repository/runSettings, snapshot trigger)', () => {
    const run = mkRun() as unknown as Record<string, unknown>;
    expectInvalid('RunJson', { ...run, spec: { path: 'a', sha256: SHA256_A, extra: 1 } });
    expectInvalid('RunJson', {
      ...run,
      repository: { ...(run.repository as object), extra: 1 },
    });
    expectInvalid('RunJson', {
      ...run,
      runSettings: { ...(run.runSettings as object), extra: 1 },
    });
    const snapshot = VALID.PlanRevisionSnapshot() as Record<string, unknown>;
    expectInvalid('PlanRevisionSnapshot', {
      ...snapshot,
      trigger: { type: 'initial', reason: 'r', sourceSessionId: null, extra: 1 },
    });
    const record = VALID.SessionRecord() as Record<string, unknown>;
    expectInvalid('SessionRecord', { ...record, claude: { version: '1', model: null, provider: null, extra: 1 } });
  });
});

describe('optional association fields must be explicit null, never omitted', () => {
  const cases: ReadonlyArray<readonly [SchemaName, string]> = [
    ['RunJson', 'tasksSha256'],
    ['RunJson', 'terminalAt'],
    ['RunJson', 'activeSession'],
    ['RunJson', 'lastError'],
    ['TaskRuntimeState', 'failure'],
    ['TaskRuntimeState', 'skipReason'],
    ['TaskExecutionResult', 'replanReason'],
    ['ErrorRecord', 'toolSummary'],
    ['ErrorRecord', 'sessionId'],
    ['TaskExecutionEpisode', 'endedAt'],
    ['TaskExecutionEpisode', 'error'],
    ['SessionRecord', 'taskId'],
    ['ActiveSession', 'taskId'],
    ['SettingsJson', 'claudeCliPath'],
  ];

  it.each(cases)('%s without %s is invalid', (name, field) => {
    const data = { ...(VALID[name]() as Record<string, unknown>) };
    delete data[field];
    expectInvalid(name, data);
  });

  it.each(cases)('%s with %s set to undefined-equivalent junk is invalid', (name, field) => {
    const data = { ...(VALID[name]() as Record<string, unknown>), [field]: 12345 };
    expectInvalid(name, data);
  });
});

describe('custom formats and enums', () => {
  it('uuid format rejects uppercase and malformed values', () => {
    const session = VALID.ActiveSession() as Record<string, unknown>;
    expectInvalid('ActiveSession', { ...session, sessionId: UUID_1.toUpperCase() });
    expectInvalid('ActiveSession', { ...session, sessionId: 'not-a-uuid' });
  });

  it('sha256 format requires 64 lowercase hex', () => {
    const session = VALID.ActiveSession() as Record<string, unknown>;
    expectInvalid('ActiveSession', { ...session, specSha256: 'a'.repeat(63) });
    expectInvalid('ActiveSession', { ...session, specSha256: 'A'.repeat(64) });
  });

  it('git-oid format accepts full SHA-1/SHA-256 OIDs and rejects other shapes', () => {
    const checkpoint = VALID.IntermediateCheckpoint() as Record<string, unknown>;
    expectValid('IntermediateCheckpoint', { ...checkpoint, oid: 'b'.repeat(64) });
    expectInvalid('IntermediateCheckpoint', { ...checkpoint, oid: 'b'.repeat(39) });
    expectInvalid('IntermediateCheckpoint', { ...checkpoint, oid: 'b'.repeat(63) });
    expectInvalid('IntermediateCheckpoint', { ...checkpoint, oid: 'B'.repeat(40) });
  });

  it('git-relative-path format rejects paths outside the repository namespace', () => {
    /**
     * 所有持久化的项目文件引用共享同一 Git 相对路径契约。
     * 分别覆盖计划、Run、Session、归档清单和任务路径提示的 Schema 边界。
     */
    expectInvalid('TasksJson', {
      ...(VALID.TasksJson() as object),
      specPath: '../SPEC.md',
    });
    expectInvalid('PlanRevisionSnapshot', {
      ...(VALID.PlanRevisionSnapshot() as object),
      specPath: '/repo/SPEC.md',
    });
    const run = VALID.RunJson() as Record<string, unknown>;
    expectInvalid('RunJson', {
      ...run,
      spec: { ...(run.spec as object), path: 'docs\\SPEC.md' },
    });
    expectInvalid('RunJson', { ...run, reportPath: '../report.md' });
    expectInvalid('SessionRecord', {
      ...(VALID.SessionRecord() as object),
      logPath: 'C:/logs/session.log',
    });
    expectInvalid('RunArchiveManifest', {
      ...(VALID.RunArchiveManifest() as object),
      files: [{ path: '../run.json', byteLength: 123, sha256: SHA256_A }],
    });
    expectInvalid(
      'TaskPlanDraft',
      mkDraft([mkTask('TASK-001', [], { likelyPaths: ['./src/index.ts'] })]),
    );
  });

  it('rfc3339 format requires UTC with Z', () => {
    const record = VALID.ErrorRecord() as Record<string, unknown>;
    expectInvalid('ErrorRecord', { ...record, at: '2026-01-01T00:00:00' });
    expectInvalid('ErrorRecord', { ...record, at: '2026-01-01T00:00:00+08:00' });
    expectInvalid('ErrorRecord', { ...record, at: '2026-02-30T00:00:00Z' });
  });

  it('Task ID pattern rejects TASK-000 and other shapes', () => {
    const draft = mkDraft([mkTask('TASK-000')]);
    expectInvalid('TaskPlanDraft', draft);
    const state = VALID.TaskRuntimeState() as Record<string, unknown>;
    expectInvalid('TaskRuntimeState', { ...state, taskId: 'TASK-1000' });
    expectInvalid('TaskRuntimeState', { ...state, taskId: 'task-001' });
  });

  it('Run/Branch identifiers enforce their prefixes', () => {
    const tasks = VALID.TasksJson() as Record<string, unknown>;
    expectInvalid('TasksJson', { ...tasks, runId: 'no-prefix' });
    const run = mkRun() as unknown as Record<string, unknown>;
    expectInvalid('RunJson', {
      ...run,
      repository: { ...(run.repository as object), runBranch: 'main' },
    });
    expectInvalid('RunJson', {
      ...run,
      repository: { ...(run.repository as object), baseBranchRef: 'main' },
    });
  });

  it('enums reject out-of-set values', () => {
    expectInvalid('ActiveSession', { ...(VALID.ActiveSession() as object), type: 'other' });
    expectInvalid('TaskRuntimeState', {
      ...(VALID.TaskRuntimeState() as object),
      status: 'waiting_for_claude',
    });
    expectInvalid('TaskExecutionResult', { ...(VALID.TaskExecutionResult() as object), decision: 'done' });
    expectInvalid('SettingsJson', {
      ...(VALID.SettingsJson() as object),
      executionPermissionMode: 'plan',
    });
    expectInvalid('RunArchiveManifest', {
      ...(VALID.RunArchiveManifest() as object),
      runStatus: 'running',
    });
  });

  it('integer and range constraints hold', () => {
    expectInvalid('ActiveSession', { ...(VALID.ActiveSession() as object), planRevision: 0 });
    expectInvalid('ActiveSession', { ...(VALID.ActiveSession() as object), planRevision: 1.5 });
    const run = mkRun() as unknown as Record<string, unknown>;
    expectInvalid('RunJson', { ...run, stateRevision: '1' });
    expectInvalid('RunJson', { ...run, planRevision: -1 });
  });

  it('persisted top-level objects pin schemaVersion to the integer 1', () => {
    for (const name of [
      'TasksJson',
      'PlanRevisionSnapshot',
      'RunJson',
      'SessionRecord',
      'RunArchiveManifest',
      'SettingsJson',
    ] as const) {
      expectInvalid(name, { ...(VALID[name]() as object), schemaVersion: 2 });
      expectInvalid(name, { ...(VALID[name]() as object), schemaVersion: '1' });
      const without = { ...(VALID[name]() as Record<string, unknown>) };
      delete without.schemaVersion;
      expectInvalid(name, without);
    }
  });

  it('TaskPlanDraft structural rules: estimatedSize, acceptanceCriteria, unique dependsOn', () => {
    expectInvalid(
      'TaskPlanDraft',
      mkDraft([mkTask('TASK-001', [], { estimatedSize: 'huge' as never })]),
    );
    expectInvalid('TaskPlanDraft', mkDraft([mkTask('TASK-001', [], { acceptanceCriteria: [] })]));
    expectInvalid(
      'TaskPlanDraft',
      mkDraft([mkTask('TASK-002', ['TASK-001', 'TASK-001']), mkTask('TASK-001')]),
    );
  });

  it('SessionRecord structuredResult accepts a matching result and rejects junk', () => {
    const record = VALID.SessionRecord() as Record<string, unknown>;
    expectValid('SessionRecord', record);
    expectInvalid('SessionRecord', { ...record, structuredResult: { foo: 1 } });
  });
});
