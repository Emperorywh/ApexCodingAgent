/**
 * Final Review Episode (SPEC §11.3). Append-only like execution episodes.
 * Conditional decision/checkpoint-role coupling lives in
 * `src/domain/invariants.ts`.
 */
import { GIT_OID_PATTERN, TASK_ID_PATTERN, UUID_PATTERN } from '../ids.js';
import { errorRecordSchema, type ErrorRecord } from './error-record.js';

export type FinalReviewEpisodeDecision =
  | 'completed'
  | 'replan_required'
  | 'spec_changed'
  | 'session_error';

export const FINAL_REVIEW_EPISODE_DECISIONS: readonly FinalReviewEpisodeDecision[] = [
  'completed',
  'replan_required',
  'spec_changed',
  'session_error',
];

export type FinalReviewCheckpointRole = 'final-review-final' | 'final-review-intermediate';

export interface FinalReviewEpisode {
  sessionId: string;
  planRevision: number;
  specSha256Before: string;
  specSha256After: string | null;
  startedAt: string;
  endedAt: string | null;
  decision: FinalReviewEpisodeDecision | null;
  summary: string | null;
  reviewedTaskIds: string[];
  changedAreas: string[];
  checkpointRole: FinalReviewCheckpointRole | null;
  checkpoint: string | null;
  checkpointReason: string | null;
  error: ErrorRecord | null;
}

/**
 * 最终复核 Episode 的持久化形状由标准 JSON Schema 和契约测试覆盖。
 *
 * 决策与检查点角色的组合规则继续由领域层集中维护。
 */
export const finalReviewEpisodeSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'sessionId',
    'planRevision',
    'specSha256Before',
    'specSha256After',
    'startedAt',
    'endedAt',
    'decision',
    'summary',
    'reviewedTaskIds',
    'changedAreas',
    'checkpointRole',
    'checkpoint',
    'checkpointReason',
    'error',
  ],
  properties: {
    sessionId: { type: 'string', pattern: UUID_PATTERN.source },
    planRevision: { type: 'integer', minimum: 1 },
    specSha256Before: { type: 'string', format: 'sha256' },
    specSha256After: { anyOf: [{ type: 'null' }, { type: 'string', format: 'sha256' }] },
    startedAt: { type: 'string', format: 'rfc3339' },
    endedAt: { anyOf: [{ type: 'null' }, { type: 'string', format: 'rfc3339' }] },
    decision: {
      anyOf: [
        { type: 'null' },
        { type: 'string', enum: [...FINAL_REVIEW_EPISODE_DECISIONS] },
      ],
    },
    summary: { type: ['string', 'null'], minLength: 1 },
    reviewedTaskIds: {
      type: 'array',
      items: { type: 'string', pattern: TASK_ID_PATTERN.source },
    },
    changedAreas: { type: 'array', items: { type: 'string', minLength: 1 } },
    checkpointRole: {
      anyOf: [
        { type: 'null' },
        {
          type: 'string',
          enum: ['final-review-final', 'final-review-intermediate'],
        },
      ],
    },
    checkpoint: {
      anyOf: [{ type: 'null' }, { type: 'string', pattern: GIT_OID_PATTERN.source }],
    },
    checkpointReason: { type: ['string', 'null'], minLength: 1 },
    error: { anyOf: [{ type: 'null' }, errorRecordSchema] },
  },
} as const;
