/**
 * TaskPlanDraft semantic validation (SPEC §7.5) and the deterministic Plan
 * Revision merge algorithm (SPEC §6.5).
 *
 * Error-code policy:
 * - `PLAN_INVALID` — problems internal to the draft itself;
 * - `PLAN_REVISION_CONFLICT` — conflicts between the draft and current Run
 *   state (running task present, ID reuse, checkpoint disposition problems);
 * - `PLAN_REVISION_LIMIT_EXCEEDED` — a 51st revision is requested.
 *
 * Invalid drafts are rejected as-is: no structural repair, no field removal,
 * no dependency guessing, no reordering (SPEC §7.5).
 *
 * Revision 投影规则：草稿只需完整表达发生修改或全新的定义。completed 定义
 * 始终由系统投射，未修改的 pending 定义可以通过 retain 引用投射。若要求
 * 模型重发所有不可变定义，Revision 会随历史持续膨胀，并把纯回显准确度
 * 变成不提供额外语义信息的可靠性瓶颈。
 */
import { ApexError } from './errors.js';
import { isTaskId, taskIdNumber } from './ids.js';
import type { IntermediateCheckpoint } from './schemas/intermediate-checkpoint.js';
import {
  TASK_HARD_CONTEXT_TOKENS,
  type CheckpointDisposition,
  isRetainedTaskReference,
  type PlannedTask,
  type TaskPlanDraft,
  type VerificationStep,
} from './schemas/task-plan-draft.js';
import type { TaskRuntimeState } from './schemas/task-runtime-state.js';

export const MAX_PENDING_TASKS = 50;
export const MAX_PLAN_REVISIONS = 50;
export const MAX_TASK_ID_NUMBER = 999;

const PLAN_STAGE = 'planning';

function planInvalid(message: string): ApexError {
  return new ApexError({ code: 'PLAN_INVALID', stage: PLAN_STAGE, message });
}

function planConflict(message: string): ApexError {
  return new ApexError({ code: 'PLAN_REVISION_CONFLICT', stage: PLAN_STAGE, message });
}

/** Field-by-field deep equality of two task definitions (SPEC §6.5 step 3). */
export function plannedTaskEquals(a: PlannedTask, b: PlannedTask): boolean {
  const stringArrayEquals = (x: readonly string[], y: readonly string[]): boolean =>
    x.length === y.length && x.every((value, index) => value === y[index]);
  const verificationEquals = (x: VerificationStep, y: VerificationStep): boolean =>
    x.id === y.id &&
    x.kind === y.kind &&
    x.procedure === y.procedure &&
    x.expectedEvidence === y.expectedEvidence &&
    x.command === y.command &&
    x.timeoutSeconds === y.timeoutSeconds &&
    x.criterionIndexes.length === y.criterionIndexes.length &&
    x.criterionIndexes.every((value, index) => value === y.criterionIndexes[index]);
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.objective === b.objective &&
    a.context === b.context &&
    a.budget.targetContextBudget === b.budget.targetContextBudget &&
    a.budget.hardContextLimit === b.budget.hardContextLimit &&
    a.budget.maxAgentTurns === b.budget.maxAgentTurns &&
    stringArrayEquals(a.nonGoals, b.nonGoals) &&
    stringArrayEquals(a.dependsOn, b.dependsOn) &&
    stringArrayEquals(a.acceptanceCriteria, b.acceptanceCriteria) &&
    stringArrayEquals(a.likelyPaths, b.likelyPaths) &&
    a.verificationPlan.length === b.verificationPlan.length &&
    a.verificationPlan.every((step, index) => {
      const other = b.verificationPlan[index];
      return other !== undefined && verificationEquals(step, other);
    })
  );
}

/**
 * 校验单个 Task 的结构化验证计划与预算语义。
 *
 * JSON Schema 负责基础形状；这里集中维护验收条件覆盖、验证方式字段耦合
 * 和预算单调性，避免 Planner、Reviewer 与执行器各自解释同一契约。
 */
