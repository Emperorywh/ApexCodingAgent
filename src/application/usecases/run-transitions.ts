/**
 * Run 状态迁移与尽力持久化的共享原语（SPEC §6.3 Session 收尾、§15 错误模型）。
 *
 * 这里集中所有用例共用的失败收尾形态：终态 failed Run 的组装、写入失败时
 * 只输出诊断的 state_error 语义（§15.3：状态无法写入时仅输出诊断），以及
 * 未结束 Episode 的 session_error 关闭。纯函数不读时钟、不读环境。
 */
import { applyRunEvent } from '../../domain/run-state.js';
import {
  closeExecutionEpisode,
  closeFinalReviewEpisode,
} from '../../domain/episodes.js';
import type { ApexError } from '../../domain/errors.js';
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
 * 组装终态 failed Run（纯函数）：applyRunEvent RUN_ERROR、清
 * activeSession/currentTaskId、lastError、terminalAt=updatedAt=at、
 * stateRevision+1。
 */
export function toTerminalFailedRun(
  run: RunJson,
  error: ApexError,
  at: string,
  redaction: RedactionPort,
): RunJson {
  return {
    ...run,
    status: applyRunEvent(run.status, 'RUN_ERROR'),
    activeSession: null,
    currentTaskId: null,
    lastError: toErrorRecord(error, at, redaction),
    terminalAt: at,
    updatedAt: at,
    stateRevision: run.stateRevision + 1,
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
      deps.redaction.redactText(`state_error: run.json 无法写入，仅输出诊断: ${detail}`),
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
