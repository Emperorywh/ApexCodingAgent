/**
 * 内置 Prompt 构建器测试（SPEC §24/§25/§26 基线保留 + §7.1/§9.2/§26 上下文注入）。
 */
import { describe, expect, it } from 'vitest';
import {
  buildPlanningPrompt,
  type CompletedTaskSummary,
  type PlanningPromptInput,
  type SkippedTaskSummary,
} from '../../src/application/prompts/planning.js';
import {
  buildExecutionPrompt,
  type ExecutionPromptInput,
} from '../../src/application/prompts/execution.js';
import {
  buildFinalReviewPrompt,
  type CompletedTaskReviewSummary,
  type FinalReviewPromptInput,
} from '../../src/application/prompts/final-review.js';
import type { IntermediateCheckpoint } from '../../src/domain/schemas/intermediate-checkpoint.js';
import type { PlanRevisionTrigger } from '../../src/domain/schemas/plan-revision-snapshot.js';
import type { PlannedTask } from '../../src/domain/schemas/task-plan-draft.js';
import type { TasksJson } from '../../src/domain/schemas/tasks-json.js';

const REPOSITORY_ROOT = 'C:/repo/demo';
const RUN_BRANCH = 'apex/run-20260728-abcdef';
const SPEC_PATH = 'docs/SPEC.md';
const SPEC_SHA256 = 'a'.repeat(64);
const OID_COMPLETED = 'c'.repeat(40);
const OID_INTERMEDIATE = 'd'.repeat(40);
const UUID_1 = '11111111-1111-4111-8111-111111111111';

const completedDefinition: PlannedTask = {
  id: 'TASK-001',
  title: '建立领域模型',
  objective: '实现 Domain 层类型与不变量',
  dependsOn: [],
  acceptanceCriteria: ['npm run typecheck 通过', 'domain 单测全部通过'],
  verificationHints: ['npm run typecheck'],
  likelyPaths: ['src/domain/**'],
  estimatedSize: 'medium',
  context: '全新系统，先落地领域层。',
};

const pendingDefinition: PlannedTask = {
  id: 'TASK-002',
  title: '实现应用层编排',
  objective: '实现 Coordinator 状态机',
  dependsOn: ['TASK-001'],
  acceptanceCriteria: ['状态迁移单测通过'],
  verificationHints: ['npx vitest run'],
  likelyPaths: ['src/application/**'],
  estimatedSize: 'large',
  context: '依赖 TASK-001 的领域模型。',
};

const completedTask: CompletedTaskSummary = {
  definition: completedDefinition,
  resultSummary: '领域层已落地，typecheck 与单测通过。',
  finalCheckpoint: OID_COMPLETED,
};

const skippedTask: SkippedTaskSummary = {
  taskId: 'TASK-009',
  skipReason: '需求已在 TASK-003 中覆盖，无需独立任务。',
};

const intermediateCheckpoint: IntermediateCheckpoint = {
  oid: OID_INTERMEDIATE,
  role: 'task-intermediate',
  sourceSessionId: UUID_1,
  taskId: 'TASK-002',
  planRevision: 1,
  summary: 'TASK-002 中断前的中间提交。',
  ownerTaskId: 'TASK-004',
};

const unabsorbedCheckpoint: IntermediateCheckpoint = {
  ...intermediateCheckpoint,
  ownerTaskId: null,
};

const previousPlan: TasksJson = {
  schemaVersion: 1,
  runId: 'run-20260728-abcdef',
  planRevision: 1,
  specPath: SPEC_PATH,
  specSha256: SPEC_SHA256,
  generatedAt: '2026-07-28T00:00:00.000Z',
  plannerSessionId: UUID_1,
  summary: '第一版计划',
  assumptions: [],
  retainedCheckpointDispositions: [],
  tasks: [completedDefinition, pendingDefinition],
};

const replanTrigger: PlanRevisionTrigger = {
  type: 'execution_replan',
  reason: 'TASK-002 发现仓库事实与计划假设不符，需要重新规划。',
  sourceSessionId: UUID_1,
};

