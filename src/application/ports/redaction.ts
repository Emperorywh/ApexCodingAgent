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
   * Deep-redacts a structured JSON value before persistence: every string is
   * scanned, and values whose field name matches
   * `token|secret|password|apiKey|authorization` (case-insensitive) are
   * replaced wholesale. JSON types are preserved (only strings are replaced,
   * with a string placeholder), so schema validity survives redaction.
   */
  redactStructured<T>(value: T): T;
  /** Creates a streaming redactor for chunked text (e.g. Claude stdout). */
  createChunkRedactor(): ChunkRedactor;
}
