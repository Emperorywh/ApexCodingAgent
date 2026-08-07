/**
 * Run 状态迁移与尽力持久化的共享原语（SPEC §6.3 Session 收尾、§15 错误模型）。
 *
 * 这里集中所有用例共用的失败收尾形态：终态 failed Run 的组装、写入失败时
 * 只输出诊断的 state_error 语义（§15.3：状态无法写入时仅输出诊断），以及
 * 未结束 Episode 的 session_error 关闭。纯函数不读时钟、不读环境。
 */
import { applyRunEvent, isTerminalRunStatus } from '../../domain/run-state.js';
import {
  closeExecutionEpisode,
  closeFinalReviewEpisode,
  closeTaskReviewEpisode,
} from '../../domain/episodes.js';
import { isResumableErrorCode, type ApexError } from '../../domain/errors.js';
import type { RunJson } from '../../domain/schemas/run-json.js';
import type { RedactionPort } from '../ports/redaction.js';
import type { UseCaseDeps } from '../usecase-deps.js';
import { toErrorRecord } from './error-record.js';

/** 脱敏后仍保证非空的 Episode summary（ErrorRecord.message 要求非空）。 */
function redactedSummary(error: ApexError, redaction: RedactionPort): string {
  const summary = redaction.redactText(error.message);
  return summary.length > 0 ? summary : error.errorCode;
}

/**
 * 组装终态 failed Run（纯函数段）：applyRunEvent RUN_ERROR、清
 * activeSession/currentTaskId、lastError、terminalAt=updatedAt=at、
 * stateRevision+1。
 *
 * 可续接失败在清槽前记录 resumePoint（SPEC §2.4/§17 resume）：失败前状态、
 * 对应 Task 与 Claude Session ID，供用户显式执行 resume 后重开 Run 并续接
 * Planning、Plan Review、Execution、Task Review 或 Final Review 会话。
 *
 * “可续接”不等于自动重试：包括通用非零退出在内的外部失败仍立即终结
 * 当前驱动；只有后续独立的 resume 命令可以消费这里持久化的恢复点。
 *
 * 中断落在「候选已持久化、Reviewer 尚未启动」的窗口时（无 activeSession
 * 但当前 Task 仍 running 且带候选）：被中断 Task 转 failed 并保留候选，
 * resumePoint 记 sessionType=task_review、sessionId=null——没有可续接的
 * Reviewer 会话，resume 时由全新 Reviewer 复核候选。
 */
export function toTerminalFailedRun(
  run: RunJson,
  error: ApexError,
  at: string,
  redaction: RedactionPort,
): RunJson {
  const currentTask = run.currentTaskId === null ? undefined : run.tasks[run.currentTaskId];
  const awaitingReviewTaskId =
    isResumableErrorCode(error.errorCode) &&
    !isTerminalRunStatus(run.status) &&
    run.activeSession === null &&
    run.currentTaskId !== null &&
    currentTask !== undefined &&
    currentTask.status === 'running' &&
    currentTask.candidateResult !== null &&
    currentTask.candidateCheckpoint !== null
      ? run.currentTaskId
      : null;
  const tasks =
    awaitingReviewTaskId === null
      ? run.tasks
      : {
          ...run.tasks,
          [awaitingReviewTaskId]: {
            ...run.tasks[awaitingReviewTaskId]!,
            status: 'failed' as const,
            failure: toErrorRecord(error, at, redaction),
          },
        };
  const preservePlanningFacts = isResumableErrorCode(error.errorCode);
  /**
   * Final Review 阶段的推送失败不持久化恢复点：未推送提交由 Final Review
   * 会话自己产生，不存在可诚实归属的 Task（正常流程中它会成为 finalCommit，
   * 无需归属），而 final_review/completed 不变式要求所有中间 Checkpoint
   * 已由 completed Task 吸收——持久化恢复点会让 resume 的重开写入必然被
   * 不变式拒绝。该形态保持显式不可恢复（abandon 后人工推送本地分支），
   * 且全部 Task 候选在 Execution 阶段均已推送到远程，损失面仅限 Final
   * Review 自身的提交。
   */
  const finalReviewPushFailure =
    error.errorCode === 'GIT_PUSH_FAILED' && run.status === 'final_review';
  return {
    ...run,
    status: applyRunEvent(run.status, 'RUN_ERROR'),
    activeSession: null,
    currentTaskId: null,
    planCandidate: preservePlanningFacts ? run.planCandidate : null,
    planReviewFeedback: preservePlanningFacts ? run.planReviewFeedback : null,
    tasks,
    lastError: toErrorRecord(error, at, redaction),
    terminalAt: at,
    updatedAt: at,
    stateRevision: run.stateRevision + 1,
    resumePoint:
      isResumableErrorCode(error.errorCode) &&
      !isTerminalRunStatus(run.status) &&
      !finalReviewPushFailure
        ? {
            fromStatus: run.status,
            taskId: run.currentTaskId,
            sessionId: run.activeSession === null ? null : run.activeSession.sessionId,
            sessionType:
              awaitingReviewTaskId !== null
                ? ('task_review' as const)
                : run.activeSession === null
                  ? null
                  : run.activeSession.type,
          }
        : null,
  };
}