function assertTaskExecutionContract(task: PlannedTask): readonly number[] {
  const verificationIds = new Set<string>();
  const coveredCriteria = new Set<number>();
  for (const step of task.verificationPlan) {
    if (verificationIds.has(step.id)) {
      throw planInvalid(`task ${task.id} has duplicate verification step ${step.id}`);
    }
    verificationIds.add(step.id);
    for (const criterionIndex of step.criterionIndexes) {
      if (criterionIndex < 0 || criterionIndex >= task.acceptanceCriteria.length) {
        throw planInvalid(
          `task ${task.id} verification ${step.id} references acceptance criterion ${criterionIndex} out of range`,
        );
      }
      coveredCriteria.add(criterionIndex);
    }
    const isCommand = step.kind === 'command';
    const hasCommandFields = step.command !== null || step.timeoutSeconds !== null;
    const hasCompleteCommandFields = step.command !== null && step.timeoutSeconds !== null;
    if ((isCommand && !hasCompleteCommandFields) || (!isCommand && hasCommandFields)) {
      throw planInvalid(
        `task ${task.id} verification ${step.id} must use command and timeout only for kind command`,
      );
    }
  }
  if (task.budget.targetContextBudget >= task.budget.hardContextLimit) {
    throw planInvalid(
      `task ${task.id} target context budget must stay below its hard context limit`,
    );
  }

  /**
   * 覆盖缺口本身彼此独立，调用方需要在完成全部 Task 的结构校验后统一报告。
   * 这里返回稳定的 criterion index 列表，不在领域层拼装跨 Task 的隐式状态。
   */
  return task.acceptanceCriteria
    .map((_, index) => index)
    .filter((index) => !coveredCriteria.has(index));
}

export interface PlanDraftValidationContext {
  /** Revision number this draft would become (1 for the initial plan). */
  readonly nextPlanRevision: number;
  /** Canonical definitions of completed tasks; projected verbatim into the plan. */
  readonly completedTasks: readonly PlannedTask[];
  /**
   * 旧 pending Task 的权威定义。
   * 完整定义既用于识别可复用 ID，也用于物化紧凑 retain 引用。
   */
  readonly reusablePendingTasks: readonly PlannedTask[];
  /** Every task ID ever used in this Run (pending/running/completed/failed/skipped). */
  readonly usedTaskIds: readonly string[];
  /** OIDs of intermediate checkpoints not yet absorbed by a completed task. */
  readonly unabsorbedCheckpointOids: readonly string[];
}

/**
 * 草稿的有效任务视图：权威 completed、紧凑保留的 pending 与完整 Task 定义。
 *
 * 草稿中携带的 completed 条目仍被整体丢弃；retain 引用指向的旧
 * pending 定义由系统逐字投射。完整 tasks 只承担修改旧 Task 或新增 Task，
 * 从而让长 Run 的 Replan 不必在输入、输出和复核阶段反复复制同一份定义。
 */
function effectiveTasks(
  draft: TaskPlanDraft,
  completedTasks: readonly PlannedTask[],
  reusablePendingTasks: readonly PlannedTask[],
): PlannedTask[] {
  const completedIds = new Set(completedTasks.map((task) => task.id));
  const reusableById = new Map(reusablePendingTasks.map((task) => [task.id, task]));
  const futureTasks: PlannedTask[] = [];

  /**
   * 引用和完整定义按草稿原顺序物化，使 Planner 仍可通过排列 tasks 调整
   * 后续执行优先级；紧凑表达只消除字段复制，不改变 Revision 的顺序语义。
   * 未知引用稍后由显式冲突校验报错，此处不猜测定义。
   */
  for (const entry of draft.tasks) {
    if (isRetainedTaskReference(entry)) {
      const retained = reusableById.get(entry.id);
      if (retained !== undefined) futureTasks.push(retained);
    } else if (!completedIds.has(entry.id)) {
      futureTasks.push(entry);
    }
  }
  return [...completedTasks, ...futureTasks];
}

function assertGraphShape(tasks: readonly PlannedTask[]): void {
  const byId = new Map<string, PlannedTask>();
  for (const task of tasks) {
    if (byId.has(task.id)) {
      throw planInvalid(`duplicate task ID in draft: ${task.id}`);
    }
    byId.set(task.id, task);
  }
  for (const task of tasks) {
    for (const dependencyId of task.dependsOn) {
      if (!byId.has(dependencyId)) {
        throw planInvalid(`task ${task.id} depends on unknown task ${dependencyId}`);
      }
    }
  }

  // Cycle detection: iterative DFS with white/gray/black coloring.
  const color = new Map<string, 'gray' | 'black'>();
  for (const task of tasks) {
    if (color.has(task.id)) continue;
    const stack: Array<{ id: string; childIndex: number }> = [{ id: task.id, childIndex: 0 }];
    color.set(task.id, 'gray');
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const node = byId.get(frame.id)!;
      if (frame.childIndex < node.dependsOn.length) {
        const childId = node.dependsOn[frame.childIndex]!;
        frame.childIndex += 1;
        const childColor = color.get(childId);
        if (childColor === 'gray') {
          throw planInvalid(`dependency cycle detected at task ${childId}`);
        }
        if (childColor === undefined) {
          color.set(childId, 'gray');
          stack.push({ id: childId, childIndex: 0 });
        }
      } else {
        color.set(frame.id, 'black');
        stack.pop();
      }
    }
  }

  // At least one dependency-free root, and every task reachable from a root.
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    for (const dependencyId of task.dependsOn) {
      const list = dependents.get(dependencyId) ?? [];
      list.push(task.id);
      dependents.set(dependencyId, list);
    }
  }
  const roots = tasks.filter((task) => task.dependsOn.length === 0).map((task) => task.id);
  if (roots.length === 0) {
    throw planInvalid('plan has no dependency-free task');
  }
  const visited = new Set<string>(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const dependentId of dependents.get(id) ?? []) {
      if (!visited.has(dependentId)) {
        visited.add(dependentId);
        queue.push(dependentId);
      }
    }
  }
  for (const task of tasks) {
    if (!visited.has(task.id)) {
      throw planInvalid(`task ${task.id} is not reachable from any dependency-free task`);
    }
  }
}

