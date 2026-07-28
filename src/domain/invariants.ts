/**
 * Cross-state invariants (SPEC §6.6) plus the conditional rules of run.json,
 * Task Runtime State, Episodes and Session Records (SPEC §11.3/§11.4).
 *
 * JSON Schemas enforce structure; this module enforces the cross-field
 * conditions the schema language is not used for. Violations throw
 * STATE_VALIDATION_FAILED.
 */
import { ApexError, errorClassForCode, type ErrorCode } from './errors.js';
import { validateExecutionResultSemantics } from './results.js';
import { isTerminalRunStatus } from './run-state.js';
import { validate } from './schemas/index.js';
import type { ActiveSession } from './schemas/active-session.js';
import type { ErrorRecord } from './schemas/error-record.js';
import type { FinalReviewEpisode } from './schemas/final-review-episode.js';
import type { IntermediateCheckpoint } from './schemas/intermediate-checkpoint.js';
import type { RunJson } from './schemas/run-json.js';
import type { SessionRecord } from './schemas/session-record.js';
import type { TaskExecutionEpisode } from './schemas/task-execution-episode.js';
import type { TaskRuntimeState } from './schemas/task-runtime-state.js';
import type { PlannedTask } from './schemas/task-plan-draft.js';

const STATE_STAGE = 'state';

function violation(message: string): ApexError {
  return new ApexError({ code: 'STATE_VALIDATION_FAILED', stage: STATE_STAGE, message });
}

function assertCondition(condition: boolean, message: string): void {
  if (!condition) throw violation(message);
}

/** Error Record: errorClass must be the class derived from errorCode (§15.3). */
export function assertErrorRecordRules(record: ErrorRecord): void {
  assertCondition(
    errorClassForCode(record.errorCode) === record.errorClass,
    `error record ${record.errorCode} declares wrong errorClass ${record.errorClass}`,
  );
}

/**
 * Task Execution Episode rules (§11.3): an un-ended episode has every
 * nullable end field null; an ended episode has end time, end SPEC SHA-256,
 * summary and checkpointReason non-null, with error coupled to the outcome.
 */
export function assertExecutionEpisodeRules(episode: TaskExecutionEpisode): void {
  if (episode.endedAt === null) {
    assertCondition(
      episode.specSha256After === null &&
        episode.outcome === null &&
        episode.summary === null &&
        episode.acceptanceEvidence.length === 0 &&
        episode.finalCheckpoint === null &&
        episode.intermediateCheckpoint === null &&
        episode.checkpointReason === null &&
        episode.error === null,
      `un-ended execution episode ${episode.sessionId} must keep all end fields null`,
    );
    return;
  }
  assertCondition(
    episode.specSha256After !== null &&
      episode.outcome !== null &&
      episode.summary !== null &&
      episode.checkpointReason !== null,
    `ended execution episode ${episode.sessionId} requires specSha256After, outcome, summary and checkpointReason`,
  );
  const needsError = episode.outcome === 'failed' || episode.outcome === 'session_error';
  if (needsError) {
    assertCondition(
      episode.error !== null,
      `execution episode ${episode.sessionId} with outcome ${episode.outcome} requires an error record`,
    );
  } else {
    assertCondition(
      episode.error === null,
      `execution episode ${episode.sessionId} with outcome ${episode.outcome} must have error null`,
    );
  }
  if (episode.error !== null) assertErrorRecordRules(episode.error);
}

/**
 * Final Review Episode rules (§11.3): completed ⇒ role `final-review-final`
 * plus a checkpoint; replan_required/spec_changed ⇒ `final-review-intermediate`
 * with a checkpoint when the repository changed, both null otherwise;
 * session_error ⇒ non-null error record; checkpointReason is always non-null
 * once ended; checkpointRole/checkpoint are always both null or both set.
 */
