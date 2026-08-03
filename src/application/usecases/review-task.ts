/**
 * 独立 Task Review 用例。
 *
 * Execution 只负责产生 candidateResult/candidateCheckpoint；本用例总是启动
 * 一个新的 task_review Session，从持久化事实独立复核，批准后才允许 Task
 * 转 completed。Reviewer 被 Git 快照约束为严格只读。
 */
import { closeTaskReviewEpisode } from '../../domain/episodes.js';
import { ApexError } from '../../domain/errors.js';
import {
  isTaskReviewResultInvalid,
  normalizeTaskReviewResult,
  validateTaskReviewResultSemantics,
} from '../../domain/results.js';
import { applyRunEvent } from '../../domain/run-state.js';
import type { PlanRevisionTrigger } from '../../domain/schemas/plan-revision-snapshot.js';
import type { RunJson } from '../../domain/schemas/run-json.js';
import type { TaskReviewResult } from '../../domain/schemas/task-review-result.js';
import type { TaskReviewEpisode } from '../../domain/schemas/task-review-episode.js';
import { assertTaskTransition, selectTaskAwaitingReview } from '../../domain/task-state.js';
import { formatRfc3339InSystemTimeZone } from '../../domain/time.js';
import {
  buildTaskReviewPrompt,
  buildTaskReviewRepairPrompt,
  buildTaskReviewResumePrompt,
} from '../prompts/task-review.js';
import type { UseCaseDeps } from '../usecase-deps.js';
import {
  ensureFailedSessionRecord,
  sessionGitFacts,
  writeCompletedSessionRecord,
  type ActiveSessionHandle,
} from './claude-session.js';
import { toErrorRecord } from './error-record.js';
import { invokeResumableSession } from './resumable-session.js';
import { persistRunBestEffort, toTerminalFailedRun } from './run-transitions.js';

export type ReviewTaskResult =
  | { readonly kind: 'task-completed'; readonly run: RunJson; readonly taskId: string }
  | { readonly kind: 'changes-required'; readonly run: RunJson; readonly taskId: string }
  | {
      readonly kind: 'replan-needed';
      readonly run: RunJson;
      readonly trigger: PlanRevisionTrigger;
    }
  | { readonly kind: 'failed'; readonly run: RunJson };

export interface ReviewTaskOptions {
  /** 仅用于恢复被中断的 Reviewer 自身上下文，绝不指向 Execution Session。 */
  readonly resumeFromSessionId?: string;
}

/**
 * 复核结果修复会话的有界次数（与 Execution 结果修复同一语义）：进程正常
 * 结束但 TaskReviewResult 未过契约校验时接力一次；连续两次不合法说明
 * 结果通道系统性失配，按原路径转 failed。
 */
const MAX_RESULT_REPAIR_ATTEMPTS = 1;

/**
 * 同一 Task 连续被独立复核打回的上限：达到上限说明 Execution 与
 * Reviewer 在当前计划边界内无法收敛，按
 * TASK_REVIEW_REWORK_LIMIT_EXCEEDED 终止 Run，避免无界返工循环。
 */
const MAX_CONSECUTIVE_CHANGES_REQUIRED = 3;

/** 末尾连续 changes_required Episode 数：返工循环是否收敛的度量。 */
function countTrailingChangesRequired(episodes: readonly TaskReviewEpisode[]): number {
  let count = 0;
  for (let index = episodes.length - 1; index >= 0; index -= 1) {
    if (episodes[index]!.outcome !== 'changes_required') break;
    count += 1;
  }
  return count;
}

