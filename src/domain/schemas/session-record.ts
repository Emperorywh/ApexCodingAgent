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
import {
  taskReviewResultSchema,
  type TaskReviewResult,
} from './task-review-result.js';
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
  structuredResult: TaskPlanDraft | TaskExecutionResult | TaskReviewResult | FinalReviewResult | null;
  logPath: string;
  error: ErrorRecord | null;
}

/**
 * Session Record 显式组合公共事实与三类结构化结果联合类型。
 *
 * 会话类型、结果类型和错误状态的对应关系仍由领域不变式显式校验。
 */
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
    type: { type: 'string', enum: ['planning', 'execution', 'task_review', 'final_review'] },
    status: { type: 'string', enum: ['completed', 'failed'] },
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
        taskReviewResultSchema,
        finalReviewResultSchema,
      ],
    },
    logPath: { type: 'string', format: 'git-relative-path' },
    error: { anyOf: [{ type: 'null' }, errorRecordSchema] },
  },
} as const;