export function assertFinalReviewEpisodeRules(episode: FinalReviewEpisode): void {
  if (episode.endedAt === null) {
    assertCondition(
      episode.specSha256After === null &&
        episode.decision === null &&
        episode.summary === null &&
        episode.reviewedTaskIds.length === 0 &&
        episode.changedAreas.length === 0 &&
        episode.checkpointRole === null &&
        episode.checkpoint === null &&
        episode.checkpointReason === null &&
        episode.error === null,
      `un-ended final review episode ${episode.sessionId} must keep all end fields null`,
    );
    return;
  }
  assertCondition(
    episode.specSha256After !== null &&
      episode.decision !== null &&
      episode.summary !== null &&
      episode.checkpointReason !== null,
    `ended final review episode ${episode.sessionId} requires specSha256After, decision, summary and checkpointReason`,
  );
  assertCondition(
    (episode.checkpointRole === null) === (episode.checkpoint === null),
    `final review episode ${episode.sessionId} must set checkpointRole and checkpoint together`,
  );
  switch (episode.decision) {
    case 'completed':
      assertCondition(
        episode.checkpointRole === 'final-review-final' && episode.checkpoint !== null,
        `final review episode ${episode.sessionId} completed requires role final-review-final and a checkpoint`,
      );
      assertCondition(
        episode.error === null,
        `final review episode ${episode.sessionId} completed must have error null`,
      );
      break;
    case 'replan_required':
    case 'spec_changed':
      assertCondition(
        episode.checkpointRole === null || episode.checkpointRole === 'final-review-intermediate',
        `final review episode ${episode.sessionId} ${episode.decision} allows only role final-review-intermediate or null`,
      );
      assertCondition(
        episode.error === null,
        `final review episode ${episode.sessionId} ${episode.decision} must have error null`,
      );
      break;
    case 'session_error':
      assertCondition(
        episode.error !== null,
        `final review episode ${episode.sessionId} session_error requires an error record`,
      );
      assertCondition(
        episode.checkpointRole === null || episode.checkpointRole === 'final-review-intermediate',
        `final review episode ${episode.sessionId} session_error allows only role final-review-intermediate or null`,
      );
      break;
    case null:
      break;
  }
  if (episode.error !== null) assertErrorRecordRules(episode.error);
}

/** Task Runtime State conditional null rules (§11.3). */
export function assertTaskRuntimeStateRules(state: TaskRuntimeState): void {
  switch (state.status) {
    case 'pending':
    case 'running':
      assertCondition(
        state.completedResult === null &&
          state.finalCheckpoint === null &&
          state.skipReason === null &&
          state.failure === null,
        `${state.status} task ${state.taskId} must keep completedResult, finalCheckpoint, skipReason and failure null`,
      );
      break;
    case 'completed':
      assertCondition(
        state.completedResult !== null && state.finalCheckpoint !== null,
        `completed task ${state.taskId} requires completedResult and finalCheckpoint`,
      );
      assertCondition(
        state.completedResult?.decision === 'completed',
        `completed task ${state.taskId} requires completedResult decision completed`,
      );
      assertCondition(
        state.skipReason === null && state.failure === null,
        `completed task ${state.taskId} must keep skipReason and failure null`,
      );
      break;
    case 'failed':
      assertCondition(state.failure !== null, `failed task ${state.taskId} requires an error record`);
      assertCondition(
        state.completedResult === null &&
          state.finalCheckpoint === null &&
          state.skipReason === null,
        `failed task ${state.taskId} must keep completedResult, finalCheckpoint and skipReason null`,
      );
      assertErrorRecordRules(state.failure!);
      break;
    case 'skipped':
      assertCondition(
        state.skipReason !== null,
        `skipped task ${state.taskId} requires a skipReason`,
      );
      assertCondition(
        state.completedResult === null &&
          state.finalCheckpoint === null &&
          state.failure === null,
        `skipped task ${state.taskId} must keep completedResult, finalCheckpoint and failure null`,
      );
      break;
  }
  for (const episode of state.executionEpisodes) {
    assertCondition(
      episode.taskId === state.taskId,
      `execution episode ${episode.sessionId} taskId ${episode.taskId} does not match task ${state.taskId}`,
    );
    assertExecutionEpisodeRules(episode);
  }
}

/** Active Session rules (§11.3): only execution carries a taskId. */
export function assertActiveSessionRules(active: ActiveSession): void {
  if (active.type === 'execution') {
    assertCondition(
      active.taskId !== null,
      `active execution session ${active.sessionId} requires a taskId`,
    );
  } else {
    assertCondition(
      active.taskId === null,
      `active ${active.type} session ${active.sessionId} must have taskId null`,
    );
  }
}

