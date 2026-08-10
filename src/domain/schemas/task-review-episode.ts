/**
 * Task Review Episode：一次独立 Task 复核的追加式事实记录。
 *
 * start 字段固定候选 Execution Session 与候选 Checkpoint，end 字段记录
 * 复核结论；未结束 Episode 的全部 end 字段保持 null/空数组。
 */
import { GIT_OID_PATTERN, TASK_ID_PATTERN, UUID_PATTERN } from '../ids.js';
import { errorRecordSchema, type ErrorRecord } from './error-record.js';
import {
  acceptanceEvidenceSchema,
  testReportSchema,
  type AcceptanceEvidence,
  type TestReport,
} from './task-execution-result.js';
import {
  reviewIssueSchema,
  verificationEvidenceSchema,
  type ReviewIssue,
  type VerificationEvidence,
} from './review-evidence.js';

export type TaskReviewEpisodeOutcome =
  | 'approved'
  | 'changes_required'
  | 'replan_required'
  | 'spec_changed'
  | 'session_error';

export const TASK_REVIEW_EPISODE_OUTCOMES: readonly TaskReviewEpisodeOutcome[] = [
  'approved',
  'changes_required',
  'replan_required',
  'spec_changed',
  'session_error',
];

export interface TaskReviewEpisode {
  readonly sessionId: string;
  readonly taskId: string;
  readonly executionSessionId: string;
  readonly candidateCheckpoint: string;
  readonly planRevision: number;
  readonly specSha256Before: string;
  readonly specSha256After: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly outcome: TaskReviewEpisodeOutcome | null;
  readonly summary: string | null;
  readonly tests: TestReport[];
  readonly verificationEvidence: readonly VerificationEvidence[];
  readonly acceptanceEvidence: AcceptanceEvidence[];
  readonly issues: readonly ReviewIssue[];
  readonly error: ErrorRecord | null;
}

/**
 * Episode Schema 保存可审计事实，不隐藏跨字段状态机。
 *
 * outcome 与 error、批准门槛及 Session 身份隔离由 invariants.ts 统一
 * 校验，保证持久化入口和内存转换使用同一套规则。
 */
export const taskReviewEpisodeSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'sessionId',
    'taskId',
    'executionSessionId',
    'candidateCheckpoint',
    'planRevision',
    'specSha256Before',
    'specSha256After',
    'startedAt',
    'endedAt',
    'outcome',
    'summary',
    'tests',
    'verificationEvidence',
    'acceptanceEvidence',
    'issues',
    'error',
  ],
  properties: {
    sessionId: { type: 'string', pattern: UUID_PATTERN.source },
    taskId: { type: 'string', pattern: TASK_ID_PATTERN.source },
    executionSessionId: { type: 'string', pattern: UUID_PATTERN.source },
    candidateCheckpoint: { type: 'string', pattern: GIT_OID_PATTERN.source },
    planRevision: { type: 'integer', minimum: 1 },
    specSha256Before: { type: 'string', format: 'sha256' },
    specSha256After: { anyOf: [{ type: 'null' }, { type: 'string', format: 'sha256' }] },
    startedAt: { type: 'string', format: 'rfc3339' },
    endedAt: { anyOf: [{ type: 'null' }, { type: 'string', format: 'rfc3339' }] },
    outcome: {
      anyOf: [
        { type: 'null' },
        { type: 'string', enum: [...TASK_REVIEW_EPISODE_OUTCOMES] },
      ],
    },
    summary: { type: ['string', 'null'], minLength: 1 },
    tests: { type: 'array', items: testReportSchema },
    verificationEvidence: { type: 'array', items: verificationEvidenceSchema },
    acceptanceEvidence: { type: 'array', items: acceptanceEvidenceSchema },
    issues: { type: 'array', items: reviewIssueSchema },
    error: { anyOf: [{ type: 'null' }, errorRecordSchema] },
  },
} as const;
