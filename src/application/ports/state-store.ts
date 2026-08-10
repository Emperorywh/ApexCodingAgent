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
 * - 任何写入在首次文件操作前都必须通过脱敏稳定性断言；State Store 只拒绝
 *   未清洗事实，不静默改写可能影响恢复协议的操作性字段。
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

/**
 * 前台属主进程的一次存活信号（SPEC §2.4 崩溃判定的唯一系统依据）。
 *
 * 这是轻量运行期事实，不是聚合：不 schema 注册、不参与一致读、不归档。
 * 文件缺失只表示"没有信号"（旧版本 Run 或信号尚未写入），不表示崩溃。
 */
export interface RunHeartbeatFact {
  /** 发送信号的 Run；只有与当前 run.json 同 runId 的信号才有判定效力。 */
  readonly runId: string;
  /** 信号发送时间（携带当前操作系统时区偏移量的 RFC 3339，程序生成）。 */
  readonly at: string;
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
  /**
   * 读取当前状态目录内全部已提交 Session Record，按文件名确定性排序。
   * 临时文件与非 Session 文件不属于已提交事实，必须忽略；每个返回记录
   * 仍执行与单条读取完全相同的 Schema 和领域校验。
   */
  listSessionRecords(): Promise<readonly SessionRecord[]>;
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

  /**
   * 写入一次前台属主存活信号（`heartbeat.json`，同目录 temp→rename 原子替换）。
   *
   * 与聚合写协议不同：不 schema 校验、不要求 stateRevision，是覆盖式的
   * 最新值语义；I/O 失败仍映射 STATE_WRITE_FAILED，由调用方降级处理。
   */
  writeHeartbeat(fact: RunHeartbeatFact): Promise<void>;
  /**
   * 读取最近一次存活信号。返回 `null` 表示文件不存在；返回 `'unreadable'`
   * 表示文件存在但内容不可解析（写入中途被截断或已损坏）——调用方必须按
   * "可能有活跃写入者"的保守方向处理，绝不能据此判定属主已消亡。
   */
  readHeartbeat(): Promise<RunHeartbeatFact | null | 'unreadable'>;
}
