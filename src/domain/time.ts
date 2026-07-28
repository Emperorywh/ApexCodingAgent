/**
 * Time format validation and formatting (SPEC §11.5: program-generated, UTC
 * RFC 3339).
 *
 * Pure functions only — the clock itself is injected via ClockPort
 * (Application/Adapter layers); the Domain and the model never read a clock.
 */

/** UTC RFC 3339 with mandatory `Z` designator, optional fractional seconds. */
export const RFC3339_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const RFC3339_UTC_GROUPS =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?Z$/;

export function isRfc3339Utc(value: string): boolean {
  const match = RFC3339_UTC_GROUPS.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;
  // Reject non-existent calendar days (e.g. 2026-02-30) that parse by rolling over.
  const date = new Date(parsed);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * Formats a Date as UTC RFC 3339 (`YYYY-MM-DDTHH:mm:ss.sssZ`). This is the
 * single formatter for every program-generated timestamp (SPEC §11.5).
 * Throws a RangeError for an invalid Date.
 */
export function formatRfc3339Utc(date: Date): string {
  return date.toISOString();
}