/**
 * Deterministic TaskPlanDraft validation (SPEC §7.5). Completed tasks are
 * projected onto the draft first (see {@link effectiveTasks}); the merged
 * view must already satisfy the TaskPlanDraft schema. Throws ApexError on
 * the first violated rule.
 */
export function validateTaskPlanDraft(
  draft: TaskPlanDraft,
  context: PlanDraftValidationContext,
): void {
  if (context.nextPlanRevision > MAX_PLAN_REVISIONS) {
    throw new ApexError({
      code: 'PLAN_REVISION_LIMIT_EXCEEDED',
      stage: PLAN_STAGE,
      message: `plan revision ${context.nextPlanRevision} exceeds limit ${MAX_PLAN_REVISIONS}`,
    });
  }

  const completedIds = new Set(context.completedTasks.map((task) => task.id));
  const reusablePendingTasks = context.reusablePendingTasks;
  const reusablePendingIds = new Set(reusablePendingTasks.map((task) => task.id));
  const usedIds = new Set(context.usedTaskIds);
  const references = draft.tasks.filter(isRetainedTaskReference);
  const retainedIds = new Set<string>();

  /**
   * 初始规划没有可供引用的上一 Revision；Replan 的紧凑引用则必须唯一、
   * 必须指向当前 pending Task，且不能和完整 tasks 定义重复表达同一 ID。
   */
  if (context.nextPlanRevision === 1 && references.length > 0) {
    throw planInvalid('initial plan must not contain retained task references');
  }
  const fullDraftIds = new Set(
    draft.tasks
      .filter((entry): entry is PlannedTask => !isRetainedTaskReference(entry))
      .filter((task) => !completedIds.has(task.id))
      .map((task) => task.id),
  );
  for (const reference of references) {
    const taskId = reference.id;
    if (retainedIds.has(taskId)) {
      throw planInvalid(`draft contains duplicate retained task reference ${taskId}`);
    }
    retainedIds.add(taskId);
    if (!reusablePendingIds.has(taskId)) {
      throw planConflict(`retained task reference points to non-pending task ${taskId}`);
    }
    if (fullDraftIds.has(taskId)) {
      throw planConflict(
        `pending task ${taskId} cannot appear as both a retain reference and a full definition`,
      );
    }
  }

  const tasks = effectiveTasks(draft, context.completedTasks, reusablePendingTasks);

  if (tasks.length === 0) {
    throw planInvalid('plan must contain at least one task');
  }

  const pendingCount = tasks.filter((task) => !completedIds.has(task.id)).length;
  if (pendingCount > MAX_PENDING_TASKS) {
    throw planInvalid(`plan has ${pendingCount} pending tasks, limit is ${MAX_PENDING_TASKS}`);
  }

  const uncoveredCriteria: string[] = [];
  for (const task of tasks) {
    if (!isTaskId(task.id)) {
      throw planInvalid(`invalid task ID format: ${task.id}`);
    }
    const numeric = taskIdNumber(task.id);
    if (numeric === null || numeric > MAX_TASK_ID_NUMBER) {
      throw planInvalid(`task ID number out of range: ${task.id}`);
    }
    for (const criterionIndex of assertTaskExecutionContract(task)) {
      uncoveredCriteria.push(
        `task ${task.id} acceptance criterion ${criterionIndex} has no verification step`,
      );
    }
  }

  /**
   * 一次返回整份草稿的全部覆盖缺口，让 Planner 可以在同一修正轮内处理完毕。
   * 其他结构错误仍保持立即失败，因为后续检查依赖其局部结构已经可信。
   */
  if (uncoveredCriteria.length > 0) {
    throw planInvalid(uncoveredCriteria.join('; '));
  }

  assertGraphShape(tasks);

  // Task ID permanence: reused IDs must be completed or old pending; anything
  // else must be brand-new (skipped IDs are never reusable).
  for (const task of tasks) {
    if (completedIds.has(task.id) || reusablePendingIds.has(task.id)) continue;
    if (usedIds.has(task.id)) {
      throw planConflict(`task ID ${task.id} has already been used in this Run`);
    }
    /**
     * 全新任务必须使用当前预算政策值。原样保留的 completed/pending Task
     * 允许携带历史政策值（如 2.0.25 前的 hardContextLimit 300000）——
     * 若对它们也强制当前值，会与「completed 定义不可变」形成死锁，
     * 旧 Run 的任何 Revision 都无法提交。
     */
    if (task.budget.hardContextLimit !== TASK_HARD_CONTEXT_TOKENS) {
      throw planInvalid(
        `new task ${task.id} must use the current hardContextLimit ${TASK_HARD_CONTEXT_TOKENS}`,
      );
    }
  }

  // Checkpoint dispositions (SPEC §7.3/§7.5).
  const unabsorbed = new Set(context.unabsorbedCheckpointOids);
  if (context.nextPlanRevision === 1) {
    if (draft.retainedCheckpointDispositions.length > 0) {
      throw planInvalid('initial plan must have an empty retainedCheckpointDispositions');
    }
    return;
  }
  const draftById = new Map(tasks.map((task) => [task.id, task]));
  const seenOids = new Set<string>();
  for (const disposition of draft.retainedCheckpointDispositions) {
    if (!unabsorbed.has(disposition.checkpointOid)) {
      throw planConflict(
        `disposition references unknown checkpoint ${disposition.checkpointOid}`,
      );
    }
    if (seenOids.has(disposition.checkpointOid)) {
      throw planConflict(
        `checkpoint ${disposition.checkpointOid} has more than one disposition`,
      );
    }
    seenOids.add(disposition.checkpointOid);
    const owner = draftById.get(disposition.ownerTaskId);
    if (!owner) {
      throw planConflict(
        `disposition for ${disposition.checkpointOid} references unknown task ${disposition.ownerTaskId}`,
      );
    }
    if (completedIds.has(owner.id)) {
      throw planConflict(
        `checkpoint ${disposition.checkpointOid} must be adopted by a pending task, not completed task ${owner.id}`,
      );
    }
  }
  for (const oid of unabsorbed) {
    if (!seenOids.has(oid)) {
      throw planConflict(`unabsorbed intermediate checkpoint ${oid} has no disposition`);
    }
  }
}

