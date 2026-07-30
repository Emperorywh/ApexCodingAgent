/**
 * ClockPort（SPEC §5.2、NFR-005）。
 *
 * 所有时间戳均由程序生成；调用方使用 Domain 的
 * `formatRfc3339InSystemTimeZone` 按当前操作系统时区格式化 `now()`，
 * 模型永远不提供时间戳。
 */

export interface ClockPort {
  now(): Date;
}