const planningBase: PlanningPromptInput = {
  repositoryRoot: REPOSITORY_ROOT,
  runBranch: RUN_BRANCH,
  specPath: SPEC_PATH,
  specSha256: SPEC_SHA256,
  previousPlan: null,
  completedTasks: [],
  pendingTasks: [],
  skippedTasks: [],
  replanTrigger: null,
  unabsorbedCheckpoints: [],
};

describe('buildPlanningPrompt（SPEC §24）', () => {
  it('保留基线核心职责与全部拆分原则的标志性语句', () => {
    const prompt = buildPlanningPrompt(planningBase);
    expect(prompt).toContain('你是 ApexCodingAgent 的规划器');
    expect(prompt).toContain('不得修改、暂存或提交任何项目文件');
    expect(prompt).toContain('完整读取 SPEC_PATH，不得只读取局部或根据标题猜测');
    // 拆分原则逐条抽查（首尾与关键条目）
    expect(prompt).toContain('每个任务只承担一个清晰的主要目标');
    expect(prompt).toContain('依赖关系必须明确且无环');
    expect(prompt).toContain('无法判断的信息记录为 assumption，不要发明业务需求');
    expect(prompt).toContain('Replan 时返回完整新计划，不要返回局部补丁');
    expect(prompt).toContain('每个保留的中间 Checkpoint 必须由且只能由一个 pending Task 接管');
    expect(prompt).toContain('likelyPaths 只是提示，不是强制文件范围');
    // 返回结构
    expect(prompt).toContain('retainedCheckpointDispositions');
    expect(prompt).toContain('estimatedSize');
    expect(prompt).toContain('不要返回 Markdown');
  });

  it('注入 REPOSITORY_ROOT / RUN_BRANCH / SPEC_PATH / SPEC_SHA256 小节', () => {
    const prompt = buildPlanningPrompt(planningBase);
    expect(prompt).toContain(`REPOSITORY_ROOT: ${REPOSITORY_ROOT}`);
    expect(prompt).toContain(`RUN_BRANCH: ${RUN_BRANCH}`);
    expect(prompt).toContain(`SPEC_PATH: ${SPEC_PATH}`);
    expect(prompt).toContain(`SPEC_SHA256: ${SPEC_SHA256}`);
  });

  it('初始规划（previousPlan/replanTrigger 为 null）不出现 REPLAN 与 RETAINED_INTERMEDIATE_CHECKPOINTS 节', () => {
    const prompt = buildPlanningPrompt(planningBase);
    expect(prompt).not.toContain('REPLAN 上下文');
    expect(prompt).not.toContain('RETAINED_INTERMEDIATE_CHECKPOINTS:');
    expect(prompt).not.toContain('PREVIOUS_PLAN_TASKS');
  });

  it('replan 时追加 §7.1 全部上下文', () => {
    const prompt = buildPlanningPrompt({
      ...planningBase,
      previousPlan,
      completedTasks: [completedTask],
      pendingTasks: [pendingDefinition],
      skippedTasks: [skippedTask],
      replanTrigger,
      unabsorbedCheckpoints: [unabsorbedCheckpoint],
    });
    // 结构化原因
    expect(prompt).toContain('REPLAN_TRIGGER');
    expect(prompt).toContain('type: execution_replan');
    expect(prompt).toContain(replanTrigger.reason);
    // 上一 Revision 完整计划（JSON 序列化 tasks）
    expect(prompt).toContain('PREVIOUS_PLAN_TASKS');
    expect(prompt).toContain('"id": "TASK-001"');
    expect(prompt).toContain('"id": "TASK-002"');
    // completed Task：不可变定义 + 摘要 + Checkpoint
    expect(prompt).toContain('COMPLETED_TASKS');
    expect(prompt).toContain(completedTask.resultSummary);
    expect(prompt).toContain(OID_COMPLETED);
    // 当前 pending 与 skipped
    expect(prompt).toContain('PENDING_TASKS');
    expect(prompt).toContain('"title": "实现应用层编排"');
    expect(prompt).toContain('SKIPPED_TASKS');
    expect(prompt).toContain(skippedTask.skipReason);
    // 未吸收中间 Checkpoint：OID + role + taskId + summary + 接管要求
    expect(prompt).toContain('RETAINED_INTERMEDIATE_CHECKPOINTS:');
    expect(prompt).toContain(OID_INTERMEDIATE);
    expect(prompt).toContain('role: task-intermediate');
    expect(prompt).toContain('taskId: TASK-002');
    expect(prompt).toContain(unabsorbedCheckpoint.summary);
    expect(prompt).toContain('并在 retainedCheckpointDispositions 中给出归属');
  });

  it('仅 replanTrigger 非 null（previousPlan 为 null）也视为 replan', () => {
    const prompt = buildPlanningPrompt({ ...planningBase, replanTrigger });
    expect(prompt).toContain('REPLAN_TRIGGER');
    expect(prompt).not.toContain('PREVIOUS_PLAN_TASKS');
  });
});

