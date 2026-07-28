/**
 * ClockPort (SPEC §5.2, NFR-005). All timestamps are program-generated;
 * callers format `now()` with the Domain pure function `formatRfc3339Utc`
 * (SPEC §11.5: UTC RFC 3339). The model never supplies timestamps.
 */

export interface ClockPort {
  now(): Date;
}
