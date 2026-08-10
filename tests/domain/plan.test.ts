/**
 * TaskPlanDraft semantic validation (§7.5) and Plan Revision merge (§6.5):
 * duplicate IDs, missing dependencies, cycles, completed-task projection,
 * permanent ID uniqueness, pending modification and skipped merge, the
 * 50-revision limit and checkpoint disposition rules.
 */
import { describe, expect, it } from 'vitest';
import {
  mergePlanRevision,
  plannedTaskEquals,
  validateTaskPlanDraft,
  type PlanDraftValidationContext,
  type PlanMergeInput,
} from '../../src/domain/plan.js';
import type { IntermediateCheckpoint } from '../../src/domain/schemas/intermediate-checkpoint.js';
import {
  expectApexError,
  mkDraft,
  mkTask,
  mkTaskState,
  OID_C,
  OID_D,
  UUID_1,
} from './fixtures.js';

const INITIAL_CONTEXT: PlanDraftValidationContext = {
  nextPlanRevision: 1,
  completedTasks: [],
  reusablePendingTaskIds: [],
  usedTaskIds: [],
  unabsorbedCheckpointOids: [],
};

function replanContext(overrides: Partial<PlanDraftValidationContext>): PlanDraftValidationContext {
  return { ...INITIAL_CONTEXT, nextPlanRevision: 2, ...overrides };
}

