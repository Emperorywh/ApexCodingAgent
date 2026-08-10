/**
 * Semantic gates for Claude results: TaskExecutionResult (§9.4) and
 * FinalReviewResult (§14.1).
 */
import { describe, expect, it } from 'vitest';
import {
  normalizeExecutionResult,
  normalizeFinalReviewResult,
  normalizeTaskReviewResult,
  validatePlanReviewResultSemantics,
  validateExecutionResultSemantics,
  validateFinalReviewResultSemantics,
  validateTaskReviewResultSemantics,
} from '../../src/domain/results.js';
import type { FinalReviewResult } from '../../src/domain/schemas/final-review-result.js';
import type { PlanReviewResult } from '../../src/domain/schemas/plan-review-result.js';
import type { PlannedTask } from '../../src/domain/schemas/task-plan-draft.js';
import type { TaskReviewResult } from '../../src/domain/schemas/task-review-result.js';
import {
  expectApexError,
  mkPlanReviewChecks,
  mkResult,
  mkReviewIssue,
  mkTask,
  mkVerificationEvidence,
} from './fixtures.js';

const TASK = mkTask('TASK-001'); // two acceptance criteria: indexes 0 and 1
const PLAN_TASKS = [TASK, mkTask('TASK-002')];

function mkFinalReview(overrides: Partial<FinalReviewResult> = {}): FinalReviewResult {
  return {
    decision: 'completed',
    summary: '整体复核通过',
    reviewedTaskIds: ['TASK-001', 'TASK-002'],
    tests: [{ command: 'npm test', result: 'passed' }],
    changedAreas: [],
    remainingRisks: [],
    replanReason: null,
    ...overrides,
  };
}

/**
 * 构造精确覆盖两个候选 Task 的独立计划复核结果。
 * 领域门禁测试通过覆盖、顺序和 decision/issues 耦合的局部变化验证失败路径。
 */
function mkPlanReview(overrides: Partial<PlanReviewResult> = {}): PlanReviewResult {
  return {
    decision: 'approved',
    summary: '独立计划复核通过',
    taskAssessments: [
      { taskId: 'TASK-001', decision: 'approved', checks: mkPlanReviewChecks(), issues: [] },
      { taskId: 'TASK-002', decision: 'approved', checks: mkPlanReviewChecks(), issues: [] },
    ],
    issues: [],
    ...overrides,
  };
}

/**
 * 构造覆盖全部验收标准的独立复核结果。
 * 各测试只覆盖需要变化的字段，避免重复拼装掩盖领域门禁差异。
 */
function mkTaskReview(overrides: Partial<TaskReviewResult> = {}): TaskReviewResult {
  return {
    decision: 'approved',
    summary: '独立复核通过',
    tests: [{ command: 'npm test', result: 'passed' }],
    verificationEvidence: [mkVerificationEvidence()],
    acceptanceEvidence: [
      { criterionIndex: 0, status: 'satisfied', evidence: '证据 0' },
      { criterionIndex: 1, status: 'satisfied', evidence: '证据 1' },
    ],
    issues: [],
    replanReason: null,
    ...overrides,
  };
}

