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
  const untrustedRedactor = options.redaction.createChunkRedactor();
  let initialized = false;
  let writeFailure: unknown | null = null;
  let filteredTelemetryCount = 0;
  let finished = false;

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

  /**
   * 所有结构化值先按字段类型脱敏，再序列化为单行 JSON。
   *
   * 数字和布尔敏感字段由 RedactionPort 保持原 JSON 类型，避免文本占位符
   * 把合法 stream-json 变成无法被标准解析器读取的损坏记录。
   */
  async function appendJson(value: Readonly<Record<string, unknown>>): Promise<void> {
    await ensureInitialized();
    const redacted = options.redaction.redactStructured(value);
    await record(() =>
      options.fileSystem.appendFile(absolute, encoder.encode(`${JSON.stringify(redacted)}\n`)),
    );
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
      if (filteredTelemetryCount > 0) {
        await appendJson({
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
        await appendJson({
          type: 'apex.stderr-diagnostic',
          summary: stderrSummary,
        });
      }
      await ensureInitialized();
    },
    failure: () => writeFailure,
  };
}
