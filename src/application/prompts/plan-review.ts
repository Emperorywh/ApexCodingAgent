/**
 * 独立 Plan Review Prompt 构建器。
 *
 * Reviewer 不继承 Planner 对话，只接收已经通过确定性领域校验的草稿候选
 * （保留/修改的 pending Task 与新增 Task；completed Task 由系统按权威
 * 定义自动并入，不属于候选），并从仓库、SPEC 与任务预算事实独立判断
 * 是否允许提交 Plan Revision。
 */
import { isResultContractErrorCode, type ErrorCode } from '../../domain/errors.js';
import { PLAN_REVIEW_DIMENSIONS } from '../../domain/schemas/review-evidence.js';
import type { TaskPlanDraft } from '../../domain/schemas/task-plan-draft.js';
import type { CompletedTaskSummary } from './planning.js';
import { withStructuredOutputInstruction } from './structured-output.js';

export interface PlanReviewPromptInput {
  readonly repositoryRoot: string;
  readonly runBranch: string;
  readonly specPath: string;
  readonly specSha256: string;
  readonly planRevision: number;
  /** 候选草稿：tasks 只含非 completed 任务（保留/修改的 pending 与新增）。 */
  readonly draft: TaskPlanDraft;
  /** 已 completed Task 的紧凑摘要（不参与评估，仅供边界判断）。 */
  readonly completedTasks: readonly CompletedTaskSummary[];
}

function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function formatCompletedSummaries(tasks: readonly CompletedTaskSummary[]): string {
  if (tasks.length === 0) return '（无）';
  return tasks
    .map((task) => `- ${task.definition.id}: ${task.definition.title} — ${task.resultSummary}`)
    .join('\n');
}

/**
 * 固定审核维度直接从领域常量生成，避免 Prompt 与语义校验各维护一份顺序。
 */
function formatReviewDimensions(): string {
  return PLAN_REVIEW_DIMENSIONS.map((dimension, index) => `${index + 1}. ${dimension}`).join('\n');
}