describe('TaskExecutionResult semantics (§9.4)', () => {
  it('accepts a fully satisfied completed result', () => {
    expect(() => validateExecutionResultSemantics(mkResult(), TASK)).not.toThrow();
  });

  it('rejects missing, out-of-range and duplicated criterionIndex entries', () => {
    const missing = mkResult({
      acceptanceEvidence: [{ criterionIndex: 0, status: 'satisfied', evidence: 'e' }],
    });
    expectApexError(
      () => validateExecutionResultSemantics(missing, TASK),
      'CLAUDE_RESULT_INVALID',
    );

    const outOfRange = mkResult({
      acceptanceEvidence: [
        { criterionIndex: 0, status: 'satisfied', evidence: 'e' },
        { criterionIndex: 1, status: 'satisfied', evidence: 'e' },
        { criterionIndex: 2, status: 'satisfied', evidence: 'e' },
      ],
    });
    expectApexError(
      () => validateExecutionResultSemantics(outOfRange, TASK),
      'CLAUDE_RESULT_INVALID',
    );

    const duplicated = mkResult({
      acceptanceEvidence: [
        { criterionIndex: 0, status: 'satisfied', evidence: 'e' },
        { criterionIndex: 0, status: 'satisfied', evidence: 'e' },
        { criterionIndex: 1, status: 'satisfied', evidence: 'e' },
      ],
    });
    expectApexError(
      () => validateExecutionResultSemantics(duplicated, TASK),
      'CLAUDE_RESULT_INVALID',
    );
  });

  it('completed requires every criterion satisfied and no failed test', () => {
    const notSatisfied = mkResult({
      acceptanceEvidence: [
        { criterionIndex: 0, status: 'satisfied', evidence: 'e' },
        { criterionIndex: 1, status: 'not_satisfied', evidence: 'e' },
      ],
    });
    expectApexError(
      () => validateExecutionResultSemantics(notSatisfied, TASK),
      'CLAUDE_RESULT_INVALID',
    );

    const failedTest = mkResult({ tests: [{ command: 'npm test', result: 'failed' }] });
    expectApexError(
      () => validateExecutionResultSemantics(failedTest, TASK),
      'CLAUDE_RESULT_INVALID',
    );
  });

  it('replan_required needs a reason but allows not_satisfied evidence', () => {
    const legal = mkResult({
      decision: 'replan_required',
      replanReason: 'architecture changed',
      acceptanceEvidence: [
        { criterionIndex: 0, status: 'satisfied', evidence: 'e' },
        { criterionIndex: 1, status: 'not_satisfied', evidence: 'e' },
      ],
    });
    expect(() => validateExecutionResultSemantics(legal, TASK)).not.toThrow();

    const noReason = mkResult({ decision: 'replan_required' });
    expectApexError(
      () => validateExecutionResultSemantics(noReason, TASK),
      'CLAUDE_RESULT_INVALID',
    );

    const stillIncomplete = mkResult({
      decision: 'replan_required',
      replanReason: 'r',
      acceptanceEvidence: [{ criterionIndex: 0, status: 'satisfied', evidence: 'e' }],
    });
    expectApexError(
      () => validateExecutionResultSemantics(stillIncomplete, TASK),
      'CLAUDE_RESULT_INVALID',
    );
  });

  it('failed decision keeps full coverage and a null replanReason', () => {
    const legal = mkResult({
      decision: 'failed',
      acceptanceEvidence: [
        { criterionIndex: 0, status: 'satisfied', evidence: 'e' },
        { criterionIndex: 1, status: 'not_satisfied', evidence: 'e' },
      ],
    });
    expect(() => validateExecutionResultSemantics(legal, TASK)).not.toThrow();

    const withReason = mkResult({ decision: 'failed', replanReason: 'r' });
    expectApexError(
      () => validateExecutionResultSemantics(withReason, TASK),
      'CLAUDE_RESULT_INVALID',
    );
  });

  it('completed must not carry a replanReason', () => {
    const withReason = mkResult({ replanReason: 'r' });
    expectApexError(
      () => validateExecutionResultSemantics(withReason, TASK),
      'CLAUDE_RESULT_INVALID',
    );
  });
});

