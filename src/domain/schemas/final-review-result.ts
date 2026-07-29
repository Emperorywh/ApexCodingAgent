/**
 * FinalReviewResult (SPEC §14.1). Returned by the Final Review Session.
 *
 * Structural only; the reviewedTaskIds completeness/duplication rules and the
 * completed ⇔ no-failed-test gate live in `src/domain/results.ts`.
 */
import { TASK_ID_PATTERN } from '../ids.js';
import { testReportSchema, type TestReport } from './task-execution-result.js';

export type FinalReviewResultDecision = 'completed' | 'replan_required';

export interface FinalReviewResult {
  decision: FinalReviewResultDecision;
  summary: string;
  reviewedTaskIds: string[];
  tests: TestReport[];
  changedAreas: string[];
  remainingRisks: string[];
  replanReason: string | null;
}

/**
 * 最终复核结果复用任务测试结构，避免复制测试报告字段。
 *
 * 显式 null 与跨字段业务规则分别由 Schema 契约测试和 results 模块负责。
 */
export const finalReviewResultSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'decision',
    'summary',
    'reviewedTaskIds',
    'tests',
    'changedAreas',
    'remainingRisks',
    'replanReason',
  ],
  properties: {
    decision: { type: 'string', enum: ['completed', 'replan_required'] },
    summary: { type: 'string', minLength: 1 },
    reviewedTaskIds: {
      type: 'array',
      items: { type: 'string', pattern: TASK_ID_PATTERN.source },
    },
    tests: { type: 'array', items: testReportSchema },
    changedAreas: { type: 'array', items: { type: 'string', minLength: 1 } },
    remainingRisks: { type: 'array', items: { type: 'string', minLength: 1 } },
    replanReason: { type: ['string', 'null'], minLength: 1 },
  },
} as const;