/** Intermediate Checkpoint rules (§11.3): taskId coupling with the role. */
export function assertIntermediateCheckpointRules(checkpoint: IntermediateCheckpoint): void {
  if (checkpoint.role === 'task-intermediate') {
    assertCondition(
      checkpoint.taskId !== null,
      `task-intermediate checkpoint ${checkpoint.oid} requires a taskId`,
    );
  } else {
    assertCondition(
      checkpoint.taskId === null,
      `final-review-intermediate checkpoint ${checkpoint.oid} must have taskId null`,
    );
  }
}

/**
 * 必须保存 null 退出码的错误：进程未启动，或 Coordinator 放弃接力而
 * 旧进程退出状态未知。这两类情况不得伪造数字退出码。
 */
const ERROR_CODES_REQUIRING_NULL_EXIT_CODE: readonly ErrorCode[] = [
  'CLAUDE_START_FAILED',
  'RUN_ABANDONED_BY_USER',
];

/**
 * 允许没有数字退出码的错误。除上述两类外，ChildProcess 由信号结束时
 * Node.js 也会返回 null；此时 CLAUDE_EXIT_NONZERO 或 RUN_INTERRUPTED
 * 仍然是已知失败事实，不能伪造整数退出码。
 */
const ERROR_CODES_ALLOWING_NULL_EXIT_CODE: readonly ErrorCode[] = [
  ...ERROR_CODES_REQUIRING_NULL_EXIT_CODE,
  'CLAUDE_EXIT_NONZERO',
  'RUN_INTERRUPTED',
];

/** Session Record rules (§11.4). */
export function assertSessionRecordRules(record: SessionRecord): void {
  if (record.type === 'execution') {
    assertCondition(
      record.taskId !== null,
      `execution session record ${record.sessionId} requires a taskId`,
    );
  } else {
    assertCondition(
      record.taskId === null,
      `${record.type} session record ${record.sessionId} must have taskId null`,
    );
  }
  if (record.status === 'completed') {
    assertCondition(
      record.error === null,
      `completed session record ${record.sessionId} must have error null`,
    );
    assertCondition(
      record.structuredResult !== null,
      `completed session record ${record.sessionId} requires a structuredResult`,
    );
    assertCondition(
      record.exitCode === 0,
      `completed session record ${record.sessionId} requires exitCode 0`,
    );
  } else {
    assertCondition(
      record.error !== null,
      `failed session record ${record.sessionId} requires an error record`,
    );
    assertCondition(
      record.structuredResult === null,
      `failed session record ${record.sessionId} must have structuredResult null`,
    );
    assertErrorRecordRules(record.error!);
    /**
     * 进程未启动或放弃接力时强制为 null；其他失败优先保存真实整数，
     * 但由信号结束时允许 null。该约束忠实表达 Node.js 可观察事实，
     * 不把约定值伪装成工具退出码。
     */
    assertCondition(
      !ERROR_CODES_REQUIRING_NULL_EXIT_CODE.includes(record.error!.errorCode) ||
        record.exitCode === null,
      `failed session record ${record.sessionId} requires exitCode null for ${record.error!.errorCode}`,
    );
    assertCondition(
      record.exitCode !== null ||
        ERROR_CODES_ALLOWING_NULL_EXIT_CODE.includes(record.error!.errorCode),
      `failed session record ${record.sessionId} errorCode ${record.error!.errorCode} does not allow a null exitCode`,
    );
  }
  // The stored structured result must be the one matching the session type.
  if (record.structuredResult !== null) {
    const schemaName =
      record.type === 'planning'
        ? 'TaskPlanDraft'
        : record.type === 'execution'
          ? 'TaskExecutionResult'
          : 'FinalReviewResult';
    assertCondition(
      validate(schemaName, record.structuredResult).valid,
      `session record ${record.sessionId} structuredResult does not match ${schemaName}`,
    );
  }
}

