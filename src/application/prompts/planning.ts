/**
 * 内置 Planning Prompt 构建器（SPEC §24 规范性基线 + §7.1 上下文注入）。
 *
 * 基线文本逐条保留核心职责与全部任务拆分原则，仅在末尾追加系统上下文小节；
 * Replan（previousPlan 或 replanTrigger 非 null）时按 §7.1 追加 pending 权威
 * 定义、completed/skipped 摘要、结构化原因与未吸收中间 Checkpoint。
 *
 * 纯函数，不依赖 node:*，不读取文件系统——SPEC 内容与仓库事实由调用方
 * （Coordinator / 适配层）负责提供，模型 Session 自行读取仓库。
 */
import type { IntermediateCheckpoint } from '../../domain/schemas/intermediate-checkpoint.js';
import type { PlanRevisionTrigger } from '../../domain/schemas/plan-revision-snapshot.js';
import type { PlanReviewResult } from '../../domain/schemas/plan-review-result.js';
import type { PlannedTask, TaskPlanDraft } from '../../domain/schemas/task-plan-draft.js';
import type { TasksJson } from '../../domain/schemas/tasks-json.js';
import { withStructuredOutputInstruction } from './structured-output.js';

/** completed Task 的不可变摘要：标识/标题 + 结果摘要 + 最终 Checkpoint（SPEC §7.1）。 */
export interface CompletedTaskSummary {
  readonly definition: PlannedTask;
  readonly resultSummary: string;
  readonly finalCheckpoint: string;
}

/** skipped Task 及其原因（SPEC §7.1）。 */
export interface SkippedTaskSummary {
  readonly taskId: string;
  readonly skipReason: string;
}

export interface PlanningPromptInput {
  /** 仓库根目录绝对路径。 */
  readonly repositoryRoot: string;
  /** 当前 Run Branch。 */
  readonly runBranch: string;
  /** 权威 SPEC 的 Git 相对路径。 */
  readonly specPath: string;
  /** 启动时 SPEC 内容的 SHA-256。 */
  readonly specSha256: string;
  /** Replan 时存在的上一 Revision 计划事实；初始规划为 null。 */
  readonly previousPlan: TasksJson | null;
  /** 已 completed 的 Task（不可变定义 + 结果摘要 + Checkpoint）。 */
  readonly completedTasks: readonly CompletedTaskSummary[];
  /** 当前 pending Task（Replan 时）。 */
  readonly pendingTasks: readonly PlannedTask[];
  /** 已 skipped 的 Task 及原因。 */
  readonly skippedTasks: readonly SkippedTaskSummary[];
  /** Replan 的结构化原因；null 表示初始规划。 */
  readonly replanTrigger: PlanRevisionTrigger | null;
  /** 尚未被 completed Task 吸收的中间 Checkpoint。 */
  readonly unabsorbedCheckpoints: readonly IntermediateCheckpoint[];
  /** 上一轮独立 Plan Review 的草稿与结构化反馈；首次尝试为 null。 */
  readonly planReviewFeedback: {
    readonly rejectedDraft: TaskPlanDraft;
    readonly review: PlanReviewResult;
  } | null;
}

