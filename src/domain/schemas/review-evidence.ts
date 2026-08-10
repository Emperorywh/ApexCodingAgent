/**
 * 独立审核共享的证据契约。
 *
 * Review 不再用无法推导的自由字符串表达阻塞问题：每个问题必须同时给出
 * 分类、可观察证据、必须达到的修复结果以及受影响路径。Plan Review 还要
 * 对固定质量维度逐项举证，Task Review 则要逐项覆盖任务 verificationPlan。
 */
import { GIT_RELATIVE_PATH_PATTERN } from '../paths.js';

export const REVIEW_ISSUE_ID_PATTERN = /^ISSUE-[0-9]{3}$/;

export const REVIEW_ISSUE_CATEGORIES = [
  'spec_alignment',
  'task_scope',
  'architecture',
  'dependency',
  'acceptance_criteria',
  'verification',
  'budget',
  'correctness',
  'regression',
  'security',
  'maintainability',
  'repository_compliance',
] as const;

export type ReviewIssueCategory = (typeof REVIEW_ISSUE_CATEGORIES)[number];

/**
 * 可直接交给下一轮 Planner / Execution 消费的阻塞问题。
 *
 * `evidence` 只描述当前可观察事实；`requiredChange` 描述修复后必须成立的
 * 结果，二者分离可以避免 Reviewer 用实现方案代替问题证据。验收索引只在
 * 问题确实关联某些 acceptanceCriteria 时填写，否则保持空数组。
 */
export interface ReviewIssue {
  readonly id: string;
  readonly category: ReviewIssueCategory;
  readonly summary: string;
  readonly evidence: string;
  readonly requiredChange: string;
  readonly affectedPaths: readonly string[];
  readonly criterionIndexes: readonly number[];
}

export const reviewIssueSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'category',
    'summary',
    'evidence',
    'requiredChange',
    'affectedPaths',
    'criterionIndexes',
  ],
  properties: {
    id: { type: 'string', pattern: REVIEW_ISSUE_ID_PATTERN.source },
    category: { type: 'string', enum: [...REVIEW_ISSUE_CATEGORIES] },
    summary: { type: 'string', minLength: 1 },
    evidence: { type: 'string', minLength: 1 },
    requiredChange: { type: 'string', minLength: 1 },
    affectedPaths: {
      type: 'array',
      uniqueItems: true,
      items: {
        type: 'string',
        format: 'git-relative-path',
        pattern: GIT_RELATIVE_PATH_PATTERN.source,
      },
    },
    criterionIndexes: {
      type: 'array',
      uniqueItems: true,
      items: { type: 'integer', minimum: 0 },
    },
  },
} as const;

export const PLAN_REVIEW_DIMENSIONS = [
  'spec_alignment',
  'scope_cohesion',
  'dependency_soundness',
  'acceptance_verifiability',
  'verification_coverage',
  'architecture_fit',
  'budget_feasibility',
] as const;

export type PlanReviewDimension = (typeof PLAN_REVIEW_DIMENSIONS)[number];

/** Plan Reviewer 对单个候选 Task 的固定维度结论。 */
export interface PlanReviewCheck {
  readonly dimension: PlanReviewDimension;
  readonly status: 'satisfied' | 'not_satisfied';
  readonly evidence: string;
}

export const planReviewCheckSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['dimension', 'status', 'evidence'],
  properties: {
    dimension: { type: 'string', enum: [...PLAN_REVIEW_DIMENSIONS] },
    status: { type: 'string', enum: ['satisfied', 'not_satisfied'] },
    evidence: { type: 'string', minLength: 1 },
  },
} as const;

/**
 * Task Reviewer 对计划内单条验证步骤的独立执行事实。
 *
 * `not_run` 只能诚实表达未执行；是否允许批准由领域语义结合验证步骤类型
 * 判断，避免模型通过省略验证项或把未运行命令描述成通过来绕过门禁。
 */
export interface VerificationEvidence {
  readonly verificationId: string;
  readonly status: 'passed' | 'failed' | 'not_run';
  readonly evidence: string;
}

export const verificationEvidenceSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['verificationId', 'status', 'evidence'],
  properties: {
    verificationId: { type: 'string', pattern: '^VERIFY-[0-9]{3}$' },
    status: { type: 'string', enum: ['passed', 'failed', 'not_run'] },
    evidence: { type: 'string', minLength: 1 },
  },
} as const;
