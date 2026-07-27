/**
 * Run state machine (SPEC §6.1): six states, an explicit transition table and
 * the domain event table. Terminal states never recover; continued work
 * requires a new Run.
 */
import { ApexError } from './errors.js';
import { RUN_STATUSES, type RunStatus } from './schemas/run-json.js';

export type { RunStatus } from './schemas/run-json.js';

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['completed', 'failed', 'abandoned'];

export type RunEvent =
  | 'PLAN_ACCEPTED'
  | 'REPLAN_REQUESTED'
  | 'SPEC_CHANGED'
  | 'ALL_TASKS_COMPLETED'
  | 'FINAL_REVIEW_COMPLETED'
  | 'RUN_ERROR'
  | 'RUN_ABANDONED';

/** Pairwise allowed transitions, mirroring SPEC §6.1 exactly. */
export const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  planning: ['running', 'failed', 'abandoned'],
  running: ['planning', 'final_review', 'failed', 'abandoned'],
  final_review: ['planning', 'completed', 'failed', 'abandoned'],
  completed: [],
  failed: [],
  abandoned: [],
};

const NON_TERMINAL: readonly RunStatus[] = ['planning', 'running', 'final_review'];

/** Domain event table (SPEC §6.1). SPEC_CHANGED from planning stays planning. */
export const RUN_EVENT_TRANSITIONS: Readonly<
  Record<RunEvent, { readonly from: readonly RunStatus[]; readonly to: RunStatus }>
> = {
  PLAN_ACCEPTED: { from: ['planning'], to: 'running' },
  REPLAN_REQUESTED: { from: ['running', 'final_review'], to: 'planning' },
  SPEC_CHANGED: { from: ['planning', 'running', 'final_review'], to: 'planning' },
  ALL_TASKS_COMPLETED: { from: ['running'], to: 'final_review' },
  FINAL_REVIEW_COMPLETED: { from: ['final_review'], to: 'completed' },
  RUN_ERROR: { from: NON_TERMINAL, to: 'failed' },
  RUN_ABANDONED: { from: NON_TERMINAL, to: 'abandoned' },
};

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

export function canRunTransition(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!canRunTransition(from, to)) {
    throw new ApexError({
      code: 'STATE_VALIDATION_FAILED',
      stage: 'state',
      message: `illegal Run transition: ${from} -> ${to}`,
    });
  }
}

/**
 * Applies a domain event to a Run status, returning the new status.
 * Throws on events that are illegal for the current status (including any
 * event on a terminal Run).
 */
export function applyRunEvent(current: RunStatus, event: RunEvent): RunStatus {
  const transition = RUN_EVENT_TRANSITIONS[event];
  if (!transition.from.includes(current)) {
    throw new ApexError({
      code: 'STATE_VALIDATION_FAILED',
      stage: 'state',
      message: `Run event ${event} is not allowed in status ${current}`,
    });
  }
  return transition.to;
}

export function isRunStatus(value: string): value is RunStatus {
  return (RUN_STATUSES as readonly string[]).includes(value);
}
