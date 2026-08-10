/**
 * Task Review Result：独立复核会话对候选 Task 交付物给出的结构化结论。
 *
 * 复核会话只能基于仓库事实、候选结果和验收标准作出判断，不能继承
 * Execution Session 的对话上下文；是否完成的最终决定由该结果承载。
 */
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

export type TaskReviewDecision = 'approved' | 'changes_required' | 'replan_required';

export interface TaskReviewResult {
  readonly decision: TaskReviewDecision;
  readonly summary: string;
  readonly tests: TestReport[];
  readonly verificationEvidence: readonly VerificationEvidence[];
  readonly acceptanceEvidence: AcceptanceEvidence[];
  readonly issues: readonly ReviewIssue[];
  readonly replanReason: string | null;
}

/**
 * JSON Schema 只约束复核结果的结构。
 *
 * 验收条件索引覆盖、批准门槛和 decision/replanReason 耦合由
 * results.ts 的纯领域校验集中维护，避免在多个层重复业务规则。
 */
export const taskReviewResultSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'decision',
    'summary',
    'tests',
    'verificationEvidence',
    'acceptanceEvidence',
    'issues',
    'replanReason',
  ],
  properties: {
    decision: {
      type: 'string',
      enum: ['approved', 'changes_required', 'replan_required'],
    },
    summary: { type: 'string', minLength: 1 },
    tests: { type: 'array', items: testReportSchema },
    verificationEvidence: { type: 'array', items: verificationEvidenceSchema },
    acceptanceEvidence: { type: 'array', items: acceptanceEvidenceSchema },
    issues: { type: 'array', items: reviewIssueSchema },
    replanReason: { type: ['string', 'null'], minLength: 1 },
  },
} as const;
