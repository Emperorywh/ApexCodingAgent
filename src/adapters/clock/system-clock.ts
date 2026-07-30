/**
 * 系统时钟适配器（SPEC §5.2）。
 *
 * 本层只读取当前时间；操作系统时区下的 RFC 3339 格式化统一由
 * Domain 的 `formatRfc3339InSystemTimeZone` 完成。
 */
import type { ClockPort } from '../../application/ports/clock.js';

export function createSystemClock(): ClockPort {
  return {
    now(): Date {
      return new Date();
    },
  };
}
