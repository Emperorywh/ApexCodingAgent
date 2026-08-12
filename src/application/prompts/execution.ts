/**
 * 内置 Execution Prompt 构建器（SPEC §25 规范性基线 + §9.2 上下文注入）。
 *
 * 基线文本逐条保留 12 条执行要求（含安全边界、验收证据与 Replan 语义），
 * 末尾追加 §9.2 要求的全部 11 项上下文。按 §9.2 规定，这里不注入全部历史
 * 日志和所有 Session 原始输出——completed Task 只给简洁摘要与 Checkpoint。
 *
 * 纯函数，不依赖 node:*。
 */
import { isTurnBudgetExhaustedErrorCode, type ErrorCode } from '../../domain/errors.js';
import type { IntermediateCheckpoint } from '../../domain/schemas/intermediate-checkpoint.js';
import type { PlannedTask } from '../../domain/schemas/task-plan-draft.js';
import type {
  ReviewIssue,
  VerificationEvidence,
} from '../../domain/schemas/review-evidence.js';
import type {
  AcceptanceEvidence,
  TestReport,
} from '../../domain/schemas/task-execution-result.js';
import type { CompletedTaskSummary } from './planning.js';
import { withStructuredOutputInstruction } from './structured-output.js';
import { VERIFICATION_POLICY } from './verification-policy.js';

/**
 * 上一轮独立 Task Review 打回（changes_required）时传给修复执行的反馈事实。
 *
 * 只注入可执行的负面证据：复核摘要、未满足的验收证据、失败测试与问题
 * 清单；仍不注入 Reviewer 的对话上下文，保持会话间上下文隔离。
 */
export interface TaskReviewFeedback {
  readonly summary: string;
  readonly issues: readonly ReviewIssue[];
  readonly failedTests: readonly TestReport[];
  readonly blockedVerifications: readonly VerificationEvidence[];
  readonly unsatisfiedEvidence: readonly AcceptanceEvidence[];
}

export interface ExecutionPromptInput {
  /** 仓库根目录绝对路径。 */
  readonly repositoryRoot: string;
  /** 当前 Run Branch。 */
  readonly runBranch: string;
  /** 权威 SPEC 的 Git 相对路径。 */
  readonly specPath: string;
  /** 启动时 SPEC 内容的 SHA-256。 */
  readonly specSha256: string;
  /** 当前 Plan Revision。 */
  readonly planRevision: number;
  /** 当前 Task 的完整定义。 */
  readonly task: PlannedTask;
  /** completed Task 的简洁摘要与 Checkpoint。 */
  readonly completedTasks: readonly CompletedTaskSummary[];
  /** 当前 Task 接管的中间 Checkpoint。 */
  readonly adoptedCheckpoints: readonly IntermediateCheckpoint[];
  /** 上一轮独立复核的打回反馈；非返工执行时为 null。 */
  readonly reviewFeedback: TaskReviewFeedback | null;
}

