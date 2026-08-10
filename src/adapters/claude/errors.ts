/**
 * Claude CLI 外部失败到稳定错误码的唯一映射点。其他模块不得解释进程
 * 结果、原始流事件或能力探测输出；Provider、鉴权、网络、代理和额度
 * 失败统一收敛为 CLAUDE_EXIT_NONZERO。唯一可信 ResultMessage 携带的
 * terminal_reason/result 只用于补全脱敏诊断，不改变稳定错误码；只有明确
 * 给出的回合上限与续接尚未开始时的 transcript 缺失使用专用错误码。
 */
import type { ApexErrorInit } from '../../domain/errors.js';
import type { SessionType } from '../../domain/schemas/active-session.js';
import { ClaudeInvocationError } from '../../application/ports/ClaudeRuntimePort.js';

/** stderr 诊断摘要的最大字符数，与 Git 适配器保持同一边界。 */
const SUMMARY_LIMIT = 2_000;
const MESSAGE_DETAIL_LIMIT = 300;

/** 失败调用附带的进程事实，供 Session Record 持久化。 */
export interface ClaudeProcessFacts {
  readonly processExitCode: number | null;
  readonly claudeVersion: string | null;
}

/**
 * 唯一、Session ID 一致且明确标记 is_error 的 ResultMessage 失败事实。
 * Adapter 只传递公开流协议字段，不从模型文本猜测 Provider、网络或鉴权类别。
 */
export interface ClaudeTerminalFailureFact {
  readonly reason: string | null;
  readonly result: string | null;
}

interface InvocationErrorOptions {
  /** Error Record 使用的阶段标识，例如 execution 或 startup。 */
  readonly stage: string;
  readonly sessionId?: string;
  readonly toolSummary?: string | null;
  readonly cause?: unknown;
  readonly facts?: Partial<ClaudeProcessFacts>;
}

function invocationError(
  code: ApexErrorInit['code'],
  message: string,
  options: InvocationErrorOptions,
): ClaudeInvocationError {
  return new ClaudeInvocationError({
    code,
    stage: options.stage,
    message,
    toolSummary: options.toolSummary ?? null,
    sessionId: options.sessionId ?? null,
    ...(options.cause === undefined ? {} : { cause: options.cause }),
    processExitCode: options.facts?.processExitCode ?? null,
    claudeVersion: options.facts?.claudeVersion ?? null,
  });
}

/** 脱敏且有长度上限的 stderr 摘要；没有内容时返回 null。 */
export function summarizeStderr(
  stderr: string,
  redact: (text: string) => string,
): string | null {
  const trimmed = stderr.trim();
  if (trimmed === '') return null;
  return redact(trimmed).slice(0, SUMMARY_LIMIT);
}

/**
 * 合并 stdout 终止事件与 stderr 的失败诊断，并在离开 Adapter 前统一脱敏。
 * stdout 是 Claude Code 2.1.x 报告 api_error 的实际通道，不能因 stderr 为空
 * 而把可行动的超时事实丢弃。
 */
function summarizeInvocationFailure(
  stderr: string,
  terminalFailure: ClaudeTerminalFailureFact | undefined,
  redact: (text: string) => string,
): string | null {
  if (terminalFailure === undefined) return summarizeStderr(stderr, redact);
  const parts = [
    terminalFailure.reason === null
      ? null
      : `terminal_reason: ${terminalFailure.reason}`,
    terminalFailure.result,
    stderr.trim() === '' ? null : stderr,
  ].filter((part): part is string => part !== null && part.trim() !== '');
  return summarizeStderr(parts.join('\n'), redact);
}

/**
 * ErrorRecord.message 与 CLI 失败摘要必须保持单行且有界。
 * 原始终止结果仍以较长的 toolSummary 保存，便于报告与日志排障。
 */
function boundedMessageValue(
  value: string | null | undefined,
  redact: (text: string) => string,
): string | null {
  if (value === undefined || value === null) return null;
  const oneLine = redact(value).replace(/\s+/g, ' ').trim();
  return oneLine === '' ? null : oneLine.slice(0, MESSAGE_DETAIL_LIMIT);
}

/** 可执行文件未能启动，此时数字退出码必须记录为 null。 */
export function claudeStartFailed(
  stage: SessionType,
  detail: string,
  options: { readonly cause?: unknown; readonly sessionId?: string; readonly claudeVersion?: string | null },
): ClaudeInvocationError {
  return invocationError('CLAUDE_START_FAILED', detail, {
    stage,
    ...(options.cause === undefined ? {} : { cause: options.cause }),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    facts: { processExitCode: null, claudeVersion: options.claudeVersion ?? null },
  });
}

/**
 * 所有非零退出都映射到这里，包括 Provider、鉴权、网络、额度和权限
 * 模式拒绝。null 表示进程由信号结束而没有数字退出码，同样不是成功。
 */
export function claudeExitNonZero(
  stage: SessionType,
  exitCode: number | null,
  stderr: string,
  redact: (text: string) => string,
  options: {
    readonly sessionId?: string;
    readonly claudeVersion?: string | null;
    readonly terminalFailure?: ClaudeTerminalFailureFact;
  },
): ClaudeInvocationError {
  const baseMessage =
    exitCode === null
      ? 'claude process was terminated without an exit code (signal)'
      : `claude exited with code ${exitCode}`;
  const detail = boundedMessageValue(options.terminalFailure?.result, redact);
  const reason = boundedMessageValue(options.terminalFailure?.reason, redact);
  const terminalContext = reason === null ? '' : ` after reporting ${reason}`;
  const message = `${baseMessage}${terminalContext}${detail === null ? '' : `: ${detail}`}`;
  return invocationError('CLAUDE_EXIT_NONZERO', message, {
    stage,
    toolSummary: summarizeInvocationFailure(stderr, options.terminalFailure, redact),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    facts: { processExitCode: exitCode, claudeVersion: options.claudeVersion ?? null },
  });
}

