/**
 * 调试文件日志适配器（SPEC §18.4 脱敏边界、NFR-005）：LoggerPort 的落盘实现。
 *
 * - 输出为 JSON Lines：每行 `{"ts","level","event",...fields}`，时间戳为
 *   RFC3339 UTC；整行在到达任何 sink 前统一过 RedactionPort；
 * - `log` 同步返回：追加写经内部 Promise 链串行化，保证行序与调用序一致；
 *   首次写入前惰性创建父目录（此时状态目录必然已存在）；
 * - 写失败只回调 `onWriteFailure` 诊断，绝不抛出、不打断后续写入——调试
 *   日志不得影响 Run 本身；
 * - `mirror`（--verbose 的 stderr 镜像）同步调用，与文件写入解耦。
 */
import { formatRfc3339Utc } from '../../domain/time.js';
import type { ClockPort } from '../../application/ports/clock.js';
import type { FileSystemPort } from '../../application/ports/file-system.js';
import type { LoggerPort, LogFields, LogLevel } from '../../application/ports/logger.js';
import type { RedactionPort } from '../../application/ports/redaction.js';

export interface DebugFileLoggerOptions {
  readonly fileSystem: FileSystemPort;
  readonly clock: ClockPort;
  readonly redaction: RedactionPort;
  /** 调试日志绝对路径（`/` 分隔），如 `<stateDir>/logs/apex-debug.log`。 */
  readonly logPath: string;
  /** 可选同步镜像 sink（--verbose 的 stderr）；入参为已脱敏的整行。 */
  readonly mirror?: ((line: string) => void) | null;
  /** 落盘失败诊断回调；入参为已脱敏的一行说明。 */
  readonly onWriteFailure?: ((detail: string) => void) | null;
}

export function createDebugLogger(options: DebugFileLoggerOptions): LoggerPort {
  const encoder = new TextEncoder();
  const parentDir = options.logPath.slice(0, options.logPath.lastIndexOf('/'));
  /** 追加写串行化链：行序与 log 调用序一致，失败在链内消化。 */
  let tail: Promise<void> = Promise.resolve();
  let dirReady = false;

  function serialize(level: LogLevel, event: string, fields: LogFields | undefined): string {
    return JSON.stringify({
      ts: formatRfc3339Utc(options.clock.now()),
      level,
      event,
      ...fields,
    });
  }

  function enqueue(line: string): void {
    tail = tail.then(async () => {
      if (!dirReady) {
        await options.fileSystem.mkdir(parentDir, { recursive: true });
        dirReady = true;
      }
      await options.fileSystem.appendFile(options.logPath, encoder.encode(`${line}\n`));
    });
    tail = tail.catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      options.onWriteFailure?.(
        options.redaction.redactText(`debug log write failed (${options.logPath}): ${detail}`),
      );
    });
  }

  return {
    log(level: LogLevel, event: string, fields?: LogFields): void {
      const line = options.redaction.redactText(serialize(level, event, fields));
      options.mirror?.(line);
      enqueue(line);
    },
    flush(): Promise<void> {
      return tail;
    },
  };
}
