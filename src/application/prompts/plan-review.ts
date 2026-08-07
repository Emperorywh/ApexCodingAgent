/**
 * 独立 Plan Review Prompt 构建器。
 *
 * Reviewer 不继承 Planner 对话，只接收已经通过确定性领域校验的完整草稿，
 * 并从仓库、SPEC 与任务预算事实独立判断是否允许提交 Plan Revision。
 */
import type { TaskPlanDraft } from '../../domain/schemas/task-plan-draft.js';

export interface PlanReviewPromptInput {
  readonly repositoryRoot: string;
  readonly runBranch: string;
  readonly specPath: string;
  readonly specSha256: string;
  readonly planRevision: number;
  readonly draft: TaskPlanDraft;
}

function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** 构造全新、严格只读的计划复核会话输入。 */
export function buildPlanReviewPrompt(input: PlanReviewPromptInput): string {
  return `你是 ApexCodingAgent 的独立 Plan Reviewer。你没有、也不得尝试恢复生成该草稿的 Planning Session。你的职责是基于仓库与 SPEC 事实，判断这份计划中的每个 Task 是否足够聚焦、可独立验证，并能在声明的注意力预算内完成。

仓库根目录：${input.repositoryRoot}
Run Branch：${input.runBranch}
SPEC 路径：${input.specPath}
SPEC SHA-256：${input.specSha256}
待提交 Plan Revision：${input.planRevision}

PLAN_CANDIDATE（完整草稿，JSON）：
${toJson(input.draft)}

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
12. 每个 Task 都必须给出一条 taskAssessment，按 PLAN_CANDIDATE.tasks 原顺序且不多不少。
13. 只有全部 Task assessment 均 approved 且不存在计划级 issues 时，整体 decision 才能为 approved。
14. 本会话严格只读：不得修改、创建、删除、暂存或提交文件，不得移动 HEAD，不得执行 remote push 或其他有副作用的操作。

返回 PlanReviewResult：
- decision: "approved" | "changes_required"
- summary: 非空复核摘要
- taskAssessments: { taskId, decision: "approved" | "changes_required", issues: string[] }[]
- issues: 计划级问题 string[]

不要返回 Markdown，不要在结构化结果之外输出解释。`;
}

/**
 * Plan Review 中断后只续接 Reviewer 自己的上下文。
 *
 * 原 transcript 已含完整草稿与仓库边界，本提示只重申独立性、只读性和
 * 结构化结果契约，防止恢复后退化为 Planner 自审。
 */
export function buildPlanReviewResumePrompt(): string {
  return `此前的独立 Plan Review Session 被前台中断，本会话只续接 Reviewer 自己的复核上下文。

继续基于仓库、SPEC 与原 PLAN_CANDIDATE 检查 Task 单一目标、nonGoals、结构化验证覆盖和预算可完成性。不得恢复或引用 Planning Session，不得修改仓库或移动 HEAD。

完成后返回完整 PlanReviewResult。只有每个 Task 都 approved 且计划级 issues 为空时才能批准。不要返回 Markdown。`;
}
