/**
 * Claude Session 日志的结构化持久化边界。
 *
 * 上游解析器负责解释 stream-json 并给出显式记录分类；本模块只负责过滤
 * 高频遥测、结构化脱敏和增量写入。每一条落盘内容都是独立 JSON 对象，
 * 外部原始文本只能作为已脱敏字符串进入诊断信封，不能破坏 JSONL 结构。
 */
import type { FileSystemPort } from '../../application/ports/file-system.js';
import type { RedactionPort } from '../../application/ports/redaction.js';
import type { ClaudeStreamLogRecord } from './stream-parser.js';

export interface ClaudeSessionLog {
  /** 增量持久化解析器已经完成分类的记录。 */
  readonly push: (records: readonly ClaudeStreamLogRecord[]) => Promise<void>;
  /** 写入聚合遥测与 stderr 诊断，并关闭日志。 */
  readonly finish: (stderrSummary: string | null) => Promise<void>;
  /** 首个文件系统失败；没有失败时为 null。 */
  readonly failure: () => unknown | null;
}

export interface ClaudeSessionLogOptions {
  readonly repositoryRoot: string;
  readonly sessionId: string;
  readonly fileSystem: FileSystemPort;
  readonly redaction: RedactionPort;
}

/**
 * 创建单次 Session 独占的 JSONL 写入器。
 *
 * 文件操作保持原有回压语义：每次 append 都等待完成；首个写入失败后不再
 * 触碰文件系统，让 Claude 进程先到达真实退出边界，再由调用方统一映射错误。
 */
export function createClaudeSessionLog(options: ClaudeSessionLogOptions): ClaudeSessionLog {
  const root = options.repositoryRoot.replace(/[\\/]+$/, '');
  const absolute = `${root}/.apex-coding-agent/logs/${options.sessionId}.log`;
  const parent = absolute.slice(0, absolute.lastIndexOf('/'));
  const encoder = new TextEncoder();
  const untrustedRedactor = options.redaction.createChunkRedactor('all');
  const recordSpanningRedactor =
    options.redaction.createChunkRedactor('record-spanning');
  let initialized = false;
  let writeFailure: unknown | null = null;
  let filteredTelemetryCount = 0;
  let finished = false;
  let pendingRecordCount = 0;
  let pendingRecordInput = '';
  let pendingRecordOutput = '';

  async function record(operation: () => Promise<void>): Promise<void> {
    if (writeFailure !== null) return;
    try {
      await operation();
    } catch (error) {
      writeFailure = error;
    }
  }

  async function ensureInitialized(): Promise<void> {
    if (initialized || writeFailure !== null) return;
    initialized = true;
    await record(async () => {
      await options.fileSystem.mkdir(parent, { recursive: true });
      await options.fileSystem.writeFile(absolute, new Uint8Array(0));
    });
  }

  /** 只追加已经脱敏并完成 JSONL 边界处理的文本。 */
  async function appendText(text: string): Promise<void> {
    if (text === '') return;
    await ensureInitialized();
    await record(() =>
      options.fileSystem.appendFile(absolute, encoder.encode(text)),
    );
  }

  /**
   * 写入已经确认不再参与 stdout 跨记录检测的安全 JSON 对象。
   *
   * 该入口只用于程序生成的摘要和已完成流式脱敏的 stderr；Claude stdout
   * 事件必须走 appendJson，不能绕过跨记录私钥检测。
   */
  async function appendSafeJson(value: Readonly<Record<string, unknown>>): Promise<void> {
    const redacted = options.redaction.redactStructured(value);
    await appendText(`${JSON.stringify(redacted)}\n`);
  }

  /**
   * 对单记录先做类型安全脱敏，再用只含跨记录规则的流式窗口检查相邻记录。
   *
   * 数字和布尔敏感字段由 RedactionPort 保持原 JSON 类型，避免文本占位符
   * 把合法 stream-json 变成无法被标准解析器读取的损坏记录。
   *
   * 一旦规则确实跨越多条 JSONL 记录，不能直接把文本替换结果写回，因为不同
   * 事件结构可能被拼成非法 JSON；这里丢弃整批受影响记录并写安全计数摘要。
   */
  async function appendJson(value: Readonly<Record<string, unknown>>): Promise<void> {
    const redacted = options.redaction.redactStructured(value);
    const serialized = `${JSON.stringify(redacted)}\n`;
    pendingRecordCount += 1;
    pendingRecordInput += serialized;
    pendingRecordOutput += recordSpanningRedactor.push(serialized);
    const boundaryOutput = recordSpanningRedactor.flushRecordBoundary();
    if (boundaryOutput === '') return;
    pendingRecordOutput += boundaryOutput;

    if (pendingRecordOutput === pendingRecordInput) {
      await appendText(pendingRecordInput);
    } else {
      await appendSafeJson({
        type: 'apex.redacted-records',
        reason: 'record-spanning-secret',
        count: pendingRecordCount,
      });
    }
    pendingRecordCount = 0;
    pendingRecordInput = '';
    pendingRecordOutput = '';
  }

  /**
   * 流结束时仍被保留的记录含有未闭合跨记录秘密起点。
   *
   * 与普通文本 flush 不同，Session 日志宁可丢弃这些诊断事件，也不能把一个
   * BEGIN 私钥块及其后续正文原样落盘；计数摘要保留最小可观察事实。
   */
  async function finishRecordStream(): Promise<void> {
    if (pendingRecordCount === 0) {
      recordSpanningRedactor.flush();
      return;
    }
    recordSpanningRedactor.flush();
    await appendSafeJson({
      type: 'apex.redacted-records',
      reason: 'unclosed-record-spanning-secret',
      count: pendingRecordCount,
    });
    pendingRecordCount = 0;
    pendingRecordInput = '';
    pendingRecordOutput = '';
  }

  /** 把非法流原文封装为安全 JSON 字符串，同时保留跨行秘密的检测窗口。 */
  async function appendUntrustedFragment(fragment: string): Promise<void> {
    if (fragment === '') return;
    await appendJson({
      type: 'apex.invalid-stream-fragment',
      detail: fragment,
    });
  }

  return {
    async push(records): Promise<void> {
      if (finished) throw new Error('cannot write to a finished session log');
      for (const logRecord of records) {
        if (logRecord.kind === 'event') {
          await appendJson(logRecord.event);
          continue;
        }
        if (logRecord.kind === 'telemetry') {
          filteredTelemetryCount += 1;
          continue;
        }
        await appendUntrustedFragment(untrustedRedactor.push(`${logRecord.line}\n`));
      }
    },
    async finish(stderrSummary): Promise<void> {
      if (finished) throw new Error('session log finish called more than once');
      finished = true;
      await appendUntrustedFragment(untrustedRedactor.flush());
      await finishRecordStream();
      if (filteredTelemetryCount > 0) {
        await appendSafeJson({
          type: 'apex.log-summary',
          filteredEvents: [
            {
              category: 'system/thinking',
              count: filteredTelemetryCount,
            },
          ],
        });
      }
      if (stderrSummary !== null) {
        await appendSafeJson({
          type: 'apex.stderr-diagnostic',
          summary: stderrSummary,
        });
      }
      await ensureInitialized();
    },
    failure: () => writeFailure,
  };
}