/** run.json conditional rules (§11.3) that need no plan knowledge. */
export function assertRunJsonRules(run: RunJson): void {
  if (run.planRevision === 0) {
    assertCondition(
      run.tasksSha256 === null,
      'planRevision 0 requires tasksSha256 null (initial planning, no revision committed)',
    );
    assertCondition(
      run.status === 'planning' || run.status === 'failed' || run.status === 'abandoned',
      'planRevision 0 is only allowed while initially planning or after that phase terminates',
    );
    assertCondition(
      Object.keys(run.tasks).length === 0,
      'planRevision 0 requires an empty task state map (tasks.json must not exist yet)',
    );
  } else {
    assertCondition(
      run.tasksSha256 !== null,
      'planRevision > 0 requires the tasks.json SHA-256',
    );
  }

  const terminal = isTerminalRunStatus(run.status);
  assertCondition(
    terminal === (run.terminalAt !== null),
    `terminalAt must be non-null exactly for terminal statuses, got status ${run.status}`,
  );
  if (run.status === 'completed') {
    assertCondition(
      run.finalCommit !== null && run.reportPath !== null,
      'completed run requires finalCommit and reportPath',
    );
  }
  if (run.status === 'failed' || run.status === 'abandoned') {
    assertCondition(run.finalCommit === null, `${run.status} run must keep finalCommit null`);
    assertCondition(
      run.activeSession === null && run.currentTaskId === null,
      `${run.status} run must not keep an activeSession or currentTaskId`,
    );
  }

  if (run.activeSession !== null) {
    assertActiveSessionRules(run.activeSession);
    if (run.activeSession.type === 'execution') {
      assertCondition(
        run.currentTaskId !== null && run.currentTaskId === run.activeSession.taskId,
        'execution activeSession must belong to the task referenced by currentTaskId',
      );
    }
  }
  if (run.currentTaskId !== null) {
    const current = run.tasks[run.currentTaskId];
    assertCondition(
      current !== undefined && current.status === 'running',
      `currentTaskId ${run.currentTaskId} must reference a running task`,
    );
  }

  for (const [taskId, state] of Object.entries(run.tasks)) {
    assertCondition(
      state.taskId === taskId,
      `task state keyed ${taskId} carries mismatched taskId ${state.taskId}`,
    );
    assertTaskRuntimeStateRules(state);
  }
  for (const episode of run.finalReviewEpisodes) {
    assertFinalReviewEpisodeRules(episode);
  }
  for (const checkpoint of run.intermediateCheckpoints) {
    assertIntermediateCheckpointRules(checkpoint);
    if (checkpoint.ownerTaskId !== null) {
      assertCondition(
        run.tasks[checkpoint.ownerTaskId] !== undefined,
        `intermediate checkpoint ${checkpoint.oid} owner ${checkpoint.ownerTaskId} is not a known task`,
      );
    }
  }
  if (run.lastError !== null) assertErrorRecordRules(run.lastError);
}

/**
 * 校验进入 Final Review 或 completed 前的共同完成门槛。
 *
 * 两个状态都要求当前 Revision 的任务全部完成，且所有中间 Checkpoint
 * 已由 completed Task 吸收；集中实现可防止两个终段状态的规则逐渐漂移。
 */
function assertCompletionPrerequisites(
  run: RunJson,
  currentPlan: { readonly tasks: readonly PlannedTask[] } | null,
  targetStatus: 'final_review' | 'completed',
): string[] {
  assertCondition(
    currentPlan !== null,
    `${targetStatus} invariants require the current plan task list`,
  );
  const taskIds = currentPlan!.tasks.map((task) => task.id);
  for (const taskId of taskIds) {
    assertCondition(
      run.tasks[taskId]?.status === 'completed',
      `${targetStatus} requires plan task ${taskId} completed`,
    );
  }
  for (const checkpoint of run.intermediateCheckpoints) {
    const owner = checkpoint.ownerTaskId !== null ? run.tasks[checkpoint.ownerTaskId] : undefined;
    assertCondition(
      owner !== undefined && owner.status === 'completed',
      `${targetStatus} requires intermediate checkpoint ${checkpoint.oid} owned by a completed task`,
    );
  }
  return taskIds;
}

/**
 * Cross-state invariants (SPEC §6.6). `currentPlan` is the task list of the
 * committed plan revision; it must be provided whenever planRevision > 0.
 */