export interface PlanMergeInput {
  /**
   * Planner 结构化草稿。只应包含未改 pending 的 retain 引用、修改后
   * pending 的完整定义与新增 Task；携带的 completed 条目一律被丢弃，
   * 由权威定义投射替代。
   */
  readonly draft: TaskPlanDraft;
  /** 0 when no revision has been committed yet. */
  readonly currentPlanRevision: number;
  /** Task definitions of the current plan (empty before revision 1). */
  readonly currentTasks: readonly PlannedTask[];
  /** Current run.json task runtime states (empty before revision 1). */
  readonly taskStates: Readonly<Record<string, TaskRuntimeState>>;
  /** Intermediate checkpoints not yet absorbed by a completed task. */
  readonly unabsorbedCheckpoints: readonly IntermediateCheckpoint[];
}

export interface PlanMergeResult {
  /** The revision number this merge commits (`currentPlanRevision + 1`). */
  readonly planRevision: number;
  /**
   * Full task list of the new plan: canonical completed definitions in
   * previous-plan order, then the draft's non-completed tasks in draft order.
   */
  readonly tasks: PlannedTask[];
  /**
   * 草稿中完整表达的修改/新增 Task；retain 引用的未改 Task 已在
   * 上一 Revision 通过复核，不再让 Reviewer 重复评估整份历史定义。
   */
  readonly candidateTasks: PlannedTask[];
  /** Old pending tasks kept in the new plan (definition may have changed). */
  readonly retainedPendingTaskIds: string[];
  /** Subset of retained pending tasks whose definition changed. */
  readonly updatedPendingTaskIds: string[];
  /** Brand-new tasks that become pending. */
  readonly newTaskIds: string[];
  /** Old pending tasks omitted by the new plan; they become skipped. */
  readonly skippedTaskIds: string[];
  /** The skipReason to record on each newly skipped task. */
  readonly skipReason: string;
  /** Validated checkpoint dispositions to persist with the revision. */
  readonly dispositions: CheckpointDisposition[];
}

