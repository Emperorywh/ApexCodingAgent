/**
 * 独立 Plan Review 对尚未提交的 TaskPlanDraft 给出的结构化结论。
 *
 * Reviewer 必须逐个覆盖草稿中的 Task；只有所有 Task 均通过且不存在计划级
 * 问题时才能批准。精确覆盖与 decision/issue 耦合由 results.ts 集中校验。
 */
import { TASK_ID_PATTERN } from '../ids.js';
import {
  planReviewCheckSchema,
  reviewIssueSchema,
  type PlanReviewCheck,
  type ReviewIssue,
} from './review-evidence.js';

export type PlanReviewDecision = 'approved' | 'changes_required';
export type PlanReviewTaskDecision = 'approved' | 'changes_required';

export interface PlanReviewTaskAssessment {
  readonly taskId: string;
  readonly decision: PlanReviewTaskDecision;
  readonly checks: readonly PlanReviewCheck[];
  readonly issues: readonly ReviewIssue[];
}

export interface PlanReviewResult {
  readonly decision: PlanReviewDecision;
  readonly summary: string;
  readonly taskAssessments: readonly PlanReviewTaskAssessment[];
  readonly issues: readonly ReviewIssue[];
}

export const planReviewResultSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'summary', 'taskAssessments', 'issues'],
  properties: {
    decision: { type: 'string', enum: ['approved', 'changes_required'] },
    summary: { type: 'string', minLength: 1 },
    taskAssessments: {
      type: 'array',
      /**
       * 紧凑 Replan 可能只调整 Checkpoint 归属并原样保留全部 pending Task；
       * 此时候选定义为空，Reviewer 仍需给出计划级结论但没有 Task 可逐项评估。
       */
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['taskId', 'decision', 'checks', 'issues'],
        properties: {
          taskId: { type: 'string', pattern: TASK_ID_PATTERN.source },
          decision: { type: 'string', enum: ['approved', 'changes_required'] },
          checks: { type: 'array', items: planReviewCheckSchema },
          issues: { type: 'array', items: reviewIssueSchema },
        },
      },
    },
    issues: { type: 'array', items: reviewIssueSchema },
  },
} as const;
