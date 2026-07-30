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
  /** Creates a streaming redactor for chunked text (e.g. Claude stdout). */
  createChunkRedactor(): ChunkRedactor;
}
