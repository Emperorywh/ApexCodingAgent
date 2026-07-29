/**
 * Semantic gates for Claude-returned results beyond their JSON Schemas:
 * TaskExecutionResult (SPEC §9.4) and FinalReviewResult (SPEC §14.1).
 *
 * These run after the structural schema validation inside the Claude Runtime
 * adapter; failures map to CLAUDE_RESULT_INVALID / FINAL_REVIEW_RESULT_INVALID.
 */
import { ApexError, isApexError } from './errors.js';
import type { FinalReviewResult } from './schemas/final-review-result.js';
import type { TaskExecutionResult } from './schemas/task-execution-result.js';
import type { PlannedTask } from './schemas/task-plan-draft.js';

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

function finalReviewInvalid(message: string): ApexError {
  return new ApexError({ code: 'FINAL_REVIEW_RESULT_INVALID', stage: 'final_review', message });
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
