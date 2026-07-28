/**
 * run.json (SPEC §11.3). The single source of truth for Run and Task runtime
 * status. Conditional rules (terminal fields, planRevision/tasksSha256
 * coupling, per-task null rules) are enforced in `src/domain/invariants.ts`.
 */
import { GIT_OID_PATTERN, RUN_BRANCH_PATTERN, RUN_ID_PATTERN, TASK_ID_PATTERN } from '../ids.js';
import { activeSessionSchema, type ActiveSession } from './active-session.js';
import { errorRecordSchema, type ErrorRecord } from './error-record.js';
import {
  finalReviewEpisodeSchema,
  type FinalReviewEpisode,
} from './final-review-episode.js';
import {
  intermediateCheckpointSchema,
  type IntermediateCheckpoint,
} from './intermediate-checkpoint.js';
import { EXECUTION_PERMISSION_MODES, type ExecutionPermissionMode } from './settings-json.js';
import {
  taskRuntimeStateSchema,
  type TaskRuntimeState,
} from './task-runtime-state.js';

export type RunStatus = 'planning' | 'running' | 'final_review' | 'completed' | 'failed' | 'abandoned';

export const RUN_STATUSES: readonly RunStatus[] = [
  'planning',
  'running',
  'final_review',
  'completed',
  'failed',
  'abandoned',
];

export interface RunSpecFact {
  path: string;
  sha256: string;
}

export interface RunSettings {
  executionPermissionMode: ExecutionPermissionMode;
  claudeCliPath: string | null;
  gitCliPath: string | null;
}

export interface RepositoryFact {
  root: string;
  baseBranch: string;
  baseBranchRef: string;
  baseCommit: string;
  runBranch: string;
  expectedHead: string;
}

export interface RunJson {
  schemaVersion: 1;
  stateRevision: number;
  runId: string;
  status: RunStatus;
  spec: RunSpecFact;
  planRevision: number;
  tasksSha256: string | null;
  runSettings: RunSettings;
  repository: RepositoryFact;
  currentTaskId: string | null;
  activeSession: ActiveSession | null;
  tasks: Record<string, TaskRuntimeState>;
  intermediateCheckpoints: IntermediateCheckpoint[];
  finalReviewEpisodes: FinalReviewEpisode[];
  lastError: ErrorRecord | null;
  finalCommit: string | null;
  reportPath: string | null;
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
}

const nullableGitOid = {
  anyOf: [{ type: 'null' }, { type: 'string', pattern: GIT_OID_PATTERN.source }],
} as const;

export const runJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'stateRevision',
    'runId',
    'status',
    'spec',
    'planRevision',
    'tasksSha256',
    'runSettings',
    'repository',
    'currentTaskId',
    'activeSession',
    'tasks',
    'intermediateCheckpoints',
    'finalReviewEpisodes',
    'lastError',
    'finalCommit',
    'reportPath',
    'createdAt',
    'updatedAt',
    'terminalAt',
  ],
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    stateRevision: { type: 'integer', minimum: 1 },
    runId: { type: 'string', pattern: RUN_ID_PATTERN.source },
    status: { enum: [...RUN_STATUSES] },
    spec: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'sha256'],
      properties: {
        path: { type: 'string', format: 'git-relative-path' },
        sha256: { type: 'string', format: 'sha256' },
      },
    },
    planRevision: { type: 'integer', minimum: 0 },
    tasksSha256: { anyOf: [{ type: 'null' }, { type: 'string', format: 'sha256' }] },
    runSettings: {
      type: 'object',
      additionalProperties: false,
      required: ['executionPermissionMode', 'claudeCliPath', 'gitCliPath'],
      properties: {
        executionPermissionMode: { enum: [...EXECUTION_PERMISSION_MODES] },
        claudeCliPath: { type: ['string', 'null'], minLength: 1 },
        gitCliPath: { type: ['string', 'null'], minLength: 1 },
      },
    },
    repository: {
      type: 'object',
      additionalProperties: false,
      required: ['root', 'baseBranch', 'baseBranchRef', 'baseCommit', 'runBranch', 'expectedHead'],
      properties: {
        root: { type: 'string', minLength: 1 },
        baseBranch: { type: 'string', minLength: 1 },
        baseBranchRef: { type: 'string', pattern: '^refs/heads/.+$' },
        baseCommit: { type: 'string', pattern: GIT_OID_PATTERN.source },
        runBranch: { type: 'string', pattern: RUN_BRANCH_PATTERN.source },
        expectedHead: { type: 'string', pattern: GIT_OID_PATTERN.source },
      },
    },
    currentTaskId: {
      anyOf: [{ type: 'null' }, { type: 'string', pattern: TASK_ID_PATTERN.source }],
    },
    activeSession: { anyOf: [{ type: 'null' }, activeSessionSchema] },
    tasks: {
      type: 'object',
      propertyNames: { pattern: TASK_ID_PATTERN.source },
      additionalProperties: taskRuntimeStateSchema,
    },
    intermediateCheckpoints: { type: 'array', items: intermediateCheckpointSchema },
    finalReviewEpisodes: { type: 'array', items: finalReviewEpisodeSchema },
    lastError: { anyOf: [{ type: 'null' }, errorRecordSchema] },
    finalCommit: nullableGitOid,
    reportPath: {
      anyOf: [{ type: 'null' }, { type: 'string', format: 'git-relative-path' }],
    },
    createdAt: { type: 'string', format: 'rfc3339' },
    updatedAt: { type: 'string', format: 'rfc3339' },
    terminalAt: { anyOf: [{ type: 'null' }, { type: 'string', format: 'rfc3339' }] },
  },
} as const;
