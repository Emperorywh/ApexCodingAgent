/**
 * JSON State Store (SPEC §11.1–11.2): StateStorePort over FileSystemPort.
 *
 * - Every write goes through the temp-file replacement protocol and persists
 *   only Domain-validated aggregates (SPEC §5.5).
 * - `stateRevision` strictly increases on each run.json replacement; when
 *   `planRevision > 0`, `run.tasksSha256` must equal the SHA-256 of the
 *   current tasks.json raw bytes, and `planRevision === 0` requires
 *   tasks.json to be absent.
 * - Plan Revision commit order (SPEC §11.2): immutable snapshot → tasks.json
 *   → raw-byte SHA-256 → run.json commit point. All Domain checks run before
 *   the first write, so validation failures touch zero files.
 * - Consistent read (SPEC §11.2): run → tasks → run with stateRevision,
 *   planRevision and tasksSha256 agreement; 1 attempt + at most 3 immediate
 *   retries, then STATE_SNAPSHOT_BUSY without modifying anything.
 */
import type { FileSystemPort } from '../../application/ports/file-system.js';
import type {
  ConsistentSnapshot,
  PlanRevisionCommit,
  StateStorePort,
} from '../../application/ports/state-store.js';
import { ApexError } from '../../domain/errors.js';
import { isUuid } from '../../domain/ids.js';
import {
  assertRunInvariants,
  assertRunJsonRules,
  assertSessionRecordRules,
} from '../../domain/invariants.js';
import { assertSchemaValid } from '../../domain/schemas/index.js';
import type { PlanRevisionSnapshot } from '../../domain/schemas/plan-revision-snapshot.js';
import type { RunJson } from '../../domain/schemas/run-json.js';
import type { SessionRecord } from '../../domain/schemas/session-record.js';
import type { PlannedTask } from '../../domain/schemas/task-plan-draft.js';
import type { TasksJson } from '../../domain/schemas/tasks-json.js';
import {
  ensureDirectory,
  readJsonIfExists,
  serializeJson,
  sha256Hex,
  stateValidationFailed,
  stateWriteFailed,
  writeJsonAtomically,
  type ReadJsonResult,
} from './json-file-writer.js';

const STATE_STAGE = 'state';
const STATE_VALIDATION = { code: 'STATE_VALIDATION_FAILED', stage: STATE_STAGE } as const;

/** 1 initial attempt + at most 3 immediate retries (SPEC §11.2). */
const MAX_CONSISTENT_READ_ATTEMPTS = 4;

export interface JsonStateStoreOptions {
  /** Absolute path of the `.apex-coding-agent/` state directory, `/`-separated. */
  readonly stateDir: string;
  readonly fs: FileSystemPort;
}

