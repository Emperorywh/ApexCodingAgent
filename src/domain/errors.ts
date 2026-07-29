/**
 * Stable error model (SPEC §15.2/§15.3).
 *
 * Every failure surfaced by the system carries a stable `errorCode`; the code
 * deterministically maps to an `errorClass` which drives run-level behavior.
 * Domain code throws {@link ApexError} with these codes instead of ad-hoc
 * strings.
 */

export const ERROR_CLASSES = [
  'startup_validation',
  'run_error',
  'run_control',
  'claude_error',
  'plan_error',
  'git_error',
  'state_error',
  'report_error',
  'command_error',
] as const;

export type ErrorClass = (typeof ERROR_CLASSES)[number];

/** errorCode -> errorClass, mirroring SPEC §15.3 exactly. */
export const ERROR_CODE_TO_CLASS = {
  // startup_validation
  ENVIRONMENT_UNSUPPORTED: 'startup_validation',
  SPEC_NOT_FOUND: 'startup_validation',
  SPEC_AMBIGUOUS: 'startup_validation',
  SPEC_EMPTY: 'startup_validation',
  SPEC_NOT_REGULAR_FILE: 'startup_validation',
  SPEC_NOT_READABLE: 'startup_validation',
  SPEC_INVALID_UTF8: 'startup_validation',
  SPEC_OUTSIDE_REPOSITORY: 'startup_validation',
  SPEC_STAGED: 'startup_validation',
  WORKING_TREE_DIRTY: 'startup_validation',
  STATE_DIRECTORY_TRACKED: 'startup_validation',
  STATE_DIRECTORY_UNWRITABLE: 'startup_validation',
  GIT_UNAVAILABLE: 'startup_validation',
  GIT_WORKTREE_REQUIRED: 'startup_validation',
  GIT_HEAD_REQUIRED: 'startup_validation',
  BASE_BRANCH_REQUIRED: 'startup_validation',
  CLAUDE_CAPABILITY_MISSING: 'startup_validation',
  CLAUDE_INSTALLATION_UNHEALTHY: 'startup_validation',
  SETTINGS_INVALID: 'startup_validation',
  RUN_ALREADY_ACTIVE_OR_INTERRUPTED: 'startup_validation',
  STATE_INVALID: 'startup_validation',
  ARCHIVE_FAILED: 'startup_validation',
  ARCHIVE_CONFLICT: 'startup_validation',
  // run_error
  RUN_INTERRUPTED: 'run_error',
  // run_control
  RUN_ABANDONED_BY_USER: 'run_control',
  // claude_error
  CLAUDE_START_FAILED: 'claude_error',
  CLAUDE_EXIT_NONZERO: 'claude_error',
  CLAUDE_STREAM_FAILED: 'claude_error',
  CLAUDE_RESUME_UNAVAILABLE: 'claude_error',
  CLAUDE_RESULT_INVALID: 'claude_error',
  CLAUDE_REPORTED_FAILURE: 'claude_error',
  FINAL_REVIEW_RESULT_INVALID: 'claude_error',
  // plan_error
  PLAN_INVALID: 'plan_error',
  PLAN_REVISION_CONFLICT: 'plan_error',
  PLAN_REVISION_LIMIT_EXCEEDED: 'plan_error',
  // git_error
  GIT_COMMAND_FAILED: 'git_error',
  GIT_FACT_CONFLICT: 'git_error',
  GIT_HISTORY_DIVERGED: 'git_error',
  PLANNING_SIDE_EFFECT_DETECTED: 'git_error',
  PROTECTED_PATH_CHANGED: 'git_error',
  // state_error
  STATE_WRITE_FAILED: 'state_error',
  STATE_VALIDATION_FAILED: 'state_error',
  // report_error
  FINAL_REPORT_GENERATION_FAILED: 'report_error',
  // command_error
  CLI_USAGE_INVALID: 'command_error',
  RUN_NOT_FOUND: 'command_error',
  COMMAND_STATE_INVALID: 'command_error',
  REPORT_NOT_AVAILABLE: 'command_error',
  REPORT_COMMAND_FAILED: 'command_error',
  STATE_SNAPSHOT_BUSY: 'command_error',
  RUN_NOT_ABANDONABLE: 'command_error',
  ABANDON_REQUIRES_FORCE: 'command_error',
  RUN_NOT_RESUMABLE: 'command_error',
  RESUME_REQUIRES_FORCE: 'command_error',
} as const satisfies Record<string, ErrorClass>;

export type ErrorCode = keyof typeof ERROR_CODE_TO_CLASS;

export const ERROR_CODES = Object.keys(ERROR_CODE_TO_CLASS) as ErrorCode[];

export function errorClassForCode(code: ErrorCode): ErrorClass {
  return ERROR_CODE_TO_CLASS[code];
}

export interface ApexErrorInit {
  readonly code: ErrorCode;
  /** Stage where the failure occurred, e.g. "startup", "planning", "execution". */
  readonly stage: string;
  readonly message: string;
  /** Redacted, semantics-preserving tool output summary, when available. */
  readonly toolSummary?: string | null;
  readonly sessionId?: string | null;
  readonly taskId?: string | null;
  readonly cause?: unknown;
}

/**
 * The single error type thrown across the system. Carries the stable error
 * code and its derived class; timestamps are supplied by callers when the
 * error is persisted as an Error Record (time is program-generated upstream).
 */
export class ApexError extends Error {
  readonly errorCode: ErrorCode;
  readonly errorClass: ErrorClass;
  readonly stage: string;
  readonly toolSummary: string | null;
  readonly sessionId: string | null;
  readonly taskId: string | null;

  constructor(init: ApexErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'ApexError';
    this.errorCode = init.code;
    this.errorClass = errorClassForCode(init.code);
    this.stage = init.stage;
    this.toolSummary = init.toolSummary ?? null;
    this.sessionId = init.sessionId ?? null;
    this.taskId = init.taskId ?? null;
  }
}

export function isApexError(value: unknown): value is ApexError {
  return value instanceof ApexError;
}
