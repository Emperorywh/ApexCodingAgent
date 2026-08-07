/**
 * 内置 Final Review Prompt 构建器（SPEC §26 规范性基线 + §14.1 上下文注入）。
 *
 * 基线文本逐条保留 11 条 Review 要求，末尾追加 §26“系统会提供”的全部
 * 上下文与 FinalReviewResult 结构说明（字段规则见 §14.1）。
 *
 * 纯函数，不依赖 node:*。
 */
import { isResultContractErrorCode, type ErrorCode } from '../../domain/errors.js';
import type { IntermediateCheckpoint } from '../../domain/schemas/intermediate-checkpoint.js';
import type { PlannedTask } from '../../domain/schemas/task-plan-draft.js';
import type {
  AcceptanceEvidence,
  TestReport,
} from '../../domain/schemas/task-execution-result.js';
import type { SkippedTaskSummary } from './planning.js';
import { VERIFICATION_POLICY } from './verification-policy.js';

/**
 * completed Task 的复核输入：定义、独立复核证据、复核摘要、最终 Checkpoint
 * 与测试结果。resultSummary 承载独立 Task Review 批准 Episode 的摘要，
 * 而非 Execution 自报摘要。
 */
export interface CompletedTaskReviewSummary {
  readonly definition: PlannedTask;
  readonly resultSummary: string;
  readonly acceptanceEvidence: readonly AcceptanceEvidence[];
  readonly finalCheckpoint: string;
  readonly tests: readonly TestReport[];
}

export interface FinalReviewPromptInput {
  /** 仓库根目录绝对路径。 */
  readonly repositoryRoot: string;
  /** 当前 Run Branch。 */
  readonly runBranch: string;
  /** 权威 SPEC 的 Git 相对路径。 */
  readonly specPath: string;
  /** 启动时 SPEC 内容的 SHA-256。 */
  readonly specSha256: string;
  /** 当前完整 Plan Revision。 */
  readonly planRevision: number;
  /** 全部 completed Task 的复核输入。 */
  readonly completedTasks: readonly CompletedTaskReviewSummary[];
  /** skipped Task 及原因。 */
  readonly skippedTasks: readonly SkippedTaskSummary[];
  /** 中间 Checkpoint（含最终归属 ownerTaskId）。 */
  readonly intermediateCheckpoints: readonly IntermediateCheckpoint[];
}

/** SPEC §26 规范性基线文本（逐条保留全部 Review 要求）。 */
const FINAL_REVIEW_BASELINE = `你是 ApexCodingAgent 的最终整体 Reviewer。你需要基于权威 SPEC 和当前 Run Branch 判断整个交付是否完整、一致并可验证。

系统会提供：
- REPOSITORY_ROOT、RUN_BRANCH、SPEC_PATH 和 SPEC_SHA256
- 当前完整 Plan Revision
- 全部 completed Task 的定义、独立 Task Review 验收证据、复核摘要和最终 Checkpoint
- skipped Task 及原因
- 中间 Checkpoint 的最终归属
- 已报告测试结果
- FinalReviewResult Schema

Review 要求：
1. 完整读取 SPEC，不得只依赖 Task 摘要。
2. 检查当前架构、数据流、状态流、模块边界和实现是否一致。
3. 检查每个 completed Task 的独立复核 acceptanceEvidence 是否存在、可信且与仓库事实相符。
4. 自主运行必要的最终测试和集成验证。
${VERIFICATION_POLICY}
5. 只能直接修复不改变模块边界、数据模型或验收范围的局部问题；需要 Task 级工作时返回 replan_required。
6. 不得修改、暂存或提交 SPEC。
7. 不得修改、暂存、提交或删除 .apex-coding-agent。
8. 不执行 remote push、生产部署、付款、生产数据变更或破坏其他分支。
9. 只有全部 completed Task 均已复核、没有 failed test、没有未处理规格缺口时才能返回 completed。
10. 发现仍需独立编码任务、架构调整或需求变化时返回 replan_required，并给出非空原因。
11. reviewedTaskIds 必须无重复；completed 时必须精确列出当前计划的全部 completed Task ID。

返回 FinalReviewResult 结构化结果。不要返回 Markdown，不要在结构化结果之外输出解释。`;

function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function formatCompletedTasks(tasks: readonly CompletedTaskReviewSummary[]): string {
  if (tasks.length === 0) return '（无）';
  return tasks
    .map(
      (task) =>
        `- ${task.definition.id}:\n` +
        `  definition: ${toJson(task.definition)}\n` +
        `  resultSummary: ${task.resultSummary}\n` +
        `  finalCheckpoint: ${task.finalCheckpoint}\n` +
        `  acceptanceEvidence: ${toJson(task.acceptanceEvidence)}\n` +
        `  tests: ${toJson(task.tests)}`,
    )
    .join('\n');
}