describe('TaskReviewResult 独立完成门禁', () => {
  it('只接受证据完整、测试无失败且无问题的 approved', () => {
    expect(() => validateTaskReviewResultSemantics(mkTaskReview(), TASK)).not.toThrow();

    expectApexError(
      () =>
        validateTaskReviewResultSemantics(
          mkTaskReview({
            acceptanceEvidence: [
              { criterionIndex: 0, status: 'satisfied', evidence: '证据 0' },
              { criterionIndex: 1, status: 'not_satisfied', evidence: '证据 1' },
            ],
          }),
          TASK,
        ),
      'TASK_REVIEW_RESULT_INVALID',
    );
    expectApexError(
      () =>
        validateTaskReviewResultSemantics(
          mkTaskReview({ tests: [{ command: 'npm test', result: 'failed' }] }),
          TASK,
        ),
      'TASK_REVIEW_RESULT_INVALID',
    );
    expectApexError(
      () =>
        validateTaskReviewResultSemantics(
          mkTaskReview({ issues: [mkReviewIssue()] }),
          TASK,
        ),
      'TASK_REVIEW_RESULT_INVALID',
    );
  });

  it('要求 verificationPlan 精确覆盖且命令结果一致', () => {
    expectApexError(
      () =>
        validateTaskReviewResultSemantics(
          mkTaskReview({ verificationEvidence: [] }),
          TASK,
        ),
      'TASK_REVIEW_RESULT_INVALID',
    );
    expectApexError(
      () =>
        validateTaskReviewResultSemantics(
          mkTaskReview({
            verificationEvidence: [mkVerificationEvidence({ status: 'failed' })],
          }),
          TASK,
        ),
      'TASK_REVIEW_RESULT_INVALID',
    );
  });

  it('manual 验证必须诚实 not_run，且不会阻止其他证据完整的批准', () => {
    const manualTask: PlannedTask = {
      ...TASK,
      verificationPlan: [
        {
          id: 'VERIFY-001',
          kind: 'manual',
          criterionIndexes: [0, 1],
          procedure: '由用户检查交互结果',
          expectedEvidence: '用户确认界面行为符合验收标准',
          command: null,
          timeoutSeconds: null,
        },
      ],
    };
    const manualReview = mkTaskReview({
      tests: [],
      verificationEvidence: [
        {
          verificationId: 'VERIFY-001',
          status: 'not_run',
          evidence: '该步骤按计划保留给用户手动验证',
        },
      ],
    });
    expect(() => validateTaskReviewResultSemantics(manualReview, manualTask)).not.toThrow();
    expectApexError(
      () =>
        validateTaskReviewResultSemantics(
          {
            ...manualReview,
            verificationEvidence: [
              {
                verificationId: 'VERIFY-001',
                status: 'passed',
                evidence: '自动 Reviewer 不得代替用户确认',
              },
            ],
          },
          manualTask,
        ),
      'TASK_REVIEW_RESULT_INVALID',
    );
  });

  it('拒绝缺失或重复的验收证据', () => {
    expectApexError(
      () =>
        validateTaskReviewResultSemantics(
          mkTaskReview({
            acceptanceEvidence: [
              { criterionIndex: 0, status: 'satisfied', evidence: '证据 0' },
            ],
          }),
          TASK,
        ),
      'TASK_REVIEW_RESULT_INVALID',
    );
    expectApexError(
      () =>
        validateTaskReviewResultSemantics(
          mkTaskReview({
            acceptanceEvidence: [
              { criterionIndex: 0, status: 'satisfied', evidence: '证据 A' },
              { criterionIndex: 0, status: 'satisfied', evidence: '证据 B' },
            ],
          }),
          TASK,
        ),
      'TASK_REVIEW_RESULT_INVALID',
    );
  });

  it('changes_required 必须有可观察问题，replan_required 必须有原因', () => {
    expectApexError(
      () =>
        validateTaskReviewResultSemantics(
          mkTaskReview({ decision: 'changes_required' }),
          TASK,
        ),
      'TASK_REVIEW_RESULT_INVALID',
    );
    expect(() =>
      validateTaskReviewResultSemantics(
        mkTaskReview({ decision: 'changes_required', issues: [mkReviewIssue()] }),
        TASK,
      ),
    ).not.toThrow();
    expectApexError(
      () =>
        validateTaskReviewResultSemantics(
          mkTaskReview({ decision: 'replan_required' }),
          TASK,
        ),
      'TASK_REVIEW_RESULT_INVALID',
    );
    expect(() =>
      validateTaskReviewResultSemantics(
        mkTaskReview({ decision: 'replan_required', replanReason: '架构前提已变化' }),
        TASK,
      ),
    ).not.toThrow();
  });
});

