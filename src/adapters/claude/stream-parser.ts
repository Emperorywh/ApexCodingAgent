/**
 * Claude stream-json 的增量解析与纯结果求值。
 *
 * 正式 Session 只保留结果判定所需的有限状态：首个 init 元数据、Session
 * ID 冲突事实、终止事件计数和结构化结果。普通事件在完成活动摘要后立即
 * 释放，避免长任务的内存占用随完整 transcript 线性增长。
 *
 * 确定性失败顺序保持 SPEC §7.2 不变：
 * 1. 非空行不是 JSON 对象时返回 CLAUDE_STREAM_FAILED；
 * 2. 非零或信号退出时返回 CLAUDE_EXIT_NONZERO；
 * 3. Session ID 冲突、result 缺失或重复时返回结果非法；
 * 4. structured_output 缺失或 Schema 非法时返回结果非法。
 */

import type {
  ClaudeStructuredResultBySessionType,
  ClaudeStreamActivity,
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
const EVENT_SUMMARY_LIMIT = 200;

interface StreamParseFailure {
  readonly lineNumber: number;
  readonly kind: 'invalid-json' | 'non-object';
}

export interface CollectedClaudeStream {
  readonly parseFailure: StreamParseFailure | null;
  readonly hasContent: boolean;
  readonly sessionIdConflict: boolean;
  readonly terminalEventCount: number;
  readonly terminalHasStructuredOutput: boolean;
  readonly structuredOutput: unknown;
  readonly model: string | null;
  readonly provider: string | null;
}

export interface ClaudeStreamCollector {
  /**
   * 依照进程 stdout 的原始 chunk 顺序增量消费字节。
   *
   * push 只解析已经闭合的行；跨 chunk 的 UTF-8 字符和未完成行由内部
   * TextDecoder 与行缓冲保存，直到后续 chunk 或 finish 到达。
   */
  push(chunk: Uint8Array): void;
  finish(): CollectedClaudeStream;
}

export interface StreamCollectorOptions {
  readonly sessionId: string;
  readonly onActivity?: (activity: ClaudeStreamActivity) => void;
}

export interface CollectedStreamEvaluationInput<T extends SessionType = SessionType> {
  readonly stream: CollectedClaudeStream;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly sessionId: string;
  readonly sessionType: T;
  readonly claudeVersion: string | null;
  readonly redact: (text: string) => string;
}

export interface StreamEvaluationInput<T extends SessionType = SessionType>
  extends Omit<CollectedStreamEvaluationInput<T>, 'stream'> {
  readonly stdout: string;
}

export interface StreamEvaluation<T extends SessionType = SessionType> {
  readonly structuredResult: ClaudeStructuredResultBySessionType[T];
  readonly model: string | null;
  readonly provider: string | null;
  readonly stderrSummary: string | null;
}

type StreamEvent = Record<string, unknown>;
type StreamContentBlock = Record<string, unknown>;

function toSummaryLine(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= EVENT_SUMMARY_LIMIT
    ? oneLine
    : `${oneLine.slice(0, EVENT_SUMMARY_LIMIT)}…`;
}

function readContentBlocks(event: StreamEvent): StreamContentBlock[] {
  const message = event['message'];
  if (typeof message !== 'object' || message === null) return [];
  const content = (message as Record<string, unknown>)['content'];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter(
    (block): block is StreamContentBlock => typeof block === 'object' && block !== null,
  );
}

function summarizeToolUse(block: StreamContentBlock): string {
  const name = typeof block['name'] === 'string' ? block['name'] : 'unknown';
  const input = block['input'];
  if (typeof input !== 'object' || input === null) return `tool: ${name}`;
  const record = input as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return `tool: ${name} — ${toSummaryLine(value)}`;
    }
  }
  return `tool: ${name}`;
}

function summarizeToolResult(block: StreamContentBlock): string {
  const prefix = block['is_error'] === true ? 'tool result (error)' : 'tool result';
  const content = block['content'];
  if (typeof content === 'string') return `${prefix}: ${toSummaryLine(content)}`;
  if (Array.isArray(content)) {
    const text = content
      .map((part: unknown) => {
        if (typeof part !== 'object' || part === null) return '';
        const record = part as Record<string, unknown>;
        return typeof record['text'] === 'string' ? record['text'] : '';
      })
      .filter((part: string) => part !== '')
      .join(' ');
    if (text !== '') return `${prefix}: ${toSummaryLine(text)}`;
  }
  return `${prefix} received`;
}

