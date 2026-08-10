/**
 * Semantic gates for Claude-returned results beyond their JSON Schemas:
 * TaskExecutionResult (SPEC §9.4) and FinalReviewResult (SPEC §14.1).
 *
 * These run after the structural schema validation inside the Claude Runtime
 * adapter; failures map to CLAUDE_RESULT_INVALID / FINAL_REVIEW_RESULT_INVALID.
 */
import { ApexError, isApexError } from './errors.js';
import type { FinalReviewResult } from './schemas/final-review-result.js';
import type { PlanReviewResult } from './schemas/plan-review-result.js';
import type { TaskExecutionResult } from './schemas/task-execution-result.js';
import type { TaskReviewResult } from './schemas/task-review-result.js';
import type { PlannedTask } from './schemas/task-plan-draft.js';
import {
  PLAN_REVIEW_DIMENSIONS,
  type ReviewIssue,
} from './schemas/review-evidence.js';

function resultInvalid(message: string): ApexError {
  return new ApexError({ code: 'CLAUDE_RESULT_INVALID', stage: 'execution', message });
}

/**
 * 判断错误是否为结果契约校验失败（适配器 Schema 校验或 §9.4 字段规则）。
 * Application 层据此决定结果修复接力，不直接引用稳定错误码字面量。
 */
export function isClaudeResultInvalid(error: unknown): boolean {
  return isApexError(error) && error.errorCode === 'CLAUDE_RESULT_INVALID';
}

/**
 * 判断错误是否为 Task Review 结果契约校验失败（适配器 Schema 或领域语义
 * 门禁）。Application 层据此决定复核结果修复接力，不直接引用错误码字面量。
 */
export function isTaskReviewResultInvalid(error: unknown): boolean {
  return isApexError(error) && error.errorCode === 'TASK_REVIEW_RESULT_INVALID';
}

/**
 * 判断错误是否为 Plan Review 结果契约校验失败（适配器 Schema 或领域语义
 * 门禁）。Application 层据此决定复核结果修复接力，不直接引用错误码字面量。
 */
export function isPlanReviewResultInvalid(error: unknown): boolean {
  return isApexError(error) && error.errorCode === 'PLAN_REVIEW_RESULT_INVALID';
}

function finalReviewInvalid(message: string): ApexError {
  return new ApexError({ code: 'FINAL_REVIEW_RESULT_INVALID', stage: 'final_review', message });
}

/** 独立 Plan Review 结果的稳定契约错误。 */
function planReviewInvalid(message: string): ApexError {
  return new ApexError({
    code: 'PLAN_REVIEW_RESULT_INVALID',
    stage: 'plan_review',
    message,
  });
}

/** 独立 Task 复核结果的稳定契约错误。 */
function taskReviewInvalid(message: string): ApexError {
  return new ApexError({
    code: 'TASK_REVIEW_RESULT_INVALID',
    stage: 'task_review',
    message,
  });
}

/**
 * 审核问题的跨字段门禁。
 *
 * Schema 已保证字段非空与路径安全；这里补充结果内 ID 唯一性和验收索引
 * 边界。计划级问题没有单一 Task 上下文，因此不得携带验收索引。
 */
function validateReviewIssues(
  issues: readonly ReviewIssue[],
  context: string,
  criterionCount: number | null,
  seenIssueIds: Set<string>,
  invalid: (message: string) => ApexError,
): void {
  for (const issue of issues) {
    if (seenIssueIds.has(issue.id)) {
      throw invalid(`review issue ID ${issue.id} is duplicated`);
    }
    seenIssueIds.add(issue.id);
    if (criterionCount === null && issue.criterionIndexes.length > 0) {
      throw invalid(`${context} issue ${issue.id} must keep criterionIndexes empty`);
    }
    for (const index of issue.criterionIndexes) {
      if (criterionCount === null || index < 0 || index >= criterionCount) {
        throw invalid(
          `${context} issue ${issue.id} criterionIndex ${index} is outside the Task acceptance criteria`,
        );
      }
    }
  }
}

