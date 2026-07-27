/**
 * ID / hash / time format validation (SPEC §11.5 common rules).
 */
import { describe, expect, it } from 'vitest';
import {
  isGitOid,
  isRunBranch,
  isRunId,
  isSha256,
  isTaskId,
  isUuid,
  taskIdNumber,
} from '../../src/domain/ids.js';
import { isRfc3339Utc } from '../../src/domain/time.js';
import { RUN_ID, UUID_1 } from './fixtures.js';

describe('ids', () => {
  it('accepts canonical lowercase UUIDs only', () => {
    expect(isUuid(UUID_1)).toBe(true);
    expect(isUuid(UUID_1.toUpperCase())).toBe(false);
    expect(isUuid('123e4567-e89b-42d3-a456')).toBe(false);
    expect(isUuid('123e4567-e89b-42d3-a456-42661417400g')).toBe(false);
    expect(isUuid('')).toBe(false);
  });

  it('validates Run IDs as RUN-<uuid>', () => {
    expect(isRunId(RUN_ID)).toBe(true);
    expect(isRunId(UUID_1)).toBe(false);
    expect(isRunId(`run-${UUID_1}`)).toBe(false);
    expect(isRunId(`RUN-${UUID_1.toUpperCase()}`)).toBe(false);
  });

  it('validates Task IDs as TASK-001..TASK-999', () => {
    expect(isTaskId('TASK-001')).toBe(true);
    expect(isTaskId('TASK-999')).toBe(true);
    expect(isTaskId('TASK-000')).toBe(false);
    expect(isTaskId('TASK-1000')).toBe(false);
    expect(isTaskId('TASK-1')).toBe(false);
    expect(isTaskId('task-001')).toBe(false);
  });

  it('extracts the numeric part of Task IDs', () => {
    expect(taskIdNumber('TASK-042')).toBe(42);
    expect(taskIdNumber('TASK-999')).toBe(999);
    expect(taskIdNumber('TASK-000')).toBeNull();
    expect(taskIdNumber('nope')).toBeNull();
  });

  it('validates SHA-256 as 64 lowercase hex chars', () => {
    expect(isSha256('a'.repeat(64))).toBe(true);
    expect(isSha256('a'.repeat(63))).toBe(false);
    expect(isSha256('a'.repeat(65))).toBe(false);
    expect(isSha256('A'.repeat(64))).toBe(false);
    expect(isSha256('g'.repeat(64))).toBe(false);
  });

  it('validates Git OIDs as 40 lowercase hex chars', () => {
    expect(isGitOid('b'.repeat(40))).toBe(true);
    expect(isGitOid('b'.repeat(39))).toBe(false);
    expect(isGitOid('b'.repeat(41))).toBe(false);
    expect(isGitOid('B'.repeat(40))).toBe(false);
  });

  it('validates Run Branch names', () => {
    expect(isRunBranch(`apex-coding-agent/${RUN_ID}`)).toBe(true);
    expect(isRunBranch(`feature/${RUN_ID}`)).toBe(false);
    expect(isRunBranch(RUN_ID)).toBe(false);
  });
});

describe('time', () => {
  it('accepts UTC RFC 3339 with Z designator', () => {
    expect(isRfc3339Utc('2026-01-01T00:00:00Z')).toBe(true);
    expect(isRfc3339Utc('2026-01-01T00:00:00.123Z')).toBe(true);
    expect(isRfc3339Utc('2026-02-29T23:59:59Z')).toBe(false); // 2026 is not a leap year
    expect(isRfc3339Utc('2024-02-29T23:59:59Z')).toBe(true); // 2024 is a leap year
  });

  it('rejects offsets, missing Z and out-of-range components', () => {
    expect(isRfc3339Utc('2026-01-01T00:00:00+08:00')).toBe(false);
    expect(isRfc3339Utc('2026-01-01T00:00:00')).toBe(false);
    expect(isRfc3339Utc('2026-13-01T00:00:00Z')).toBe(false);
    expect(isRfc3339Utc('2026-01-32T00:00:00Z')).toBe(false);
    expect(isRfc3339Utc('2026-01-01T24:00:00Z')).toBe(false);
    expect(isRfc3339Utc('2026-02-30T00:00:00Z')).toBe(false);
    expect(isRfc3339Utc('not-a-date')).toBe(false);
  });
});
