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
  ClaudeStreamDisplayEvent,
  ClaudeStructuredResultBySessionType,
  ClaudeStreamActivity,
} from '../../application/ports/ClaudeRuntimePort.js';
import type { SessionType } from '../../domain/schemas/active-session.js';
import { validate } from '../../domain/schemas/index.js';
import { stripVTControlCharacters } from 'node:util';
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
   * TextDecoder 与行缓冲保存，直到后续 chunk 或 finish 到达。返回值是
   * 当前解码文本中已验证 JSON 对象记录结束后的字符偏移，供日志脱敏器
   * 安全降低输出延迟；首次非法记录之后不再声明任何安全边界。
   */
  push(chunk: Uint8Array): readonly number[];
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
type StreamDisplayEventDraft = Omit<ClaudeStreamDisplayEvent, 'sequence'>;

function toSummaryLine(text: string): string {
  /*
   * Claude 或 Provider 元数据可能夹带颜色控制序列。原始 Session 日志仍
   * 保存脱敏后的完整事件，但任何进入展示事实的文本必须先清理控制序列，
   * 防止模型名或工具详情污染用户终端。
   */
  const oneLine = stripVTControlCharacters(text).replace(/\s+/g, ' ').trim();
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

function describeToolUse(block: StreamContentBlock): StreamDisplayEventDraft {
  const name = typeof block['name'] === 'string' ? block['name'] : 'unknown';
  const input = block['input'];
  if (typeof input !== 'object' || input === null) {
    return { kind: 'tool', label: toSummaryLine(name), detail: null };
  }
  const record = input as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return {
        kind: 'tool',
        label: toSummaryLine(name),
        detail: toSummaryLine(value),
      };
    }
  }
  return { kind: 'tool', label: toSummaryLine(name), detail: null };
}

function describeToolResult(block: StreamContentBlock): StreamDisplayEventDraft {
  const isError = block['is_error'] === true;
  const content = block['content'];
  if (typeof content === 'string') {
    return {
      kind: isError ? 'tool_error' : 'tool_result',
      label: isError ? '工具执行失败' : '工具结果',
      detail: toSummaryLine(content),
    };
  }
  if (Array.isArray(content)) {
    const text = content
      .map((part: unknown) => {
        if (typeof part !== 'object' || part === null) return '';
        const record = part as Record<string, unknown>;
        return typeof record['text'] === 'string' ? record['text'] : '';
      })
      .filter((part: string) => part !== '')
      .join(' ');
    if (text !== '') {
      return {
        kind: isError ? 'tool_error' : 'tool_result',
        label: isError ? '工具执行失败' : '工具结果',
        detail: toSummaryLine(text),
      };
    }
  }
  return {
    kind: isError ? 'tool_error' : 'tool_result',
    label: isError ? '工具执行失败' : '工具结果',
    detail: null,
  };
}

/**
 * 从单个事件提取一个或多个结构化展示事实。
 *
 * 一个 assistant/user 事件可能同时包含多个工具块；逐块返回可以保证默认
 * 终端不漏掉实际动作，同时仍让 Application 自主过滤 thinking 与结果噪声。
 */
export function describeStreamEvent(event: StreamEvent): StreamDisplayEventDraft[] {
  const type = event['type'];
  if (type === 'assistant' || type === 'user') {
    const events: StreamDisplayEventDraft[] = [];
    for (const block of readContentBlocks(event)) {
      switch (block['type']) {
        case 'thinking':
          if (typeof block['thinking'] === 'string' && block['thinking'].trim() !== '') {
            events.push({
              kind: 'thinking',
              label: '思考',
              detail: toSummaryLine(block['thinking']),
            });
          }
          break;
        case 'text':
          if (typeof block['text'] === 'string' && block['text'].trim() !== '') {
            events.push({
              kind: 'message',
              label: '消息',
              detail: toSummaryLine(block['text']),
            });
          }
          break;
        case 'tool_use':
          events.push(describeToolUse(block));
          break;
        case 'tool_result':
          events.push(describeToolResult(block));
          break;
        default:
          break;
      }
    }
    return events;
  }
  if (type === 'system') {
    const subtype = typeof event['subtype'] === 'string' ? event['subtype'] : 'unknown';
    return [{ kind: 'system', label: toSummaryLine(subtype), detail: null }];
  }
  if (type === 'result') return [{ kind: 'result', label: '结果已返回', detail: null }];
  return [];
}