describe('TaskPlanDraft validation (§7.5)', () => {
  it('accepts a valid initial draft with a dependency chain', () => {
    const draft = mkDraft([
      mkTask('TASK-001'),
      mkTask('TASK-002', ['TASK-001']),
      mkTask('TASK-003', ['TASK-002']),
    ]);
    expect(() => validateTaskPlanDraft(draft, INITIAL_CONTEXT)).not.toThrow();
  });

  it('rejects an empty plan', () => {
    expectApexError(
      () => validateTaskPlanDraft(mkDraft([]), INITIAL_CONTEXT),
      'PLAN_INVALID',
    );
  });

  it('rejects duplicate task IDs', () => {
    const draft = mkDraft([mkTask('TASK-001'), mkTask('TASK-001')]);
    expectApexError(() => validateTaskPlanDraft(draft, INITIAL_CONTEXT), 'PLAN_INVALID');
  });

  it('rejects dependencies on unknown tasks', () => {
    const draft = mkDraft([mkTask('TASK-001', ['TASK-099'])]);
    expectApexError(() => validateTaskPlanDraft(draft, INITIAL_CONTEXT), 'PLAN_INVALID');
  });

  it('rejects dependency cycles, including self-dependencies', () => {
    const cycle = mkDraft([mkTask('TASK-001', ['TASK-002']), mkTask('TASK-002', ['TASK-001'])]);
    expectApexError(() => validateTaskPlanDraft(cycle, INITIAL_CONTEXT), 'PLAN_INVALID');

    const selfCycle = mkDraft([mkTask('TASK-001', ['TASK-001'])]);
    expectApexError(() => validateTaskPlanDraft(selfCycle, INITIAL_CONTEXT), 'PLAN_INVALID');
  });

  it('rejects more than 50 pending tasks', () => {
    const tasks = Array.from({ length: 51 }, (_, index) =>
      mkTask(`TASK-${String(index + 1).padStart(3, '0')}`),
    );
    expectApexError(() => validateTaskPlanDraft(mkDraft(tasks), INITIAL_CONTEXT), 'PLAN_INVALID');
    const exactlyFifty = tasks.slice(0, 50);
    expect(() => validateTaskPlanDraft(mkDraft(exactlyFifty), INITIAL_CONTEXT)).not.toThrow();
  });

  it('rejects invalid task ID formats (TASK-000)', () => {
    const draft = mkDraft([mkTask('TASK-000')]);
    expectApexError(() => validateTaskPlanDraft(draft, INITIAL_CONTEXT), 'PLAN_INVALID');
  });

  it('requires verificationPlan to cover every acceptance criterion', () => {
    const task = mkTask('TASK-001', [], {
      verificationPlan: [
        {
          id: 'VERIFY-001',
          kind: 'command',
          criterionIndexes: [0],
          procedure: '运行单元测试',
          expectedEvidence: '命令通过',
          command: 'npm test',
          timeoutSeconds: 900,
        },
      ],
    });
    expectApexError(
      () => validateTaskPlanDraft(mkDraft([task]), INITIAL_CONTEXT),
      'PLAN_INVALID',
    );
  });

  it('reports every uncovered acceptance criterion in one deterministic failure', () => {
    /**
     * Planner 修正会话必须一次收到整份草稿的覆盖缺口，不能按 Task 顺序逐个
     * 打回并反复要求模型重发完整计划。其他结构规则仍由既有断言独立覆盖。
     */
    const missingCoverage = (id: string, dependsOn: string[] = []) =>
      mkTask(id, dependsOn, {
        acceptanceCriteria: ['条件一', '条件二', '条件三'],
        verificationPlan: [
          {
            id: `VERIFY-${id.slice(-3)}`,
            kind: 'command',
            criterionIndexes: [0],
            procedure: '运行单元测试',
            expectedEvidence: '命令通过',
            command: 'npm test',
            timeoutSeconds: 900,
          },
        ],
      });
    const error = expectApexError(
      () =>
        validateTaskPlanDraft(
          mkDraft([
            missingCoverage('TASK-001'),
            missingCoverage('TASK-002', ['TASK-001']),
          ]),
          INITIAL_CONTEXT,
        ),
      'PLAN_INVALID',
    );

    expect(error.message).toContain('task TASK-001 acceptance criterion 1');
    expect(error.message).toContain('task TASK-001 acceptance criterion 2');
    expect(error.message).toContain('task TASK-002 acceptance criterion 1');
    expect(error.message).toContain('task TASK-002 acceptance criterion 2');
  });

  it('rejects duplicate verification IDs and kind/command coupling violations', () => {
    const duplicate = mkTask('TASK-001', [], {
      verificationPlan: [
        ...mkTask('TASK-001').verificationPlan,
        ...mkTask('TASK-001').verificationPlan,
      ],
    });
    expectApexError(
      () => validateTaskPlanDraft(mkDraft([duplicate]), INITIAL_CONTEXT),
      'PLAN_INVALID',
    );

    const invalidStatic = mkTask('TASK-001', [], {
      verificationPlan: [
        {
          id: 'VERIFY-001',
          kind: 'static_analysis',
          criterionIndexes: [0, 1],
          procedure: '检查模块依赖',
          expectedEvidence: '不存在跨层引用',
          command: 'npm test',
          timeoutSeconds: null,
        },
      ],
    });
    expectApexError(
      () => validateTaskPlanDraft(mkDraft([invalidStatic]), INITIAL_CONTEXT),
      'PLAN_INVALID',
    );
  });

  it('keeps the target context budget strictly below the hard limit', () => {
    const task = mkTask('TASK-001', [], {
      budget: {
        targetContextBudget: 600_000,
        hardContextLimit: 600_000,
        maxAgentTurns: 64,
      },
    });
    expectApexError(
      () => validateTaskPlanDraft(mkDraft([task]), INITIAL_CONTEXT),
      'PLAN_INVALID',
    );
  });

  it('requires brand-new tasks to use the current hard context limit', () => {
    const legacyBudget = {
      targetContextBudget: 200_000,
      hardContextLimit: 300_000,
      maxAgentTurns: 64,
    };
    expectApexError(
      () =>
        validateTaskPlanDraft(
          mkDraft([mkTask('TASK-001', [], { budget: legacyBudget })]),
          INITIAL_CONTEXT,
        ),
      'PLAN_INVALID',
    );
  });

  it('allows retained completed and pending tasks to keep historical budget values', () => {
    // 旧 Revision（2.0.25 前）的任务携带 hardContextLimit 300000；原样保留
    // 它们不得与新任务的当前政策值要求冲突，否则旧 Run 无法提交任何 Revision。
    const legacyBudget = {
      targetContextBudget: 200_000,
      hardContextLimit: 300_000,
      maxAgentTurns: 64,
    };
    const completed = mkTask('TASK-001', [], { budget: legacyBudget });
    const retainedPending = mkTask('TASK-002', ['TASK-001'], { budget: legacyBudget });
    const fresh = mkTask('TASK-003', ['TASK-002']);
    expect(() =>
      validateTaskPlanDraft(
        mkDraft([completed, retainedPending, fresh]),
        replanContext({
          completedTasks: [completed],
          reusablePendingTaskIds: ['TASK-002'],
          usedTaskIds: ['TASK-001', 'TASK-002'],
        }),
      ),
    ).not.toThrow();
  });

  it('rejects dispositions in the initial plan', () => {
    const draft = mkDraft(
      [mkTask('TASK-001')],
      [{ checkpointOid: OID_C, ownerTaskId: 'TASK-001', rationale: 'keep' }],
    );
    expectApexError(() => validateTaskPlanDraft(draft, INITIAL_CONTEXT), 'PLAN_INVALID');
  });

  it('projects completed tasks: draft entries are ignored, canonical definitions win', () => {
    /**
     * completed 定义是不可变 Run 事实，草稿不再承担逐字复述义务：缺失或
     * 被改写的 completed 条目都不再是冲突，校验始终在「权威 completed +
     * 草稿非 completed」的投射视图上进行。依赖 completed ID 的新任务合法。
     */
    const completed = mkTask('TASK-001');
    const context = replanContext({
      completedTasks: [completed],
      usedTaskIds: ['TASK-001'],
    });
    // 草稿完全不包含 completed Task：新任务 dependsOn completed ID 合法。
    expect(() =>
      validateTaskPlanDraft(mkDraft([mkTask('TASK-002', ['TASK-001'])]), context),
    ).not.toThrow();
    // 草稿携带被改写的 completed 条目：被忽略，不再构成冲突。
    expect(() =>
      validateTaskPlanDraft(
        mkDraft([mkTask('TASK-001', [], { objective: 'rewritten' }), mkTask('TASK-002')]),
        context,
      ),
    ).not.toThrow();
    // 草稿携带逐字一致的 completed 条目：同样容忍。
    expect(() =>
      validateTaskPlanDraft(mkDraft([mkTask('TASK-001'), mkTask('TASK-002')]), context),
    ).not.toThrow();
  });

  it('enforces permanent task ID uniqueness', () => {
    // TASK-005 was used before (e.g. skipped) and is neither completed nor old-pending.
    const context = replanContext({ usedTaskIds: ['TASK-005'] });
    expectApexError(
      () => validateTaskPlanDraft(mkDraft([mkTask('TASK-005')]), context),
      'PLAN_REVISION_CONFLICT',
    );
    // Old pending IDs may be kept with a modified definition.
    const retained = replanContext({
      reusablePendingTaskIds: ['TASK-005'],
      usedTaskIds: ['TASK-005'],
    });
    expect(() =>
      validateTaskPlanDraft(mkDraft([mkTask('TASK-005', [], { title: 'changed' })]), retained),
    ).not.toThrow();
    // A never-used ID is fine.
    expect(() => validateTaskPlanDraft(mkDraft([mkTask('TASK-006')]), context)).not.toThrow();
  });

  it('rejects the 51st plan revision', () => {
    const context = replanContext({ nextPlanRevision: 51 });
    expectApexError(
      () => validateTaskPlanDraft(mkDraft([mkTask('TASK-001')]), context),
      'PLAN_REVISION_LIMIT_EXCEEDED',
    );
    expect(() =>
      validateTaskPlanDraft(
        mkDraft([mkTask('TASK-001')]),
        replanContext({ nextPlanRevision: 50 }),
      ),
    ).not.toThrow();
  });
});