/**
 * 从单个事件提取面向用户的活动摘要。
 *
 * 该函数不参与结果判定；未知事件或字段缺失只会返回 null，不能改变
 * Session 的成功、失败或结构化结果。
 */
export function summarizeStreamEvent(event: StreamEvent): string | null {
  const type = event['type'];
  if (type === 'assistant' || type === 'user') {
    const parts: string[] = [];
    for (const block of readContentBlocks(event)) {
      switch (block['type']) {
        case 'thinking':
          if (typeof block['thinking'] === 'string' && block['thinking'].trim() !== '') {
            parts.push(`thinking: ${toSummaryLine(block['thinking'])}`);
          }
          break;
        case 'text':
          if (typeof block['text'] === 'string' && block['text'].trim() !== '') {
            parts.push(toSummaryLine(block['text']));
          }
          break;
        case 'tool_use':
          parts.push(summarizeToolUse(block));
          break;
        case 'tool_result':
          parts.push(summarizeToolResult(block));
          break;
        default:
          break;
      }
    }
    return parts.length === 0 ? null : toSummaryLine(parts.join(' | '));
  }
  if (type === 'system') {
    const subtype = typeof event['subtype'] === 'string' ? event['subtype'] : 'unknown';
    return `system: ${subtype}`;
  }
  if (type === 'result') return 'result event received';
  return null;
}

/**
 * 创建单次 Session 独占的增量收集器。
 *
 * 收集器在每个 chunk 后发送一次活动事实，但只在完整事件行到达时更新
 * 最近事件。finish 只能调用一次，防止部分行被重复纳入结果判定。
 */
export function createClaudeStreamCollector(options: StreamCollectorOptions): ClaudeStreamCollector {
  const decoder = new TextDecoder();
  let lineBuffer = '';
  let lineNumber = 0;
  let receivedStdoutBytes = 0;
  let lastEventType: string | null = null;
  let lastEventSummary: string | null = null;
  let hasContent = false;
  let parseFailure: StreamParseFailure | null = null;
  let sessionIdConflict = false;
  let terminalEventCount = 0;
  let terminalHasStructuredOutput = false;
  let structuredOutput: unknown;
  let model: string | null = null;
  let provider: string | null = null;
  let finished = false;

  function consumeEvent(event: StreamEvent): void {
    if (typeof event['type'] === 'string') {
      lastEventType = event['type'];
      const summary = summarizeStreamEvent(event);
      if (summary !== null) lastEventSummary = summary;
    }
    if ('session_id' in event && event['session_id'] !== options.sessionId) {
      sessionIdConflict = true;
    }
    if (event['type'] === 'system' && event['subtype'] === 'init') {
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
    if (event['type'] === 'result') {
      terminalEventCount += 1;
      if (terminalEventCount === 1 && 'structured_output' in event) {
        terminalHasStructuredOutput = true;
        structuredOutput = event['structured_output'];
      }
    }
  }

  function consumeLine(rawLine: string): void {
    lineNumber += 1;
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') return;
    if (parseFailure !== null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      parseFailure = { lineNumber, kind: 'invalid-json' };
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      parseFailure = { lineNumber, kind: 'non-object' };
      return;
    }
    consumeEvent(parsed as StreamEvent);
  }

  function consumeText(text: string): void {
    if (text.trim() !== '') hasContent = true;
    lineBuffer += text;
    let newlineIndex = lineBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      consumeLine(lineBuffer.slice(0, newlineIndex));
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      newlineIndex = lineBuffer.indexOf('\n');
    }
  }

  function reportActivity(): void {
    options.onActivity?.({
      receivedStdoutBytes,
      lastEventType,
      lastEventSummary,
      model,
      provider,
    });
  }

  return {
    push(chunk): void {
      if (finished) throw new Error('cannot push to a finished Claude stream collector');
      receivedStdoutBytes += chunk.byteLength;
      consumeText(decoder.decode(chunk, { stream: true }));
      reportActivity();
    },
    finish(): CollectedClaudeStream {
      if (finished) throw new Error('Claude stream collector finish called more than once');
      finished = true;
      consumeText(decoder.decode());
      if (lineBuffer !== '') {
        consumeLine(lineBuffer);
        lineBuffer = '';
      }
      return {
        parseFailure,
        hasContent,
        sessionIdConflict,
        terminalEventCount,
        terminalHasStructuredOutput,
        structuredOutput,
        model,
        provider,
      };
    },
  };
}