/**
 * 结果契约边界上的 replanReason 归一化。
 *
 * replanReason 在 JSON Schema 中是 required 字段（type ["string","null"]），
 * 模型在 decision 不是 replan_required 时经常把它当作"必填但不适用"的字段，
 * 填入占位字符串（"null"、"N/A"、"无" 等）而不是 JSON null。该字段只有
 * 在 replan 路径上才会被消费（转 planning 的 trigger reason），completed /
 * failed 下是死数据；把这种装饰性噪声判为契约致命会让已验证完成的工作
 * 整体报废（结果修复会话由同一模型执行，同样的系统性行为无法靠接力消除）。
 *
 * 因此 decision 非 replan_required 时统一归一为 null；replan_required 的
 * 非空约束仍由语义校验严格把关。未发生归一时返回原引用，调用方据此判断
 * 是否记录告警。
 */
export function normalizeExecutionResult(result: TaskExecutionResult): TaskExecutionResult {
  if (result.decision === 'replan_required' || result.replanReason === null) return result;
  return { ...result, replanReason: null };
}

/**
 * Task Review 的 replanReason 只在重新规划路径上有业务含义。
 *
 * approved/changes_required 下统一清除模型产生的占位噪声，后续语义门禁
 * 仍会严格验证真正的 replan_required 必须携带非空原因。
 */
export function normalizeTaskReviewResult(result: TaskReviewResult): TaskReviewResult {
  if (result.decision === 'replan_required' || result.replanReason === null) return result;
  return { ...result, replanReason: null };
}

/** FinalReviewResult 的同款归一化（§14.1 与 §9.4 的耦合规则一致）。 */
export function normalizeFinalReviewResult(result: FinalReviewResult): FinalReviewResult {
  if (result.decision === 'replan_required' || result.replanReason === null) return result;
  return { ...result, replanReason: null };
}

/**
 * §9.4 field rules: criterionIndex covers every acceptance criterion exactly
 * once (0-based, no gaps, duplicates or out-of-range), replanReason coupling,
 * and the `completed` gates (all evidence satisfied, no failed test).
 * `failed`/`replan_required` must still cover all criteria.
 */
export function validateExecutionResultSemantics(
  result: TaskExecutionResult,
  task: PlannedTask,
): void {
  if (result.decision === 'replan_required') {
    if (result.replanReason === null) {
      throw resultInvalid('decision replan_required requires a non-empty replanReason');
    }
  } else if (result.replanReason !== null) {
    throw resultInvalid(`decision ${result.decision} requires replanReason to be null`);
  }

  const criterionCount = task.acceptanceCriteria.length;
  const covered = new Set<number>();
  for (const evidence of result.acceptanceEvidence) {
    const index = evidence.criterionIndex;
    if (index < 0 || index >= criterionCount) {
      throw resultInvalid(
        `acceptanceEvidence criterionIndex ${index} out of range 0..${criterionCount - 1}`,
      );
    }
    if (covered.has(index)) {
      throw resultInvalid(`acceptanceEvidence criterionIndex ${index} reported more than once`);
    }
    covered.add(index);
  }
  for (let index = 0; index < criterionCount; index += 1) {
    if (!covered.has(index)) {
      throw resultInvalid(`acceptanceEvidence missing criterionIndex ${index}`);
    }
  }

  if (result.decision === 'completed') {
    if (result.tests.some((test) => test.result === 'failed')) {
      throw resultInvalid('decision completed must not contain failed tests');
    }
    if (result.acceptanceEvidence.some((evidence) => evidence.status !== 'satisfied')) {
      throw resultInvalid('decision completed requires every acceptanceEvidence satisfied');
    }
  }
}

/**
 * 独立 Task Review 的领域门禁。
 *
 * 每条验收标准必须被精确覆盖；approved 只有在全部证据 satisfied、没有
 * failed test 且 issues 为空时成立。changes_required 必须给出可观察的
 * 不通过事实，防止无理由打回造成不可推导循环。
 */