describe('checkpoint dispositions (§7.3/§7.5, AC-033)', () => {
  const checkpoint: IntermediateCheckpoint = {
    oid: OID_C,
    role: 'task-intermediate',
    sourceSessionId: UUID_1,
    taskId: 'TASK-001',
    planRevision: 1,
    summary: 'preserve intermediate work',
    ownerTaskId: 'TASK-001',
  };

  function dispositionContext(): PlanDraftValidationContext {
    return replanContext({
      completedTasks: [],
      reusablePendingTaskIds: ['TASK-001', 'TASK-002'],
      usedTaskIds: ['TASK-001', 'TASK-002'],
      unabsorbedCheckpointOids: [checkpoint.oid],
    });
  }

  it('requires exactly one disposition per unabsorbed checkpoint', () => {
    const context = dispositionContext();
    // Missing disposition.
    expectApexError(
      () => validateTaskPlanDraft(mkDraft([mkTask('TASK-001')]), context),
      'PLAN_REVISION_CONFLICT',
    );
    // Duplicated disposition.
    const duplicated = mkDraft(
      [mkTask('TASK-001'), mkTask('TASK-002')],
      [
        { checkpointOid: OID_C, ownerTaskId: 'TASK-001', rationale: 'a' },
        { checkpointOid: OID_C, ownerTaskId: 'TASK-002', rationale: 'b' },
      ],
    );
    expectApexError(() => validateTaskPlanDraft(duplicated, context), 'PLAN_REVISION_CONFLICT');
    // Exactly one.
    const legal = mkDraft(
      [mkTask('TASK-001'), mkTask('TASK-002')],
      [{ checkpointOid: OID_C, ownerTaskId: 'TASK-002', rationale: 'adopt changes' }],
    );
    expect(() => validateTaskPlanDraft(legal, context)).not.toThrow();
  });

  it('rejects dispositions referencing unknown checkpoints or tasks', () => {
    const context = dispositionContext();
    const unknownCheckpoint = mkDraft(
      [mkTask('TASK-001')],
      [
        { checkpointOid: OID_C, ownerTaskId: 'TASK-001', rationale: 'ok' },
        { checkpointOid: OID_D, ownerTaskId: 'TASK-001', rationale: 'unknown' },
      ],
    );
    expectApexError(
      () => validateTaskPlanDraft(unknownCheckpoint, context),
      'PLAN_REVISION_CONFLICT',
    );

    const unknownOwner = mkDraft(
      [mkTask('TASK-001')],
      [{ checkpointOid: OID_C, ownerTaskId: 'TASK-099', rationale: 'unknown owner' }],
    );
    expectApexError(
      () => validateTaskPlanDraft(unknownOwner, context),
      'PLAN_REVISION_CONFLICT',
    );
  });

  it('requires the owner to be a pending task, not a completed one', () => {
    const context = replanContext({
      completedTasks: [mkTask('TASK-009')],
      reusablePendingTaskIds: ['TASK-001'],
      usedTaskIds: ['TASK-001', 'TASK-009'],
      unabsorbedCheckpointOids: [checkpoint.oid],
    });
    const ownedByCompleted = mkDraft(
      [mkTask('TASK-009'), mkTask('TASK-001')],
      [{ checkpointOid: OID_C, ownerTaskId: 'TASK-009', rationale: 'wrong owner' }],
    );
    expectApexError(
      () => validateTaskPlanDraft(ownedByCompleted, context),
      'PLAN_REVISION_CONFLICT',
    );
  });
});

