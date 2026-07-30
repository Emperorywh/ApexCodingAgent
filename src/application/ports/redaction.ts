/**
 * RedactionPort (SPEC §5.2, §18.4, NFR-006). The single redaction boundary:
 * every untrusted external string (Claude stdout/stderr, structured results,
 * Git errors, provider metadata, test commands, exception objects, user
 * visible diagnostics) passes through this port before reaching any sink —
 * logs/, Session Records, run.json/tasks.json, Plan Snapshots, report.md,
 * Archive Manifest diagnostics, console stdout/stderr.
 *
 * Redaction is a detection mechanism that lowers accidental persistence
 * risk; it is not an absolute credential-discovery guarantee (SPEC §18.4).
 */

/** Fixed placeholder; original values are never hashed, encoded or echoed. */
export const REDACTED_PLACEHOLDER = '[REDACTED]';

/** 流式脱敏的规则范围；调用方必须按输入边界显式选择。 */
export type ChunkRedactionScope = 'all' | 'record-spanning';

/** 不包含任何原文的安全审计事实，供结构化日志记录脱敏行为。 */
export interface RedactionAudit {
  readonly matchCount: number;
  readonly matchedRules: readonly string[];
}

/** 结构化值及其安全审计事实；审计信息只包含规则名和命中次数。 */
export interface StructuredRedactionResult<T> {
  readonly value: T;
  readonly audit: RedactionAudit;
}

/**
 * Streaming text redactor. Chunks may split a secret anywhere; the
 * implementation holds back an overlap window (SPEC §18.4) so a token
 * crossing a chunk boundary cannot bypass redaction. Concatenating
 * `push(...)` outputs plus the final `flush()` yields the fully redacted
 * stream.
 */
export interface ChunkRedactor {
  /** Accepts the next chunk; returns the portion now safe to emit. */
  push(chunk: string): string;
  /**
   * 通知实现当前位于调用方已经验证的逻辑记录边界。
   *
   * 不跨记录的规则可以据此提前排出；仍可能跨记录的多行规则会继续保留
   * 原始窗口，因此该方法不等同于结束整个输入流。
   */
  flushRecordBoundary(): string;
  /** Ends the stream; returns the remaining redacted text. */
  flush(): string;
}

export interface RedactionPort {
  /** Redacts secrets from a complete text (log lines, console output, markdown). */
  redactText(text: string): string;
  /**
   * 持久化前递归脱敏结构化 JSON：扫描所有字符串，并整体替换字段名命中
   * `token|secret|password|apiKey|authorization`（不区分大小写）的值。
   * 字符串、数字和布尔值分别使用同类型占位值，null 保持不变，因此脱敏后
   * 的记录仍是合法 JSON，也不会因占位符改变原字段的 JSON 类型。
   */
  redactStructured<T>(value: T): T;
  /**
   * 结构化脱敏并返回安全审计事实。
   *
   * 该入口服务于调试日志等需要解释“哪些类别被隐藏”的 Sink；它绝不返回
   * 原值、哈希、长度或可用于恢复秘密的片段。
   */
  redactStructuredWithAudit<T>(value: T): StructuredRedactionResult<T>;
  /**
   * 创建流式脱敏器。
   *
   * `all` 用于原始 stdout/stderr；`record-spanning` 只启用允许跨逻辑记录
   * 的规则，供 JSONL 写入器在不重复应用单记录规则的前提下检测跨记录秘密。
   */
  createChunkRedactor(scope: ChunkRedactionScope): ChunkRedactor;
}
