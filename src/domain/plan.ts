/**
 * TaskPlanDraft semantic validation (SPEC §7.5) and the deterministic Plan
 * Revision merge algorithm (SPEC §6.5).
 *
 * Error-code policy:
 * - `PLAN_INVALID` — problems internal to the draft itself;
 * - `PLAN_REVISION_CONFLICT` — conflicts between the draft and current Run
 *   state (running task present, completed task rewritten, ID reuse,
 *   checkpoint disposition problems);
 * - `PLAN_REVISION_LIMIT_EXCEEDED` — a 51st revision is requested.
 *
 * Invalid drafts are rejected as-is: no structural repair, no field removal,
 * no dependency guessing, no reordering (SPEC §7.5).
 */
import { ApexError } from './errors.js';
import { isTaskId, taskIdNumber } from './ids.js';
import type { IntermediateCheckpoint } from './schemas/intermediate-checkpoint.js';
import {
  TASK_HARD_CONTEXT_TOKENS,
  type CheckpointDisposition,
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
function assertTaskExecutionContract(task: PlannedTask): void {
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
  for (let index = 0; index < task.acceptanceCriteria.length; index += 1) {
    if (!coveredCriteria.has(index)) {
      throw planInvalid(
        `task ${task.id} acceptance criterion ${index} has no verification step`,
      );
    }
  }
  if (task.budget.targetContextBudget >= task.budget.hardContextLimit) {
    throw planInvalid(
      `task ${task.id} target context budget must stay below its hard context limit`,
    );
  }
}

export interface PlanDraftValidationContext {
  /** Revision number this draft would become (1 for the initial plan). */
  readonly nextPlanRevision: number;
  /** Definitions of completed tasks; must reappear verbatim in the draft. */
  readonly completedTasks: readonly PlannedTask[];
  /** Old pending task IDs; drafts may keep these IDs with modified definitions. */
  readonly reusablePendingTaskIds: readonly string[];
  /** Every task ID ever used in this Run (pending/running/completed/failed/skipped). */
  readonly usedTaskIds: readonly string[];
  /** OIDs of intermediate checkpoints not yet absorbed by a completed task. */
  readonly unabsorbedCheckpointOids: readonly string[];
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
 * Deterministic TaskPlanDraft validation (SPEC §7.5). Assumes the draft
 * already passed the TaskPlanDraft schema. Throws ApexError on the first
 * violated rule.
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
  if (draft.tasks.length === 0) {
    throw planInvalid('plan must contain at least one task');
  }

  const completedIds = new Set(context.completedTasks.map((task) => task.id));
  const reusablePendingIds = new Set(context.reusablePendingTaskIds);
  const usedIds = new Set(context.usedTaskIds);

  const pendingCount = draft.tasks.filter((task) => !completedIds.has(task.id)).length;
  if (pendingCount > MAX_PENDING_TASKS) {
    throw planInvalid(`plan has ${pendingCount} pending tasks, limit is ${MAX_PENDING_TASKS}`);
  }

  for (const task of draft.tasks) {
    if (!isTaskId(task.id)) {
      throw planInvalid(`invalid task ID format: ${task.id}`);
    }
    const numeric = taskIdNumber(task.id);
    if (numeric === null || numeric > MAX_TASK_ID_NUMBER) {
      throw planInvalid(`task ID number out of range: ${task.id}`);
    }
    assertTaskExecutionContract(task);
  }

  assertGraphShape(draft.tasks);

  // Completed task protection: every completed definition must reappear verbatim.
  const draftById = new Map(draft.tasks.map((task) => [task.id, task]));
  for (const completedTask of context.completedTasks) {
    const draftTask = draftById.get(completedTask.id);
    if (!draftTask) {
      throw planConflict(`completed task ${completedTask.id} is missing from the new plan`);
    }
    if (!plannedTaskEquals(draftTask, completedTask)) {
      throw planConflict(`completed task ${completedTask.id} was modified by the new plan`);
    }
  }

  // Task ID permanence: reused IDs must be completed or old pending; anything
  // else must be brand-new (skipped IDs are never reusable).
  for (const task of draft.tasks) {
    if (completedIds.has(task.id) || reusablePendingIds.has(task.id)) continue;
    if (usedIds.has(task.id)) {
      throw planConflict(`task ID ${task.id} has already been used in this Run`);
    }
    /**
     * 全新任务必须使用当前预算政策值。原样保留的 completed/pending Task
     * 允许携带历史政策值（如 2.0.25 前的 hardContextLimit 300000）——
     * 若对它们也强制当前值，会与「completed 定义必须原样重现」形成死锁，
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
  /** Full task list of the new plan (the draft's tasks). */
  readonly tasks: PlannedTask[];
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
  const completedTasks: PlannedTask[] = [];
  const oldPendingTaskIds: string[] = [];
  for (const state of Object.values(input.taskStates)) {
    if (state.status === 'completed' || state.status === 'pending') {
      const definition = currentById.get(state.taskId);
      if (!definition) {
        throw new ApexError({
          code: 'STATE_VALIDATION_FAILED',
          stage: PLAN_STAGE,
          message: `task ${state.taskId} has runtime state but no plan definition`,
        });
      }
      if (state.status === 'completed') {
        completedTasks.push(definition);
      } else {
        oldPendingTaskIds.push(state.taskId);
      }
    }
  }

  // §6.5 steps 1, 3, 7, 8: schema/ID/dependency/cycle + completed protection +
  // disposition validation + reuse rejection.
  validateTaskPlanDraft(input.draft, {
    nextPlanRevision,
    completedTasks,
    reusablePendingTaskIds: oldPendingTaskIds,
    usedTaskIds: Object.keys(input.taskStates),
    unabsorbedCheckpointOids: input.unabsorbedCheckpoints.map((checkpoint) => checkpoint.oid),
  });

  // §6.5 steps 4–6: classify old pending and new tasks.
  const draftById = new Map(input.draft.tasks.map((task) => [task.id, task]));
  const completedIds = new Set(completedTasks.map((task) => task.id));
  const retainedPendingTaskIds: string[] = [];
  const updatedPendingTaskIds: string[] = [];
  const skippedTaskIds: string[] = [];
  for (const taskId of oldPendingTaskIds) {
    const draftTask = draftById.get(taskId);
    if (draftTask) {
      retainedPendingTaskIds.push(taskId);
      const oldDefinition = currentById.get(taskId)!;
      if (!plannedTaskEquals(draftTask, oldDefinition)) {
        updatedPendingTaskIds.push(taskId);
      }
    } else {
      skippedTaskIds.push(taskId);
    }
  }
  const oldPendingIds = new Set(oldPendingTaskIds);
  const newTaskIds = input.draft.tasks
    .filter((task) => !completedIds.has(task.id) && !oldPendingIds.has(task.id))
    .map((task) => task.id);

  return {
    planRevision: nextPlanRevision,
    tasks: [...input.draft.tasks],
    retainedPendingTaskIds,
    updatedPendingTaskIds,
    newTaskIds,
    skippedTaskIds,
    skipReason: `Omitted by plan revision ${nextPlanRevision}`,
    dispositions: [...input.draft.retainedCheckpointDispositions],
  };
}