/**
 * 单行摘要兼容入口供纯解析测试和诊断使用。
 *
 * 正式进度链路使用 describeStreamEvent 的结构化结果，不再解析该字符串；
 * 多块内容仍以稳定分隔符合并，便于日志断言。
 */
export function summarizeStreamEvent(event: StreamEvent): string | null {
  const descriptions = describeStreamEvent(event);
  if (descriptions.length === 0) return null;
  const parts = descriptions.map((description) => {
    if (description.kind === 'thinking') return `thinking: ${description.detail ?? ''}`;
    if (description.kind === 'tool') {
      return `tool: ${description.label}${description.detail === null ? '' : ` — ${description.detail}`}`;
    }
    if (description.kind === 'tool_error') {
      return `tool result (error)${description.detail === null ? ' received' : `: ${description.detail}`}`;
    }
    if (description.kind === 'tool_result') {
      return `tool result${description.detail === null ? ' received' : `: ${description.detail}`}`;
    }
    if (description.kind === 'system') return `system: ${description.label}`;
    if (description.kind === 'result') return 'result event received';
    return description.detail ?? description.label;
  });
  return toSummaryLine(parts.join(' | '));
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
  let displayEvent: ClaudeStreamDisplayEvent | null = null;
  let displaySequence = 0;
  let hasContent = false;
  let parseFailure: StreamParseFailure | null = null;
  let sessionIdConflict = false;
  let terminalEventCount = 0;
  let terminalHasStructuredOutput = false;
  let structuredOutput: unknown;
  let model: string | null = null;
  let provider: string | null = null;
  let finished = false;

  /**
   * 每个结构化展示事实立即上报。
   *
   * 回调粒度绑定“完整事件/内容块”而不是底层 stdout chunk；操作系统即使
   * 把多行合并成一个 chunk，也不会再吞掉前面的工具动作。
   */
  function consumeEvent(event: StreamEvent): void {
    if (typeof event['type'] === 'string') {
      lastEventType = event['type'];
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
    const descriptions = describeStreamEvent(event);
    if (descriptions.length === 0) {
      reportActivity();
      return;
    }
    for (const description of descriptions) {
      displaySequence += 1;
      displayEvent = { sequence: displaySequence, ...description };
      reportActivity();
    }
  }

  function consumeLine(rawLine: string): boolean {
    lineNumber += 1;
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') return false;
    if (parseFailure !== null) return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      parseFailure = { lineNumber, kind: 'invalid-json' };
      return false;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      parseFailure = { lineNumber, kind: 'non-object' };
      return false;
    }
    consumeEvent(parsed as StreamEvent);
    return true;
  }

  function consumeText(text: string): readonly number[] {
    if (text.trim() !== '') hasContent = true;
    const safeRecordBoundaryOffsets: number[] = [];
    let segmentStart = 0;
    let newlineIndex = text.indexOf('\n');
    while (newlineIndex !== -1) {
      lineBuffer += text.slice(segmentStart, newlineIndex);
      if (consumeLine(lineBuffer)) {
        safeRecordBoundaryOffsets.push(newlineIndex + 1);
      }
      lineBuffer = '';
      segmentStart = newlineIndex + 1;
      newlineIndex = text.indexOf('\n', segmentStart);
    }
    lineBuffer += text.slice(segmentStart);
    return safeRecordBoundaryOffsets;
  }

  function reportActivity(): void {
    options.onActivity?.({
      receivedStdoutBytes,
      lastEventType,
      displayEvent,
      model,
      provider,
    });
  }

  return {
    push(chunk): readonly number[] {
      if (finished) throw new Error('cannot push to a finished Claude stream collector');
      receivedStdoutBytes += chunk.byteLength;
      const sequenceBefore = displaySequence;
      const eventTypeBefore = lastEventType;
      const safeRecordBoundaryOffsets = consumeText(decoder.decode(chunk, { stream: true }));
      /*
       * 没有完整事件时仍上报字节活跃事实，供静默心跳判断流是否继续前进。
       * 已完整消费事件时 consumeEvent 已逐条回调，这里不得再重复上报。
       */
      if (displaySequence === sequenceBefore && lastEventType === eventTypeBefore) {
        reportActivity();
      }
      return safeRecordBoundaryOffsets;
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
  const model =
    input.stream.model === null
      ? null
      : input.redact(stripVTControlCharacters(input.stream.model));
  const provider =
    input.stream.provider === null
      ? null
      : input.redact(stripVTControlCharacters(input.stream.provider));
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
