/**
 * Task state machine (SPEC §6.2) and Ready Task selection (SPEC §9.1).
 *
 * Every transition carries its unique legal reason set; transitions for any
 * other reason — or outside the transition table — are rejected. Task Plan
 * definitions never carry runtime status; status lives only in run.json.
 */
import { ApexError } from './errors.js';
import type { RunStatus } from './run-state.js';
import type { PlannedTask } from './schemas/task-plan-draft.js';
import type { TaskRuntimeState, TaskStatus } from './schemas/task-runtime-state.js';

export type { TaskStatus } from './schemas/task-runtime-state.js';

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['completed', 'failed', 'skipped'];

/**
 * Legal transition reasons (SPEC §6.2 table). Each transition accepts exactly
 * the reasons listed here and no others.
 */
export type TaskTransitionReason =
  /** Orchestrator selected the task and saved the session facts before starting Claude. */
  | 'orchestrator_selected'
  /** A new Plan Revision explicitly omitted this old pending task. */
  | 'plan_revision_omitted'
  /** Claude legally returned `replan_required`. */
  | 'replan_required'
  /** SPEC changed during the session. */
  | 'spec_changed'
  /** Claude legally returned `completed` and the Git Checkpoint succeeded. */
  | 'completed_and_checkpointed'
  /** Claude invocation failed (start/stream/exit). */
  | 'claude_call_failed'
  /** Claude legally returned decision `failed`. */
  | 'reported_failure'
  /** Structured result failed the contract. */
  | 'result_invalid'
  /** Git Checkpoint failed. */
  | 'checkpoint_failed'
  /** Foreground interrupt. */
  | 'run_interrupted'
  /** User abandoned the Run. */
  | 'run_abandoned'
  /** The resume command reopens an interrupted/crashed Run. */
  | 'run_resumed';

/** transition key form: `<from>-><to>` */
export const TASK_TRANSITION_REASONS: Readonly<
  Record<string, readonly TaskTransitionReason[]>
> = {
  'pending->running': ['orchestrator_selected'],
  'pending->skipped': ['plan_revision_omitted'],
  'running->pending': ['replan_required', 'spec_changed', 'run_resumed'],
  'running->completed': ['completed_and_checkpointed'],
  'running->failed': [
    'claude_call_failed',
    'reported_failure',
    'result_invalid',
    'checkpoint_failed',
    'run_interrupted',
    'run_abandoned',
  ],
  // 仅 resume 命令：被中断（failed 且 failure 为 RUN_INTERRUPTED）的 Task
  // 复位后重新参与调度。
  'failed->pending': ['run_resumed'],
};

export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ['running', 'skipped'],
  running: ['pending', 'completed', 'failed'],
  completed: [],
  failed: ['pending'],
  skipped: [],
};

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status);
}

export function canTaskTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function legalTaskTransitionReasons(
  from: TaskStatus,
  to: TaskStatus,
): readonly TaskTransitionReason[] {
  return TASK_TRANSITION_REASONS[`${from}->${to}`] ?? [];
}

/**
 * Asserts that `from -> to` for `reason` is a legal task transition,
 * throwing ApexError otherwise.
 */
export function assertTaskTransition(
  from: TaskStatus,
  to: TaskStatus,
  reason: TaskTransitionReason,
): void {
  if (!canTaskTransition(from, to)) {
    throw new ApexError({
      code: 'STATE_VALIDATION_FAILED',
      stage: 'state',
      message: `illegal Task transition: ${from} -> ${to}`,
    });
  }
  if (!legalTaskTransitionReasons(from, to).includes(reason)) {
    throw new ApexError({
      code: 'STATE_VALIDATION_FAILED',
      stage: 'state',
      message: `reason ${reason} is not legal for Task transition ${from} -> ${to}`,
    });
  }
}

/**
 * Ready Task selection (SPEC §6.2 run conditions + §9.1 scheduling).
 *
 * A task is runnable only when the Run is `running`, the task is `pending`,
 * every dependsOn task is `completed` and no other task is `running`.
 * Selection scans `planTasks` in their stable tasks.json order and returns
 * the first runnable task ID, or `null` when nothing can run now.
 */
export function selectReadyTask(
  runStatus: RunStatus,
  planTasks: readonly PlannedTask[],
  taskStates: Readonly<Record<string, TaskRuntimeState>>,
): string | null {
  if (runStatus !== 'running') return null;
  for (const state of Object.values(taskStates)) {
    if (state.status === 'running') return null;
  }
  for (const task of planTasks) {
    const state = taskStates[task.id];
    if (!state || state.status !== 'pending') continue;
    const dependenciesCompleted = task.dependsOn.every(
      (dependencyId) => taskStates[dependencyId]?.status === 'completed',
    );
    if (dependenciesCompleted) return task.id;
  }
  return null;
}