/** SPEC §24 规范性基线文本（逐条保留，不得删改核心职责与拆分原则）。 */
const PLANNING_BASELINE = `你是 ApexCodingAgent 的规划器。ApexCodingAgent 是一个围绕完整软件需求持续执行的 Coding Agent。

你当前只负责理解需求并生成可执行任务计划，不得修改、暂存或提交任何项目文件，不得执行实现，不得创建 Git Commit，不得修改 .apex-coding-agent。

项目根目录是当前工作目录，也是系统提供的 REPOSITORY_ROOT。
主要需求来源由系统提供为 SPEC_PATH。完整读取该文件，但不要修改它。

请完成以下工作：

1. 完整读取 SPEC_PATH，不得只读取局部或根据标题猜测。
2. 检查当前仓库的目录结构、技术栈、模块边界、构建入口和测试入口。
3. 判断项目是全新系统还是已有系统。
4. 理解需求涉及的数据流、状态流、核心实体和模块依赖。
5. 将需求拆分为一组可以按顺序执行、独立判断是否完成的编码任务。
6. Replan 时检查系统提供的 RETAINED_INTERMEDIATE_CHECKPOINTS，为每个尚未被 completed Task 吸收的 Checkpoint 指定一个负责继续采用、验证或移除其变更的 pending Task。
7. 在返回最终结果前，自行检查任务是否遗漏规格中的关键要求。

任务拆分原则：

- 每个任务只承担一个清晰的主要目标。
- 每个任务必须用 nonGoals 明确排除相邻但不属于本任务的工作。
- 优先按领域能力、模块边界或可验证的纵向功能拆分。
- 不要按文件数量机械拆分。
- 每个任务完成后，仓库应处于可理解、可继续开发的状态。
- 任务粒度应适合一个顶层 Claude Code Session 完成。
- 不要制造大量微型任务。
- 测试通常包含在对应实现任务中。
- 架构基础必须先于依赖它的业务实现。
- 依赖关系必须明确且无环。
- 无法判断的信息记录为 assumption，不要发明业务需求。
- 调查任务必须产生具体结论或设计决策。
- Replan 时返回完整新计划语义，不要返回局部补丁：tasks 中用 {id, disposition: "retain"} 引用按上一 Revision 原样保留的 pending Task；只有修改后的旧 pending Task 与新增 Task 才输出完整定义。
- Replan 原因暴露环境能力或外部约束（如 Docker 不可用、网络受限）时，必须审查所有 pending Task 的 acceptanceCriteria 与 verificationPlan 中依赖同一能力的条目，在本次 Revision 中一并调整（如拆分为本地可验证部分与独立 CI 门禁 Task），不得只修复触发 Replan 的 Task。
- Replan 时不得在草稿中包含 completed Task：系统合并时会按权威定义把它们自动并入新计划，草稿中携带的 completed 条目会被直接忽略。新 Task 的 dependsOn 可以引用 completed Task 的 ID。
- Replan 时可以修改 pending Task；保留不变的 pending Task 只在 tasks 写入 {id, disposition: "retain"}，不要复制完整定义。
- 旧 pending Task 若既没有 retain 引用，也未以完整定义出现在 tasks，表示将其标记为 skipped。
- 新增 Task 使用从未出现过的 ID。
- 当前计划中的 pending Task 不得超过 50 个。
- 整个 Run 的 Task ID 数字部分不得超过 999。
- 每个保留的中间 Checkpoint 必须由且只能由一个 pending Task 接管。
- 全新系统不得添加 legacy、兼容、迁移、fallback 或 deprecated 任务。
- 最后包含必要的整体集成与最终验证。
- 所有 Task ID 使用 TASK-001、TASK-002 这样的稳定格式。
- dependsOn 只能引用本计划内存在的 Task ID。
- acceptanceCriteria 必须是可观察、可判断的完成结果。
- verificationPlan 必须逐条覆盖 acceptanceCriteria，并区分 command、static_analysis 与 manual。
- command 验证必须填写真实存在或由仓库事实支持的命令与有界 timeoutSeconds；其他验证的 command 和 timeoutSeconds 必须为 null。
- manual 验证必须写出用户可执行的具体过程与期望证据；仓库代理说明禁止自动界面测试时，不得把开发服务器命令列为 Agent 必跑项。
- 需要本地服务的自动验证必须规划为单一有界入口，由同一入口负责启动、就绪检查和结束，不能依赖长期后台服务。
- 新增或修改的 Task：budget.hardContextLimit 固定为 600000，targetContextBudget（单位为 token）不得超过 480000，maxAgentTurns 必须在 8..128 内并与范围相称；原样保留的 pending Task 必须保持其既有 budget 数值不变（旧 Revision 的 hardContextLimit 可能是 300000），不得改写为新值。
- 预算评估必须包含理解仓库、实现、验证与一次返工余量；不能靠填满硬上限容纳本应拆分的多个目标。
- likelyPaths 只是提示，不是强制文件范围；每项必须是仓库根目录下的 Git 相对路径，使用正斜杠，文件和目录均不得以斜杠结尾，不得包含 . 或 .. 路径段。

请返回结构化任务计划，包含：

- summary
- assumptions
- retainedCheckpointDispositions
- tasks

Replan 时 tasks 的每一项使用二选一结构：
- 原样保留旧 pending Task：{ id, disposition: "retain" }
- 修改旧 pending Task 或新增 Task：使用下述完整任务字段

每个任务包含：

- id
- title
- objective
- nonGoals
- dependsOn
- acceptanceCriteria
- verificationPlan
- likelyPaths
- budget
- context

不要返回 Markdown。
不要在结构化结果之外输出解释。`;

/** 将结构化上下文序列化为缩进 JSON，便于模型直接引用。 */
function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * pending 权威定义已有清晰字段边界，不需要额外缩进重复消耗上下文。
 * 紧凑 JSON 保留逐字段信息，只移除空白。
 */
