/**
 * Plan Revision 的确定性合并与提交（SPEC §6.5 合并算法 + §11.2 提交顺序）。
 *
 * 输入是已脱敏的 TaskPlanDraft；Domain 的 mergePlanRevision 完成决策步骤
 * 1–8，本用例执行持久化步骤 9–11：组装不可变 Snapshot 与 tasks.json
 * （同一 generatedAt 等重复事实），再由 StateStorePort.commitPlanRevision
 * 按 Snapshot → tasks.json → SHA-256 → run.json（提交点）的顺序落盘。
 */
import { mergePlanRevision, type PlanMergeResult } from '../../domain/plan.js';
import { applyRunEvent } from '../../domain/run-state.js';
import { ApexError } from '../../domain/errors.js';
import { formatRfc3339InSystemTimeZone } from '../../domain/time.js';
import { assertTaskTransition } from '../../domain/task-state.js';
import type { IntermediateCheckpoint } from '../../domain/schemas/intermediate-checkpoint.js';
import type { PlanRevisionSnapshot, PlanRevisionTrigger } from '../../domain/schemas/plan-revision-snapshot.js';
import type { RunJson } from '../../domain/schemas/run-json.js';
import type { TaskPlanDraft } from '../../domain/schemas/task-plan-draft.js';
import type { TaskRuntimeState } from '../../domain/schemas/task-runtime-state.js';
import type { TasksJson } from '../../domain/schemas/tasks-json.js';
import type { CompletedTaskSummary } from '../prompts/planning.js';
import type { UseCaseDeps } from '../usecase-deps.js';

export interface ApplyPlanRevisionInput {
  /** 已脱敏的 Planner 结构化结果。 */
  readonly draft: TaskPlanDraft;
  readonly trigger: PlanRevisionTrigger;
  readonly plannerSessionId: string;
  /** 独立批准该草稿的 Plan Review Session。 */
  readonly planReviewerSessionId: string;
  /** 该 Planning Session 启动前重算的 SPEC SHA。 */
  readonly specSha256: string;
  readonly repositoryRoot: string;
}

/** 未被 completed Task 吸收的中间 Checkpoint：owner 为 null 或 owner 非 completed。 */
export function unabsorbedCheckpoints(run: RunJson): IntermediateCheckpoint[] {
  return run.intermediateCheckpoints.filter((checkpoint) => {
    if (checkpoint.ownerTaskId === null) return true;
    const owner = run.tasks[checkpoint.ownerTaskId];
    return owner === undefined || owner.status !== 'completed';
  });
}

/**
 * completed Task 的权威摘要（定义来自现行计划，结果事实来自 run.json）。
 *
 * Planning 与 Plan Review 提示词共用同一推导，保证「哪些工作已完成」
 * 在两个独立会话中是一致的系统事实，而不是各自重新解释状态。
 */
export function completedTaskSummaries(
  run: RunJson,
  tasks: TasksJson | null,
): CompletedTaskSummary[] {
  if (tasks === null) return [];
  const definitionById = new Map(tasks.tasks.map((task) => [task.id, task]));
  return Object.values(run.tasks)
    .filter((state) => state.status === 'completed')
    .map((state) => ({
      definition: definitionById.get(state.taskId)!,
      resultSummary: state.completedResult!.summary,
      finalCheckpoint: state.finalCheckpoint!,
    }));
}

/**
 * 在启动独立 Plan Review 前执行与最终提交完全相同的确定性合并校验。
 *
 * Reviewer 只处理需要语义判断的任务边界、验证可行性和预算问题；ID、DAG、
 * Revision 与 Checkpoint 归属等确定性错误不得浪费一个模型会话。
 */
export function preparePlanRevisionMerge(
  run: RunJson,
  currentTasks: TasksJson | null,
  draft: TaskPlanDraft,
): PlanMergeResult {
  return mergePlanRevision({
    draft,
    currentPlanRevision: run.planRevision,
    currentTasks: currentTasks?.tasks ?? [],
    taskStates: run.tasks,
    unabsorbedCheckpoints: unabsorbedCheckpoints(run),
  });
}

/**
 * 合并并提交一个 Plan Revision，返回提交后的权威 run（status running，
 * tasksSha256 由 store 计算，提交后通过 readRun 读回）。
 */