export function assertRunInvariants(
  run: RunJson,
  currentPlan: { readonly tasks: readonly PlannedTask[] } | null,
): void {
  assertRunJsonRules(run);

  /**
   * 已提交计划与运行态 Map 是同一组任务事实的两个视图。
   *
   * 当前计划中的任务必须全部有运行态；被新 Revision 移出的历史任务只能
   * 以 skipped 留存，避免旧任务继续参与调度或完成态判断。
   */
  if (run.planRevision > 0) {
    assertCondition(currentPlan !== null, 'committed plan invariants require the current plan');
    const currentTaskById = new Map(currentPlan!.tasks.map((task) => [task.id, task]));
    for (const task of currentPlan!.tasks) {
      const state = run.tasks[task.id];
      assertCondition(state !== undefined, `current plan task ${task.id} has no runtime state`);
      assertCondition(
        state?.status !== 'skipped',
        `current plan task ${task.id} must not have skipped runtime state`,
      );
      if (state?.status === 'completed' && state.completedResult !== null) {
        try {
          validateExecutionResultSemantics(state.completedResult, task);
        } catch (error) {
          const detail = error instanceof Error ? `: ${error.message}` : '';
          throw violation(
            `completed task ${task.id} result does not satisfy its planned acceptance criteria${detail}`,
          );
        }
      }
    }
    for (const state of Object.values(run.tasks)) {
      assertCondition(
        currentTaskById.has(state.taskId) || state.status === 'skipped',
        `runtime task ${state.taskId} is outside the current plan but is not skipped`,
      );
    }
  }

  const runningTaskIds = Object.values(run.tasks)
    .filter((state) => state.status === 'running')
    .map((state) => state.taskId);

  if (run.status === 'planning') {
    assertCondition(runningTaskIds.length === 0, 'planning run must not have a running task');
  }
  if (run.status === 'running') {
    assertCondition(
      runningTaskIds.length <= 1,
      `running run has ${runningTaskIds.length} running tasks, at most one is allowed`,
    );
    // Every intermediate checkpoint not yet absorbed by a completed task must
    // be adopted by a pending task or by the currently running task.
    for (const checkpoint of run.intermediateCheckpoints) {
      const owner = checkpoint.ownerTaskId !== null ? run.tasks[checkpoint.ownerTaskId] : undefined;
      const absorbed = owner !== undefined && owner.status === 'completed';
      if (absorbed) continue;
      const adoptedByPending = owner !== undefined && owner.status === 'pending';
      const adoptedByRunning =
        owner !== undefined && owner.status === 'running' && owner.taskId === run.currentTaskId;
      assertCondition(
        adoptedByPending || adoptedByRunning,
        `intermediate checkpoint ${checkpoint.oid} is not adopted by a pending or the running task`,
      );
    }
  }
  if (run.status === 'final_review') {
    assertCompletionPrerequisites(run, currentPlan, 'final_review');
  }
  if (run.status === 'completed') {
    assertCondition(
      run.activeSession === null && run.currentTaskId === null,
      'completed run must not keep an activeSession or currentTaskId',
    );
    const completedTaskIds = assertCompletionPrerequisites(run, currentPlan, 'completed');

    /**
     * Run 完成必须由最后一次 Final Review 的完成结论封口。
     *
     * reviewedTaskIds 按集合精确覆盖当前 Revision，防止缺审、重复审或把
     * 历史任务混入最终完成证据。
     */
    const finalReview = run.finalReviewEpisodes.at(-1);
    assertCondition(
      finalReview !== undefined && finalReview.decision === 'completed',
      'completed run requires the last final review episode to be completed',
    );
    const reviewedTaskIds = finalReview?.reviewedTaskIds ?? [];
    const reviewedSet = new Set(reviewedTaskIds);
    assertCondition(
      reviewedSet.size === reviewedTaskIds.length,
      'completed run final review contains duplicate reviewedTaskIds',
    );
    assertCondition(
      reviewedSet.size === completedTaskIds.length &&
        completedTaskIds.every((taskId) => reviewedSet.has(taskId)),
      'completed run final review must cover exactly the current plan tasks',
    );
  }
  if (run.status === 'failed' || run.status === 'abandoned') {
    assertCondition(
      runningTaskIds.length === 0,
      `${run.status} run must not have a running task`,
    );
  }
}