/** 构造全新、严格只读的计划复核会话输入。 */
export function buildPlanReviewPrompt(input: PlanReviewPromptInput): string {
  return withStructuredOutputInstruction(`你是 ApexCodingAgent 的独立 Plan Reviewer。你没有、也不得尝试恢复生成该草稿的 Planning Session。你的职责是基于仓库与 SPEC 事实，判断这份计划中的每个 Task 是否足够聚焦、可独立验证，并能在声明的注意力预算内完成。

仓库根目录：${input.repositoryRoot}
Run Branch：${input.runBranch}
SPEC 路径：${input.specPath}
SPEC SHA-256：${input.specSha256}
待提交 Plan Revision：${input.planRevision}

PLAN_CANDIDATE（候选草稿，JSON；只含保留/修改的 pending Task 与新增 Task，不含 completed Task）：
${toJson(input.draft)}

COMPLETED_TASKS（已 completed Task 的结果摘要；它们的定义已锁定、由系统自动并入新计划，不属于候选、不需要评估）：
${formatCompletedSummaries(input.completedTasks)}

复核要求：
1. 完整读取 SPEC，并检查仓库架构、模块边界、构建入口与测试入口；不得根据 Planner 的 summary 代替仓库事实。
2. 逐个 Task 检查是否只有一个清晰主要目标；若 objective、验收条件或交付物形成多个可独立闭环，必须要求拆分。
3. 检查 nonGoals 是否明确限制相邻但不属于本 Task 的工作，且不与 objective 或 acceptanceCriteria 冲突。
4. 检查每条 acceptanceCriteria 是否可观察、可判定，并被 verificationPlan 至少一个步骤覆盖。
5. 检查 verificationPlan 的 command 是否真实存在或能由仓库事实支持；manual 步骤必须给出用户可执行的具体过程和期望证据，不得伪装为 Agent 已自动验证。
6. 检查 likelyPaths 与 context 是否足以帮助定位但没有把文件列表误当作任务边界。
7. 检查 budget：以 token 为单位的 targetContextBudget 不得超过 480000，新增或修改的 Task hardContextLimit 必须为 600000；从旧 Revision 原样保留的 Task 允许携带历史预算值（如 hardContextLimit 300000），不得因此要求修改。结合仓库规模、未知项、实现范围与验证成本，判断 Task 是否有充分把握在 target 内完成，并为返工保留余量。
8. maxAgentTurns 必须与任务复杂度相称；不得通过放大回合数掩盖应当拆分的多个目标。
9. 调查工作只有在产生明确设计决策、接口契约或可消费结论时才是合法 Task。
10. 不要按文件数或架构层机械拆分；一个具有单一行为闭环的纵向功能可以跨层。
11. 全新系统不得接受 legacy、兼容、迁移、fallback 或 deprecated 工作。
12. 每个候选 Task 都必须给出一条 taskAssessment，按 PLAN_CANDIDATE.tasks 原顺序且不多不少；COMPLETED_TASKS 中的 Task 不得出现在 taskAssessments 中。
13. 每条 assessment 必须按下列固定顺序给出完整 checks，不得省略、合并或增加维度。每个 check 都要引用 SPEC 条目、仓库路径、已有接口或 Task 字段等可核对事实，不能只写“看起来合理”：
${formatReviewDimensions()}
14. assessment 的 decision 必须与 checks 和 issues 一致：approved 要求全部 checks 为 satisfied 且 issues 为空；changes_required 必须同时包含至少一个 not_satisfied check 和至少一个阻塞 ReviewIssue，二者不得互相替代。
15. issue 必须是结构化对象，并把“观察到的问题”与“修复后必须成立的结果”分开：id 使用本次结果内全局唯一的 ISSUE-001..ISSUE-999；category 使用契约枚举；summary 简述问题；evidence 引用具体 SPEC/Task/仓库事实；requiredChange 描述必须达到的修复结果；affectedPaths 只填写已确认相关的 Git 相对路径；criterionIndexes 只填写关联的 acceptanceCriteria 索引。计划级 issue 没有单一 Task 上下文，criterionIndexes 必须为空数组。
16. issues 只收录必须修改的阻塞性问题；不影响计划正确性的观察、建议或文档瑕疵一律写入 summary，不得写入任何 issues。
17. 只有全部 Task assessment 均 approved 且计划级 issues 为空时，整体 decision 才能为 approved；计划级 issues 同样只收录阻塞性问题。
18. 候选 Task 不得重复或推翻 COMPLETED_TASKS 已经完成的工作；dependsOn 引用 completed Task 的 ID 是允许的。发现候选与已完成工作重叠或边界冲突时，写入对应 Task 的 issues。
19. 本会话严格只读：不得修改、创建、删除、暂存或提交文件，不得移动 HEAD，不得执行 remote push 或其他有副作用的操作。

返回 PlanReviewResult：
- decision: "approved" | "changes_required"
- summary: 非空复核摘要（非阻塞性观察写在这里）
- taskAssessments: { taskId, decision, checks: { dimension, status: "satisfied" | "not_satisfied", evidence }[], issues: ReviewIssue[] }[]
- issues: 计划级 ReviewIssue[]（整体 approved 时必须为 []，criterionIndexes 必须为空）
- ReviewIssue: { id, category, summary, evidence, requiredChange, affectedPaths, criterionIndexes }

不要返回 Markdown，不要在结构化结果之外输出解释。`);
}

/**
 * Plan Review 中断后只续接 Reviewer 自己的上下文。
 *
 * 原 transcript 已含完整草稿与仓库边界，本提示只重申独立性、只读性和
 * 结构化结果契约，防止恢复后退化为 Planner 自审。首句必须如实陈述断点
 * 原因：结果契约失败的上一趟会话并未被中断，其复核事实仍然有效，只需
 * 按契约重新表达结论，不能让模型误以为复核未完成而推倒重来。
 */
