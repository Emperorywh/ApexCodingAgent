/**
 * 三类 Claude Session 共用的续接协调器。
 *
 * 该模块只负责 Session 生命周期层面的两趟上限协议：
 * 1. 有恢复提示时，经 `--resume --fork-session` 启动一次；
 * 2. 仅当 Adapter 明确返回 CLAUDE_RESUME_UNAVAILABLE，先保存失败
 *    Session Record、由调用方关闭本类型 Episode，再启动一次全新会话。
 *
 * 其他启动、流、退出、鉴权、网络和结果错误一律原样交给业务用例收尾，
 * 不进行自动重试。Planning、Execution、Final Review 因而共享同一判定。
 */
import { ApexError, isApexError } from '../../domain/errors.js';
import type { SessionType } from '../../domain/schemas/active-session.js';
import type { RunJson } from '../../domain/schemas/run-json.js';
import type { ClaudeInvocationFact } from '../ports/ClaudeRuntimePort.js';
import type { UseCaseDeps } from '../usecase-deps.js';
import {
  beginSession,
  ensureFailedSessionRecord,
  invokeSession,
  type ActiveSessionHandle,
  type BeginSessionInput,
  type BeginSessionOptions,
} from './claude-session.js';

export interface SessionResumeHint {
  readonly sessionId: string;
  readonly prompt: string;
}

export interface InvokeResumableSessionInput<T extends SessionType> {
  readonly run: RunJson;
  readonly session: Omit<BeginSessionInput<T>, 'prompt' | 'resumeFromSessionId'>;
  readonly freshPrompt: string;
  readonly resume: SessionResumeHint | null;
  /** 当前 run 已处于接力状态时使用，例如 Execution 结果修复会话。 */
  readonly initialBeginOptions?: BeginSessionOptions;
  /** resume 不可用后的新会话如何接管上一趟运行态。 */
  readonly fallbackBeginOptions?: BeginSessionOptions;
  /**
   * 关闭续接失败会话的类型事实。Planning 没有 Episode，可原样返回
   * handle.run；Execution / Final Review 必须关闭各自未结束 Episode。
   */
  readonly closeResumeAttempt: (
    handle: ActiveSessionHandle<T>,
    error: ApexError,
  ) => RunJson;
}

export type InvokeResumableSessionResult<T extends SessionType> =
  | {
      readonly kind: 'completed';
      readonly handle: ActiveSessionHandle<T>;
      readonly fact: ClaudeInvocationFact<T>;
    }
  | {
      readonly kind: 'failed';
      readonly handle: ActiveSessionHandle<T>;
      readonly error: ApexError;
    };

/** 把非契约异常收敛为携带当前 Session 事实的稳定应用错误。 */
function normalizeInvocationError(
  error: unknown,
  handle: ActiveSessionHandle,
): ApexError {
  if (isApexError(error)) return error;
  return new ApexError({
    code: 'STATE_VALIDATION_FAILED',
    stage: handle.type,
    message: error instanceof Error ? error.message : String(error),
    sessionId: handle.sessionId,
    taskId: handle.taskId,
    cause: error,
  });
}

export async function invokeResumableSession<T extends SessionType>(
  deps: UseCaseDeps,
  input: InvokeResumableSessionInput<T>,
): Promise<InvokeResumableSessionResult<T>> {
  let sessionRun = input.run;
  let resume = input.resume;
  let beginOptions = input.initialBeginOptions;

  for (;;) {
    const sessionInput: BeginSessionInput<T> = {
      ...input.session,
      prompt: resume === null ? input.freshPrompt : resume.prompt,
      resumeFromSessionId: resume?.sessionId ?? null,
    };
    const handle = await beginSession(deps, sessionRun, sessionInput, beginOptions);
    try {
      const fact = await invokeSession(deps, handle, sessionInput);
      return { kind: 'completed', handle, fact };
    } catch (error) {
      const apex = normalizeInvocationError(error, handle);
      if (resume === null || apex.errorCode !== 'CLAUDE_RESUME_UNAVAILABLE') {
        return { kind: 'failed', handle, error: apex };
      }

      await ensureFailedSessionRecord(deps, handle, apex);
      sessionRun = input.closeResumeAttempt(handle, apex);
      deps.output.writeLine(
        deps.redaction.redactText(
          `[apex] session ${handle.sessionId.slice(0, 8)} ${handle.type} resume unavailable ` +
            `(${apex.errorCode}); starting a fresh session with the full prompt`,
        ),
      );
      deps.logger.log('warn', 'session.resume_fallback', {
        sessionId: handle.sessionId,
        type: handle.type,
        taskId: handle.taskId,
        errorCode: apex.errorCode,
      });

      resume = null;
      beginOptions = input.fallbackBeginOptions;
    }
  }
}
