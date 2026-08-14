/**
 * 内置 Prompt 构建器测试（SPEC §24/§25/§26 基线保留 + §7.1/§9.2/§26 上下文注入）。
 */
import { describe, expect, it } from 'vitest';
import {
  buildPlanningCorrectionAppendix,
  buildPlanningCorrectionPrompt,
  buildPlanningCorrectionSessionPrompt,
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
import {
  buildPlanReviewPrompt,
  buildPlanReviewRepairPrompt,
  buildPlanReviewResumePrompt,
  type PlanReviewRepairPromptInput,
} from '../../src/application/prompts/plan-review.js';
import { STRUCTURED_OUTPUT_INSTRUCTION } from '../../src/application/prompts/structured-output.js';
import type { IntermediateCheckpoint } from '../../src/domain/schemas/intermediate-checkpoint.js';
import type { PlanRevisionTrigger } from '../../src/domain/schemas/plan-revision-snapshot.js';
import type { PlannedTask } from '../../src/domain/schemas/task-plan-draft.js';
import type { TasksJson } from '../../src/domain/schemas/tasks-json.js';
import { mkPlanReviewChecks, mkReviewIssue } from '../domain/fixtures.js';

const REPOSITORY_ROOT = 'C:/repo/demo';
const RUN_BRANCH = 'apex/run-20260728-abcdef';
const SPEC_PATH = 'docs/SPEC.md';
const SPEC_SHA256 = 'a'.repeat(64);
const OID_COMPLETED = 'c'.repeat(40);
const OID_INTERMEDIATE = 'd'.repeat(40);
const UUID_1 = '11111111-1111-4111-8111-111111111111';
const UUID_2 = '22222222-2222-4222-8222-222222222222';

/**
 * Prompt 测试使用与生产 Schema 相同的结构化验证步骤和预算。
 * 两个 Task 仅改变验收条件覆盖范围，避免重复维护契约字段。
 */
function verificationPlan(criterionIndexes: number[]): PlannedTask['verificationPlan'] {
  return [
    {
      id: 'VERIFY-001',
      kind: 'command',
      criterionIndexes,
      procedure: '运行仓库测试门禁',
      expectedEvidence: '命令成功退出',
      command: 'npm test',
      timeoutSeconds: 900,
    },
  ];
}

const DEFAULT_BUDGET: PlannedTask['budget'] = {
  targetContextBudget: 200_000,
  hardContextLimit: 600_000,
  maxAgentTurns: 64,
};

const completedDefinition: PlannedTask = {
  id: 'TASK-001',
  title: '建立领域模型',
  objective: '实现 Domain 层类型与不变量',
  nonGoals: ['不实现应用层编排'],
  dependsOn: [],
  acceptanceCriteria: ['npm run typecheck 通过', 'domain 单测全部通过'],
  verificationPlan: verificationPlan([0, 1]),
  likelyPaths: ['src/domain/**'],
  budget: DEFAULT_BUDGET,
  context: '全新系统，先落地领域层。',
};

const pendingDefinition: PlannedTask = {
  id: 'TASK-002',
  title: '实现应用层编排',
  objective: '实现 Coordinator 状态机',
  nonGoals: ['不修改领域层公共契约'],
  dependsOn: ['TASK-001'],
  acceptanceCriteria: ['状态迁移单测通过'],
  verificationPlan: verificationPlan([0]),
  likelyPaths: ['src/application/**'],
  budget: DEFAULT_BUDGET,
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
  planReviewerSessionId: UUID_2,
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
  planReviewFeedback: null,
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
    expect(prompt).toContain('Replan 时返回完整新计划语义，不要返回局部补丁');
    expect(prompt).toContain('{id, disposition: "retain"}');
    // completed Task 由系统投射，模型不再承担逐字复述不可变定义的义务。
    expect(prompt).toContain('Replan 时不得在草稿中包含 completed Task');
    expect(prompt).toContain('每个保留的中间 Checkpoint 必须由且只能由一个 pending Task 接管');
    /*
     * Planning 必须提前把自动验证与人工界面验收分开，避免后续执行 Agent
     * 把长期后台服务误当作验收命令，并在任务间遗留资源。
     */
    expect(prompt).toContain('verificationPlan 必须逐条覆盖 acceptanceCriteria');
    expect(prompt).toContain('不能依赖长期后台服务');
    expect(prompt).toContain('likelyPaths 只是提示，不是强制文件范围');
    expect(prompt).toContain('文件和目录均不得以斜杠结尾');
    expect(prompt).toContain('不得包含 . 或 .. 路径段');
    // 返回结构
    expect(prompt).toContain('retainedCheckpointDispositions');
    expect(prompt).toContain('targetContextBudget');
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
    expect(prompt).toContain('INITIAL_PLAN_CONTRACT');
    expect(prompt).toContain('禁止使用 {id, disposition: "retain"}');
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
    // 只注入当前 pending 的完整定义；completed 定义由紧凑结果摘要替代。
    expect(prompt).toContain('PENDING_TASK_DEFINITIONS');
    expect(prompt).toContain('"id":"TASK-002"');
    expect(prompt).not.toContain('"id":"TASK-001"');
    // completed Task：只注入紧凑摘要 + Checkpoint，不再复制不可变完整定义。
    expect(prompt).toContain('COMPLETED_TASKS');
    expect(prompt).toContain(completedTask.resultSummary);
    expect(prompt).toContain(OID_COMPLETED);
    expect(prompt).toContain('一律不得出现在草稿 tasks 中');
    expect(prompt).toContain('不得复述进草稿');
    // 当前 pending 定义与 skipped 状态都存在。
    expect(prompt).toContain('"title":"实现应用层编排"');
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

  it('大 pending 定义在 Replan 输入中只出现一次，completed 完整定义不再注入', () => {
    /**
     * 真实长 Run 中 17 个 pending Task 的完整定义约 80KB，旧 Prompt 在
     * PREVIOUS_PLAN_TASKS 与 PENDING_TASKS 各复制一次，随后又要求模型
     * 全量回显。现在只给当前 pending 权威定义；用唯一长字段锁定单份输入。
     */
    const uniqueContext = `UNIQUE-LARGE-PENDING-CONTEXT-${'x'.repeat(8_000)}`;
    const largePending = { ...pendingDefinition, context: uniqueContext };
    const prompt = buildPlanningPrompt({
      ...planningBase,
      previousPlan: { ...previousPlan, tasks: [completedDefinition, largePending] },
      completedTasks: [completedTask],
      pendingTasks: [largePending],
      replanTrigger,
    });

    expect(prompt.split(uniqueContext)).toHaveLength(2);
    expect(prompt).toContain('PENDING_TASK_DEFINITIONS');
    expect(prompt).not.toContain('"id":"TASK-001"');
    expect(prompt).not.toContain('PENDING_TASKS（当前 pending Task，JSON）');
  });

  it('仅 replanTrigger 非 null（previousPlan 为 null）也视为 replan', () => {
    const prompt = buildPlanningPrompt({ ...planningBase, replanTrigger });
    expect(prompt).toContain('REPLAN_TRIGGER');
    expect(prompt).not.toContain('PREVIOUS_PLAN_TASKS');
  });

  it('独立 Plan Review 打回后注入原草稿与结构化问题', () => {
    const prompt = buildPlanningPrompt({
      ...planningBase,
      planReviewFeedback: {
        rejectedDraft: {
          summary: '范围过大的草稿',
          assumptions: [],
          retainedCheckpointDispositions: [],
          tasks: [pendingDefinition],
        },
        review: {
          decision: 'changes_required',
          summary: '任务需要继续拆分',
          taskAssessments: [
            {
              taskId: 'TASK-002',
              decision: 'changes_required',
              checks: mkPlanReviewChecks({
                scope_cohesion: {
                  dimension: 'scope_cohesion',
                  status: 'not_satisfied',
                  evidence: '目标同时包含两个可独立交付且可独立验收的能力',
                },
              }),
              issues: [
                mkReviewIssue({
                  category: 'task_scope',
                  summary: 'objective 包含两个独立交付物',
                  evidence: '目标同时要求领域模型和应用编排两个可独立验收的交付物',
                  requiredChange: '拆分为两个边界清晰且依赖显式的 Task',
                }),
              ],
            },
          ],
          issues: [],
        },
      },
    });
    expect(prompt).toContain('PLAN_REVIEW_FEEDBACK');
    expect(prompt).toContain('范围过大的草稿');
    expect(prompt).toContain('objective 包含两个独立交付物');
    expect(prompt).toContain('完整的新 TaskPlanDraft');
    /**
     * Review 打回没有提交 Revision 1，提示词必须再次声明完整输出契约，
     * 不能让“上一轮”措辞诱导 Planner 进入 Replan 的紧凑引用协议。
     */
    expect(prompt).toContain('本次仍在修正未提交的初始 Revision');
    expect(prompt).toContain('不得把 REJECTED_DRAFT 中未修改的 Task 改写成 retain 引用');
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

describe('buildPlanningCorrectionPrompt（确定性校验打回后的续接修正）', () => {
  it('携带精确校验结论并要求返回完整修正稿', () => {
    const prompt = buildPlanningCorrectionPrompt(
      'task TASK-008 acceptance criterion 3 has no verification step',
    );
    // 续接会话复用原 transcript：只注入校验结论，不重复 SPEC 与仓库上下文。
    expect(prompt).toContain('VALIDATION_ERROR');
    expect(prompt).toContain('task TASK-008 acceptance criterion 3 has no verification step');
    expect(prompt).toContain('完整的修正后 TaskPlanDraft');
    expect(prompt).toContain('只读边界');
    expect(prompt).toContain('verificationPlan 逐条覆盖');
    expect(prompt).not.toContain(REPOSITORY_ROOT);
    expect(prompt).not.toContain('REJECTED_DRAFT');
  });
});

describe('buildPlanningCorrectionAppendix（全新修正会话附录）', () => {
  it('重新注入被拒草稿与校验结论，格式与 PLAN_REVIEW_FEEDBACK 呼应', () => {
    const appendix = buildPlanningCorrectionAppendix(
      {
        summary: '覆盖缺口的草稿',
        assumptions: [],
        retainedCheckpointDispositions: [],
        tasks: [pendingDefinition],
      },
      'task TASK-002 acceptance criterion 0 has no verification step',
    );
    expect(appendix).toContain('PLAN_DRAFT_CORRECTION');
    expect(appendix).toContain('REJECTED_DRAFT');
    expect(appendix).toContain('覆盖缺口的草稿');
    expect(appendix).toContain('"id": "TASK-002"');
    expect(appendix).toContain('VALIDATION_ERROR');
    expect(appendix).toContain('task TASK-002 acceptance criterion 0 has no verification step');
    expect(appendix).toContain('完整的新 TaskPlanDraft');
  });
});

describe('buildPlanningCorrectionSessionPrompt（轻量独立修正会话）', () => {
  it('只携带被拒草稿和完整错误，不重新注入仓库探索上下文', () => {
    /**
     * 真实事故中的 Planner transcript 已包含 SPEC 全文、命令输出和长思考。
     * 独立修正提示必须以被拒草稿作为权威输入，避免局部结构修复继承超大上下文。
     */
    const prompt = buildPlanningCorrectionSessionPrompt(
      {
        summary: '需要补齐验证覆盖',
        assumptions: [],
        retainedCheckpointDispositions: [],
        tasks: [pendingDefinition],
      },
      'task TASK-002 acceptance criterion 0 has no verification step',
    );

    expect(prompt).toContain('计划草稿修正器');
    expect(prompt).toContain('REJECTED_DRAFT');
    expect(prompt).toContain('VALIDATION_ERROR');
    expect(prompt).toContain('不重新探索仓库');
    expect(prompt).toContain('完整的新 TaskPlanDraft');
    expect(prompt).not.toContain(REPOSITORY_ROOT);
  });

  it('标出系统物化的权威 Task，禁止轻量修正会话改写', () => {
    const prompt = buildPlanningCorrectionSessionPrompt(
      {
        summary: '已经展开的完整草稿',
        assumptions: [],
        retainedCheckpointDispositions: [],
        tasks: [pendingDefinition],
      },
      'initial plan must not contain retained task references',
      ['TASK-002', 'TASK-003'],
    );

    /**
     * 修正器拿到的是程序从上一稿逐 ID 展开的定义，不是可自由重写的参考文本。
     * 两个 ID 都必须进入明确的逐字段保护指令。
     */
    expect(prompt).toContain('确定性展开为权威 Task 定义');
    expect(prompt).toContain('TASK-002、TASK-003');
    expect(prompt).toContain('不得重新概括、缩写或改写');
  });
});

describe('buildPlanReviewPrompt（执行前独立计划复核）', () => {
  it('使用全新只读上下文复核任务边界、验证覆盖和预算', () => {
    const prompt = buildPlanReviewPrompt({
      repositoryRoot: REPOSITORY_ROOT,
      runBranch: RUN_BRANCH,
      specPath: SPEC_PATH,
      specSha256: SPEC_SHA256,
      planRevision: 2,
      draft: {
        summary: '候选计划',
        assumptions: [],
        retainedCheckpointDispositions: [],
        tasks: [pendingDefinition],
      },
      retainedPendingTasks: [],
      completedTasks: [completedTask],
    });
    expect(prompt).toContain('独立 Plan Reviewer');
    expect(prompt).toContain('不得尝试恢复生成该草稿的 Planning Session');
    expect(prompt).toContain('nonGoals');
    expect(prompt).toContain('verificationPlan');
    expect(prompt).toContain('hardContextLimit 必须为 600000');
    expect(prompt).toContain('本会话严格只读');
    expect(prompt).toContain('PlanReviewResult');
    // 候选只含非 completed 任务；completed 摘要以只读上下文注入且不参与评估。
    expect(prompt).toContain('只含修改的 pending Task 与新增 Task');
    expect(prompt).toContain('COMPLETED_TASKS');
    expect(prompt).toContain(completedTask.resultSummary);
    expect(prompt).toContain('不得出现在 taskAssessments 中');
    expect(prompt).toContain('不得重复或推翻 COMPLETED_TASKS 已经完成的工作');
  });

  it('明确 decision 与逐维度证据耦合：approved 必须全部满足且空 issues', () => {
    const prompt = buildPlanReviewPrompt({
      repositoryRoot: REPOSITORY_ROOT,
      runBranch: RUN_BRANCH,
      specPath: SPEC_PATH,
      specSha256: SPEC_SHA256,
      planRevision: 2,
      draft: {
        summary: '候选计划',
        assumptions: [],
        retainedCheckpointDispositions: [],
        tasks: [pendingDefinition],
      },
      retainedPendingTasks: [],
      completedTasks: [completedTask],
    });
    expect(prompt).toContain('approved 要求全部 checks 为 satisfied 且 issues 为空');
    expect(prompt).toContain('changes_required 必须同时包含至少一个 not_satisfied check');
    expect(prompt).toContain('spec_alignment');
    expect(prompt).toContain('budget_feasibility');
    expect(prompt).toContain('ISSUE-001..ISSUE-999');
    expect(prompt).toContain('非阻塞性观察');
    expect(prompt).toContain('写入 summary');
  });

  it('没有修改或新增 Task 时明确要求空逐任务评估并保留计划级复核', () => {
    /**
     * 全部 pending 都用 retain 引用的 Revision 仍需独立 Reviewer 批准，
     * 但不能虚构逐任务候选或为了满足旧 minItems 重复输出历史定义。
     */
    const prompt = buildPlanReviewPrompt({
      repositoryRoot: REPOSITORY_ROOT,
      runBranch: RUN_BRANCH,
      specPath: SPEC_PATH,
      specSha256: SPEC_SHA256,
      planRevision: 2,
      draft: {
        summary: '仅调整 Checkpoint 归属',
        assumptions: [],
        retainedCheckpointDispositions: [],
        tasks: [],
      },
      retainedPendingTasks: [pendingDefinition],
      completedTasks: [completedTask],
    });
    expect(prompt).toContain('PLAN_CANDIDATE.tasks 为空');
    expect(prompt).toContain('taskAssessments 必须为 []');
    expect(prompt).toContain('仍须完成仓库、SPEC 与计划级问题复核');
    expect(prompt).toContain('RETAINED_PENDING_CONTEXT');
    expect(prompt).toContain('不得为这些 Task 生成 taskAssessment');
  });

  it('恢复提示只续接 Reviewer 自己的上下文', () => {
    const prompt = buildPlanReviewResumePrompt({ cause: 'RUN_INTERRUPTED' });
    expect(prompt).toContain('被前台中断');
    expect(prompt).toContain('只续接 Reviewer 自己的复核上下文');
    expect(prompt).toContain('不得恢复或引用 Planning Session');
    expect(prompt).toContain('完整 PlanReviewResult');
    expect(prompt).toContain('changes_required 必须同时包含 not_satisfied check');
    expect(prompt).toContain('approved 的 assessment 不得携带任何 issue');
  });

  it('结果契约失败的恢复提示如实陈述断点原因', () => {
    const prompt = buildPlanReviewResumePrompt({ cause: 'PLAN_REVIEW_RESULT_INVALID' });
    expect(prompt).toContain('未通过契约校验');
    expect(prompt).not.toContain('被前台中断');
    expect(prompt).toContain('重新返回合法结果');
    expect(prompt).toContain('approved 的 assessment 不得携带任何 issue');
  });
});

describe('buildPlanReviewRepairPrompt（计划复核结果修复接力）', () => {
  const invalidResultJson = JSON.stringify(
    {
      decision: 'approved',
      summary: '复核通过但夹带观察',
      taskAssessments: [{ taskId: 'TASK-002', decision: 'approved', issues: ['非阻塞性观察'] }],
      issues: [],
    },
    null,
    2,
  );
  const input: PlanReviewRepairPromptInput = {
    repositoryRoot: REPOSITORY_ROOT,
    runBranch: RUN_BRANCH,
    specPath: SPEC_PATH,
    specSha256: SPEC_SHA256,
    planRevision: 2,
    draft: {
      summary: '候选计划',
      assumptions: [],
      retainedCheckpointDispositions: [],
      tasks: [pendingDefinition],
    },
    validationError: 'approved task assessment TASK-002 requires an empty issues list',
    invalidResultJson,
  };

  it('附校验错误、非法结果原文与 PLAN_CANDIDATE 完整草稿', () => {
    const prompt = buildPlanReviewRepairPrompt(input);
    expect(prompt).toContain('PlanReviewResult 未通过契约校验');
    expect(prompt).toContain('approved task assessment TASK-002 requires an empty issues list');
    expect(prompt).toContain('非阻塞性观察');
    expect(prompt).toContain('"id": "TASK-002"');
    expect(prompt).toContain(REPOSITORY_ROOT);
    expect(prompt).toContain(RUN_BRANCH);
    expect(prompt).toContain(SPEC_SHA256);
  });

  it('重申只读边界、精确覆盖与 decision/issues 耦合规则', () => {
    const prompt = buildPlanReviewRepairPrompt(input);
    expect(prompt).toContain('本会话严格只读');
    expect(prompt).toContain('不得修改、创建、删除、暂存或提交文件');
    expect(prompt).toContain('按 PLAN_CANDIDATE.tasks 原顺序且不多不少');
    expect(prompt).toContain('approved 要求所有 checks satisfied 且 issues 为空');
    expect(prompt).toContain('changes_required 必须同时包含 failed check 和结构化 issue');
    expect(prompt).toContain('checks 必须按以下固定顺序完整覆盖');
    expect(prompt).toContain('不要返回 Markdown');
  });

  it('要求真实阻塞性问题改为 changes_required 而非删除 issue', () => {
    const prompt = buildPlanReviewRepairPrompt(input);
    expect(prompt).toContain('改为 changes_required');
  });

  it('非法结果不可解析时给出占位', () => {
    const prompt = buildPlanReviewRepairPrompt({ ...input, invalidResultJson: null });
    expect(prompt).toContain('（无）');
    expect(prompt).not.toContain('复核通过但夹带观察');
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
    expect(prompt).toContain('kind=manual 的步骤严格禁止由 Agent 执行');
    expect(prompt).toContain('verificationPlan 是本 Task 的封闭验证集合');
    expect(prompt).toContain('立即返回结构化结果');
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
      issues: [
        mkReviewIssue({
          category: 'correctness',
          summary: 'src/foo.ts 未处理空数组输入',
          evidence: '空数组会直接进入首元素读取分支',
          requiredChange: '为空数组增加显式错误分支并补充回归测试',
          affectedPaths: ['src/foo.ts'],
          criterionIndexes: [0],
        }),
      ],
      failedTests: [{ command: 'npx vitest run tests/foo', result: 'failed' }],
      blockedVerifications: [
        { verificationId: 'VERIFY-001', status: 'failed', evidence: '目标测试返回非零退出码' },
      ],
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
    expect(prompt).toContain('未通过验证 VERIFY-001（failed）');
    expect(prompt).toContain('ISSUE-001 [correctness] src/foo.ts 未处理空数组输入');
    expect(prompt).toContain('必须达到：为空数组增加显式错误分支并补充回归测试');
  });

  it('reviewFeedback 为 null 时不出现 REVIEW_FEEDBACK 小节', () => {
    expect(buildExecutionPrompt(input)).not.toContain('REVIEW_FEEDBACK');
  });
});

describe('buildExecutionResumePrompt（Execution 断点续接）', () => {
  it('恢复后继续遵守验证收敛与资源生命周期边界', () => {
    const prompt = buildExecutionResumePrompt({
      task: pendingDefinition,
      cause: 'RUN_INTERRUPTED',
      origin: 'user_resume',
    });
    /*
     * 恢复会话会继承中断前的仓库状态，但不能因此丢失验证资源的所有权。
     * 这里同时确认任务定义和统一验证策略都进入了续接提示。
     */
    expect(prompt).toContain('"id": "TASK-002"');
    expect(prompt).toContain('不要推倒重来');
    expect(prompt).toContain('不得把独立的开发服务器留在后台');
    expect(prompt).toContain('原则上只进行两轮有针对性的修正');
    expect(prompt).toContain('RESUME_CAUSE: RUN_INTERRUPTED');
    expect(prompt).toContain('上一趟会话被前台中断');
    expect(prompt).toContain('显式 resume');
  });

  it('回合预算耗尽后优先复用证据并立即收敛', () => {
    const prompt = buildExecutionResumePrompt({
      task: pendingDefinition,
      cause: 'CLAUDE_TURN_LIMIT_REACHED',
      origin: 'user_resume',
    });
    /**
     * 回合耗尽后的续接不是普通中断：必须携带稳定原因，并明确禁止在已有
     * 验收证据齐备后继续追加可选检查，防止真实长任务反复耗尽预算。
     */
    expect(prompt).toContain('RESUME_CAUSE: CLAUDE_TURN_LIMIT_REACHED');
    expect(prompt).toContain('已耗尽 maxAgentTurns');
    expect(prompt).toContain('必须立即返回结构化结果');
    expect(prompt).toContain('不得重复已通过的验证');
  });

  it('预算自动接力如实陈述非人工干预并保持同一收敛策略', () => {
    const prompt = buildExecutionResumePrompt({
      task: pendingDefinition,
      cause: 'CLAUDE_TURN_LIMIT_REACHED',
      origin: 'budget_extension',
    });
    /*
     * 自动续接与显式 resume 共用同一预算耗尽收敛策略，但必须如实告知
     * 模型本次续接来自系统自动接力而非人工操作。
     */
    expect(prompt).toContain('RESUME_CAUSE: CLAUDE_TURN_LIMIT_REACHED');
    expect(prompt).toContain('必须立即返回结构化结果');
    expect(prompt).toContain('系统自动续接');
    expect(prompt).toContain('不是人工干预');
    expect(prompt).not.toContain('显式 resume');
  });

  it('推送失败的恢复提示如实陈述本地 Checkpoint 已保留并要求直接收敛', () => {
    const prompt = buildExecutionResumePrompt({
      task: pendingDefinition,
      cause: 'GIT_PUSH_FAILED',
      origin: 'user_resume',
    });
    /*
     * 推送失败时实现与验证证据都已在 transcript 与本地提交中齐备；续接
     * 会话的唯一缺口是重新交付结果以重试推送，必须明确禁止重复工作。
     */
    expect(prompt).toContain('RESUME_CAUSE: GIT_PUSH_FAILED');
    expect(prompt).toContain('推送到远程失败');
    expect(prompt).toContain('本地提交完整保留');
    expect(prompt).toContain('不要重复已完成的工作');
    expect(prompt).not.toContain('被前台中断');
    expect(prompt).not.toContain('已耗尽 maxAgentTurns');
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
    const prompt = buildTaskReviewResumePrompt({ cause: 'RUN_INTERRUPTED' });
    expect(prompt).toContain('被前台中断');
    expect(prompt).toContain('只续接该 Reviewer 自己的复核上下文');
    expect(prompt).toContain('不得恢复或引用产生候选实现的 Execution Session');
    expect(prompt).toContain('不得修改、创建、删除、暂存或提交文件');
    expect(prompt).toContain('TaskReviewResult');
  });

  it('结果契约失败的恢复提示如实陈述断点原因', () => {
    const prompt = buildTaskReviewResumePrompt({ cause: 'TASK_REVIEW_RESULT_INVALID' });
    expect(prompt).toContain('未通过契约校验');
    expect(prompt).not.toContain('被前台中断');
    expect(prompt).toContain('重新返回合法结果');
    expect(prompt).toContain('不得恢复或引用产生候选实现的 Execution Session');
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
    expect(prompt).toContain('changes_required 必须至少有一项未满足事实');
    expect(prompt).toContain('verificationEvidence 必须按 CURRENT_TASK.verificationPlan 原顺序逐项覆盖');
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
    const prompt = buildFinalReviewResumePrompt({ cause: 'RUN_INTERRUPTED' });
    /**
     * Final Review 是可写会话，恢复提示必须显式保留当前仓库事实，避免
     * 模型把中断前已经产生但尚未收尾的复核修改当作应回滚内容。
     */
    expect(prompt).toContain('被前台中断');
    expect(prompt).toContain('从原对话断点继续');
    expect(prompt).toContain('不要推倒重来');
    expect(prompt).toContain('完成整体复核');
    expect(prompt).toContain('不得把独立的开发服务器留在后台');
    expect(prompt).toContain('原则上只进行两轮有针对性的修正');
    expect(prompt).toContain('FinalReviewResult');
  });

  it('结果契约失败的恢复提示如实陈述断点原因', () => {
    const prompt = buildFinalReviewResumePrompt({ cause: 'FINAL_REVIEW_RESULT_INVALID' });
    expect(prompt).toContain('未通过契约校验');
    expect(prompt).not.toContain('被前台中断');
    expect(prompt).toContain('重新返回合法结果');
    expect(prompt).toContain('FinalReviewResult');
  });

  it('推送失败的恢复提示如实陈述本地 Checkpoint 已保留', () => {
    const prompt = buildFinalReviewResumePrompt({ cause: 'GIT_PUSH_FAILED' });
    /**
     * Final Review 的复核结论与本地 Checkpoint 在推送失败前已形成；续接
     * 会话基于已有复核事实重新表达结论即可触发重试推送，不能推倒重来。
     */
    expect(prompt).toContain('推送到远程失败');
    expect(prompt).toContain('本地提交完整保留');
    expect(prompt).not.toContain('被前台中断');
    expect(prompt).toContain('FinalReviewResult');
  });
});

describe('统一结构化结果提交协议', () => {
  it('覆盖全部完整会话 Prompt，并且协议固定处于末尾且只出现一次', () => {
    /**
     * 真实故障中 Execution Agent 把结果 JSON 写成普通文本，Claude Code
     * 随后在 StructuredOutput 强制提交阶段收到 Provider 400。这里枚举
     * 首次、恢复和结果修复入口，防止任一会话重新出现提交语义歧义。
     */
    const draft = {
      summary: '候选计划',
      assumptions: [],
      retainedCheckpointDispositions: [],
      tasks: [pendingDefinition],
    };
    const executionInput: ExecutionPromptInput = {
      repositoryRoot: REPOSITORY_ROOT,
      runBranch: RUN_BRANCH,
      specPath: SPEC_PATH,
      specSha256: SPEC_SHA256,
      planRevision: 1,
      task: pendingDefinition,
      completedTasks: [completedTask],
      adoptedCheckpoints: [],
      reviewFeedback: null,
    };
    const taskReviewInput: TaskReviewPromptInput = {
      repositoryRoot: REPOSITORY_ROOT,
      runBranch: RUN_BRANCH,
      specPath: SPEC_PATH,
      specSha256: SPEC_SHA256,
      planRevision: 1,
      task: pendingDefinition,
      candidateCheckpoint: OID_COMPLETED,
    };
    const prompts: readonly { readonly name: string; readonly value: string }[] = [
      { name: 'planning', value: buildPlanningPrompt(planningBase) },
      { name: 'planning-resume', value: buildPlanningResumePrompt() },
      {
        name: 'planning-correction',
        value: buildPlanningCorrectionPrompt('verification coverage invalid'),
      },
      {
        name: 'planning-correction-session',
        value: buildPlanningCorrectionSessionPrompt(draft, 'verification coverage invalid'),
      },
      {
        name: 'plan-review',
        value: buildPlanReviewPrompt({
          repositoryRoot: REPOSITORY_ROOT,
          runBranch: RUN_BRANCH,
          specPath: SPEC_PATH,
          specSha256: SPEC_SHA256,
          planRevision: 1,
          draft,
          retainedPendingTasks: [],
          completedTasks: [],
        }),
      },
      {
        name: 'plan-review-resume',
        value: buildPlanReviewResumePrompt({ cause: 'CLAUDE_EXIT_NONZERO' }),
      },
      {
        name: 'plan-review-repair',
        value: buildPlanReviewRepairPrompt({
          repositoryRoot: REPOSITORY_ROOT,
          runBranch: RUN_BRANCH,
          specPath: SPEC_PATH,
          specSha256: SPEC_SHA256,
          planRevision: 1,
          draft,
          validationError: 'result invalid',
          invalidResultJson: null,
        }),
      },
      { name: 'execution', value: buildExecutionPrompt(executionInput) },
      {
        name: 'execution-resume',
        value: buildExecutionResumePrompt({
          task: pendingDefinition,
          cause: 'CLAUDE_EXIT_NONZERO',
          origin: 'user_resume',
        }),
      },
      {
        name: 'execution-repair',
        value: buildExecutionResultRepairPrompt({
          repositoryRoot: REPOSITORY_ROOT,
          runBranch: RUN_BRANCH,
          task: pendingDefinition,
          validationError: 'result invalid',
          invalidResultJson: null,
        }),
      },
      { name: 'task-review', value: buildTaskReviewPrompt(taskReviewInput) },
      {
        name: 'task-review-resume',
        value: buildTaskReviewResumePrompt({ cause: 'CLAUDE_EXIT_NONZERO' }),
      },
      {
        name: 'task-review-repair',
        value: buildTaskReviewRepairPrompt({
          repositoryRoot: REPOSITORY_ROOT,
          runBranch: RUN_BRANCH,
          task: pendingDefinition,
          candidateCheckpoint: OID_COMPLETED,
          validationError: 'result invalid',
          invalidResultJson: null,
        }),
      },
      {
        name: 'final-review',
        value: buildFinalReviewPrompt({
          repositoryRoot: REPOSITORY_ROOT,
          runBranch: RUN_BRANCH,
          specPath: SPEC_PATH,
          specSha256: SPEC_SHA256,
          planRevision: 1,
          completedTasks: [],
          skippedTasks: [],
          intermediateCheckpoints: [],
        }),
      },
      {
        name: 'final-review-resume',
        value: buildFinalReviewResumePrompt({ cause: 'CLAUDE_EXIT_NONZERO' }),
      },
    ];

    expect(STRUCTURED_OUTPUT_INSTRUCTION).toContain('select:StructuredOutput');
    expect(STRUCTURED_OUTPUT_INSTRUCTION).toContain('不得把最终 JSON 作为普通文本');
    for (const prompt of prompts) {
      expect(prompt.value.endsWith(STRUCTURED_OUTPUT_INSTRUCTION), prompt.name).toBe(true);
      expect(prompt.value.split(STRUCTURED_OUTPUT_INSTRUCTION), prompt.name).toHaveLength(2);
    }
  });
});