/**
 * 对已经增量收集完成的进程事实执行纯结果判定。
 *
 * 该入口供正式 Session 使用，不再需要完整 stdout 字符串；错误优先级、
 * Schema 校验和元数据白名单与原有协议保持完全一致。
 */
export function evaluateCollectedStreamOutcome<T extends SessionType>(
  input: CollectedStreamEvaluationInput<T>,
): StreamEvaluation<T> {
  const facts: ClaudeProcessFacts = {
    processExitCode: input.exitCode,
    claudeVersion: input.claudeVersion,
  };
  const stderrSummary = summarizeStderr(input.stderr, input.redact);
  if (input.stream.parseFailure !== null) {
    const detail =
      input.stream.parseFailure.kind === 'invalid-json'
        ? 'is not valid JSON'
        : 'is not a JSON object';
    throw claudeStreamFailed(
      input.sessionType,
      `stdout line ${input.stream.parseFailure.lineNumber} ${detail}`,
      {
        sessionId: input.sessionId,
        facts,
        toolSummary: stderrSummary,
      },
    );
  }
  if (input.exitCode !== 0) {
    throw claudeExitNonZero(input.sessionType, input.exitCode, input.stderr, input.redact, {
      sessionId: input.sessionId,
      claudeVersion: input.claudeVersion,
    });
  }
  if (input.stream.sessionIdConflict) {
    throw claudeResultInvalid(
      input.sessionType,
      'stream event session_id conflicts with the requested --session-id',
      { sessionId: input.sessionId, facts, toolSummary: stderrSummary },
    );
  }
  if (input.stream.terminalEventCount === 0) {
    throw claudeResultInvalid(
      input.sessionType,
      'missing terminal type=="result" event despite exit code 0',
      { sessionId: input.sessionId, facts, toolSummary: stderrSummary },
    );
  }
  if (input.stream.terminalEventCount > 1) {
    throw claudeResultInvalid(
      input.sessionType,
      `expected exactly one terminal result event, got ${input.stream.terminalEventCount}`,
      { sessionId: input.sessionId, facts, toolSummary: stderrSummary },
    );
  }
  if (!input.stream.terminalHasStructuredOutput) {
    throw claudeResultInvalid(
      input.sessionType,
      'terminal result event carries no structured_output despite exit code 0',
      { sessionId: input.sessionId, facts, toolSummary: stderrSummary },
    );
  }

  const resultSchema = RESULT_SCHEMA_BY_SESSION_TYPE[input.sessionType];
  const validation = validate(resultSchema, input.stream.structuredOutput);
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

  /**
   * 元数据只来自收集器认可的 system/init 事件，并在离开适配器前脱敏。
   *
   * 这既阻止未知事件污染持久化事实，也不会读取或推导用户环境中的
   * Provider 配置。
   */
  const model = input.stream.model === null ? null : input.redact(input.stream.model);
  const provider =
    input.stream.provider === null ? null : input.redact(input.stream.provider);
  return {
    structuredResult:
      input.stream.structuredOutput as ClaudeStructuredResultBySessionType[T],
    model,
    provider,
    stderrSummary,
  };
}

/**
 * 字符串兼容入口只服务于固定 Fixture 和纯单元测试。
 *
 * 它复用正式增量收集器而不是维护第二套解析逻辑，因此测试覆盖的失败
 * 顺序与生产流式路径保持一致。
 */
export function evaluateStreamOutcome<T extends SessionType>(
  input: StreamEvaluationInput<T>,
): StreamEvaluation<T> {
  const collector = createClaudeStreamCollector({ sessionId: input.sessionId });
  collector.push(new TextEncoder().encode(input.stdout));
  return evaluateCollectedStreamOutcome({
    stream: collector.finish(),
    stderr: input.stderr,
    exitCode: input.exitCode,
    sessionId: input.sessionId,
    sessionType: input.sessionType,
    claudeVersion: input.claudeVersion,
    redact: input.redact,
  });
}
