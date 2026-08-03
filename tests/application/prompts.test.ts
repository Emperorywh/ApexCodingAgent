/**
 * 内置 Prompt 构建器测试（SPEC §24/§25/§26 基线保留 + §7.1/§9.2/§26 上下文注入）。
 */
import { describe, expect, it } from 'vitest';
import {
  buildPlanningPrompt,
  buildPlanningResumePrompt,
  type CompletedTaskSummary,
  type PlanningPromptInput,
  type SkippedTaskSummary,
} from '../../src/application/prompts/planning.js';
import {
  buildExecutionPrompt,
  buildExecutionResumePrompt,
  buildExecutionResultRepairPrompt,
  type ExecutionPromptInput,
  type ExecutionResultRepairPromptInput,
  type TaskReviewFeedback,
} from '../../src/application/prompts/execution.js';
import {
  buildFinalReviewPrompt,
  buildFinalReviewResumePrompt,
  type CompletedTaskReviewSummary,
  type FinalReviewPromptInput,
} from '../../src/application/prompts/final-review.js';
import {
  buildTaskReviewPrompt,
  buildTaskReviewRepairPrompt,
  buildTaskReviewResumePrompt,
  type TaskReviewPromptInput,
  type TaskReviewRepairPromptInput,
} from '../../src/application/prompts/task-review.js';
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
    /*
     * Planning 必须提前把自动验证与人工界面验收分开，避免后续执行 Agent
     * 把长期后台服务误当作验收命令，并在任务间遗留资源。
     */
    expect(prompt).toContain('verificationHints 必须区分可自动运行的检查与用户手动验证');
    expect(prompt).toContain('不能依赖长期后台服务');
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

