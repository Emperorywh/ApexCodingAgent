/**
 * Error model (SPEC §15.2/§15.3): stable errorCode → errorClass mapping and
 * the ApexError shape.
 */
import { describe, expect, it } from 'vitest';
import {
  ApexError,
  ERROR_CLASSES,
  ERROR_CODE_TO_CLASS,
  ERROR_CODES,
  errorClassForCode,
  isApexError,
  type ErrorClass,
  type ErrorCode,
} from '../../src/domain/errors.js';

const EXPECTED_TABLE: Record<ErrorClass, readonly ErrorCode[]> = {
  startup_validation: [
    'ENVIRONMENT_UNSUPPORTED',
    'SPEC_NOT_FOUND',
    'SPEC_AMBIGUOUS',
    'SPEC_EMPTY',
    'SPEC_NOT_REGULAR_FILE',
    'SPEC_NOT_READABLE',
    'SPEC_INVALID_UTF8',
    'SPEC_OUTSIDE_REPOSITORY',
    'SPEC_STAGED',
    'WORKING_TREE_DIRTY',
    'STATE_DIRECTORY_TRACKED',
    'STATE_DIRECTORY_UNWRITABLE',
    'GIT_UNAVAILABLE',
    'GIT_WORKTREE_REQUIRED',
    'GIT_HEAD_REQUIRED',
    'BASE_BRANCH_REQUIRED',
    'GIT_REMOTE_INVALID',
    'CLAUDE_CAPABILITY_MISSING',
    'CLAUDE_INSTALLATION_UNHEALTHY',
    'SETTINGS_INVALID',
    'RUN_ALREADY_ACTIVE_OR_INTERRUPTED',
    'STATE_INVALID',
    'ARCHIVE_FAILED',
    'ARCHIVE_CONFLICT',
  ],
  run_error: ['RUN_INTERRUPTED'],
  run_control: ['RUN_ABANDONED_BY_USER'],
  claude_error: [
    'CLAUDE_START_FAILED',
    'CLAUDE_EXIT_NONZERO',
    'CLAUDE_STREAM_FAILED',
    'CLAUDE_RESUME_UNAVAILABLE',
    'CLAUDE_RESULT_INVALID',
    'CLAUDE_REPORTED_FAILURE',
    'PLAN_REVIEW_RESULT_INVALID',
    'TASK_REVIEW_RESULT_INVALID',
    'FINAL_REVIEW_RESULT_INVALID',
  ],
  plan_error: [
    'PLAN_INVALID',
    'PLAN_REVISION_CONFLICT',
    'PLAN_REVISION_LIMIT_EXCEEDED',
    'PLAN_REVIEW_REWORK_LIMIT_EXCEEDED',
    'TASK_REVIEW_REWORK_LIMIT_EXCEEDED',
  ],
  git_error: [
    'GIT_COMMAND_FAILED',
    'GIT_FACT_CONFLICT',
    'GIT_HISTORY_DIVERGED',
    'PLANNING_SIDE_EFFECT_DETECTED',
    'PLAN_REVIEW_SIDE_EFFECT_DETECTED',
    'TASK_REVIEW_SIDE_EFFECT_DETECTED',
    'PROTECTED_PATH_CHANGED',
    'GIT_PUSH_FAILED',
  ],
  state_error: ['STATE_WRITE_FAILED', 'STATE_VALIDATION_FAILED'],
  report_error: ['FINAL_REPORT_GENERATION_FAILED'],
  command_error: [
    'CLI_USAGE_INVALID',
    'RUN_NOT_FOUND',
    'COMMAND_STATE_INVALID',
    'REPORT_NOT_AVAILABLE',
    'REPORT_COMMAND_FAILED',
    'STATE_SNAPSHOT_BUSY',
    'RUN_NOT_ABANDONABLE',
    'ABANDON_REQUIRES_FORCE',
    'RUN_NOT_RESUMABLE',
    'RESUME_REQUIRES_FORCE',
  ],
};

describe('error model (§15)', () => {
  it('defines exactly 61 stable error codes and 9 error classes', () => {
    expect(ERROR_CODES).toHaveLength(61);
    expect(ERROR_CLASSES).toHaveLength(9);
  });

  it('maps every errorCode to its §15.3 errorClass', () => {
    for (const [errorClass, codes] of Object.entries(EXPECTED_TABLE)) {
      for (const code of codes) {
        expect(errorClassForCode(code)).toBe(errorClass);
        expect(ERROR_CODE_TO_CLASS[code]).toBe(errorClass);
      }
    }
  });

  it('covers every expected code exactly once', () => {
    const allExpected = Object.values(EXPECTED_TABLE).flat();
    expect(allExpected).toHaveLength(61);
    expect([...ERROR_CODES].sort()).toEqual([...allExpected].sort());
  });

  it('ApexError carries code, derived class, stage and optional facts', () => {
    const error = new ApexError({
      code: 'CLAUDE_EXIT_NONZERO',
      stage: 'execution',
      message: 'claude exited 1',
      toolSummary: 'exit 1',
      sessionId: '123e4567-e89b-42d3-a456-426614174000',
      taskId: 'TASK-001',
    });
    expect(error.errorCode).toBe('CLAUDE_EXIT_NONZERO');
    expect(error.errorClass).toBe('claude_error');
    expect(error.stage).toBe('execution');
    expect(error.message).toBe('claude exited 1');
    expect(error.toolSummary).toBe('exit 1');
    expect(error.sessionId).toBe('123e4567-e89b-42d3-a456-426614174000');
    expect(error.taskId).toBe('TASK-001');
    expect(isApexError(error)).toBe(true);
  });

  it('ApexError defaults optional facts to null', () => {
    const error = new ApexError({ code: 'PLAN_INVALID', stage: 'planning', message: 'bad plan' });
    expect(error.toolSummary).toBeNull();
    expect(error.sessionId).toBeNull();
    expect(error.taskId).toBeNull();
    expect(isApexError(new Error('nope'))).toBe(false);
  });
});