export function buildPlanReviewResumePrompt(input: { readonly cause: ErrorCode }): string {
  const causeSentence =
    input.cause === 'RUN_INTERRUPTED'
      ? '此前的独立 Plan Review Session 被前台中断，本会话只续接 Reviewer 自己的复核上下文。'
      : isResultContractErrorCode(input.cause)
        ? '此前的独立 Plan Review Session 进程正常结束，但返回的 PlanReviewResult 未通过契约校验；本会话续接该 Reviewer 的复核上下文，基于已完成的复核事实重新返回合法结果。'
        : `此前的独立 Plan Review Session 因可续接错误 ${input.cause} 终止，本会话只续接 Reviewer 自己的复核上下文。`;
  return withStructuredOutputInstruction(`${causeSentence}

继续基于仓库、SPEC 与原 PLAN_CANDIDATE 检查 Task 单一目标、nonGoals、结构化验证覆盖和预算可完成性。每个 Task 必须按固定顺序完整返回七个 checks；Task 级 changes_required 必须同时包含 not_satisfied check 与带 evidence、requiredChange 的结构化 ReviewIssue。不得恢复或引用 Planning Session，不得修改仓库或移动 HEAD。

完成后返回完整 PlanReviewResult。只有每个 Task 都 approved 且计划级 issues 为空时才能批准；approved 的 assessment 不得携带任何 issue，非阻塞性观察写入 summary。不要返回 Markdown。`);
}

export interface PlanReviewRepairPromptInput {
  readonly repositoryRoot: string;
  readonly runBranch: string;
  readonly specPath: string;
  readonly specSha256: string;
  readonly planRevision: number;
  /** 被复核的候选草稿（tasks 只含非 completed 任务，taskAssessments 覆盖与顺序依据）。 */
  readonly draft: TaskPlanDraft;
  /** 上一次结果的契约校验错误（原样给出）。 */
  readonly validationError: string;
  /** 上一次非法结果的 JSON 文本；结果不可解析时为 null。 */
  readonly invalidResultJson: string | null;
}

/**
 * 计划复核结果修复 Session 的提示词（对齐 Task Review 结果修复）。
 *
 * 上一趟复核会话进程正常结束，但 PlanReviewResult 未通过契约校验；本
 * Session 唯一职责是按校验错误重新返回合法结论，计划候选仍未被批准或
 * 打回，严格只读边界不变。
 */
export function buildPlanReviewRepairPrompt(input: PlanReviewRepairPromptInput): string {
  return withStructuredOutputInstruction(`你是 ApexCodingAgent 的独立 Plan Reviewer。上一趟计划复核会话已结束，但它返回的 PlanReviewResult 未通过契约校验，计划候选仍未被批准或打回。

仓库根目录：${input.repositoryRoot}
Run Branch：${input.runBranch}
SPEC 路径：${input.specPath}
SPEC SHA-256：${input.specSha256}
待提交 Plan Revision：${input.planRevision}

校验错误：
${input.validationError}

上一次返回的结构化结果（JSON；不可得时为"（无）"）：
${input.invalidResultJson ?? '（无）'}

PLAN_CANDIDATE（候选草稿，JSON；只含保留/修改的 pending Task 与新增 Task）：
${toJson(input.draft)}

修复要求：
1. 本会话严格只读：不得修改、创建、删除、暂存或提交文件，不得移动 HEAD，不得执行任何有副作用的操作；本 Session 唯一职责是重新返回合法的 PlanReviewResult。
2. 每个候选 Task 都必须给出一条 taskAssessment，按 PLAN_CANDIDATE.tasks 原顺序且不多不少、不重复、不越界。
3. 每条 assessment 的 checks 必须按以下固定顺序完整覆盖，每个 evidence 都要保留可核对事实：${PLAN_REVIEW_DIMENSIONS.join('、')}。
4. approved 要求所有 checks satisfied 且 issues 为空；changes_required 必须同时包含 failed check 和结构化 issue；整体 approved 当且仅当全部 Task approved 且计划级 issues 为空。
5. 每条 issue 必须包含全局唯一 ISSUE-NNN、category、summary、evidence、requiredChange、affectedPaths 和 criterionIndexes；计划级 issue 的 criterionIndexes 必须为空。非阻塞性观察写入 summary。
6. 只修正导致校验失败的字段；复核结论本身仍须基于仓库事实。不要为了让结果合法而删除真实存在的阻塞性问题——若某条 issue 确实要求修改计划，应将该 Task（或整体 decision）改为 changes_required 并保留该 issue。

不要返回 Markdown，不要在结构化结果之外输出解释。`);
}
