/**
 * Identifier and hash format validation (SPEC §11.5 common rules).
 *
 * Pure format checks only — generation of IDs is an Application-layer duty
 * (G5 uses `globalThis.crypto.randomUUID()`), so nothing here creates values.
 */

/** Canonical lowercase UUID (Session IDs). */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Run ID: `RUN-<UUID>` with a canonical lowercase UUID part. */
export const RUN_ID_PATTERN = /^RUN-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Task ID: TASK-001 .. TASK-999 (numeric part 1..999, zero-padded to 3). */
export const TASK_ID_PATTERN = /^TASK-(?!000)\d{3}$/;

/** SHA-256 as 64 lowercase hex chars, always computed over raw bytes. */
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** Full lowercase Git object ID (SHA-1). */
export const GIT_OID_PATTERN = /^[0-9a-f]{40}$/;

export const RUN_BRANCH_PREFIX = 'apex-coding-agent/';

/** Run Branch: `apex-coding-agent/<run-id>` (SPEC §8.3). */
export const RUN_BRANCH_PATTERN =
  /^apex-coding-agent\/RUN-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function isRunId(value: string): boolean {
  return RUN_ID_PATTERN.test(value);
}

export function isTaskId(value: string): boolean {
  return TASK_ID_PATTERN.test(value);
}

export function isSha256(value: string): boolean {
  return SHA256_PATTERN.test(value);
}

export function isGitOid(value: string): boolean {
  return GIT_OID_PATTERN.test(value);
}

export function isRunBranch(value: string): boolean {
  return RUN_BRANCH_PATTERN.test(value);
}

/**
 * Numeric part of a Task ID (1..999), or `null` when the format is invalid.
 * Task ID numbers must never exceed 999 within a Run (SPEC §7.5).
 */
export function taskIdNumber(value: string): number | null {
  if (!TASK_ID_PATTERN.test(value)) return null;
  return Number.parseInt(value.slice('TASK-'.length), 10);
}