export async function applyPlanRevision(
  deps: UseCaseDeps,
  run: RunJson,
  currentTasks: TasksJson | null,
  input: ApplyPlanRevisionInput,
): Promise<RunJson> {
  const merge = preparePlanRevisionMerge(run, currentTasks, input.draft);

  const generatedAt = formatRfc3339InSystemTimeZone(deps.clock.now());

  // §6.5 步骤 4–6：completed 原样；retained pending 原样；被省略的转
  // skipped（保留 executionEpisodes）；新增 Task 建全新 pending 运行态。
  const nextTasks: Record<string, TaskRuntimeState> = {};
  for (const [taskId, state] of Object.entries(run.tasks)) {
    if (state.status === 'pending' && merge.skippedTaskIds.includes(taskId)) {
      assertTaskTransition('pending', 'skipped', 'plan_revision_omitted');
      nextTasks[taskId] = { ...state, status: 'skipped', skipReason: merge.skipReason };
    } else {
      nextTasks[taskId] = state;
    }
  }
  for (const taskId of merge.newTaskIds) {
    nextTasks[taskId] = {
      taskId,
      status: 'pending',
      executionEpisodes: [],
      taskReviewEpisodes: [],
      candidateResult: null,
      candidateCheckpoint: null,
      completedResult: null,
      finalCheckpoint: null,
      skipReason: null,
      failure: null,
    };
  }

  // §6.5 步骤 7：记录所有未吸收中间 Checkpoint 的 disposition（更新 owner）。
  const ownerByOid = new Map(
    merge.dispositions.map((disposition) => [disposition.checkpointOid, disposition.ownerTaskId]),
  );
  const nextCheckpoints = run.intermediateCheckpoints.map((checkpoint) => {
    const ownerTaskId = ownerByOid.get(checkpoint.oid);
    return ownerTaskId === undefined ? checkpoint : { ...checkpoint, ownerTaskId };
  });

  const snapshot: PlanRevisionSnapshot = {
    schemaVersion: 1,
    runId: run.runId,
    planRevision: merge.planRevision,
    parentPlanRevision: run.planRevision === 0 ? null : run.planRevision,
    trigger: input.trigger,
    specPath: run.spec.path,
    specSha256: input.specSha256,
    generatedAt,
    plannerSessionId: input.plannerSessionId,
    planReviewerSessionId: input.planReviewerSessionId,
    summary: input.draft.summary,
    assumptions: [...input.draft.assumptions],
    retainedCheckpointDispositions: merge.dispositions,
    tasks: merge.tasks,
  };
  // tasks.json 与 Snapshot 是同一批计划事实的两个持久化视图（§11.2）。
  const tasks: TasksJson = {
    schemaVersion: 1,
    runId: snapshot.runId,
    planRevision: snapshot.planRevision,
    specPath: snapshot.specPath,
    specSha256: snapshot.specSha256,
    generatedAt: snapshot.generatedAt,
    plannerSessionId: snapshot.plannerSessionId,
    planReviewerSessionId: snapshot.planReviewerSessionId,
    summary: snapshot.summary,
    assumptions: [...snapshot.assumptions],
    retainedCheckpointDispositions: merge.dispositions,
    tasks: merge.tasks,
  };

  const candidateRun: RunJson = {
    ...run,
    status: applyRunEvent(run.status, 'PLAN_ACCEPTED'),
    planRevision: merge.planRevision,
    spec: { ...run.spec, sha256: input.specSha256 },
    tasks: nextTasks,
    intermediateCheckpoints: nextCheckpoints,
    activeSession: null,
    currentTaskId: null,
    planCandidate: null,
    planReviewFeedback: null,
    stateRevision: run.stateRevision + 1,
    updatedAt: generatedAt,
  };
  const { tasksSha256: _omitted, ...runWithoutTasksSha256 } = candidateRun;

  await deps.stateStore.commitPlanRevision({ snapshot, tasks, run: runWithoutTasksSha256 });

  // 提交后读回权威值（tasksSha256 由 store 按 tasks.json 原始字节计算）。
  const committed = await deps.stateStore.readRun();
  if (committed === null) {
    throw new ApexError({
      code: 'STATE_VALIDATION_FAILED',
      stage: 'state',
      message: 'plan revision committed but run.json is missing afterwards',
    });
  }
  return committed;
}