/**
 * Deterministic Plan Revision merge (SPEC §6.5). Covers the decision steps
 * 1–8; the persistence steps 9–11 (snapshot, tasks.json, run.json replacement)
 * are performed by the Application layer from this result.
 *
 * Completed tasks are never taken from the draft: their canonical
 * definitions (current plan order) are projected verbatim, and any
 * completed-task entries in the draft are discarded before validation.
 */
export function mergePlanRevision(input: PlanMergeInput): PlanMergeResult {
  const nextPlanRevision = input.currentPlanRevision + 1;

  // §6.5 step 2: no running task may exist when a revision is committed.
  for (const state of Object.values(input.taskStates)) {
    if (state.status === 'running') {
      throw planConflict(`cannot commit a plan revision while task ${state.taskId} is running`);
    }
  }

  const currentById = new Map(input.currentTasks.map((task) => [task.id, task]));
  for (const state of Object.values(input.taskStates)) {
    if (
      (state.status === 'completed' || state.status === 'pending') &&
      !currentById.has(state.taskId)
    ) {
      throw new ApexError({
        code: 'STATE_VALIDATION_FAILED',
        stage: PLAN_STAGE,
        message: `task ${state.taskId} has runtime state but no plan definition`,
      });
    }
  }
  // 权威 completed 与旧 pending 定义都按现行计划顺序取出。
  const completedTasks: PlannedTask[] = [];
  const oldPendingTasks: PlannedTask[] = [];
  for (const task of input.currentTasks) {
    const status = input.taskStates[task.id]?.status;
    if (status === 'completed') {
      completedTasks.push(task);
    } else if (status === 'pending') {
      oldPendingTasks.push(task);
    }
  }

  /**
   * §6.5 steps 1, 3, 7, 8：先在「completed + retained pending + 完整
   * definitions」投影视图上做全部确定性校验，再按旧计划顺序物化完整计划。
   * 这样紧凑草稿不会改变未修改 Task 的相对执行顺序。
   */
  validateTaskPlanDraft(
    input.draft,
    {
      nextPlanRevision,
      completedTasks,
      reusablePendingTasks: oldPendingTasks,
      usedTaskIds: Object.keys(input.taskStates),
      unabsorbedCheckpointOids: input.unabsorbedCheckpoints.map((checkpoint) => checkpoint.oid),
    },
  );

  const completedIds = new Set(completedTasks.map((task) => task.id));
  const candidateTasks = input.draft.tasks
    .filter((entry): entry is PlannedTask => !isRetainedTaskReference(entry))
    .filter((task) => !completedIds.has(task.id));
  const draftById = new Map(candidateTasks.map((task) => [task.id, task]));
  const compactRetainedIds = new Set(
    input.draft.tasks
      .filter(isRetainedTaskReference)
      .map((reference) => reference.id),
  );
  const oldPendingTaskIds = oldPendingTasks.map((task) => task.id);
  const oldPendingIds = new Set(oldPendingTaskIds);

  /**
   * §6.5 steps 4–6：完整定义覆盖旧 pending，retain 引用投射原定义，
   * 两处都未出现的旧 pending 转 skipped；全新 Task 按草稿顺序追加。
   */
  const retainedPendingTaskIds: string[] = [];
  const updatedPendingTaskIds: string[] = [];
  const skippedTaskIds: string[] = [];
  for (const oldTask of oldPendingTasks) {
    const taskId = oldTask.id;
    const draftTask = draftById.get(taskId);
    if (draftTask) {
      retainedPendingTaskIds.push(taskId);
      if (!plannedTaskEquals(draftTask, oldTask)) {
        updatedPendingTaskIds.push(taskId);
      }
    } else if (compactRetainedIds.has(taskId)) {
      retainedPendingTaskIds.push(taskId);
    } else {
      skippedTaskIds.push(taskId);
    }
  }
  const newTasks = candidateTasks.filter((task) => !oldPendingIds.has(task.id));
  const newTaskIds = newTasks.map((task) => task.id);
  const mergedTasks = effectiveTasks(input.draft, completedTasks, oldPendingTasks);

  return {
    planRevision: nextPlanRevision,
    tasks: mergedTasks,
    candidateTasks,
    retainedPendingTaskIds,
    updatedPendingTaskIds,
    newTaskIds,
    skippedTaskIds,
    skipReason: `Omitted by plan revision ${nextPlanRevision}`,
    dispositions: [...input.draft.retainedCheckpointDispositions],
  };
}
