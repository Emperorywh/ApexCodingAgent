/**
 * 独立 Task Review Prompt 构建器。
 *
 * 该提示词不注入 Execution transcript、思考过程、自报结果或会话续接
 * 信息；复核模型必须从全新上下文独立读取仓库并验证候选实现。
 */
import { isResultContractErrorCode, type ErrorCode } from '../../domain/errors.js';
import type { PlannedTask } from '../../domain/schemas/task-plan-draft.js';
import { VERIFICATION_POLICY } from './verification-policy.js';

export interface TaskReviewPromptInput {
  readonly repositoryRoot: string;
  readonly runBranch: string;
  readonly specPath: string;
  readonly specSha256: string;
  readonly planRevision: number;
  readonly task: PlannedTask;
  readonly candidateCheckpoint: string;
}

function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * 构造全新 Task Review Session 的完整输入。
 *
 * Review 为严格只读：可以读取文件和运行无副作用验证，但不得修改工作树、
 * 索引或 HEAD；编排器会用会话前后 Git 快照独立执行第二道门禁。
 */
export function buildTaskReviewPrompt(input: TaskReviewPromptInput): string {
  return `你是 ApexCodingAgent 的独立 Task Reviewer。你没有、也不得尝试恢复产生候选实现的 Execution Session 上下文。你的职责是从全新上下文独立验证候选 Task 是否真正完成。

仓库根目录：${input.repositoryRoot}
Run Branch：${input.runBranch}
SPEC 路径：${input.specPath}
SPEC SHA-256：${input.specSha256}
Plan Revision：${input.planRevision}
候选 Checkpoint：${input.candidateCheckpoint}

CURRENT_TASK（完整定义，JSON）：
${toJson(input.task)}

复核要求：
1. 独立阅读 CURRENT_TASK、SPEC、相关源码、测试和仓库状态，不采信候选结果的自我判断。
2. 同时核对 objective 与 nonGoals，确认候选实现没有用范围外改动掩盖未完成目标。
3. 按 verificationPlan 独立覆盖每项 acceptanceCriteria；command/static_analysis 应取得相应证据，manual 步骤不得伪造成已由 Agent 自动执行。
4. 对每项 acceptanceCriteria 按原索引给出一条 acceptanceEvidence，并引用可观察的仓库或测试事实；不要仅复述 Execution Session 报告的 tests。
${VERIFICATION_POLICY}
5. 本会话严格只读：不得修改、创建、删除、暂存或提交文件，不得移动 HEAD，不得执行 remote push 或其他有副作用的操作。运行测试前先确认其产物已被 .gitignore 覆盖；若仍产生未被忽略的新文件，必须在返回结果前清理干净——会话前后的 Git 快照对任何工作树、索引或未跟踪文件差异都会判定为越权写入并终止整个 Run。
6. 全部验收条件均 satisfied、不存在 failed test 且 issues 为空时，返回 approved。
7. 当前 Task 边界内可以修复的问题，返回 changes_required，并在 issues 中逐条给出准确、可执行的问题；至少存在一项 not_satisfied、failed test 或 issue。
8. 只有仓库事实、架构前置条件、需求变化或实际范围证明预算不成立时，才返回 replan_required 和非空 replanReason。
9. 不得因为候选结果声称 completed 就降低证据标准；不确定或证据不足时不能批准。

返回 TaskReviewResult 结构化结果：
- decision: "approved" | "changes_required" | "replan_required"
- summary: 非空复核摘要
- tests: { command, result: "passed" | "failed" | "not_run" }[]
- acceptanceEvidence: { criterionIndex, status: "satisfied" | "not_satisfied", evidence }[]
- issues: string[]
- replanReason: replan_required 时为非空字符串，否则必须为 JSON null

不要返回 Markdown，不要在结构化结果之外输出解释。`;
}