export function createReviewTask(deps: UseCaseDeps): {
  execute(options?: ReviewTaskOptions): Promise<ReviewTaskResult>;
} {
  const now = (): string => formatRfc3339InSystemTimeZone(deps.clock.now());

  async function failTerminal(run: RunJson, error: ApexError): Promise<ReviewTaskResult> {
    deps.logger.log('error', 'task_review.run_failed', {
      errorCode: error.errorCode,
      stage: error.stage,
      message: error.message,
    });
    const terminal = toTerminalFailedRun(run, error, now(), deps.redaction);
    await persistRunBestEffort(deps, terminal);
    return { kind: 'failed', run: terminal };
  }

  /**
   * 关闭 Reviewer Episode 并把当前 Task 转 failed。
   *
   * 候选字段必须一并清空，避免 failed Task 仍携带可被误认为待批准的结果；
   * Execution Episode 已保留候选 Checkpoint，可供失败报告审计。
   */
  async function failWithSession(
    handle: ActiveSessionHandle<'task_review'>,
    error: ApexError,
  ): Promise<ReviewTaskResult> {
    await ensureFailedSessionRecord(deps, handle, error);
    const taskId = handle.taskId!;
    const task = handle.run.tasks[taskId]!;
    const taskReviewEpisodes = closeTaskReviewEpisode(
      task.taskReviewEpisodes,
      handle.sessionId,
      {
        specSha256After: handle.specSha256,
        endedAt: now(),
        outcome: 'session_error',
        summary: deps.redaction.redactText(error.message) || error.errorCode,
        tests: [],
        acceptanceEvidence: [],
        issues: [],
        error: toErrorRecord(error, now(), deps.redaction),
      },
    );
    assertTaskTransition(
      task.status,
      'failed',
      error.errorCode === 'RUN_INTERRUPTED' ? 'run_interrupted' :
        error.errorCode === 'TASK_REVIEW_RESULT_INVALID' ? 'result_invalid' :
          'claude_call_failed',
    );
    const preserveCandidate = error.errorCode === 'RUN_INTERRUPTED';
    const next: RunJson = {
      ...handle.run,
      tasks: {
        ...handle.run.tasks,
        [taskId]: {
          ...task,
          status: 'failed',
          taskReviewEpisodes,
          candidateResult: preserveCandidate ? task.candidateResult : null,
          candidateCheckpoint: preserveCandidate ? task.candidateCheckpoint : null,
          failure: toErrorRecord(error, now(), deps.redaction),
        },
      },
    };
    return failTerminal(next, error);
  }

  /**
   * 候选 Checkpoint 被打回或触发重规划后成为中间事实。
   *
   * 同一 OID 可能来自“无新增改动”的再次执行；此时更新归属而不追加重复
   * 记录，保证后续 Planning 看到唯一、可推导的 Checkpoint。
   */
  function retainCandidateCheckpoint(
    run: RunJson,
    taskId: string,
    executionSessionId: string,
    checkpoint: string,
    summary: string,
    ownerTaskId: string | null,
  ): RunJson['intermediateCheckpoints'] {
    const existing = run.intermediateCheckpoints.findIndex((item) => item.oid === checkpoint);
    if (existing >= 0) {
      return run.intermediateCheckpoints.map((item, index) =>
        index === existing ? { ...item, summary, ownerTaskId } : item,
      );
    }
    return [
      ...run.intermediateCheckpoints,
      {
        oid: checkpoint,
        role: 'task-intermediate',
        sourceSessionId: executionSessionId,
        taskId,
        planRevision: run.planRevision,
        summary,
        ownerTaskId,
      },
    ];
  }

  function closeEpisode(
    run: RunJson,
    taskId: string,
    sessionId: string,
    outcome: 'approved' | 'changes_required' | 'replan_required' | 'spec_changed',
    result: TaskReviewResult,
    specSha256After: string,
  ): RunJson {
    const task = run.tasks[taskId]!;
    return {
      ...run,
      tasks: {
        ...run.tasks,
        [taskId]: {
          ...task,
          taskReviewEpisodes: closeTaskReviewEpisode(task.taskReviewEpisodes, sessionId, {
            specSha256After,
            endedAt: now(),
            outcome,
            summary: deps.redaction.redactText(result.summary) || outcome,
            tests: deps.redaction.redactStructured(result.tests),
            acceptanceEvidence: deps.redaction.redactStructured(result.acceptanceEvidence),
            issues: deps.redaction.redactStructured(result.issues),
            error: null,
          }),
        },
      },
    };
  }

  async function execute(options?: ReviewTaskOptions): Promise<ReviewTaskResult> {
    const run = await deps.stateStore.readRun();
    if (run === null || run.status !== 'running') {
      throw new ApexError({
        code: 'STATE_VALIDATION_FAILED',
        stage: 'task_review',
        message: `ReviewTask requires a running run, got ${run?.status ?? 'none'}`,
      });
    }
    const taskId = selectTaskAwaitingReview(run.tasks);
    if (taskId === null || run.currentTaskId !== taskId) {
      throw new ApexError({
        code: 'STATE_VALIDATION_FAILED',
        stage: 'task_review',
        message: 'ReviewTask requires exactly one current Task with a persisted candidate',
      });
    }
    const tasks = await deps.stateStore.readTasks();
    const taskDef = tasks?.tasks.find((task) => task.id === taskId);
    const task = run.tasks[taskId]!;
    const executionEpisode = task.executionEpisodes.at(-1);
    if (
      tasks === null ||
      taskDef === undefined ||
      task.candidateResult === null ||
      task.candidateCheckpoint === null ||
      executionEpisode === undefined ||
      executionEpisode.outcome !== 'awaiting_review'
    ) {
      throw new ApexError({
        code: 'STATE_VALIDATION_FAILED',
        stage: 'task_review',
        message: `Task ${taskId} has an incomplete review candidate`,
      });
    }
    const root = run.repository.root;
    const specBefore = await deps.git.readSpecFact(root, run.spec.path);
    if (specBefore.sha256 !== run.spec.sha256) {
      const pendingTask = {
        ...task,
        status: 'pending' as const,
        candidateResult: null,
        candidateCheckpoint: null,
      };
      assertTaskTransition(task.status, 'pending', 'spec_changed');
      const next: RunJson = {
        ...run,
        status: applyRunEvent(run.status, 'SPEC_CHANGED'),
        currentTaskId: null,
        tasks: { ...run.tasks, [taskId]: pendingTask },
        intermediateCheckpoints: retainCandidateCheckpoint(
          run,
          taskId,
          executionEpisode.sessionId,
          task.candidateCheckpoint,
          `SPEC changed before independent review of ${taskId}`,
          null,
        ),
        stateRevision: run.stateRevision + 1,
        updatedAt: now(),
      };
      await deps.stateStore.writeRun(next);
      return {
        kind: 'replan-needed',
        run: next,
        trigger: {
          type: 'spec_changed',
          reason: `SPEC changed before independent review of ${taskId}`,
          sourceSessionId: null,
        },
      };
    }

    let startFact;
    try {
      startFact = await deps.git.assertSessionStart(root, sessionGitFacts(run), {
        readOnlySessionType: 'task_review',
      });
    } catch (error) {
      return failTerminal(run, error as ApexError);
    }

    const prompt = buildTaskReviewPrompt({
      repositoryRoot: root,
      runBranch: run.repository.runBranch,
      specPath: run.spec.path,
      specSha256: specBefore.sha256,
      planRevision: run.planRevision,
      task: taskDef,
      candidateCheckpoint: task.candidateCheckpoint,
    });
    /**
     * 接力收尾（结果修复 / resume 回退共用）：关闭当前复核 Episode 为
     * session_error；候选保留在 Task 上，接力会话接管 activeSession 后
     * 追加新 Episode。
     */
    const closeEpisodeForRelay = (
      handle: ActiveSessionHandle<'task_review'>,
      error: ApexError,
    ): RunJson => {
      const relayTask = handle.run.tasks[taskId]!;
      return {
        ...handle.run,
        activeSession: null,
        tasks: {
          ...handle.run.tasks,
          [taskId]: {
            ...relayTask,
            taskReviewEpisodes: closeTaskReviewEpisode(
              relayTask.taskReviewEpisodes,
              handle.sessionId,
              {
                specSha256After: handle.specSha256,
                endedAt: now(),
                outcome: 'session_error',
                summary: deps.redaction.redactText(error.message) || error.errorCode,
                tests: [],
                acceptanceEvidence: [],
                issues: [],
                error: toErrorRecord(error, now(), deps.redaction),
              },
            ),
          },
        },
      };
    };

    /** 修复接力行：让前台看到复核结果为何被拒以及修复会话的启动。 */
    const progressResultRepair = (
      handle: ActiveSessionHandle<'task_review'>,
      error: ApexError,
      attempt: number,
    ): void => {
      deps.output.writeLine(
        deps.redaction.redactText(
          `↻ 复核结果校验失败 · 会话 ${handle.sessionId.slice(0, 8)} · ` +
            `正在启动修复会话 ${attempt}/${MAX_RESULT_REPAIR_ATTEMPTS} · ${error.message}`,
        ),
      );
      deps.logger.log('warn', 'task_review.result_repair', {
        sessionId: handle.sessionId,
        taskId,
        attempt,
        message: error.message,
      });
    };

    /** 修复会话提示词：附校验错误与（可解析时的）非法结果原文。 */
    const buildRepairPrompt = (error: ApexError, result: TaskReviewResult | null): string =>
      buildTaskReviewRepairPrompt({
        repositoryRoot: root,
        runBranch: run.repository.runBranch,
        task: taskDef,
        candidateCheckpoint: task.candidateCheckpoint!,
        validationError: error.message,
        invalidResultJson: result === null ? null : JSON.stringify(result, null, 2),
      });

    /**
     * 单趟复核 + 领域语义门禁；结果契约失败时以有界修复会话接力（与
     * Execution 结果修复同一形态）。鉴权、网络、额度、普通非零退出和
     * 流失败都不自动重试；resume hint 仅首趟生效。
     */
    let sessionRun = run;
    let sessionPrompt = prompt;
    let repairAttempt = 0;
    let handle: ActiveSessionHandle<'task_review'>;
    let result: TaskReviewResult;
    let specAfter;
    for (;;) {
      const invocation = await invokeResumableSession(deps, {
        run: sessionRun,
        session: {
          type: 'task_review',
          taskId,
          planRevision: run.planRevision,
          specSha256: specBefore.sha256,
          permissionMode: 'auto',
          repositoryRoot: root,
        },
        freshPrompt: sessionPrompt,
        resume:
          repairAttempt === 0 && options?.resumeFromSessionId !== undefined
            ? {
                sessionId: options.resumeFromSessionId,
                prompt: buildTaskReviewResumePrompt(),
              }
            : null,
        closeResumeAttempt: (relayHandle, error) => closeEpisodeForRelay(relayHandle, error),
      });
      if (invocation.kind === 'failed') {
        const { handle: failedHandle, error: apex } = invocation;
        if (isTaskReviewResultInvalid(apex) && repairAttempt < MAX_RESULT_REPAIR_ATTEMPTS) {
          // 结构 Schema 未过：补失败 Record、关 Episode，接力结果修复会话。
          await ensureFailedSessionRecord(deps, failedHandle, apex);
          repairAttempt += 1;
          sessionRun = closeEpisodeForRelay(failedHandle, apex);
          sessionPrompt = buildRepairPrompt(apex, null);
          progressResultRepair(failedHandle, apex, repairAttempt);
          continue;
        }
        return failWithSession(failedHandle, apex);
      }
      const { handle: completedHandle, fact } = invocation;
      let sessionSpecAfter;
      try {
        await writeCompletedSessionRecord(deps, completedHandle, fact);
        sessionSpecAfter = await deps.git.readSpecFact(root, run.spec.path);
        await deps.git.assertSessionEnd(root, sessionGitFacts(run), startFact);
      } catch (error) {
        return failWithSession(completedHandle, error as ApexError);
      }

      const rawResult = fact.structuredResult;
      const normalized = normalizeTaskReviewResult(rawResult);
      try {
        validateTaskReviewResultSemantics(normalized, taskDef);
      } catch (error) {
        const apex = error as ApexError;
        if (repairAttempt < MAX_RESULT_REPAIR_ATTEMPTS) {
          repairAttempt += 1;
          sessionRun = closeEpisodeForRelay(completedHandle, apex);
          sessionPrompt = buildRepairPrompt(apex, normalized);
          progressResultRepair(completedHandle, apex, repairAttempt);
          continue;
        }
        return failWithSession(completedHandle, apex);
      }
      handle = completedHandle;
      result = normalized;
      specAfter = sessionSpecAfter;
      break;
    }

    if (specAfter.sha256 !== specBefore.sha256) {
      let next = closeEpisode(
        handle.run,
        taskId,
        handle.sessionId,
        'spec_changed',
        result,
        specAfter.sha256,
      );
      const nextTask = next.tasks[taskId]!;
      assertTaskTransition(nextTask.status, 'pending', 'spec_changed');
      next = {
        ...next,
        status: applyRunEvent(next.status, 'SPEC_CHANGED'),
        currentTaskId: null,
        activeSession: null,
        tasks: {
          ...next.tasks,
          [taskId]: {
            ...nextTask,
            status: 'pending',
            candidateResult: null,
            candidateCheckpoint: null,
          },
        },
        intermediateCheckpoints: retainCandidateCheckpoint(
          next,
          taskId,
          executionEpisode.sessionId,
          task.candidateCheckpoint,
          `SPEC changed during independent review of ${taskId}`,
          null,
        ),
        stateRevision: next.stateRevision + 1,
        updatedAt: now(),
      };
      await deps.stateStore.writeRun(next);
      return {
        kind: 'replan-needed',
        run: next,
        trigger: {
          type: 'spec_changed',
          reason: `SPEC changed during independent review of ${taskId}`,
          sourceSessionId: handle.sessionId,
        },
      };
    }

    if (result.decision === 'approved') {
      let next = closeEpisode(
        handle.run,
        taskId,
        handle.sessionId,
        'approved',
        result,
        specAfter.sha256,
      );
      const approvedTask = next.tasks[taskId]!;
      assertTaskTransition(approvedTask.status, 'completed', 'review_approved');
      next = {
        ...next,
        currentTaskId: null,
        activeSession: null,
        tasks: {
          ...next.tasks,
          [taskId]: {
            ...approvedTask,
            status: 'completed',
            candidateResult: null,
            candidateCheckpoint: null,
            completedResult: task.candidateResult,
            finalCheckpoint: task.candidateCheckpoint,
          },
        },
        stateRevision: next.stateRevision + 1,
        updatedAt: now(),
      };
      await deps.stateStore.writeRun(next);
      return { kind: 'task-completed', run: next, taskId };
    }

    if (result.decision === 'changes_required') {
      let next = closeEpisode(
        handle.run,
        taskId,
        handle.sessionId,
        'changes_required',
        result,
        specAfter.sha256,
      );
      const rejectedTask = next.tasks[taskId]!;
      /**
       * 连续打回上限：Execution 与 Reviewer 无法在当前计划边界内收敛时
       * 终止 Run（最后一次打回 Episode 已照常关闭），候选 Checkpoint 作为
       * 中间事实保留供报告审计，避免无界返工循环。
       */
      const consecutiveRejections = countTrailingChangesRequired(
        rejectedTask.taskReviewEpisodes,
      );
      if (consecutiveRejections >= MAX_CONSECUTIVE_CHANGES_REQUIRED) {
        const exhausted = new ApexError({
          code: 'TASK_REVIEW_REWORK_LIMIT_EXCEEDED',
          stage: 'task_review',
          message:
            `independent review requested changes ${consecutiveRejections} times in a row ` +
            `for ${taskId}; the rework loop is not converging`,
          taskId,
        });
        assertTaskTransition(rejectedTask.status, 'failed', 'reported_failure');
        const failedNext: RunJson = {
          ...next,
          currentTaskId: null,
          activeSession: null,
          tasks: {
            ...next.tasks,
            [taskId]: {
              ...rejectedTask,
              status: 'failed',
              candidateResult: null,
              candidateCheckpoint: null,
              failure: toErrorRecord(exhausted, now(), deps.redaction),
            },
          },
          intermediateCheckpoints: retainCandidateCheckpoint(
            next,
            taskId,
            executionEpisode.sessionId,
            task.candidateCheckpoint!,
            `Independent review rework limit exhausted for ${taskId}`,
            null,
          ),
        };
        return failTerminal(failedNext, exhausted);
      }
      assertTaskTransition(rejectedTask.status, 'pending', 'review_changes_required');
      next = {
        ...next,
        currentTaskId: null,
        activeSession: null,
        tasks: {
          ...next.tasks,
          [taskId]: {
            ...rejectedTask,
            status: 'pending',
            candidateResult: null,
            candidateCheckpoint: null,
          },
        },
        intermediateCheckpoints: retainCandidateCheckpoint(
          next,
          taskId,
          executionEpisode.sessionId,
          task.candidateCheckpoint,
          `Independent review requested changes for ${taskId}`,
          taskId,
        ),
        stateRevision: next.stateRevision + 1,
        updatedAt: now(),
      };
      await deps.stateStore.writeRun(next);
      return { kind: 'changes-required', run: next, taskId };
    }

    let next = closeEpisode(
      handle.run,
      taskId,
      handle.sessionId,
      'replan_required',
      result,
      specAfter.sha256,
    );
    const replanningTask = next.tasks[taskId]!;
    assertTaskTransition(replanningTask.status, 'pending', 'replan_required');
    next = {
      ...next,
      status: applyRunEvent(next.status, 'REPLAN_REQUESTED'),
      currentTaskId: null,
      activeSession: null,
      tasks: {
        ...next.tasks,
        [taskId]: {
          ...replanningTask,
          status: 'pending',
          candidateResult: null,
          candidateCheckpoint: null,
        },
      },
      intermediateCheckpoints: retainCandidateCheckpoint(
        next,
        taskId,
        executionEpisode.sessionId,
        task.candidateCheckpoint,
        `Independent review requires replan for ${taskId}`,
        null,
      ),
      stateRevision: next.stateRevision + 1,
      updatedAt: now(),
    };
    await deps.stateStore.writeRun(next);
    return {
      kind: 'replan-needed',
      run: next,
      trigger: {
        type: 'task_review_replan',
        reason: result.replanReason!,
        sourceSessionId: handle.sessionId,
      },
    };
  }

  return { execute };
}