/** SPEC §25 规范性基线文本（逐条保留，不得删改核心职责与安全边界）。 */
const EXECUTION_BASELINE = `你是 ApexCodingAgent 当前 Task 的执行 Agent。你只负责系统提供的 CURRENT_TASK，但可以读取完整仓库来理解架构和依赖。

项目根目录是 REPOSITORY_ROOT，当前分支必须是 RUN_BRANCH。权威需求文件是 SPEC_PATH，其启动哈希是 SPEC_SHA256。完整读取 SPEC，但不得修改、暂存或提交 SPEC。

系统还会提供：
- CURRENT_PLAN_REVISION
- CURRENT_TASK 的完整定义和 acceptanceCriteria
- completed Task 的摘要与 Checkpoint
- 当前 Task 接管的中间 Checkpoint
- 结构化结果 Schema

执行要求：
1. 先理解现有架构、数据流、状态流和模块边界，再实现 CURRENT_TASK。
2. 如果架构无法正确承载需求，优先在当前 Task 边界内完成必要重构，不叠加临时 patch。
3. 保持高内聚、低耦合、单一职责、分层设计和显式状态。
4. 不添加 legacy、兼容、迁移、fallback 或 deprecated 逻辑。
5. 不修改、暂存、提交或删除 .apex-coding-agent。
6. 不执行 remote push、生产部署、付款、生产数据变更或破坏其他分支。
7. 可以使用 Claude Code 原生 Skills、MCP、Subagents、Plugins 和 Hooks。
8. 运行与当前 Task 验收条件相称的测试或验证。
${VERIFICATION_POLICY}
9. 把 CURRENT_TASK.nonGoals 视为明确范围边界；不得顺手实现被排除的相邻能力。
10. 按 verificationPlan 覆盖全部 acceptanceCriteria；manual 步骤只记录为用户手动验证，不得伪造已自动执行。
11. budget 是本 Task 的注意力契约：在 targetContextBudget（单位为 token）内收敛，并受 maxAgentTurns 运行时硬限制；如果范围明显无法在预算内完成，尽早返回 replan_required 要求拆分，不要等到耗尽上下文。
12. 对每一项 acceptanceCriteria 按原索引返回一条 acceptanceEvidence，说明 satisfied 或 not_satisfied 及可观察证据。
13. 只有全部 acceptanceCriteria 均 satisfied 且不存在 failed test 时才能返回 completed。
14. 如果仓库事实、架构前置条件、需求变化或预算评估使当前计划不再正确，返回 replan_required 和非空原因，不要伪造完成。验收标准或 verificationPlan 依赖当前环境缺失的能力（如 Docker、外部服务、网络访问）而无法验证时，同样属于计划不再正确：返回 replan_required，在 replanReason 中写明缺失能力、受影响的验收条目与调整建议，不得返回 failed。
15. 仅在实现层面确实无法完成、且计划本身无需调整时返回 failed，并保留准确诊断；环境能力缺失造成的验证阻塞不按 failed 处理（见第 14 条）。

返回 TaskExecutionResult 结构化结果。不要返回 Markdown，不要在结构化结果之外输出解释。`;

function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** completed Task 只注入简洁摘要与 Checkpoint（SPEC §9.2，不注入历史日志）。 */
function formatCompletedTasks(tasks: readonly CompletedTaskSummary[]): string {
  if (tasks.length === 0) return '（无）';
  return tasks
    .map((task) => `- ${task.definition.id}: ${task.resultSummary}（Checkpoint: ${task.finalCheckpoint}）`)
    .join('\n');
}