/**
 * Claude ResultMessage 明确报告 `error_max_turns`。
 *
 * 这是配置预算按预期生效，不是 Provider、鉴权或网络故障；调用方可以保存
 * Session ID 供用户显式续接，但不能在同一次 Run 驱动中自动追加预算。
 */
export function claudeTurnLimitReached(
  stage: SessionType,
  exitCode: number,
  stderr: string,
  redact: (text: string) => string,
  options: { readonly sessionId?: string; readonly claudeVersion?: string | null },
): ClaudeInvocationError {
  return invocationError(
    'CLAUDE_TURN_LIMIT_REACHED',
    'claude reached the configured turn limit before completing the session',
    {
      stage,
      toolSummary: summarizeStderr(stderr, redact),
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      facts: { processExitCode: exitCode, claudeVersion: options.claudeVersion ?? null },
    },
  );
}

/**
 * Claude CLI 明确表示目标 transcript 不存在或无法加载。
 *
 * 该错误只由适配器在“续接尚未开始执行”的诊断边界产生，Application
 * 因而可以安全地区分 transcript 缺失与鉴权、网络、额度及运行中失败。
 */
export function claudeResumeUnavailable(
  stage: SessionType,
  exitCode: number,
  stderr: string,
  redact: (text: string) => string,
  options: { readonly sessionId?: string; readonly claudeVersion?: string | null },
): ClaudeInvocationError {
  return invocationError(
    'CLAUDE_RESUME_UNAVAILABLE',
    'claude could not load the requested session transcript',
    {
      stage,
      toolSummary: summarizeStderr(stderr, redact),
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      facts: { processExitCode: exitCode, claudeVersion: options.claudeVersion ?? null },
    },
  );
}

/** stdout 不满足逐行 JSON 对象契约，或管道发生不可恢复错误。 */
export function claudeStreamFailed(
  stage: SessionType,
  detail: string,
  options: {
    readonly sessionId?: string;
    readonly facts?: Partial<ClaudeProcessFacts>;
    readonly toolSummary?: string | null;
  } = {},
): ClaudeInvocationError {
  return invocationError('CLAUDE_STREAM_FAILED', detail, {
    stage,
    toolSummary: options.toolSummary ?? null,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.facts === undefined ? {} : { facts: options.facts }),
  });
}

/**
 * 退出码为 0 时，多个或缺失 result、Session ID 冲突、结构化结果缺失或
 * Schema 非法都会进入此映射；Final Review 使用专用稳定错误码。
 */
export function claudeResultInvalid(
  sessionType: SessionType,
  detail: string,
  options: {
    readonly sessionId?: string;
    readonly facts?: Partial<ClaudeProcessFacts>;
    readonly toolSummary?: string | null;
  } = {},
): ClaudeInvocationError {
  const errorCode =
    sessionType === 'final_review'
      ? 'FINAL_REVIEW_RESULT_INVALID'
      : sessionType === 'plan_review'
        ? 'PLAN_REVIEW_RESULT_INVALID'
      : sessionType === 'task_review'
        ? 'TASK_REVIEW_RESULT_INVALID'
        : 'CLAUDE_RESULT_INVALID';
  return invocationError(
    errorCode,
    detail,
    {
      stage: sessionType,
      toolSummary: options.toolSummary ?? null,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.facts === undefined ? {} : { facts: options.facts }),
    },
  );
}

/** 脱敏后的 Session 日志无法持久化。 */
export function claudeLogWriteFailed(
  stage: SessionType,
  logPath: string,
  cause: unknown,
  options: { readonly sessionId?: string; readonly facts?: Partial<ClaudeProcessFacts> } = {},
): ClaudeInvocationError {
  return invocationError('STATE_WRITE_FAILED', `failed to write session log ${logPath}`, {
    stage,
    cause,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.facts === undefined ? {} : { facts: options.facts }),
  });
}

/** `claude --version` 未能产生可用版本事实。 */
export function claudeInstallationUnhealthy(
  detail: string,
  options: { readonly cause?: unknown } = {},
): ClaudeInvocationError {
  return invocationError('CLAUDE_INSTALLATION_UNHEALTHY', detail, {
    stage: 'startup',
    ...(options.cause === undefined ? {} : { cause: options.cause }),
  });
}

/**
 * 必需选项或枚举值未在 help 中明确出现，或者 help 缺失、含糊、不可
 * 解析。错误消息同时列出全部缺失能力和实际版本。
 */
export function claudeCapabilityMissing(
  missing: readonly string[],
  version: string,
  options: { readonly detail?: string; readonly cause?: unknown } = {},
): ClaudeInvocationError {
  const prefix = options.detail === undefined ? '' : `${options.detail}: `;
  return invocationError(
    'CLAUDE_CAPABILITY_MISSING',
    `${prefix}missing required claude capabilities: ${missing.join(', ')} (actual version: ${version})`,
    { stage: 'startup', ...(options.cause === undefined ? {} : { cause: options.cause }) },
  );
}