describe('buildExecutionPrompt（SPEC §25 + §9.2）', () => {
  const input: ExecutionPromptInput = {
    repositoryRoot: REPOSITORY_ROOT,
    runBranch: RUN_BRANCH,
    specPath: SPEC_PATH,
    specSha256: SPEC_SHA256,
    planRevision: 3,
    task: pendingDefinition,
    completedTasks: [completedTask],
    adoptedCheckpoints: [unabsorbedCheckpoint],
  };

  it('保留 12 条执行要求的标志性语句与安全边界', () => {
    const prompt = buildExecutionPrompt(input);
    expect(prompt).toContain('不得修改、暂存或提交 SPEC');
    expect(prompt).toContain('不修改、暂存、提交或删除 .apex-coding-agent');
    expect(prompt).toContain('不执行 remote push、生产部署、付款、生产数据变更或破坏其他分支');
    expect(prompt).toContain('不添加 legacy、兼容、迁移、fallback 或 deprecated 逻辑');
    expect(prompt).toContain('按原索引返回一条 acceptanceEvidence');
    expect(prompt).toContain('只有全部 acceptanceCriteria 均 satisfied 且不存在 failed test 时才能返回 completed');
    expect(prompt).toContain('返回 replan_required 和非空原因，不要伪造完成');
    expect(prompt).toContain('返回 failed，并保留准确诊断');
    expect(prompt).toContain('不要返回 Markdown');
  });

  it('覆盖 §9.2 全部 11 项上下文', () => {
    const prompt = buildExecutionPrompt(input);
    expect(prompt).toContain(`SPEC_PATH: ${SPEC_PATH}`);
    expect(prompt).toContain(`SPEC_SHA256: ${SPEC_SHA256}`);
    expect(prompt).toContain('CURRENT_TASK（当前 Task 完整定义，JSON）：');
    expect(prompt).toContain('"id": "TASK-002"');
    expect(prompt).toContain('"acceptanceCriteria"');
    expect(prompt).toContain('CURRENT_PLAN_REVISION: 3');
    expect(prompt).toContain(completedTask.resultSummary);
    expect(prompt).toContain(OID_COMPLETED);
    expect(prompt).toContain(`RUN_BRANCH: ${RUN_BRANCH}`);
    expect(prompt).toContain(`REPOSITORY_ROOT: ${REPOSITORY_ROOT}`);
    expect(prompt).toContain('TASK_EXECUTION_RESULT_FORMAT');
    expect(prompt).toContain('replanReason');
    expect(prompt).toContain('允许返回 replan_required');
  });

  it('单列当前 Task 接管的中间 Checkpoint', () => {
    const prompt = buildExecutionPrompt(input);
    expect(prompt).toContain('ADOPTED_INTERMEDIATE_CHECKPOINTS');
    expect(prompt).toContain(OID_INTERMEDIATE);
    expect(prompt).toContain(unabsorbedCheckpoint.summary);
  });

  it('空 completed / 空接管 Checkpoint 时给出占位', () => {
    const prompt = buildExecutionPrompt({ ...input, completedTasks: [], adoptedCheckpoints: [] });
    expect(prompt).toContain('COMPLETED_TASKS（简洁摘要与最终 Checkpoint）：\n（无）');
    expect(prompt).toContain('ADOPTED_INTERMEDIATE_CHECKPOINTS（当前 Task 接管的中间 Checkpoint）：\n（无）');
  });
});