function formatAdoptedCheckpoints(checkpoints: readonly IntermediateCheckpoint[]): string {
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

/** 独立复核打回反馈小节；仅返工执行（上一结论为 changes_required）时出现。 */
function formatReviewFeedback(feedback: TaskReviewFeedback | null): string[] {
  if (feedback === null) return [];
  const lines = [
    '',
    'REVIEW_FEEDBACK（候选实现未通过上一轮独立复核；以下问题必须在本次执行中全部解决后才能返回 completed，不得仅复述先前结论）：',
    `- 复核摘要：${feedback.summary}`,
  ];
  for (const evidence of feedback.unsatisfiedEvidence) {
    lines.push(`- 未满足验收标准 ${evidence.criterionIndex}：${evidence.evidence}`);
  }
  for (const test of feedback.failedTests) {
    lines.push(`- 失败测试：${test.command}`);
  }
  for (const verification of feedback.blockedVerifications) {
    lines.push(
      `- 未通过验证 ${verification.verificationId}（${verification.status}）：${verification.evidence}`,
    );
  }
  for (const issue of feedback.issues) {
    lines.push(
      `- ${issue.id} [${issue.category}] ${issue.summary}\n` +
        `  证据：${issue.evidence}\n` +
        `  必须达到：${issue.requiredChange}\n` +
        `  影响路径：${issue.affectedPaths.join('、') || '（无已确认路径）'}\n` +
        `  验收索引：${issue.criterionIndexes.join('、') || '（无）'}`,
    );
  }
  return lines;
}

/** TaskExecutionResult 结构化结果格式说明（SPEC §9.2/§9.4）。 */
const RESULT_FORMAT_SECTION = `TASK_EXECUTION_RESULT_FORMAT（结构化结果格式说明）：
返回 TaskExecutionResult，包含字段：
- decision: "completed" | "failed" | "replan_required"
- summary: 非空结果摘要
- tests: { command, result: "passed" | "failed" | "not_run" } 数组
- acceptanceEvidence: { criterionIndex, status: "satisfied" | "not_satisfied", evidence } 数组，按 CURRENT_TASK 的 acceptanceCriteria 原索引逐条给出
- changedAreas: 字符串数组，记录本次修改的区域
- remainingRisks: 字符串数组
- replanReason: replan_required 时必须为非空字符串；否则必须为 JSON null（不是字符串 "null"、"N/A" 或空字符串）
允许返回 replan_required（见执行要求第 11 条）。`;

/** 系统上下文小节，覆盖 SPEC §9.2 全部 11 项。 */
function buildContextSection(input: ExecutionPromptInput): string {
  return [
    '系统提供的上下文：',
    '',
    `REPOSITORY_ROOT: ${input.repositoryRoot}`,
    `RUN_BRANCH: ${input.runBranch}`,
    `SPEC_PATH: ${input.specPath}`,
    `SPEC_SHA256: ${input.specSha256}`,
    `CURRENT_PLAN_REVISION: ${input.planRevision}`,
    '',
    'CURRENT_TASK（当前 Task 完整定义，JSON）：',
    toJson(input.task),
    '',
    'COMPLETED_TASKS（简洁摘要与最终 Checkpoint）：',
    formatCompletedTasks(input.completedTasks),
    '',
    'ADOPTED_INTERMEDIATE_CHECKPOINTS（当前 Task 接管的中间 Checkpoint）：',
    formatAdoptedCheckpoints(input.adoptedCheckpoints),
    ...formatReviewFeedback(input.reviewFeedback),
    '',
    RESULT_FORMAT_SECTION,
  ].join('\n');
}

/** 构建 Execution Session 的完整提示词。 */
export function buildExecutionPrompt(input: ExecutionPromptInput): string {
  return withStructuredOutputInstruction(
    [EXECUTION_BASELINE, buildContextSection(input)].join('\n\n'),
  );
}

export interface ExecutionResultRepairPromptInput {
  /** 仓库根目录绝对路径。 */
  readonly repositoryRoot: string;
  /** 当前 Run Branch。 */
  readonly runBranch: string;
  /** 当前 Task 的完整定义（acceptanceEvidence 索引依据）。 */
  readonly task: PlannedTask;
  /** 上一次结果的契约校验错误（原样给出）。 */
  readonly validationError: string;
  /** 上一次非法结果的 JSON 文本；结果不可解析时为 null。 */
  readonly invalidResultJson: string | null;
}

/**
 * 结果修复 Session 的提示词。上一个 Execution Session 已完成进程生命周期，
 * 但其结构化结果未通过契约校验（Schema 或 §9.4 字段规则）；本 Session 唯一
 * 职责是按校验错误重新返回合法的 TaskExecutionResult，不再触碰仓库。
 */
export function buildExecutionResultRepairPrompt(
  input: ExecutionResultRepairPromptInput,
): string {
  return withStructuredOutputInstruction(`你是 ApexCodingAgent 当前 Task 的结果修复 Agent。上一个 Execution Session 已结束，但它返回的 TaskExecutionResult 未通过契约校验，系统尚未提交任何业务结论，当前 Task 仍处于 running。

项目根目录是 ${input.repositoryRoot}，当前分支必须是 ${input.runBranch}。

校验错误：
${input.validationError}

上一次返回的结构化结果（JSON；不可得时为"（无）"）：
${input.invalidResultJson ?? '（无）'}

CURRENT_TASK（当前 Task 完整定义，JSON）：
${toJson(input.task)}

修复要求：
1. 不修改、暂存、提交或删除任何文件，不执行 remote push 或任何有副作用的操作；本 Session 唯一职责是重新返回合法的结构化结果。
2. 严格返回 TaskExecutionResult：decision、summary、tests、acceptanceEvidence、changedAreas、remainingRisks、replanReason。
3. 字段耦合规则：decision 为 completed 或 failed 时 replanReason 必须为 null；decision 为 replan_required 时 replanReason 必须为非空字符串。
4. acceptanceEvidence 必须按 CURRENT_TASK.acceptanceCriteria 的原索引逐条覆盖：不多、不少、不重复、不越界。
5. decision 为 completed 时，所有 acceptanceEvidence 必须为 satisfied，且 tests 中不得存在 failed。
6. 只修正导致校验失败的字段，其余字段保持对已完成工作的真实陈述；如果工作实际未全部完成，据实返回 failed 或 replan_required，不要伪造 completed。

不要返回 Markdown，不要在结构化结果之外输出解释。`);
}

/**
 * Execution 会话续接提示词（SPEC §17 resume + 回合预算有界自动续接）：
 * 被中断的 Claude 会话经 `--resume --fork-session` 恢复后，对话上下文中
 * 已包含完整基线与 Task 定义，因此这里只重申断点事实与结果契约。仓库可能
 * 保留中断时的半成品改动，继续执行而不是推倒重来；完成的判定与结构化结果
 * 契约不变。
 */
export function buildExecutionResumePrompt(input: {
  /** 当前 Task 的完整定义。 */
  readonly task: PlannedTask;
  /** 触发本次续接的稳定错误码。 */
  readonly cause: ErrorCode;
  /**
   * 续接来源：用户显式 resume（user_resume），或回合预算耗尽后编排器的
   * 有界自动接力（budget_extension）。两者共用同一收敛策略，但提示词必须
   * 如实陈述是否存在人工干预事实。
   */
  readonly origin: 'user_resume' | 'budget_extension';
}): string {
  /**
   * 恢复原因必须继续进入模型上下文。回合预算耗尽与人工中断需要不同的
   * 收敛优先级，不能在重开 Run 时退化成同一句“前台中断”。
   */
  const causeInstruction =
    isTurnBudgetExhaustedErrorCode(input.cause)
      ? '上一趟会话已耗尽 maxAgentTurns。先利用已有实现和验证证据收敛；如果验收条件已经覆盖，必须立即返回结构化结果，不得开始任何可选检查。'
      : input.cause === 'RUN_INTERRUPTED'
        ? '上一趟会话被前台中断。从已有工作树继续，但不要重复中断前已经完成且仍然有效的工作或验证。'
        : input.cause === 'GIT_PUSH_FAILED'
          ? '上一趟会话已实现并验证到可交付状态，本地 Checkpoint 已形成，仅推送到远程失败；本地提交完整保留在运行分支上。先核对 Git 历史与已有验收证据，只补齐尚未完成的最小缺口；如果验收条件已经覆盖，直接返回结构化结果，不得重复已完成的工作或验证。'
          : `上一趟会话因可续接错误 ${input.cause} 终止。先核对已有事实，再从最小缺口继续。`;

  const originSentence =
    input.origin === 'budget_extension'
      ? '上一趟会话耗尽了回合预算，系统自动续接本会话并追加了一趟等额预算；这不是人工干预，任务目标与完成判定不变。'
      : '本会话通过显式 resume 从上一趟执行断点继续。';

  return withStructuredOutputInstruction(`你是 ApexCodingAgent 当前 Task 的执行 Agent。${originSentence}

RESUME_CAUSE: ${input.cause}
${causeInstruction}

仓库中可能保留你中断前已完成的半成品改动：先核对当前文件状态，在此基础上继续完成 CURRENT_TASK，不要推倒重来，也不要重复已完成的工作。

CURRENT_TASK（当前 Task 完整定义，JSON）：
${toJson(input.task)}

${VERIFICATION_POLICY}

继续执行要求：
1. 原执行要求与安全边界全部继续有效（不修改 SPEC、不触碰 .apex-coding-agent、不执行危险操作）。
2. 对每一项 acceptanceCriteria 按原索引返回一条 acceptanceEvidence。
3. 只有全部 acceptanceCriteria 均 satisfied 且不存在 failed test 时才能返回 completed；无法完成时据实返回 failed 或 replan_required。
4. 先盘点已有实现与仍有效的测试证据，只处理尚未覆盖的最小缺口；不得重复已通过的验证，也不得追加 verificationPlan 之外的可选工作。

返回 TaskExecutionResult 结构化结果。不要返回 Markdown，不要在结构化结果之外输出解释。`);
}
