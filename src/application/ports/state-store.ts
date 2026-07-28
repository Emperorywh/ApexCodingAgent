/**
 * StateStorePort (SPEC §5.2, §11.1–11.2). JSON state persistence for the
 * Coordinator — the single programmatic writer of `run.json`, `tasks.json`,
 * `plans/` and `sessions/` (SPEC §4.3).
 *
 * Contract implemented by `src/adapters/state/`:
 * - Write protocol (SPEC §11.2): serialize → same-directory temp → close →
 *   rename → reopen and schema-validate. I/O failures map to
 *   `STATE_WRITE_FAILED`; content that fails schema or Domain validation maps
 *   to `STATE_VALIDATION_FAILED`. No previous files, no journal, no
 *   cross-file transaction.
 * - Only aggregates that passed Domain validation are persisted (SPEC §5.5).
 * - Every successful `run.json` replacement strictly increases
 *   `stateRevision`; when `planRevision > 0`, `run.tasksSha256` must equal
 *   the SHA-256 of the current tasks.json raw bytes.
 * - Plan snapshots and Session Records are immutable once written.
 *
 * Reads return `null` when the file simply does not exist (absence is a
 * valid state: no Run yet, tasks.json before the first revision). Use-case
 * callers map absence to their own error codes (e.g. RUN_NOT_FOUND).
 */
import type { PlanRevisionSnapshot } from '../../domain/schemas/plan-revision-snapshot.js';
import type { RunJson } from '../../domain/schemas/run-json.js';
import type { SessionRecord } from '../../domain/schemas/session-record.js';
import type { TasksJson } from '../../domain/schemas/tasks-json.js';

/** A cross-file consistent view produced by the consistent-read protocol. */
export interface ConsistentSnapshot {
  readonly run: RunJson;
  /** `null` exactly when `run.planRevision === 0` (tasks.json must not exist). */
  readonly tasks: TasksJson | null;
}

/**
 * Input for {@link StateStorePort.commitPlanRevision}. `run.tasksSha256` is
 * omitted: the store computes the SHA-256 of the freshly written tasks.json
 * raw bytes and stamps it onto the commit-point run.json (SPEC §11.2).
 */
export interface PlanRevisionCommit {
  readonly snapshot: PlanRevisionSnapshot;
  readonly tasks: TasksJson;
  readonly run: Omit<RunJson, 'tasksSha256'>;
}

export interface StateStorePort {
  readRun(): Promise<RunJson | null>;
  /**
   * Validates and atomically replaces run.json. `run.stateRevision` must be
   * strictly greater than the persisted one (first write exempted).
   */
  writeRun(run: RunJson): Promise<void>;

  readTasks(): Promise<TasksJson | null>;
  /**
   * Validates and atomically replaces tasks.json; resolves to the SHA-256 of
   * the file's raw bytes after replacement. Plan revision commits must go
   * through {@link StateStorePort.commitPlanRevision}; this method is the
   * building block it (and only it) uses.
   */
  writeTasks(tasks: TasksJson): Promise<string>;

  readPlanSnapshot(planRevision: number): Promise<PlanRevisionSnapshot | null>;
  /** Writes the immutable `plans/<planRevision>.json`; fails when it exists. */
  writePlanSnapshot(snapshot: PlanRevisionSnapshot): Promise<void>;

  readSessionRecord(sessionId: string): Promise<SessionRecord | null>;
  /** Writes the immutable `sessions/<sessionId>.json`; fails when it exists. */
  writeSessionRecord(record: SessionRecord): Promise<void>;

  /**
   * Plan Revision commit order (SPEC §11.2): write+validate immutable
   * snapshot → replace+validate tasks.json → compute its raw-byte SHA-256 →
   * replace run.json as the commit point. All Domain checks run before the
   * first write, so a validation failure leaves every file untouched.
   */
  commitPlanRevision(commit: PlanRevisionCommit): Promise<void>;

  /**
   * Consistent-read protocol (SPEC §11.2): run → tasks → run, requiring equal
   * stateRevision, matching planRevision and matching tasksSha256; retries at
   * most 3 times on mismatch and then throws `STATE_SNAPSHOT_BUSY` without
   * modifying anything. `planRevision === 0` compares two run.json reads only.
   * Resolves to `null` when no run.json exists.
   */
  readConsistentSnapshot(): Promise<ConsistentSnapshot | null>;
}