/**
 * 尽力持久化 run.json：写入失败时只输出一行脱敏诊断（§15.3 state_error：
 * 状态无法写入时仅输出诊断），不抛错、不伪造成功状态。
 */
export async function persistRunBestEffort(
  deps: Pick<UseCaseDeps, 'stateStore' | 'output' | 'redaction' | 'logger'>,
  run: RunJson,
): Promise<void> {
  try {
    await deps.stateStore.writeRun(run);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    deps.logger.log('error', 'run.persist_failed', {
      runId: run.runId,
      status: run.status,
      message: detail,
    });
    deps.output.writeLine(
      deps.redaction.redactText(`! 状态写入失败 · run.json · ${detail}`),
    );
  }
}

/**
 * 关闭未结束 Execution Episode 为 session_error（纯函数，返回新 run）。
 * summary 用脱敏后的 error.message（非空保证）；本路径不创建任何
 * Checkpoint，checkpointReason 用说明性非空串。
 */
export function closeExecutionEpisodeAsSessionError(
  run: RunJson,
  taskId: string,
  sessionId: string,
  error: ApexError,
  at: string,
  specSha256After: string,
  redaction: RedactionPort,
): RunJson {
  const task = run.tasks[taskId];
  if (task === undefined) return run;
  const executionEpisodes = closeExecutionEpisode(task.executionEpisodes, sessionId, {
    specSha256After,
    endedAt: at,
    outcome: 'session_error',
    summary: redactedSummary(error, redaction),
    acceptanceEvidence: [],
    finalCheckpoint: null,
    intermediateCheckpoint: null,
    checkpointReason: `error: session ended before any checkpoint (${error.errorCode})`,
    error: toErrorRecord(error, at, redaction),
  });
  return {
    ...run,
    tasks: { ...run.tasks, [taskId]: { ...task, executionEpisodes } },
  };
}

/**
 * 关闭未结束 Task Review Episode 为 session_error。
 *
 * 候选结果与 Checkpoint 仍保留在 Task 上，resume 因而可以只续接 Reviewer
 * 自己的上下文，而不必重新运行已经完成的 Execution Session。
 */
export function closeTaskReviewEpisodeAsSessionError(
  run: RunJson,
  taskId: string,
  sessionId: string,
  error: ApexError,
  at: string,
  specSha256After: string,
  redaction: RedactionPort,
): RunJson {
  const task = run.tasks[taskId];
  if (task === undefined) return run;
  const taskReviewEpisodes = closeTaskReviewEpisode(task.taskReviewEpisodes, sessionId, {
    specSha256After,
    endedAt: at,
    outcome: 'session_error',
    summary: redactedSummary(error, redaction),
    tests: [],
    acceptanceEvidence: [],
    issues: [],
    error: toErrorRecord(error, at, redaction),
  });
  return {
    ...run,
    tasks: { ...run.tasks, [taskId]: { ...task, taskReviewEpisodes } },
  };
}

/**
 * 关闭未结束 Final Review Episode 为 session_error（纯函数，返回新 run）。
 * FR Episode 的 checkpointRole/checkpoint 为 null。
 */
export function closeFinalReviewEpisodeAsSessionError(
  run: RunJson,
  sessionId: string,
  error: ApexError,
  at: string,
  specSha256After: string,
  redaction: RedactionPort,
): RunJson {
  const finalReviewEpisodes = closeFinalReviewEpisode(run.finalReviewEpisodes, sessionId, {
    specSha256After,
    endedAt: at,
    decision: 'session_error',
    summary: redactedSummary(error, redaction),
    reviewedTaskIds: [],
    changedAreas: [],
    checkpointRole: null,
    checkpoint: null,
    checkpointReason: `error: session ended before any checkpoint (${error.errorCode})`,
    error: toErrorRecord(error, at, redaction),
  });
  return { ...run, finalReviewEpisodes };
}