describe('buildPlanningResumePrompt（Planning 断点续接）', () => {
  it('要求基于原上下文继续并重申 Planning 只读与结果契约', () => {
    const prompt = buildPlanningResumePrompt();
    /**
     * 恢复提示不重复整份 SPEC，而是明确使用 transcript 中已有上下文，
     * 同时保留最重要的只读边界与完整结构化结果要求。
     */
    expect(prompt).toContain('从原对话断点继续');
    expect(prompt).toContain('只读边界');
    expect(prompt).toContain('完整 TaskPlanDraft');
    expect(prompt).not.toContain(REPOSITORY_ROOT);
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
    reviewFeedback: null,
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
    /*
     * 可写 Session 共用同一验证策略，以下断言锁定人工界面边界、
     * 有界服务生命周期和失败收敛三项关键约束。
     */
    expect(prompt).toContain('若说明要求界面由用户手动验证，不得启动浏览器或开发服务器');
    expect(prompt).toContain('不得把独立的开发服务器留在后台');
    expect(prompt).toContain('使用带截止时间的条件轮询');
    expect(prompt).toContain('原则上只进行两轮有针对性的修正');
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

  it('复核打回反馈注入 REVIEW_FEEDBACK 小节', () => {
    const reviewFeedback: TaskReviewFeedback = {
      summary: '候选实现遗漏了空输入的错误处理',
      issues: ['src/foo.ts 未处理空数组输入'],
      failedTests: [{ command: 'npx vitest run tests/foo', result: 'failed' }],
      unsatisfiedEvidence: [
        { criterionIndex: 0, status: 'not_satisfied', evidence: '仓库中不存在错误处理分支' },
      ],
    };
    const prompt = buildExecutionPrompt({ ...input, reviewFeedback });
    expect(prompt).toContain('REVIEW_FEEDBACK');
    expect(prompt).toContain(reviewFeedback.summary);
    expect(prompt).toContain('未满足验收标准 0');
    expect(prompt).toContain('仓库中不存在错误处理分支');
    expect(prompt).toContain('失败测试：npx vitest run tests/foo');
    expect(prompt).toContain('待修复问题：src/foo.ts 未处理空数组输入');
  });

  it('reviewFeedback 为 null 时不出现 REVIEW_FEEDBACK 小节', () => {
    expect(buildExecutionPrompt(input)).not.toContain('REVIEW_FEEDBACK');
  });
});

describe('buildExecutionResumePrompt（Execution 断点续接）', () => {
  it('恢复后继续遵守验证收敛与资源生命周期边界', () => {
    const prompt = buildExecutionResumePrompt({ task: pendingDefinition });
    /*
     * 恢复会话会继承中断前的仓库状态，但不能因此丢失验证资源的所有权。
     * 这里同时确认任务定义和统一验证策略都进入了续接提示。
     */
    expect(prompt).toContain('"id": "TASK-002"');
    expect(prompt).toContain('不要推倒重来');
    expect(prompt).toContain('不得把独立的开发服务器留在后台');
    expect(prompt).toContain('原则上只进行两轮有针对性的修正');
  });
});

describe('buildExecutionResultRepairPrompt（结果修复接力）', () => {
  const invalidResultJson = JSON.stringify(
    { decision: 'completed', replanReason: '遗留说明' },
    null,
    2,
  );
  const input: ExecutionResultRepairPromptInput = {
    repositoryRoot: REPOSITORY_ROOT,
    runBranch: RUN_BRANCH,
    task: pendingDefinition,
    validationError: 'decision completed requires replanReason to be null',
    invalidResultJson,
  };

  it('附校验错误、非法结果原文与 CURRENT_TASK 定义', () => {
    const prompt = buildExecutionResultRepairPrompt(input);
    expect(prompt).toContain('decision completed requires replanReason to be null');
    expect(prompt).toContain('遗留说明');
    expect(prompt).toContain('"id": "TASK-002"');
    expect(prompt).toContain(REPOSITORY_ROOT);
    expect(prompt).toContain(RUN_BRANCH);
  });

  it('重申字段耦合规则并禁止任何副作用操作', () => {
    const prompt = buildExecutionResultRepairPrompt(input);
    expect(prompt).toContain('decision 为 completed 或 failed 时 replanReason 必须为 null');
    expect(prompt).toContain('decision 为 replan_required 时 replanReason 必须为非空字符串');
    expect(prompt).toContain('不修改、暂存、提交或删除任何文件');
    expect(prompt).toContain('不要伪造 completed');
    expect(prompt).toContain('不要返回 Markdown');
  });

  it('非法结果不可解析时给出占位', () => {
    const prompt = buildExecutionResultRepairPrompt({ ...input, invalidResultJson: null });
    expect(prompt).toContain('（无）');
    expect(prompt).not.toContain('遗留说明');
  });
});

describe('buildTaskReviewPrompt（独立 Task 完成复核）', () => {
  const input: TaskReviewPromptInput = {
    repositoryRoot: REPOSITORY_ROOT,
    runBranch: RUN_BRANCH,
    specPath: SPEC_PATH,
    specSha256: SPEC_SHA256,
    planRevision: 3,
    task: pendingDefinition,
    candidateCheckpoint: OID_COMPLETED,
  };

  it('明确使用全新上下文，并且完全不注入 Execution 自报结果', () => {
    const prompt = buildTaskReviewPrompt(input);
    expect(prompt).toContain('独立 Task Reviewer');
    expect(prompt).toContain('你没有、也不得尝试恢复产生候选实现的 Execution Session 上下文');
    expect(prompt).not.toContain('CANDIDATE_EXECUTION_RESULT');
    expect(prompt).not.toContain('任务完成');
    expect(prompt).toContain(OID_COMPLETED);
    expect(prompt).toContain('不采信候选结果的自我判断');
  });

  it('锁定只读边界与严格批准条件', () => {
    const prompt = buildTaskReviewPrompt(input);
    expect(prompt).toContain('本会话严格只读');
    expect(prompt).toContain('不得修改、创建、删除、暂存或提交文件');
    expect(prompt).toContain('全部验收条件均 satisfied');
    expect(prompt).toContain('issues 为空时，返回 approved');
    expect(prompt).toContain('changes_required');
    expect(prompt).toContain('replan_required');
  });

  it('要求测试产物被 .gitignore 覆盖或在返回前清理干净', () => {
    const prompt = buildTaskReviewPrompt(input);
    expect(prompt).toContain('.gitignore 覆盖');
    expect(prompt).toContain('必须在返回结果前清理干净');
  });

  it('恢复提示只续接 Reviewer 自身上下文，不接触 Execution Session', () => {
    const prompt = buildTaskReviewResumePrompt();
    expect(prompt).toContain('只续接该 Reviewer 自己的复核上下文');
    expect(prompt).toContain('不得恢复或引用产生候选实现的 Execution Session');
    expect(prompt).toContain('不得修改、创建、删除、暂存或提交文件');
    expect(prompt).toContain('TaskReviewResult');
  });
});

describe('buildTaskReviewRepairPrompt（复核结果修复接力）', () => {
  const invalidResultJson = JSON.stringify(
    { decision: 'approved', issues: ['遗留问题'] },
    null,
    2,
  );
  const input: TaskReviewRepairPromptInput = {
    repositoryRoot: REPOSITORY_ROOT,
    runBranch: RUN_BRANCH,
    task: pendingDefinition,
    candidateCheckpoint: OID_COMPLETED,
    validationError: 'approved requires an empty issues list',
    invalidResultJson,
  };

  it('附校验错误、非法结果原文、候选 Checkpoint 与 CURRENT_TASK 定义', () => {
    const prompt = buildTaskReviewRepairPrompt(input);
    expect(prompt).toContain('approved requires an empty issues list');
    expect(prompt).toContain('遗留问题');
    expect(prompt).toContain(OID_COMPLETED);
    expect(prompt).toContain('"id": "TASK-002"');
    expect(prompt).toContain(REPOSITORY_ROOT);
    expect(prompt).toContain(RUN_BRANCH);
  });

  it('重申只读边界、索引覆盖与字段耦合规则', () => {
    const prompt = buildTaskReviewRepairPrompt(input);
    expect(prompt).toContain('本会话严格只读');
    expect(prompt).toContain('不得修改、创建、删除、暂存或提交文件');
    expect(prompt).toContain('acceptanceEvidence 必须按 CURRENT_TASK.acceptanceCriteria 的原索引逐条覆盖');
    expect(prompt).toContain('decision 为 approved 时，全部 acceptanceEvidence 必须为 satisfied');
    expect(prompt).toContain('changes_required 必须至少有一项 not_satisfied、failed test 或非空 issue');
    expect(prompt).toContain('replan_required 必须携带非空 replanReason');
    expect(prompt).toContain('不要返回 Markdown');
  });

  it('非法结果不可解析时给出占位', () => {
    const prompt = buildTaskReviewRepairPrompt({ ...input, invalidResultJson: null });
    expect(prompt).toContain('（无）');
    expect(prompt).not.toContain('遗留问题');
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
    /*
     * Final Review 与 Execution 共享验证政策，防止复核阶段重新引入
     * 无界后台服务、长时间固定等待和不收敛的重复修正。
     */
    expect(prompt).toContain('若说明要求界面由用户手动验证，不得启动浏览器或开发服务器');
    expect(prompt).toContain('不得把独立的开发服务器留在后台');
    expect(prompt).toContain('使用带截止时间的条件轮询');
    expect(prompt).toContain('原则上只进行两轮有针对性的修正');
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

describe('buildFinalReviewResumePrompt（Final Review 断点续接）', () => {
  it('要求保留中断前修改并继续完成整体复核', () => {
    const prompt = buildFinalReviewResumePrompt();
    /**
     * Final Review 是可写会话，恢复提示必须显式保留当前仓库事实，避免
     * 模型把中断前已经产生但尚未收尾的复核修改当作应回滚内容。
     */
    expect(prompt).toContain('从原对话断点继续');
    expect(prompt).toContain('不要推倒重来');
    expect(prompt).toContain('完成整体复核');
    expect(prompt).toContain('不得把独立的开发服务器留在后台');
    expect(prompt).toContain('原则上只进行两轮有针对性的修正');
    expect(prompt).toContain('FinalReviewResult');
  });
});