describe('buildFinalReviewPrompt（SPEC §26 + §14.1）', () => {
  const reviewTask: CompletedTaskReviewSummary = {
    definition: completedDefinition,
    resultSummary: completedTask.resultSummary,
    acceptanceEvidence: [
      { criterionIndex: 0, status: 'satisfied', evidence: 'npm run typecheck 输出 0 错误。' },
      { criterionIndex: 1, status: 'satisfied', evidence: 'npx vitest run 全部通过。' },
    ],
    finalCheckpoint: OID_COMPLETED,
    tests: [
      { command: 'npm run typecheck', result: 'passed' },
      { command: 'npx vitest run', result: 'passed' },
    ],
  };

  const input: FinalReviewPromptInput = {
    repositoryRoot: REPOSITORY_ROOT,
    runBranch: RUN_BRANCH,
    specPath: SPEC_PATH,
    specSha256: SPEC_SHA256,
    planRevision: 2,
    completedTasks: [reviewTask],
    skippedTasks: [skippedTask],
    intermediateCheckpoints: [intermediateCheckpoint],
  };

  it('保留 11 条 Review 要求的标志性语句', () => {
    const prompt = buildFinalReviewPrompt(input);
    expect(prompt).toContain('最终整体 Reviewer');
    expect(prompt).toContain('完整读取 SPEC，不得只依赖 Task 摘要');
    expect(prompt).toContain('acceptanceEvidence 是否存在、可信且与仓库事实相符');
    expect(prompt).toContain('不得修改、暂存或提交 SPEC');
    expect(prompt).toContain('不得修改、暂存、提交或删除 .apex-coding-agent');
    expect(prompt).toContain('不执行 remote push、生产部署、付款、生产数据变更或破坏其他分支');
    expect(prompt).toContain('返回 replan_required，并给出非空原因');
    expect(prompt).toContain('reviewedTaskIds 必须无重复；completed 时必须精确列出当前计划的全部 completed Task ID');
    expect(prompt).toContain('不要返回 Markdown');
  });

  it('注入 §26“系统会提供”的全部上下文', () => {
    const prompt = buildFinalReviewPrompt(input);
    expect(prompt).toContain(`REPOSITORY_ROOT: ${REPOSITORY_ROOT}`);
    expect(prompt).toContain(`RUN_BRANCH: ${RUN_BRANCH}`);
    expect(prompt).toContain(`SPEC_PATH: ${SPEC_PATH}`);
    expect(prompt).toContain(`SPEC_SHA256: ${SPEC_SHA256}`);
    expect(prompt).toContain('CURRENT_PLAN_REVISION: 2');
    // completed Task 定义 + acceptanceEvidence + 摘要 + 最终 Checkpoint + 测试结果
    expect(prompt).toContain('"id": "TASK-001"');
    expect(prompt).toContain('"criterionIndex": 0');
    expect(prompt).toContain('npm run typecheck 输出 0 错误');
    expect(prompt).toContain(reviewTask.resultSummary);
    expect(prompt).toContain(OID_COMPLETED);
    expect(prompt).toContain('"command": "npx vitest run"');
    // skipped 及原因
    expect(prompt).toContain('SKIPPED_TASKS');
    expect(prompt).toContain(skippedTask.skipReason);
    // 中间 Checkpoint 最终归属
    expect(prompt).toContain('INTERMEDIATE_CHECKPOINT_OWNERSHIP');
    expect(prompt).toContain(OID_INTERMEDIATE);
    expect(prompt).toContain('ownerTaskId: TASK-004');
    // FinalReviewResult 结构说明
    expect(prompt).toContain('FINAL_REVIEW_RESULT_FORMAT');
    expect(prompt).toContain('reviewedTaskIds');
    expect(prompt).toContain('replanReason');
  });
});
