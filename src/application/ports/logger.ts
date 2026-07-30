/**
 * LoggerPort：面向开发者的结构化调试日志口（SPEC §5.2 Application Ports、
 * §18.4 脱敏边界）。
 *
 * 与 OutputPort 的分工：OutputPort 承载单行、用户可见的进度摘要；
 * LoggerPort 承载排查 agent 自身行为用的详细事实（事件名 + 标量字段），
 * 默认落盘到 logs/apex-debug.log，--verbose 时由实现镜像到 stderr。
 *
 * 实现必须满足：
 * - `log` 同步返回，异步落盘由实现内部串行化，写失败绝不抛出、不影响 Run；
 * - 整条结构化记录到达任何 sink（文件/控制台）前必须经过 RedactionPort；
 * - 实现可以记录规则名和命中次数，但不得记录原值、哈希、长度或局部片段；
 * - 字段只放标量；Error 对象由调用方拆成 errorCode/message/stack 等字段。
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, string | number | boolean | null>;

export interface LoggerPort {
  /**
   * 记录一条结构化事件。`event` 使用 dot.case 稳定标识
   * （如 `session.invoke.end`），调用方不得在 event 中拼接不可信文本。
   */
  log(level: LogLevel, event: string, fields?: LogFields): void;
  /**
   * 等待已入队的事件全部落盘后 resolve；之后仍可继续 log。进程收尾与
   * 归档前必须调用，避免丢失尾部事件。
   */
  flush(): Promise<void>;
}

/** 丢弃全部事件的空实现：测试与未装配调试日志的场景使用。 */
export function createNullLogger(): LoggerPort {
  return {
    log: () => undefined,
    flush: () => Promise.resolve(),
  };
}