function formatSkippedTasks(tasks: readonly SkippedTaskSummary[]): string {
  if (tasks.length === 0) return '（无）';
  return tasks.map((task) => `- ${task.taskId}: ${task.skipReason}`).join('\n');
}

/** 中间 Checkpoint 的最终归属（ownerTaskId 为本次 Review 的核对对象）。 */
function formatCheckpointOwnership(checkpoints: readonly IntermediateCheckpoint[]): string {
  if (checkpoints.length === 0) return '（无）';
  return checkpoints
    .map(
      (checkpoint) =>
        `- oid: ${checkpoint.oid}\n` +
        `  ownerTaskId: ${checkpoint.ownerTaskId ?? 'null'}\n` +
        `  role: ${checkpoint.role}\n` +
        `  taskId: ${checkpoint.taskId ?? 'null'}\n` +
        `  summary: ${checkpoint.summary}`,
    )
    .join('\n');
}

/** FinalReviewResult 结构化结果格式说明（SPEC §14.1）。 */
const RESULT_FORMAT_SECTION = `FINAL_REVIEW_RESULT_FORMAT（结构化结果格式说明）：
返回 FinalReviewResult，包含字段：
- decision: "completed" | "replan_required"
- summary: 非空整体复核结论
- reviewedTaskIds: 字符串数组，必须无重复；completed 时必须与当前计划全部 completed Task ID 完全一致
- tests: 与 TaskExecutionResult 相同的 { command, result: "passed" | "failed" | "not_run" } 结构
- changedAreas: 字符串数组，记录 Final Review 直接修改的区域
- remainingRisks: 字符串数组
- replanReason: replan_required 时必须为非空字符串；completed 时必须为 JSON null（不是字符串 "null"、"N/A" 或空字符串）
completed 不得包含失败测试；发现任一 completed Task 的 acceptanceEvidence 缺失或矛盾时只能返回 replan_required。`;

/** 系统上下文小节，覆盖 SPEC §26“系统会提供”的全部条目。 */
function buildContextSection(input: FinalReviewPromptInput): string {
  return [
    '系统提供的上下文：',
    '',
    `REPOSITORY_ROOT: ${input.repositoryRoot}`,
    `RUN_BRANCH: ${input.runBranch}`,
    `SPEC_PATH: ${input.specPath}`,
    `SPEC_SHA256: ${input.specSha256}`,
    `CURRENT_PLAN_REVISION: ${input.planRevision}`,
    '',
    'COMPLETED_TASKS（定义、独立复核 acceptanceEvidence、复核摘要、最终 Checkpoint 与测试结果）：',
    formatCompletedTasks(input.completedTasks),
    '',
    'SKIPPED_TASKS（skipped Task 及原因）：',
    formatSkippedTasks(input.skippedTasks),
    '',
    'INTERMEDIATE_CHECKPOINT_OWNERSHIP（中间 Checkpoint 的最终归属）：',
    formatCheckpointOwnership(input.intermediateCheckpoints),
    '',
    RESULT_FORMAT_SECTION,
  ].join('\n');
}

/** 构建 Final Review Session 的完整提示词。 */
export function buildFinalReviewPrompt(input: FinalReviewPromptInput): string {
  return [FINAL_REVIEW_BASELINE, buildContextSection(input)].join('\n\n');
}

/**
 * Final Review 会话续接提示词。
 *
 * 原 transcript 已包含全部 Task 证据与 Review 契约；仓库可能保留中断前
 * 的复核修改，因此恢复后必须基于当前文件继续，而不是重新开始或撤销。
 * 首句必须如实陈述断点原因：结果契约失败的上一趟会话并未被中断，其
 * 复核事实仍然有效，只需按契约重新表达结论。
 */
export function buildFinalReviewResumePrompt(input: { readonly cause: ErrorCode }): string {
  const causeSentence =
    input.cause === 'RUN_INTERRUPTED'
      ? '此前的 Final Review 会话被前台中断，本会话从原对话断点继续。'
      : isResultContractErrorCode(input.cause)
        ? '此前的 Final Review 会话进程正常结束，但返回的 FinalReviewResult 未通过契约校验；本会话续接原复核上下文，基于已完成的复核事实重新返回合法结果。'
        : `此前的 Final Review 会话因可续接错误 ${input.cause} 终止，本会话从原对话断点继续。`;
  return `${causeSentence}

仓库可能保留此前会话的复核修改：先核对当前文件与 Git 状态，在此基础上继续完成整体复核，不要推倒重来。原安全边界、验收证据核对、测试要求、replan_required 规则和 FinalReviewResult 结构化结果契约全部继续有效。

${VERIFICATION_POLICY}

返回 FinalReviewResult。不要返回 Markdown，不要在结构化结果之外输出解释。`;
}