describe('FinalReviewResult semantics (§14.1)', () => {
  const COMPLETED_IDS = ['TASK-001', 'TASK-002'];

  it('accepts completed with the exact completed-task set, order-insensitive', () => {
    expect(() =>
      validateFinalReviewResultSemantics(mkFinalReview(), COMPLETED_IDS),
    ).not.toThrow();
    expect(() =>
      validateFinalReviewResultSemantics(
        mkFinalReview({ reviewedTaskIds: ['TASK-002', 'TASK-001'] }),
        COMPLETED_IDS,
      ),
    ).not.toThrow();
  });

  it('rejects incomplete, excessive or duplicated reviewedTaskIds', () => {
    expectApexError(
      () =>
        validateFinalReviewResultSemantics(
          mkFinalReview({ reviewedTaskIds: ['TASK-001'] }),
          COMPLETED_IDS,
        ),
      'FINAL_REVIEW_RESULT_INVALID',
    );
    expectApexError(
      () =>
        validateFinalReviewResultSemantics(
          mkFinalReview({ reviewedTaskIds: ['TASK-001', 'TASK-002', 'TASK-003'] }),
          COMPLETED_IDS,
        ),
      'FINAL_REVIEW_RESULT_INVALID',
    );
    expectApexError(
      () =>
        validateFinalReviewResultSemantics(
          mkFinalReview({ reviewedTaskIds: ['TASK-001', 'TASK-001', 'TASK-002'] }),
          COMPLETED_IDS,
        ),
      'FINAL_REVIEW_RESULT_INVALID',
    );
  });

  it('rejects duplicates even for replan_required', () => {
    expectApexError(
      () =>
        validateFinalReviewResultSemantics(
          mkFinalReview({
            decision: 'replan_required',
            replanReason: 'gap found',
            reviewedTaskIds: ['TASK-001', 'TASK-001'],
          }),
          COMPLETED_IDS,
        ),
      'FINAL_REVIEW_RESULT_INVALID',
    );
  });

  it('rejects completed with a failed test or a replanReason', () => {
    expectApexError(
      () =>
        validateFinalReviewResultSemantics(
          mkFinalReview({ tests: [{ command: 'npm test', result: 'failed' }] }),
          COMPLETED_IDS,
        ),
      'FINAL_REVIEW_RESULT_INVALID',
    );
    expectApexError(
      () =>
        validateFinalReviewResultSemantics(
          mkFinalReview({ replanReason: 'r' }),
          COMPLETED_IDS,
        ),
      'FINAL_REVIEW_RESULT_INVALID',
    );
  });

  it('rejects replan_required without a reason and accepts it with one', () => {
    expectApexError(
      () =>
        validateFinalReviewResultSemantics(
          mkFinalReview({ decision: 'replan_required', reviewedTaskIds: [] }),
          COMPLETED_IDS,
        ),
      'FINAL_REVIEW_RESULT_INVALID',
    );
    expect(() =>
      validateFinalReviewResultSemantics(
        mkFinalReview({
          decision: 'replan_required',
          replanReason: 'missing integration tests',
          reviewedTaskIds: ['TASK-001'],
        }),
        COMPLETED_IDS,
      ),
    ).not.toThrow();
  });
});

