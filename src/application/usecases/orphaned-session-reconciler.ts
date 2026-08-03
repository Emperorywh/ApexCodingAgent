/**
 * Coordinator 丢失后未完成 Session 事实的统一收尾组件。
 *
 * abandon 与 resume --force 都需要遵守同一组不可变事实：
 * - 已存在的 Session Record 永不覆盖；
 * - 缺失 Record 时补写 exitCode=null 的失败事实；
 * - 未结束的 Execution / Final Review Episode 关闭为 session_error；
 * - 本组件不决定 Task 或 Run 的下一状态，由调用用例各自负责。
 *
 * 将该协议集中在单一模块，避免两个控制命令复制并逐渐产生语义漂移。
 */
import type { ApexError } from '../../domain/errors.js';
import type { RunJson } from '../../domain/schemas/run-json.js';
import type { SessionRecord } from '../../domain/schemas/session-record.js';
import { formatRfc3339InSystemTimeZone } from '../../domain/time.js';
import type { ClockPort } from '../ports/clock.js';
import type { OutputPort } from '../ports/output.js';
import type { RedactionPort } from '../ports/redaction.js';
import type { StateStorePort } from '../ports/state-store.js';
import { toErrorRecord } from './error-record.js';
import {
  closeExecutionEpisodeAsSessionError,
  closeFinalReviewEpisodeAsSessionError,
  closeTaskReviewEpisodeAsSessionError,
} from './run-transitions.js';

export interface OrphanedSessionReconcilerDeps {
  readonly stateStore: StateStorePort;
  readonly clock: ClockPort;
  readonly redaction: RedactionPort;
  readonly output: OutputPort;
}

/**
 * 关闭给定 Run 中全部尚未结束的 Session 事实，返回尚未持久化的下一状态。
 *
 * 调用方必须把返回值与自己的 Task/Run 状态迁移合并后作为单个 run.json
 * 提交点写入；Session Record 因不可变协议独立先行落盘。
 */
export async function reconcileOrphanedSessionFacts(
  deps: OrphanedSessionReconcilerDeps,
  run: RunJson,
  error: ApexError,
): Promise<RunJson> {
  const now = (): string => formatRfc3339InSystemTimeZone(deps.clock.now());

  if (run.activeSession !== null) {
    const active = run.activeSession;
    const existing = await deps.stateStore.readSessionRecord(active.sessionId);
    if (existing === null) {
      const endedAt = now();
      const record: SessionRecord = {
        schemaVersion: 1,
        sessionId: active.sessionId,
        type: active.type,
        status: 'failed',
        runId: run.runId,
        taskId: active.taskId,
        planRevision: active.planRevision,
        specSha256: active.specSha256,
        startedAt: active.startedAt,
        endedAt,
        claude: { version: 'unknown', model: null, provider: null },
        exitCode: null,
        structuredResult: null,
        logPath: `logs/${active.sessionId}.log`,
        error: toErrorRecord(error, endedAt, deps.redaction),
      };
      try {
        await deps.stateStore.writeSessionRecord(record);
      } catch (writeError) {
        const detail = writeError instanceof Error ? writeError.message : String(writeError);
        deps.output.writeLine(
          deps.redaction.redactText(
            `! 状态写入失败 · Session ${active.sessionId} 的失败记录 · ${detail}`,
          ),
        );
      }
    }
  }

  let reconciled = run;
  for (const task of Object.values(run.tasks)) {
    for (const episode of task.executionEpisodes) {
      if (episode.endedAt !== null) continue;
      reconciled = closeExecutionEpisodeAsSessionError(
        reconciled,
        task.taskId,
        episode.sessionId,
        error,
        now(),
        episode.specSha256Before,
        deps.redaction,
      );
    }
    for (const episode of task.taskReviewEpisodes) {
      if (episode.endedAt !== null) continue;
      reconciled = closeTaskReviewEpisodeAsSessionError(
        reconciled,
        task.taskId,
        episode.sessionId,
        error,
        now(),
        episode.specSha256Before,
        deps.redaction,
      );
    }
  }
  for (const episode of run.finalReviewEpisodes) {
    if (episode.endedAt !== null) continue;
    reconciled = closeFinalReviewEpisodeAsSessionError(
      reconciled,
      episode.sessionId,
      error,
      now(),
      episode.specSha256Before,
      deps.redaction,
    );
  }
  return reconciled;
}