describe('Plan Revision merge (§6.5)', () => {
  it('merges the initial plan: everything new, nothing skipped', () => {
    const input: PlanMergeInput = {
      draft: mkDraft([mkTask('TASK-001'), mkTask('TASK-002', ['TASK-001'])]),
      currentPlanRevision: 0,
      currentTasks: [],
      taskStates: {},
      unabsorbedCheckpoints: [],
    };
    const result = mergePlanRevision(input);
    expect(result.planRevision).toBe(1);
    expect(result.newTaskIds).toEqual(['TASK-001', 'TASK-002']);
    expect(result.retainedPendingTaskIds).toEqual([]);
    expect(result.updatedPendingTaskIds).toEqual([]);
    expect(result.skippedTaskIds).toEqual([]);
    expect(result.skipReason).toBeTruthy();
  });

  it('merges a replan: retain+modify pending, skip omitted, add new', () => {
    const taskOne = mkTask('TASK-001');
    const taskTwo = mkTask('TASK-002', ['TASK-001']);
    const taskThree = mkTask('TASK-003', ['TASK-002']);
    const input: PlanMergeInput = {
      draft: mkDraft([
        mkTask('TASK-001'),
        mkTask('TASK-002', ['TASK-001'], { objective: 'redefined objective' }),
        mkTask('TASK-004', ['TASK-001']),
      ]),
      currentPlanRevision: 1,
      currentTasks: [taskOne, taskTwo, taskThree],
      taskStates: {
        'TASK-001': mkTaskState('TASK-001', 'completed'),
        'TASK-002': mkTaskState('TASK-002', 'pending'),
        'TASK-003': mkTaskState('TASK-003', 'pending'),
      },
      unabsorbedCheckpoints: [],
    };
    const result = mergePlanRevision(input);
    expect(result.planRevision).toBe(2);
    expect(result.retainedPendingTaskIds).toEqual(['TASK-002']);
    expect(result.updatedPendingTaskIds).toEqual(['TASK-002']);
    expect(result.skippedTaskIds).toEqual(['TASK-003']);
    expect(result.newTaskIds).toEqual(['TASK-004']);
    expect(result.tasks.map((task) => task.id)).toEqual(['TASK-001', 'TASK-002', 'TASK-004']);
    // 复核候选只含草稿自己表达的非 completed 任务。
    expect(result.candidateTasks.map((task) => task.id)).toEqual(['TASK-002', 'TASK-004']);
  });

  it('projects canonical completed definitions regardless of the draft', () => {
    /**
     * 狗咬尾运行中观察到的真实失效形态：长历史 Run 的 Planner（尤其弱
     * 模型）无法在单次结构化输出里逐字复述全部 completed 定义——省略、
     * 截断或凭记忆改写 context 都曾把 Revision 卡死在确定性校验上。
     * 合并一律以 tasks.json 的权威定义为准，草稿里的 completed 条目只是
     * 被丢弃的噪声。
     */
    const taskOne = mkTask('TASK-001', [], { context: '权威上下文定义' });
    const base = {
      currentPlanRevision: 1,
      currentTasks: [taskOne, mkTask('TASK-002', ['TASK-001'])],
      taskStates: {
        'TASK-001': mkTaskState('TASK-001', 'completed'),
        'TASK-002': mkTaskState('TASK-002', 'pending'),
      },
      unabsorbedCheckpoints: [],
    } as const;
    // 草稿完全省略 completed。
    const omitted = mergePlanRevision({
      ...base,
      draft: mkDraft([mkTask('TASK-002', ['TASK-001'])]),
    });
    expect(omitted.tasks.map((task) => task.id)).toEqual(['TASK-001', 'TASK-002']);
    expect(omitted.tasks[0]).toEqual(taskOne);
    // 草稿改写 completed（复述失真）：权威定义胜出，不打回、不阻塞。
    const paraphrased = mergePlanRevision({
      ...base,
      draft: mkDraft([
        mkTask('TASK-001', [], { context: '模型凭记忆改写的摘要' }),
        mkTask('TASK-002', ['TASK-001']),
      ]),
    });
    expect(paraphrased.tasks[0]).toEqual(taskOne);
    expect(paraphrased.candidateTasks.map((task) => task.id)).toEqual(['TASK-002']);
    expect(paraphrased.retainedPendingTaskIds).toEqual(['TASK-002']);
    expect(paraphrased.updatedPendingTaskIds).toEqual([]);
  });

  it('keeps retained-but-unchanged pending tasks out of the updated list', () => {
    const taskTwo = mkTask('TASK-002', ['TASK-001']);
    const input: PlanMergeInput = {
      draft: mkDraft([mkTask('TASK-001'), mkTask('TASK-002', ['TASK-001'])]),
      currentPlanRevision: 1,
      currentTasks: [mkTask('TASK-001'), taskTwo],
      taskStates: {
        'TASK-001': mkTaskState('TASK-001', 'completed'),
        'TASK-002': mkTaskState('TASK-002', 'pending'),
      },
      unabsorbedCheckpoints: [],
    };
    const result = mergePlanRevision(input);
    expect(result.retainedPendingTaskIds).toEqual(['TASK-002']);
    expect(result.updatedPendingTaskIds).toEqual([]);
    expect(result.skippedTaskIds).toEqual([]);
  });

  it('refuses to merge while a task is running', () => {
    const input: PlanMergeInput = {
      draft: mkDraft([mkTask('TASK-001')]),
      currentPlanRevision: 1,
      currentTasks: [mkTask('TASK-001')],
      taskStates: { 'TASK-001': mkTaskState('TASK-001', 'running') },
      unabsorbedCheckpoints: [],
    };
    expectApexError(() => mergePlanRevision(input), 'PLAN_REVISION_CONFLICT');
  });

  it('refuses to reuse the ID of an omitted (skipped) task', () => {
    const input: PlanMergeInput = {
      draft: mkDraft([mkTask('TASK-001'), mkTask('TASK-003')]),
      currentPlanRevision: 1,
      currentTasks: [mkTask('TASK-001'), mkTask('TASK-002')],
      taskStates: {
        'TASK-001': mkTaskState('TASK-001', 'completed'),
        'TASK-002': mkTaskState('TASK-002', 'skipped'),
        'TASK-003': mkTaskState('TASK-003', 'skipped'),
      },
      unabsorbedCheckpoints: [],
    };
    expectApexError(() => mergePlanRevision(input), 'PLAN_REVISION_CONFLICT');
  });

  it('refuses a merge beyond 50 revisions', () => {
    const input: PlanMergeInput = {
      draft: mkDraft([mkTask('TASK-001')]),
      currentPlanRevision: 50,
      currentTasks: [mkTask('TASK-001')],
      taskStates: { 'TASK-001': mkTaskState('TASK-001', 'pending') },
      unabsorbedCheckpoints: [],
    };
    expectApexError(() => mergePlanRevision(input), 'PLAN_REVISION_LIMIT_EXCEEDED');
  });

  it('plannedTaskEquals compares definitions field by field', () => {
    const a = mkTask('TASK-001');
    expect(plannedTaskEquals(a, mkTask('TASK-001'))).toBe(true);
    expect(plannedTaskEquals(a, mkTask('TASK-001', [], { context: 'other' }))).toBe(false);
    expect(plannedTaskEquals(a, mkTask('TASK-001', [], { acceptanceCriteria: ['x'] }))).toBe(false);
    expect(plannedTaskEquals(a, mkTask('TASK-002'))).toBe(false);
  });
});
