/**
 * System clock adapter (ClockPort, NFR-005).
 */
import { describe, expect, it } from 'vitest';
import { createSystemClock } from '../../../src/adapters/clock/system-clock.js';
import {
  formatRfc3339InSystemTimeZone,
  isRfc3339,
} from '../../../src/domain/time.js';

describe('system clock', () => {
  it('returns the current time as a Date', () => {
    const clock = createSystemClock();
    const before = Date.now();
    const now = clock.now();
    const after = Date.now();
    expect(now).toBeInstanceOf(Date);
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
    expect(now.getTime()).toBeLessThanOrEqual(after);
  });

  it('formats through the Domain function in the operating-system time zone', () => {
    const clock = createSystemClock();
    /*
     * 系统时钟只提供 Date，时区序列化仍集中在 Domain；这里验证真实适配器
     * 与统一格式化入口组合后得到合法且显式带偏移量的时间。
     */
    const formatted = formatRfc3339InSystemTimeZone(clock.now());
    expect(isRfc3339(formatted)).toBe(true);
    expect(formatted).toMatch(/[+-]\d{2}:\d{2}$/);
  });
});
