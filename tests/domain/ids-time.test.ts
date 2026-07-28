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
import { isGitRelativePath } from '../../src/domain/paths.js';
import { formatRfc3339Utc, isRfc3339Utc } from '../../src/domain/time.js';
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

  it('validates full lowercase Git OIDs for SHA-1 and SHA-256 repositories', () => {
    expect(isGitOid('b'.repeat(40))).toBe(true);
    expect(isGitOid('b'.repeat(64))).toBe(true);
    expect(isGitOid('b'.repeat(39))).toBe(false);
    expect(isGitOid('b'.repeat(41))).toBe(false);
    expect(isGitOid('b'.repeat(63))).toBe(false);
    expect(isGitOid('b'.repeat(65))).toBe(false);
    expect(isGitOid('B'.repeat(40))).toBe(false);
    expect(isGitOid('B'.repeat(64))).toBe(false);
  });

  it('validates Run Branch names', () => {
    expect(isRunBranch(`apex-coding-agent/${RUN_ID}`)).toBe(true);
    expect(isRunBranch(`feature/${RUN_ID}`)).toBe(false);
    expect(isRunBranch(RUN_ID)).toBe(false);
  });
});

describe('Git relative paths', () => {
  it('accepts normalized repository-relative paths', () => {
    expect(isGitRelativePath('SPEC.md')).toBe(true);
    expect(isGitRelativePath('docs/sessions/G1.md')).toBe(true);
    expect(isGitRelativePath('.apex/report.json')).toBe(true);
  });

  it('rejects absolute, escaping, ambiguous and backslash paths', () => {
    /**
     * 持久化路径只允许 Git 风格正斜杠表示法。
     * 任何盘符、绝对路径、空段或点段都必须在进入 Adapter 前被拒绝。
     */
    for (const path of [
      '',
      '/docs/SPEC.md',
      'C:/repo/SPEC.md',
      'C:\\repo\\SPEC.md',
      '../SPEC.md',
      'docs/../SPEC.md',
      './SPEC.md',
      'docs//SPEC.md',
      'docs\\SPEC.md',
    ]) {
      expect(isGitRelativePath(path)).toBe(false);
    }
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

  it('formats Dates as UTC RFC 3339 accepted by the validator', () => {
    expect(formatRfc3339Utc(new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 6)))).toBe(
      '2026-01-02T03:04:05.006Z',
    );
    expect(isRfc3339Utc(formatRfc3339Utc(new Date(Date.UTC(1999, 11, 31, 23, 59, 59))))).toBe(
      true,
    );
    expect(() => formatRfc3339Utc(new Date(Number.NaN))).toThrow(RangeError);
  });
});