describe('PlanReviewResult semantic gate', () => {
  it('accepts only exact ordered Task coverage for approved', () => {
    expect(() => validatePlanReviewResultSemantics(mkPlanReview(), PLAN_TASKS)).not.toThrow();
    expectApexError(
      () =>
        validatePlanReviewResultSemantics(
          mkPlanReview({
            taskAssessments: [
              { taskId: 'TASK-002', decision: 'approved', checks: mkPlanReviewChecks(), issues: [] },
              { taskId: 'TASK-001', decision: 'approved', checks: mkPlanReviewChecks(), issues: [] },
            ],
          }),
          PLAN_TASKS,
        ),
      'PLAN_REVIEW_RESULT_INVALID',
    );
  });

  it('要求每个 Task 对固定审核维度逐项举证', () => {
    expectApexError(
      () =>
        validatePlanReviewResultSemantics(
          mkPlanReview({
            taskAssessments: [
              { taskId: 'TASK-001', decision: 'approved', checks: [], issues: [] },
              { taskId: 'TASK-002', decision: 'approved', checks: mkPlanReviewChecks(), issues: [] },
            ],
          }),
          PLAN_TASKS,
        ),
      'PLAN_REVIEW_RESULT_INVALID',
    );
  });

  it('couples approved and changes_required to Task and plan issues', () => {
    expectApexError(
      () =>
        validatePlanReviewResultSemantics(
          mkPlanReview({
            issues: [mkReviewIssue({ category: 'architecture', criterionIndexes: [] })],
          }),
          PLAN_TASKS,
        ),
      'PLAN_REVIEW_RESULT_INVALID',
    );
    expect(() =>
      validatePlanReviewResultSemantics(
        mkPlanReview({
          decision: 'changes_required',
          taskAssessments: [
            {
              taskId: 'TASK-001',
              decision: 'changes_required',
              checks: mkPlanReviewChecks({
                scope_cohesion: {
                  dimension: 'scope_cohesion',
                  status: 'not_satisfied',
                  evidence: 'Task 同时包含两个独立闭环',
                },
              }),
              issues: [mkReviewIssue({ category: 'task_scope' })],
            },
            { taskId: 'TASK-002', decision: 'approved', checks: mkPlanReviewChecks(), issues: [] },
          ],
        }),
        PLAN_TASKS,
      ),
    ).not.toThrow();
  });

  it('changes_required 同时要求失败维度和结构化 ReviewIssue', () => {
    /**
     * 固定维度证据与返工目标不能互相替代：只有失败 check 时缺少明确
     * requiredChange，只有 issue 时又与七个维度全部 satisfied 相矛盾。
     */
    const failedChecks = mkPlanReviewChecks({
      scope_cohesion: {
        dimension: 'scope_cohesion',
        status: 'not_satisfied',
        evidence: 'Task 同时包含两个独立闭环',
      },
    });
    expectApexError(
      () =>
        validatePlanReviewResultSemantics(
          mkPlanReview({
            decision: 'changes_required',
            taskAssessments: [
              {
                taskId: 'TASK-001',
                decision: 'changes_required',
                checks: failedChecks,
                issues: [],
              },
              { taskId: 'TASK-002', decision: 'approved', checks: mkPlanReviewChecks(), issues: [] },
            ],
          }),
          PLAN_TASKS,
        ),
      'PLAN_REVIEW_RESULT_INVALID',
    );
    expectApexError(
      () =>
        validatePlanReviewResultSemantics(
          mkPlanReview({
            decision: 'changes_required',
            taskAssessments: [
              {
                taskId: 'TASK-001',
                decision: 'changes_required',
                checks: mkPlanReviewChecks(),
                issues: [mkReviewIssue({ category: 'task_scope' })],
              },
              { taskId: 'TASK-002', decision: 'approved', checks: mkPlanReviewChecks(), issues: [] },
            ],
          }),
          PLAN_TASKS,
        ),
      'PLAN_REVIEW_RESULT_INVALID',
    );
  });
});

describe('replanReason normalization at the contract boundary', () => {
  it('coerces a placeholder replanReason to null for completed and failed decisions', () => {
    // 与现网故障同形：模型把 required 的 replanReason 填成占位字符串。
    const completed = normalizeExecutionResult(mkResult({ replanReason: 'null' }));
    expect(completed.replanReason).toBeNull();
    expect(() => validateExecutionResultSemantics(completed, TASK)).not.toThrow();

    const failed = normalizeExecutionResult(
      mkResult({ decision: 'failed', replanReason: 'N/A' }),
    );
    expect(failed.replanReason).toBeNull();
    expect(() => validateExecutionResultSemantics(failed, TASK)).not.toThrow();
  });

  it('keeps the reason for replan_required and returns the same reference when unchanged', () => {
    const replan = mkResult({ decision: 'replan_required', replanReason: 'architecture changed' });
    expect(normalizeExecutionResult(replan)).toBe(replan);

    const clean = mkResult();
    expect(normalizeExecutionResult(clean)).toBe(clean);
  });

  it('coerces a placeholder replanReason to null for a completed final review', () => {
    const normalized = normalizeFinalReviewResult(mkFinalReview({ replanReason: '无' }));
    expect(normalized.replanReason).toBeNull();
    expect(() =>
      validateFinalReviewResultSemantics(normalized, ['TASK-001', 'TASK-002']),
    ).not.toThrow();

    const replan = mkFinalReview({ decision: 'replan_required', replanReason: 'gap found' });
    expect(normalizeFinalReviewResult(replan)).toBe(replan);
  });

  it('独立复核仅在 replan_required 时保留 replanReason', () => {
    const normalized = normalizeTaskReviewResult(mkTaskReview({ replanReason: 'N/A' }));
    expect(normalized.replanReason).toBeNull();
    expect(() => validateTaskReviewResultSemantics(normalized, TASK)).not.toThrow();

    const replan = mkTaskReview({
      decision: 'replan_required',
      replanReason: '验收前提已变化',
    });
    expect(normalizeTaskReviewResult(replan)).toBe(replan);
  });
});
