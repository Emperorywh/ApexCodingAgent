/**
 * Session Record (SPEC §11.4). Immutable once written. `structuredResult`
 * holds the schema-validated result for the session type (TaskPlanDraft for
 * planning, TaskExecutionResult for execution, FinalReviewResult for final
 * review) or `null` on failure; the status/error coupling rules are enforced
 * in `src/domain/invariants.ts`.
 */
import { RUN_ID_PATTERN, TASK_ID_PATTERN, UUID_PATTERN } from '../ids.js';
import { type SessionType } from './active-session.js';
import { errorRecordSchema, type ErrorRecord } from './error-record.js';
import {
  finalReviewResultSchema,
  type FinalReviewResult,
} from './final-review-result.js';
import {
  taskExecutionResultSchema,
  type TaskExecutionResult,
} from './task-execution-result.js';
import { taskPlanDraftSchema, type TaskPlanDraft } from './task-plan-draft.js';

export type SessionRecordStatus = 'completed' | 'failed';

export interface SessionClaudeFact {
  version: string;
  model: string | null;
  provider: string | null;
}

export interface SessionRecord {
  schemaVersion: 1;
  sessionId: string;
  type: SessionType;
  status: SessionRecordStatus;
  runId: string;
  taskId: string | null;
  planRevision: number;
  specSha256: string;
  startedAt: string;
  endedAt: string;
  claude: SessionClaudeFact;
  exitCode: number | null;
  structuredResult: TaskPlanDraft | TaskExecutionResult | FinalReviewResult | null;
  logPath: string;
  error: ErrorRecord | null;
}

export const sessionRecordSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'sessionId',
    'type',
    'status',
    'runId',
    'taskId',
    'planRevision',
    'specSha256',
    'startedAt',
    'endedAt',
    'claude',
    'exitCode',
    'structuredResult',
    'logPath',
    'error',
  ],
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    sessionId: { type: 'string', pattern: UUID_PATTERN.source },
    type: { enum: ['planning', 'execution', 'final_review'] },
    status: { enum: ['completed', 'failed'] },
    runId: { type: 'string', pattern: RUN_ID_PATTERN.source },
    taskId: { anyOf: [{ type: 'null' }, { type: 'string', pattern: TASK_ID_PATTERN.source }] },
    planRevision: { type: 'integer', minimum: 1 },
    specSha256: { type: 'string', format: 'sha256' },
    startedAt: { type: 'string', format: 'rfc3339' },
    endedAt: { type: 'string', format: 'rfc3339' },
    claude: {
      type: 'object',
      additionalProperties: false,
      required: ['version', 'model', 'provider'],
      properties: {
        version: { type: 'string', minLength: 1 },
        model: { type: ['string', 'null'], minLength: 1 },
        provider: { type: ['string', 'null'], minLength: 1 },
      },
    },
    exitCode: { anyOf: [{ type: 'null' }, { type: 'integer' }] },
    structuredResult: {
      anyOf: [
        { type: 'null' },
        taskPlanDraftSchema,
        taskExecutionResultSchema,
        finalReviewResultSchema,
      ],
    },
    logPath: { type: 'string', minLength: 1 },
    error: { anyOf: [{ type: 'null' }, errorRecordSchema] },
  },
} as const;