export function validateTaskReviewResultSemantics(
  result: TaskReviewResult,
  task: PlannedTask,
): void {
  if (result.decision === 'replan_required') {
    if (result.replanReason === null) {
      throw taskReviewInvalid('decision replan_required requires a non-empty replanReason');
    }
  } else if (result.replanReason !== null) {
    throw taskReviewInvalid(`decision ${result.decision} requires replanReason to be null`);
  }

  const criterionCount = task.acceptanceCriteria.length;
  const seenIssueIds = new Set<string>();
  validateReviewIssues(
    result.issues,
    `task ${task.id}`,
    criterionCount,
    seenIssueIds,
    taskReviewInvalid,
  );
  const covered = new Set<number>();
  for (const evidence of result.acceptanceEvidence) {
    const index = evidence.criterionIndex;
    if (index < 0 || index >= criterionCount) {
      throw taskReviewInvalid(
        `acceptanceEvidence criterionIndex ${index} out of range 0..${criterionCount - 1}`,
      );
    }
    if (covered.has(index)) {
      throw taskReviewInvalid(`acceptanceEvidence criterionIndex ${index} is duplicated`);
    }
    covered.add(index);
  }
  if (covered.size !== criterionCount) {
    const missing = Array.from({ length: criterionCount }, (_, index) => index).filter(
      (index) => !covered.has(index),
    );
    throw taskReviewInvalid(
      `acceptanceEvidence must cover every criterion exactly once; missing: ${missing.join(', ')}`,
    );
  }

  /**
   * verificationPlan 是 Planning 已批准的验收执行契约，Reviewer 必须按原
   * 顺序逐项交付证据。command 步骤同时要与 tests 中的真实命令结果一一
   * 对应；manual 步骤只能诚实记录 not_run，不能伪造自动通过。
   */
  if (result.verificationEvidence.length !== task.verificationPlan.length) {
    throw taskReviewInvalid(
      `verificationEvidence must cover all ${task.verificationPlan.length} verification steps exactly once`,
    );
  }
  for (const [index, step] of task.verificationPlan.entries()) {
    const evidence = result.verificationEvidence[index];
    if (evidence?.verificationId !== step.id) {
      throw taskReviewInvalid(
        `verificationEvidence at index ${index} must reference ${step.id}`,
      );
    }
    if (step.kind === 'manual' && evidence.status !== 'not_run') {
      throw taskReviewInvalid(
        `manual verification ${step.id} must be reported as not_run by the automated Reviewer`,
      );
    }
    if (step.kind === 'command') {
      const matchingTests = result.tests.filter((test) => test.command === step.command);
      if (matchingTests.length !== 1) {
        throw taskReviewInvalid(
          `command verification ${step.id} requires exactly one matching test report for ${step.command}`,
        );
      }
      if (matchingTests[0]!.result !== evidence.status) {
        throw taskReviewInvalid(
          `command verification ${step.id} status must match its test report`,
        );
      }
    }
  }

  const hasUnsatisfied = result.acceptanceEvidence.some(
    (evidence) => evidence.status === 'not_satisfied',
  );
  const hasFailedTest = result.tests.some((test) => test.result === 'failed');
  const hasBlockedAutomaticVerification = task.verificationPlan.some(
    (step, index) =>
      step.kind !== 'manual' && result.verificationEvidence[index]?.status !== 'passed',
  );
  if (result.decision === 'approved') {
    if (hasUnsatisfied) {
      throw taskReviewInvalid('approved requires every acceptance criterion satisfied');
    }
    if (hasFailedTest) {
      throw taskReviewInvalid('approved cannot contain a failed test');
    }
    if (hasBlockedAutomaticVerification) {
      throw taskReviewInvalid(
        'approved requires every command/static_analysis verification to pass',
      );
    }
    if (result.issues.length > 0) {
      throw taskReviewInvalid('approved requires an empty issues list');
    }
  }
  if (
    result.decision === 'changes_required' &&
    !hasUnsatisfied &&
    !hasFailedTest &&
    !hasBlockedAutomaticVerification &&
    result.issues.length === 0
  ) {
    throw taskReviewInvalid(
      'changes_required requires an unsatisfied criterion, failed test, or non-empty issue',
    );
  }
}

/**
 * 独立 Plan Review 的领域门禁。
 *
 * 每个草稿 Task 必须被精确评估一次；Task 的 assessment 决策必须与其 issues
 * 一致；整体 approved 只有在所有 Task 批准且计划级 issues 为空时成立。
 */