export function createJsonStateStore(options: JsonStateStoreOptions): StateStorePort {
  const { stateDir, fs } = options;
  const runPath = `${stateDir}/run.json`;
  const tasksPath = `${stateDir}/tasks.json`;
  const plansDir = `${stateDir}/plans`;
  const sessionsDir = `${stateDir}/sessions`;
  const snapshotPath = (planRevision: number): string => `${plansDir}/${planRevision}.json`;
  const sessionPath = (sessionId: string): string => `${sessionsDir}/${sessionId}.json`;

  function readTasksWithBytes(): Promise<ReadJsonResult<TasksJson> | null> {
    return readJsonIfExists<TasksJson>(fs, tasksPath, 'TasksJson');
  }

  async function readRun(): Promise<RunJson | null> {
    const read = await readJsonIfExists<RunJson>(fs, runPath, 'RunJson', assertRunJsonRules);
    return read === null ? null : read.value;
  }

  async function readTasks(): Promise<TasksJson | null> {
    const read = await readTasksWithBytes();
    return read === null ? null : read.value;
  }

  async function writeRun(run: RunJson): Promise<void> {
    const existing = await readRun();
    if (existing !== null && run.stateRevision <= existing.stateRevision) {
      throw stateValidationFailed(
        `run.json stateRevision must strictly increase: ${existing.stateRevision} -> ${run.stateRevision}`,
      );
    }

    let currentPlan: { readonly tasks: readonly PlannedTask[] } | null = null;
    if (run.planRevision > 0) {
      const tasksRead = await readTasksWithBytes();
      if (tasksRead === null) {
        throw stateValidationFailed(
          `run.json planRevision ${run.planRevision} requires tasks.json to exist`,
        );
      }
      if (tasksRead.value.planRevision !== run.planRevision) {
        throw stateValidationFailed(
          `run.json planRevision ${run.planRevision} does not match tasks.json planRevision ${tasksRead.value.planRevision}`,
        );
      }
      if (run.tasksSha256 !== sha256Hex(tasksRead.bytes)) {
        throw stateValidationFailed('run.json tasksSha256 does not match current tasks.json bytes');
      }
      currentPlan = { tasks: tasksRead.value.tasks };
    } else if ((await fs.stat(tasksPath)) !== null) {
      throw stateValidationFailed('planRevision 0 requires tasks.json to be absent');
    }

    await writeJsonAtomically(fs, {
      targetPath: runPath,
      value: run,
      schemaName: 'RunJson',
      preValidate: () => {
        assertRunInvariants(run, currentPlan);
      },
    });
  }

  async function writeTasks(tasks: TasksJson): Promise<string> {
    const reread = await writeJsonAtomically(fs, {
      targetPath: tasksPath,
      value: tasks,
      schemaName: 'TasksJson',
    });
    return sha256Hex(reread);
  }

  async function readPlanSnapshot(planRevision: number): Promise<PlanRevisionSnapshot | null> {
    if (!Number.isInteger(planRevision) || planRevision < 1) {
      throw stateValidationFailed(`invalid plan revision for snapshot read: ${planRevision}`);
    }
    const read = await readJsonIfExists<PlanRevisionSnapshot>(
      fs,
      snapshotPath(planRevision),
      'PlanRevisionSnapshot',
      (value) => {
        if (value.planRevision !== planRevision) {
          throw stateValidationFailed(
            `snapshot file ${snapshotPath(planRevision)} carries planRevision ${value.planRevision}`,
          );
        }
      },
    );
    return read === null ? null : read.value;
  }

  async function writePlanSnapshot(snapshot: PlanRevisionSnapshot): Promise<void> {
    assertSchemaValid('PlanRevisionSnapshot', snapshot, STATE_VALIDATION);
    const path = snapshotPath(snapshot.planRevision);
    if ((await fs.stat(path)) !== null) {
      throw stateWriteFailed(`immutable plan snapshot ${path} already exists`);
    }
    await ensureDirectory(fs, plansDir);
    await writeJsonAtomically(fs, {
      targetPath: path,
      value: snapshot,
      schemaName: 'PlanRevisionSnapshot',
    });
  }

  async function readSessionRecord(sessionId: string): Promise<SessionRecord | null> {
    if (!isUuid(sessionId)) {
      throw stateValidationFailed(`invalid session id for record read: ${sessionId}`);
    }
    const read = await readJsonIfExists<SessionRecord>(
      fs,
      sessionPath(sessionId),
      'SessionRecord',
      (value) => {
        if (value.sessionId !== sessionId) {
          throw stateValidationFailed(
            `session record file ${sessionPath(sessionId)} carries sessionId ${value.sessionId}`,
          );
        }
        assertSessionRecordRules(value);
      },
    );
    return read === null ? null : read.value;
  }

  async function writeSessionRecord(record: SessionRecord): Promise<void> {
    assertSchemaValid('SessionRecord', record, STATE_VALIDATION);
    const path = sessionPath(record.sessionId);
    if ((await fs.stat(path)) !== null) {
      throw stateWriteFailed(`immutable session record ${path} already exists`);
    }
    await ensureDirectory(fs, sessionsDir);
    await writeJsonAtomically(fs, {
      targetPath: path,
      value: record,
      schemaName: 'SessionRecord',
      preValidate: () => {
        assertSessionRecordRules(record);
      },
    });
  }

  async function commitPlanRevision(commit: PlanRevisionCommit): Promise<void> {
    const { snapshot, tasks, run } = commit;

    // Everything is validated before the first write, so a failure here
    // leaves zero files touched (no observable half revision).
    assertSchemaValid('PlanRevisionSnapshot', snapshot, STATE_VALIDATION);
    assertSchemaValid('TasksJson', tasks, STATE_VALIDATION);
    // Serialization is deterministic: this is the SHA-256 the tasks.json raw
    // bytes will have after replacement, verified again after the write.
    const expectedTasksSha256 = sha256Hex(serializeJson(tasks));
    const candidateRun: RunJson = { ...run, tasksSha256: expectedTasksSha256 };
    assertSchemaValid('RunJson', candidateRun, STATE_VALIDATION);
    assertRunInvariants(candidateRun, { tasks: tasks.tasks });

    if (
      snapshot.planRevision !== tasks.planRevision ||
      tasks.planRevision !== candidateRun.planRevision
    ) {
      throw stateValidationFailed(
        `plan revision mismatch: snapshot ${snapshot.planRevision}, tasks.json ${tasks.planRevision}, run.json ${candidateRun.planRevision}`,
      );
    }
    if (snapshot.runId !== tasks.runId || tasks.runId !== candidateRun.runId) {
      throw stateValidationFailed('run id mismatch across snapshot, tasks.json and run.json');
    }
    const existing = await readRun();
    if (existing !== null && candidateRun.stateRevision <= existing.stateRevision) {
      throw stateValidationFailed(
        `run.json stateRevision must strictly increase: ${existing.stateRevision} -> ${candidateRun.stateRevision}`,
      );
    }
    const snapshotTarget = snapshotPath(snapshot.planRevision);
    if ((await fs.stat(snapshotTarget)) !== null) {
      throw stateWriteFailed(`immutable plan snapshot ${snapshotTarget} already exists`);
    }

    // SPEC §11.2 commit order: snapshot -> tasks.json -> SHA-256 -> run.json.
    await writePlanSnapshot(snapshot);
    const tasksSha256 = await writeTasks(tasks);
    if (tasksSha256 !== expectedTasksSha256) {
      throw stateValidationFailed('tasks.json bytes changed during replacement (SHA-256 mismatch)');
    }
    await writeRun(candidateRun);
  }

  async function readConsistentSnapshot(): Promise<ConsistentSnapshot | null> {
    for (let attempt = 1; attempt <= MAX_CONSISTENT_READ_ATTEMPTS; attempt += 1) {
      const run1 = await readRun();
      if (run1 === null) return null;

      if (run1.planRevision === 0) {
        // Read-time Domain rules guarantee tasksSha256 is null here, so
        // tasks.json must not exist: compare two run.json reads (SPEC §11.2).
        const run2 = await readRun();
        if (run2 !== null && run1.stateRevision === run2.stateRevision) {
          return { run: run2, tasks: null };
        }
        continue;
      }

      const tasksRead = await readTasksWithBytes();
      if (tasksRead === null) {
        throw stateValidationFailed(
          `run.json planRevision ${run1.planRevision} requires tasks.json to exist`,
        );
      }
      const run2 = await readRun();
      if (
        run2 !== null &&
        run1.stateRevision === run2.stateRevision &&
        run1.planRevision === tasksRead.value.planRevision &&
        run1.tasksSha256 === sha256Hex(tasksRead.bytes)
      ) {
        return { run: run2, tasks: tasksRead.value };
      }
    }
    throw new ApexError({
      code: 'STATE_SNAPSHOT_BUSY',
      stage: STATE_STAGE,
      message: `state snapshot stayed inconsistent across ${MAX_CONSISTENT_READ_ATTEMPTS} attempts`,
    });
  }

  return {
    readRun,
    writeRun,
    readTasks,
    writeTasks,
    readPlanSnapshot,
    writePlanSnapshot,
    readSessionRecord,
    writeSessionRecord,
    commitPlanRevision,
    readConsistentSnapshot,
  };
}
