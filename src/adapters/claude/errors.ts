/**
 * Claude CLI 外部失败到稳定错误码的唯一映射点。其他模块不得解释进程
 * 结果、原始流事件或能力探测输出；Provider、鉴权、网络、代理和额度
 * 失败统一收敛为 CLAUDE_EXIT_NONZERO，并保留脱敏后的可读诊断。
 */
import type { ApexErrorInit } from '../../domain/errors.js';
import type { SessionType } from '../../domain/schemas/active-session.js';
import { ClaudeInvocationError } from '../../application/ports/ClaudeRuntimePort.js';

/** stderr 诊断摘要的最大字符数，与 Git 适配器保持同一边界。 */
const SUMMARY_LIMIT = 2_000;

/** 失败调用附带的进程事实，供 Session Record 持久化。 */
export interface ClaudeProcessFacts {
  readonly processExitCode: number | null;
  readonly claudeVersion: string | null;
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
  options: { readonly sessionId?: string; readonly claudeVersion?: string | null },
): ClaudeInvocationError {
  const message =
    exitCode === null
      ? 'claude process was terminated without an exit code (signal)'
      : `claude exited with code ${exitCode}`;
  return invocationError('CLAUDE_EXIT_NONZERO', message, {
    stage,
    toolSummary: summarizeStderr(stderr, redact),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    facts: { processExitCode: exitCode, claudeVersion: options.claudeVersion ?? null },
  });
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
  return invocationError(
    sessionType === 'final_review' ? 'FINAL_REVIEW_RESULT_INVALID' : 'CLAUDE_RESULT_INVALID',
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
