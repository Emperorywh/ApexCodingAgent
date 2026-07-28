/**
 * System clock adapter (SPEC §5.2). Timestamps are formatted through the
 * Domain pure function `formatRfc3339Utc` — no formatting logic lives here.
 */
import type { ClockPort } from '../../application/ports/clock.js';

export function createSystemClock(): ClockPort {
  return {
    now(): Date {
      return new Date();
    },
  };
}