export function validatePlanReviewResultSemantics(
  result: PlanReviewResult,
  tasks: readonly PlannedTask[],
): void {
  const taskIds = tasks.map((task) => task.id);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const expected = new Set(taskIds);
  const seen = new Set<string>();
  const seenIssueIds = new Set<string>();
  for (const [index, assessment] of result.taskAssessments.entries()) {
    if (!expected.has(assessment.taskId)) {
      throw planReviewInvalid(`task assessment references unknown task ${assessment.taskId}`);
    }
    if (seen.has(assessment.taskId)) {
      throw planReviewInvalid(`task assessment duplicates task ${assessment.taskId}`);
    }
    if (taskIds[index] !== assessment.taskId) {
      throw planReviewInvalid(
        `task assessment at index ${index} must reference ${taskIds[index] ?? 'no task'}`,
      );
    }
    seen.add(assessment.taskId);
    const task = taskById.get(assessment.taskId)!;
    validateReviewIssues(
      assessment.issues,
      `task ${assessment.taskId}`,
      task.acceptanceCriteria.length,
      seenIssueIds,
      planReviewInvalid,
    );
    if (assessment.checks.length !== PLAN_REVIEW_DIMENSIONS.length) {
      throw planReviewInvalid(
        `task assessment ${assessment.taskId} must cover all ${PLAN_REVIEW_DIMENSIONS.length} review dimensions`,
      );
    }
    for (const [checkIndex, dimension] of PLAN_REVIEW_DIMENSIONS.entries()) {
      if (assessment.checks[checkIndex]?.dimension !== dimension) {
        throw planReviewInvalid(
          `task assessment ${assessment.taskId} check ${checkIndex} must cover ${dimension}`,
        );
      }
    }
    const hasFailedCheck = assessment.checks.some(
      (check) => check.status === 'not_satisfied',
    );
    if (
      assessment.decision === 'approved' &&
      (assessment.issues.length > 0 || hasFailedCheck)
    ) {
      throw planReviewInvalid(
        `approved task assessment ${assessment.taskId} requires every check satisfied and no issues`,
      );
    }
    if (assessment.decision === 'changes_required') {
      /**
       * 失败维度与结构化问题承担不同职责，必须同时存在：check 提供固定
       * 质量维度上的否定证据，ReviewIssue 则给下一轮 Planner 明确的修复
       * 目标、影响路径与验收关联。允许二选一会重新退化为模糊打回。
       */
      if (!hasFailedCheck) {
        throw planReviewInvalid(
          `changes_required task assessment ${assessment.taskId} requires at least one failed check`,
        );
      }
      if (assessment.issues.length === 0) {
        throw planReviewInvalid(
          `changes_required task assessment ${assessment.taskId} requires at least one structured issue`,
        );
      }
    }
  }
  if (seen.size !== expected.size) {
    const missing = taskIds.filter((taskId) => !seen.has(taskId));
    throw planReviewInvalid(`task assessments are missing: ${missing.join(', ')}`);
  }

  validateReviewIssues(
    result.issues,
    'plan-level',
    null,
    seenIssueIds,
    planReviewInvalid,
  );

  const hasRejectedTask = result.taskAssessments.some(
    (assessment) => assessment.decision === 'changes_required',
  );
  const hasIssues = hasRejectedTask || result.issues.length > 0;
  if (result.decision === 'approved' && hasIssues) {
    throw planReviewInvalid('approved plan review requires every task approved and no plan issues');
  }
  if (result.decision === 'changes_required' && !hasIssues) {
    throw planReviewInvalid('changes_required plan review requires at least one observable issue');
  }
}

/**
 * §14.1 rules: reviewedTaskIds has no duplicates; `completed` requires the
 * exact set of the current plan's completed task IDs, a null replanReason
 * and no failed tests; `replan_required` requires a non-empty replanReason.
 */
export function validateFinalReviewResultSemantics(
  result: FinalReviewResult,
  completedTaskIds: readonly string[],
): void {
  const seen = new Set<string>();
  for (const taskId of result.reviewedTaskIds) {
    if (seen.has(taskId)) {
      throw finalReviewInvalid(`reviewedTaskIds contains duplicate ${taskId}`);
    }
    seen.add(taskId);
  }

  if (result.decision === 'replan_required') {
    if (result.replanReason === null) {
      throw finalReviewInvalid('decision replan_required requires a non-empty replanReason');
    }
    return;
  }

  if (result.replanReason !== null) {
    throw finalReviewInvalid('decision completed requires replanReason to be null');
  }
  if (result.tests.some((test) => test.result === 'failed')) {
    throw finalReviewInvalid('decision completed must not contain failed tests');
  }
  if (seen.size !== completedTaskIds.length) {
    throw finalReviewInvalid(
      `reviewedTaskIds lists ${seen.size} tasks, expected exactly ${completedTaskIds.length} completed tasks`,
    );
  }
  for (const taskId of completedTaskIds) {
    if (!seen.has(taskId)) {
      throw finalReviewInvalid(`reviewedTaskIds is missing completed task ${taskId}`);
    }
  }
}