function toCompactJson(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * completed Task 只渲染紧凑摘要：系统会投射其权威定义，重复全文只会
 * 放大提示词，并诱使模型把不可变条目复述进草稿。
 */
function formatCompletedTasks(tasks: readonly CompletedTaskSummary[]): string {
  if (tasks.length === 0) return '（无）';
  return tasks
    .map(
      (task) =>
        `- ${task.definition.id}: ${task.definition.title}\n` +
        `  resultSummary: ${task.resultSummary}\n` +
        `  finalCheckpoint: ${task.finalCheckpoint}`,
    )
    .join('\n');
}

function formatSkippedTasks(tasks: readonly SkippedTaskSummary[]): string {
  if (tasks.length === 0) return '（无）';
  return tasks.map((task) => `- ${task.taskId}: ${task.skipReason}`).join('\n');
}

function formatCheckpoints(checkpoints: readonly IntermediateCheckpoint[]): string {
  if (checkpoints.length === 0) return '（无）';
  return checkpoints
    .map(
      (checkpoint) =>
        `- oid: ${checkpoint.oid}\n` +
        `  role: ${checkpoint.role}\n` +
        `  taskId: ${checkpoint.taskId ?? 'null'}\n` +
        `  summary: ${checkpoint.summary}`,
    )
    .join('\n');
}

/** 系统上下文小节：REPOSITORY_ROOT / RUN_BRANCH / SPEC_PATH / SPEC_SHA256。 */
function buildContextSection(input: PlanningPromptInput): string {
  return [
    '系统提供的上下文：',
    '',
    `REPOSITORY_ROOT: ${input.repositoryRoot}`,
    `RUN_BRANCH: ${input.runBranch}`,
    `SPEC_PATH: ${input.specPath}`,
    `SPEC_SHA256: ${input.specSha256}`,
    '',
    `当前 Run Branch 为 ${input.runBranch}，规划必须基于该分支的仓库事实。`,
  ].join('\n');
}

/** Replan 追加小节（SPEC §7.1 生成新 Revision 时必须读取的全部上下文）。 */
function buildReplanSection(input: PlanningPromptInput): string {
  const parts: string[] = [
    'REPLAN 上下文（本次为重新规划，请生成完整新 Revision）：',
    '',
    '本次草稿使用紧凑差量表达：tasks 中用 {id, disposition: "retain"} 引用原样保留的 pending Task；只有修改后的旧 pending Task 与新增 Task 才输出完整定义；completed Task 由系统按权威定义自动并入，一律不得出现在草稿 tasks 中。',
    '',
  ];

  if (input.replanTrigger !== null) {
    parts.push(
      'REPLAN_TRIGGER（结构化原因）：',
      `- type: ${input.replanTrigger.type}`,
      `- reason: ${input.replanTrigger.reason}`,
      '',
    );
  }

  parts.push(
    'PENDING_TASK_DEFINITIONS（当前 pending Task 的权威完整定义，紧凑 JSON；字段信息未省略，每个未修改 Task 只需返回 retain 引用）：',
    toCompactJson(input.pendingTasks),
    '',
  );

  parts.push(
    'COMPLETED_TASKS（已完成 Task 的结果摘要，仅供上下文，不得复述进草稿）：',
    formatCompletedTasks(input.completedTasks),
    '',
    'SKIPPED_TASKS（skipped Task 及原因）：',
    formatSkippedTasks(input.skippedTasks),
    '',
    'RETAINED_INTERMEDIATE_CHECKPOINTS: 尚未被 completed Task 吸收的中间 Checkpoint：',
    formatCheckpoints(input.unabsorbedCheckpoints),
    '',
    '以上每个中间 Checkpoint 必须由且只能由一个 pending Task 接管（见基线第 6 条），并在 retainedCheckpointDispositions 中给出归属。',
  );

  return parts.join('\n');
}

/** 上一轮独立计划复核反馈：Planner 必须生成新草稿，不得仅解释或争辩。 */
function buildPlanReviewFeedbackSection(input: PlanningPromptInput): string {
  const feedback = input.planReviewFeedback;
  if (feedback === null) return '';
  return [
    'PLAN_REVIEW_FEEDBACK（上一轮草稿未通过独立复核）：',
    '',
    'REJECTED_DRAFT（JSON）：',
    toJson(feedback.rejectedDraft),
    '',
    'REVIEW_RESULT（JSON）：',
    toJson(feedback.review),
    '',
    '必须逐条解决 taskAssessments 与计划级 issues 后返回一份完整的新 TaskPlanDraft；不要返回局部补丁，也不要只解释原方案。',
  ].join('\n');
}

/**
 * 构建 Planning Session 的完整提示词。
 * 初始规划（previousPlan 与 replanTrigger 均为 null）时不出现 REPLAN 小节。
 */
export function buildPlanningPrompt(input: PlanningPromptInput): string {
  const sections = [PLANNING_BASELINE, buildContextSection(input)];
  if (input.previousPlan !== null || input.replanTrigger !== null) {
    sections.push(buildReplanSection(input));
  }
  if (input.planReviewFeedback !== null) {
    sections.push(buildPlanReviewFeedbackSection(input));
  }
  return withStructuredOutputInstruction(sections.join('\n\n'));
}

/**
 * Planning 会话续接提示词。
 *
 * 原 transcript 已包含完整 SPEC、仓库事实与规划契约；恢复时只要求模型
 * 从被中断位置继续并重新核对当前只读事实，避免重复注入整份上下文。
 */
export function buildPlanningResumePrompt(): string {
  return withStructuredOutputInstruction(`此前的 Planning 会话被前台中断，本会话从原对话断点继续。

请先核对当前 SPEC 与仓库只读事实是否仍和原规划上下文一致，然后继续完成尚未完成的规划工作。Planning 的只读边界、Task 拆分规则、依赖约束、Checkpoint 接管规则和 TaskPlanDraft 结构化结果契约全部继续有效。Replan 结果继续使用紧凑差量表达：tasks 中以 {id, disposition: "retain"} 引用未改旧 pending Task，修改或新增 Task 才返回完整定义。

返回完整 TaskPlanDraft。不要返回 Markdown，不要在结构化结果之外输出解释。`);
}

/**
 * 确定性校验打回后的 Planning 续接修正提示词。
 *
 * 原 transcript 已包含完整 SPEC、仓库事实、规划契约与被拒草稿本身；
 * 修正会话只携带精确的校验结论，模型据此做定向修正，而不是盲目重规划。
 */
export function buildPlanningCorrectionPrompt(error: string): string {
  return withStructuredOutputInstruction(`你上一轮返回的 TaskPlanDraft 未通过系统的确定性校验，未被提交。

VALIDATION_ERROR（确定性校验结论）：
${error}

请针对该校验结论修正计划，并返回一份完整的修正后 TaskPlanDraft：不是局部补丁，也不要只解释原因。Planning 的只读边界、Task 拆分规则、依赖约束、验收条件必须由 verificationPlan 逐条覆盖等结构化结果契约全部继续有效。

不要返回 Markdown，不要在结构化结果之外输出解释。`);
}

/**
 * 全新修正会话共用的被拒草稿与校验结论附录。
 *
 * 进程内轻量修正直接使用该事实；用户显式 resume 的 transcript 不可用时，
 * 同一事实也作为安全回退输入。小节格式与 PLAN_REVIEW_FEEDBACK 保持一致。
 */
export function buildPlanningCorrectionAppendix(
  rejectedDraft: TaskPlanDraft,
  error: string,
): string {
  return [
    'PLAN_DRAFT_CORRECTION（上一趟 Planning 草稿未通过系统确定性校验）：',
    '',
    'REJECTED_DRAFT（JSON）：',
    toJson(rejectedDraft),
    '',
    'VALIDATION_ERROR（确定性校验结论）：',
    error,
    '',
    '必须针对该校验结论修正后返回一份完整的新 TaskPlanDraft；不要返回局部补丁，也不要只解释原方案。',
  ].join('\n');
}

/**
 * 为进程内确定性修正构建独立、轻量的 Planning 提示词。
 *
 * 被拒草稿已经包含模型完成仓库分析后的全部计划结论；结构校验错误也由系统
 * 精确给出。修正会话只需要保留草稿中不相关字段并处理列出的缺口，无需再次
 * 继承包含 SPEC 全文、工具输出和长思考的 Planner transcript。
 */
export function buildPlanningCorrectionSessionPrompt(
  rejectedDraft: TaskPlanDraft,
  error: string,
): string {
  return withStructuredOutputInstruction(
    [
      '你是 ApexCodingAgent 的计划草稿修正器。当前会话只修正一份已经完成仓库分析、但未通过确定性校验的 TaskPlanDraft。',
      '',
      '修正规则：',
      '1. 逐条处理 VALIDATION_ERROR 中列出的全部问题；一条结论可能同时列出多个独立覆盖缺口。',
      '2. 除修复这些错误必需的最小字段外，保持 REJECTED_DRAFT 的任务边界、依赖、预算、Checkpoint disposition 与其他字段不变。',
      '3. 不重新探索仓库，不执行工具，不重新制定方案；被拒草稿是本次修正的权威输入。',
      '4. 返回一份完整的新 TaskPlanDraft，不是局部补丁；不要返回 Markdown，也不要在结构化结果之外输出解释。',
      '',
      buildPlanningCorrectionAppendix(rejectedDraft, error),
    ].join('\n'),
  );
}