/**
 * 中断恢复只续接 Reviewer 自己的对话，不接触候选 Execution Session。
 *
 * 原始完整上下文已经存在于 Reviewer transcript；恢复提示只重申只读边界
 * 和结果契约，防止中断后的模型误把复核变成实现会话。首句必须如实陈述
 * 断点原因：结果契约失败的上一趟会话并未被中断，只是把复核结论重新
 * 按契约表达，不能让模型误以为复核工作未完成而推倒重来。
 */
export function buildTaskReviewResumePrompt(input: { readonly cause: ErrorCode }): string {
  const causeSentence =
    input.cause === 'RUN_INTERRUPTED'
      ? '此前的独立 Task Review Session 被前台中断，本会话只续接该 Reviewer 自己的复核上下文。'
      : isResultContractErrorCode(input.cause)
        ? '此前的独立 Task Review Session 进程正常结束，但返回的 TaskReviewResult 未通过契约校验；本会话续接该 Reviewer 的复核上下文，基于已完成的复核事实重新返回合法结果。'
        : `此前的独立 Task Review Session 因可续接错误 ${input.cause} 终止，本会话只续接该 Reviewer 自己的复核上下文。`;
  return `${causeSentence}

继续从仓库事实核对 CURRENT_TASK 和候选 Checkpoint。不得恢复或引用产生候选实现的 Execution Session；不得修改、创建、删除、暂存或提交文件，也不得移动 HEAD。

${VERIFICATION_POLICY}

完成后返回 TaskReviewResult。只有全部验收条件 satisfied、没有 failed test 且 issues 为空时才能返回 approved；否则据实返回 changes_required 或 replan_required。不要返回 Markdown。`;
}

export interface TaskReviewRepairPromptInput {
  /** 仓库根目录绝对路径。 */
  readonly repositoryRoot: string;
  /** 当前 Run Branch。 */
  readonly runBranch: string;
  /** 当前 Task 的完整定义（acceptanceEvidence 索引依据）。 */
  readonly task: PlannedTask;
  /** 被复核的候选 Checkpoint。 */
  readonly candidateCheckpoint: string;
  /** 上一次结果的契约校验错误（原样给出）。 */
  readonly validationError: string;
  /** 上一次非法结果的 JSON 文本；结果不可解析时为 null。 */
  readonly invalidResultJson: string | null;
}

/**
 * 复核结果修复 Session 的提示词（对齐 Execution 结果修复）。
 *
 * 上一趟复核会话进程正常结束，但 TaskReviewResult 未通过契约校验；本
 * Session 唯一职责是按校验错误重新返回合法结论，候选实现仍未被批准或
 * 打回，严格只读边界不变。
 */
export function buildTaskReviewRepairPrompt(input: TaskReviewRepairPromptInput): string {
  return `你是 ApexCodingAgent 的独立 Task Reviewer。上一趟复核会话已结束，但它返回的 TaskReviewResult 未通过契约校验，候选实现仍未被批准或打回。

项目根目录是 ${input.repositoryRoot}，当前分支必须是 ${input.runBranch}。候选 Checkpoint：${input.candidateCheckpoint}。

校验错误：
${input.validationError}

上一次返回的结构化结果（JSON；不可得时为"（无）"）：
${input.invalidResultJson ?? '（无）'}

CURRENT_TASK（完整定义，JSON）：
${toJson(input.task)}

修复要求：
1. 本会话严格只读：不得修改、创建、删除、暂存或提交文件，不得移动 HEAD，不得执行任何有副作用的操作；本 Session 唯一职责是重新返回合法的 TaskReviewResult。
2. acceptanceEvidence 必须按 CURRENT_TASK.acceptanceCriteria 的原索引逐条覆盖：不多、不少、不重复、不越界。
3. decision 为 approved 时，全部 acceptanceEvidence 必须为 satisfied、不存在 failed test 且 issues 为空；changes_required 必须至少有一项 not_satisfied、failed test 或非空 issue；replan_required 必须携带非空 replanReason，其他 decision 的 replanReason 必须为 JSON null。
4. 只修正导致校验失败的字段；复核结论本身仍须基于仓库事实，不要为了让结果合法而批准实际未满足的验收条件。

不要返回 Markdown，不要在结构化结果之外输出解释。`;
}
