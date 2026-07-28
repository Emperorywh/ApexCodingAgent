/**
 * stream-json 事件契约的纯求值器。固定 Fixture 可以直接覆盖所有分支，
 * 原始 Claude 事件也只允许在本模块解释。未知但合法的非终止事件只能
 * 进入脱敏日志，不得改变结构化结果或 Session 元数据。
 *
 * 确定性失败顺序：
 * 1. 非空行不是 JSON 对象时返回 CLAUDE_STREAM_FAILED；
 * 2. 非零或信号退出时返回 CLAUDE_EXIT_NONZERO；
 * 3. Session ID 冲突、result 缺失或重复时返回结果非法；
 * 4. structured_output 缺失或 Schema 非法时返回结果非法。
 */
import type {
  ClaudeInvocationError,
  ClaudeStructuredResultBySessionType,
} from '../../application/ports/ClaudeRuntimePort.js';
import type { SessionType } from '../../domain/schemas/active-session.js';
import { validate } from '../../domain/schemas/index.js';
import {
  claudeExitNonZero,
  claudeResultInvalid,
  claudeStreamFailed,
  summarizeStderr,
  type ClaudeProcessFacts,
} from './errors.js';

const RESULT_SCHEMA_BY_SESSION_TYPE = {
  planning: 'TaskPlanDraft',
  execution: 'TaskExecutionResult',
  final_review: 'FinalReviewResult',
} as const;

export interface StreamEvaluationInput<T extends SessionType = SessionType> {
  readonly stdout: string;
  readonly stderr: string;
  /** 数字退出码；进程由信号结束时为 null。 */
  readonly exitCode: number | null;
  /** 传给 CLI 的 `--session-id` 值。 */
  readonly sessionId: string;
  readonly sessionType: T;
  /** 已探测的 CLI 版本，失败事实无法获得时为 null。 */
  readonly claudeVersion: string | null;
  /** 所有诊断进入错误对象前使用的脱敏钩子。 */
  readonly redact: (text: string) => string;
}

export interface StreamEvaluation<T extends SessionType = SessionType> {
  readonly structuredResult: ClaudeStructuredResultBySessionType[T];
  readonly model: string | null;
  readonly provider: string | null;
  readonly stderrSummary: string | null;
}

type StreamEvent = Record<string, unknown>;

/**
 * Session 元数据只允许来自稳定的 system/init 事件及顶层 model/provider
 * 字段。未知事件即使携带同名字段也只进入日志，不能污染持久化事实。
 */
function extractMetadata(events: readonly StreamEvent[]): {
  readonly model: string | null;
  readonly provider: string | null;
} {
  let model: string | null = null;
  let provider: string | null = null;
  for (const event of events) {
    if (event['type'] !== 'system' || event['subtype'] !== 'init') continue;
    if (model === null && typeof event['model'] === 'string' && event['model'] !== '') {
      model = event['model'];
    }
    if (
      provider === null &&
      typeof event['provider'] === 'string' &&
      event['provider'] !== ''
    ) {
      provider = event['provider'];
    }
  }
  return { model, provider };
}

/** 按 UTF-8 逐行解析 JSON 对象，严格只忽略真正的空行。 */
function parseStreamEvents(
  stdout: string,
  sessionType: SessionType,
  sessionId: string,
  facts: ClaudeProcessFacts,
  stderrSummary: string | null,
): StreamEvent[] {
  const events: StreamEvent[] = [];
  const lines = stdout.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw claudeStreamFailed(sessionType, `stdout line ${index + 1} is not valid JSON`, {
        sessionId,
        facts,
        toolSummary: stderrSummary,
      });
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw claudeStreamFailed(sessionType, `stdout line ${index + 1} is not a JSON object`, {
        sessionId,
        facts,
        toolSummary: stderrSummary,
      });
    }
    events.push(parsed as StreamEvent);
  }
  return events;
}

/**
 * 按 §7.2 对一个已经结束的 Claude 进程求值。任一失败都抛出稳定的
 * ClaudeInvocationError；成功时返回与 Session 类型对应的结构化结果、
 * 允许列表元数据以及脱敏 stderr 摘要。
 */
export function evaluateStreamOutcome<T extends SessionType>(
  input: StreamEvaluationInput<T>,
): StreamEvaluation<T> {
  const facts: ClaudeProcessFacts = {
    processExitCode: input.exitCode,
    claudeVersion: input.claudeVersion,
  };
  const stderrSummary = summarizeStderr(input.stderr, input.redact);
  const events = parseStreamEvents(
    input.stdout,
    input.sessionType,
    input.sessionId,
    facts,
    stderrSummary,
  );

  if (input.exitCode !== 0) {
    throw claudeExitNonZero(input.sessionType, input.exitCode, input.stderr, input.redact, {
      sessionId: input.sessionId,
      claudeVersion: input.claudeVersion,
    });
  }

  for (const event of events) {
    if ('session_id' in event && event['session_id'] !== input.sessionId) {
      throw claudeResultInvalid(
        input.sessionType,
        'stream event session_id conflicts with the requested --session-id',
        { sessionId: input.sessionId, facts, toolSummary: stderrSummary },
      );
    }
  }

  const terminalEvents = events.filter((event) => event['type'] === 'result');
  if (terminalEvents.length === 0) {
    throw claudeResultInvalid(
      input.sessionType,
      'missing terminal type=="result" event despite exit code 0',
      { sessionId: input.sessionId, facts, toolSummary: stderrSummary },
    );
  }
  if (terminalEvents.length > 1) {
    throw claudeResultInvalid(
      input.sessionType,
      `expected exactly one terminal result event, got ${terminalEvents.length}`,
      { sessionId: input.sessionId, facts, toolSummary: stderrSummary },
    );
  }
  const terminal = terminalEvents[0];
  if (terminal === undefined || !('structured_output' in terminal)) {
    throw claudeResultInvalid(
      input.sessionType,
      'terminal result event carries no structured_output despite exit code 0',
      { sessionId: input.sessionId, facts, toolSummary: stderrSummary },
    );
  }

  const structuredOutput = terminal['structured_output'];
  const resultSchema = RESULT_SCHEMA_BY_SESSION_TYPE[input.sessionType];
  const validation = validate(resultSchema, structuredOutput);
  if (!validation.valid) {
    const detail = validation.issues
      .map((issue) => `${issue.path} (${issue.keyword}): ${issue.message}`)
      .join('; ');
    throw claudeResultInvalid(
      input.sessionType,
      `structured_output failed ${resultSchema} schema validation: ${detail}`,
      { sessionId: input.sessionId, facts, toolSummary: stderrSummary },
    );
  }

  const metadata = extractMetadata(events);
  /**
   * 元数据先按事件形态和字段白名单提取，再经过统一脱敏边界。这样既不
   * 会读取完整配置，也不会把恶意伪装成 Provider 名称的凭据带出适配器。
   */
  const model = metadata.model === null ? null : input.redact(metadata.model);
  const provider = metadata.provider === null ? null : input.redact(metadata.provider);
  return {
    structuredResult: structuredOutput as ClaudeStructuredResultBySessionType[T],
    model,
    provider,
    stderrSummary,
  };
}
