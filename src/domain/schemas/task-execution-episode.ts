/**
 * Task Execution Episode (SPEC §11.3). Append-only, never overwritten; an
 * un-ended episode has every nullable end field set to `null`.
 *
 * The append/close/no-overwrite rules live in `src/domain/episodes.ts`, the
 * conditional outcome rules in `src/domain/invariants.ts`.
 */
import { GIT_OID_PATTERN, TASK_ID_PATTERN, UUID_PATTERN } from '../ids.js';
import { errorRecordSchema, type ErrorRecord } from './error-record.js';
import {
  acceptanceEvidenceSchema,
  type AcceptanceEvidence,
} from './task-execution-result.js';

export type ExecutionEpisodeOutcome =
  | 'completed'
  | 'failed'
  | 'replan_required'
  | 'spec_changed'
  | 'session_error';

export const EXECUTION_EPISODE_OUTCOMES: readonly ExecutionEpisodeOutcome[] = [
  'completed',
  'failed',
  'replan_required',
  'spec_changed',
  'session_error',
];

export interface TaskExecutionEpisode {
  sessionId: string;
  taskId: string;
  planRevision: number;
  specSha256Before: string;
  specSha256After: string | null;
  startedAt: string;
  endedAt: string | null;
  outcome: ExecutionEpisodeOutcome | null;
  summary: string | null;
  acceptanceEvidence: AcceptanceEvidence[];
  finalCheckpoint: string | null;
  intermediateCheckpoint: string | null;
  checkpointReason: string | null;
  error: ErrorRecord | null;
}

export const taskExecutionEpisodeSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'sessionId',
    'taskId',
    'planRevision',
    'specSha256Before',
    'specSha256After',
    'startedAt',
    'endedAt',
    'outcome',
    'summary',
    'acceptanceEvidence',
    'finalCheckpoint',
    'intermediateCheckpoint',
    'checkpointReason',
    'error',
  ],
  properties: {
    sessionId: { type: 'string', pattern: UUID_PATTERN.source },
    taskId: { type: 'string', pattern: TASK_ID_PATTERN.source },
    planRevision: { type: 'integer', minimum: 1 },
    specSha256Before: { type: 'string', format: 'sha256' },
    specSha256After: { anyOf: [{ type: 'null' }, { type: 'string', format: 'sha256' }] },
    startedAt: { type: 'string', format: 'rfc3339' },
    endedAt: { anyOf: [{ type: 'null' }, { type: 'string', format: 'rfc3339' }] },
    outcome: {
      anyOf: [{ type: 'null' }, { enum: [...EXECUTION_EPISODE_OUTCOMES] }],
    },
    summary: { type: ['string', 'null'], minLength: 1 },
    acceptanceEvidence: { type: 'array', items: acceptanceEvidenceSchema },
    finalCheckpoint: {
      anyOf: [{ type: 'null' }, { type: 'string', pattern: GIT_OID_PATTERN.source }],
    },
    intermediateCheckpoint: {
      anyOf: [{ type: 'null' }, { type: 'string', pattern: GIT_OID_PATTERN.source }],
    },
    checkpointReason: { type: ['string', 'null'], minLength: 1 },
    error: { anyOf: [{ type: 'null' }, errorRecordSchema] },
  },
} as const;
