/**
 * System clock adapter (ClockPort, NFR-005).
 */
import { describe, expect, it } from 'vitest';
import { createSystemClock } from '../../../src/adapters/clock/system-clock.js';
import { isRfc3339Utc, formatRfc3339Utc } from '../../../src/domain/time.js';

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

  it('formats through the Domain pure function as UTC RFC 3339', () => {
    const clock = createSystemClock();
    expect(isRfc3339Utc(formatRfc3339Utc(clock.now()))).toBe(true);
  });
});
