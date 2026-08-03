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
 * - 每个聚合在首次 I/O 前执行脱敏稳定性断言；检测到上游遗漏时拒绝写入，
 *   不在持久化层静默改变影响恢复协议的领域事实。
 * - Consistent read (SPEC §11.2): run → tasks → run with stateRevision,
 *   planRevision and tasksSha256 agreement; 1 attempt + at most 3 immediate
 *   retries, then STATE_SNAPSHOT_BUSY without modifying anything.
 */
import type { FileSystemPort } from '../../application/ports/file-system.js';
import type { RedactionPort } from '../../application/ports/redaction.js';
import type {
  ConsistentSnapshot,
  PlanRevisionCommit,
  RunHeartbeatFact,
  StateStorePort,
} from '../../application/ports/state-store.js';
import { ApexError } from '../../domain/errors.js';
import { isUuid } from '../../domain/ids.js';
import {
  assertRunInvariants,
  assertRunJsonRules,
  assertSessionRecordRules,
} from '../../domain/invariants.js';
import {
  assertPlanRevisionCommitCoherent,
  assertPlanRevisionSnapshotRules,
} from '../../domain/plan-documents.js';
import { assertSchemaValid } from '../../domain/schemas/index.js';
import type { PlanRevisionSnapshot } from '../../domain/schemas/plan-revision-snapshot.js';
import type { RunJson } from '../../domain/schemas/run-json.js';
import type { SessionRecord } from '../../domain/schemas/session-record.js';
import type { PlannedTask } from '../../domain/schemas/task-plan-draft.js';
import type { TasksJson } from '../../domain/schemas/tasks-json.js';
import {
  ensureDirectory,
  isNotFound,
  readJsonIfExists,
  renameReplacing,
  serializeJson,
  sha256Hex,
  stateValidationFailed,
  stateWriteFailed,
  tempPathFor,
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
  /** 写入前的最后安全断言；State Store 不负责猜测应如何修复业务事实。 */
  readonly redaction: RedactionPort;
}

export function createJsonStateStore(options: JsonStateStoreOptions): StateStorePort {
  const { stateDir, fs } = options;
  const runPath = `${stateDir}/run.json`;
  const tasksPath = `${stateDir}/tasks.json`;
  const heartbeatPath = `${stateDir}/heartbeat.json`;
  const plansDir = `${stateDir}/plans`;
  const sessionsDir = `${stateDir}/sessions`;
  const snapshotPath = (planRevision: number): string => `${plansDir}/${planRevision}.json`;
  const sessionPath = (sessionId: string): string => `${sessionsDir}/${sessionId}.json`;

  /**
   * 状态层只做“已经安全”的断言，不在这里静默改写领域事实。
   *
   * 如果调用方遗漏了脱敏，直接替换路径、Task ID 或其他操作性字段可能破坏
   * 恢复协议；因此检测到差异时以稳定验证错误拒绝首次写入，由事实组装层修复。
   */
  function assertPayloadAlreadyRedacted(schemaName: string, value: unknown): void {
    const redacted = options.redaction.redactStructured(value);
    if (JSON.stringify(redacted) !== JSON.stringify(value)) {
      throw stateValidationFailed(
        `${schemaName} contains recognized sensitive content before persistence`,
      );
    }
  }

  function readTasksWithBytes(): Promise<ReadJsonResult<TasksJson> | null> {
    return readJsonIfExists<TasksJson>(fs, tasksPath, 'TasksJson');
  }

  async function readRun(): Promise<RunJson | null> {
    const read = await readJsonIfExists<RunJson>(
      fs,
      runPath,
      'RunJson',
      assertRunJsonRules,
    );
    return read === null ? null : read.value;
  }

  async function readTasks(): Promise<TasksJson | null> {
    const read = await readTasksWithBytes();
    return read === null ? null : read.value;
  }

  async function writeRun(run: RunJson): Promise<void> {
    assertPayloadAlreadyRedacted('RunJson', run);
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
    assertPayloadAlreadyRedacted('TasksJson', tasks);
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
        assertPlanRevisionSnapshotRules(value);
      },
    );
    return read === null ? null : read.value;
  }

  async function writePlanSnapshot(snapshot: PlanRevisionSnapshot): Promise<void> {
    assertPayloadAlreadyRedacted('PlanRevisionSnapshot', snapshot);
    assertSchemaValid('PlanRevisionSnapshot', snapshot, STATE_VALIDATION);
    assertPlanRevisionSnapshotRules(snapshot);
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
    assertPayloadAlreadyRedacted('SessionRecord', record);
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

    /**
     * 在首次写盘前校验三份文档的完整聚合一致性。
     *
     * 任何字段漂移、Revision 跳号或父版本错误都会以零写入失败，
     * 不会制造一个表面可读、语义上却互相矛盾的半提交 Revision。
     */
    assertPayloadAlreadyRedacted('PlanRevisionSnapshot', snapshot);
    assertPayloadAlreadyRedacted('TasksJson', tasks);
    assertPayloadAlreadyRedacted('RunJson', run);
    assertSchemaValid('PlanRevisionSnapshot', snapshot, STATE_VALIDATION);
    assertSchemaValid('TasksJson', tasks, STATE_VALIDATION);
    /**
     * 序列化是确定性的，因此这里可预先得到 tasks.json 写盘后的原始字节哈希；
     * 完成替换后仍会复算一次，保护 FileSystemPort 的实现边界。
     */
    const expectedTasksSha256 = sha256Hex(serializeJson(tasks));
    const candidateRun: RunJson = { ...run, tasksSha256: expectedTasksSha256 };
    assertSchemaValid('RunJson', candidateRun, STATE_VALIDATION);

    const existing = await readRun();
    if (existing === null) {
      throw stateValidationFailed('plan revision commit requires an existing run.json');
    }
    assertPlanRevisionCommitCoherent(existing, snapshot, tasks, candidateRun);
    assertRunInvariants(candidateRun, { tasks: tasks.tasks });
    if (candidateRun.stateRevision <= existing.stateRevision) {
      throw stateValidationFailed(
        `run.json stateRevision must strictly increase: ${existing.stateRevision} -> ${candidateRun.stateRevision}`,
      );
    }
    const snapshotTarget = snapshotPath(snapshot.planRevision);
    if ((await fs.stat(snapshotTarget)) !== null) {
      throw stateWriteFailed(`immutable plan snapshot ${snapshotTarget} already exists`);
    }

    /**
     * 提交顺序固定为 Snapshot → tasks.json → 哈希复核 → run.json。
     * 最后的 run.json 替换是新 Revision 对读者可见的提交点。
     */
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
        /**
         * Revision 0 的一致快照不仅要求两次 run.json 相同，还要求 tasks.json
         * 确实不存在。计划提交在 run.json 提交点前失败时会遗留较新的
         * tasks.json，此时必须重试并最终报告忙，不能静默返回旧计划视图。
         */
        const run2 = await readRun();
        const tasksStat = await fs.stat(tasksPath);
        if (
          run2 !== null &&
          run1.stateRevision === run2.stateRevision &&
          run2.planRevision === 0 &&
          tasksStat === null
        ) {
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
        run1.planRevision === run2.planRevision &&
        run1.tasksSha256 === run2.tasksSha256 &&
        run2.planRevision === tasksRead.value.planRevision &&
        run2.tasksSha256 === sha256Hex(tasksRead.bytes)
      ) {
        /**
         * 双读稳定后再验证跨文档事实和完整运行态不变量。
         * 不稳定读只重试；稳定但语义损坏的数据必须明确报验证失败。
         */
        if (
          run2.runId !== tasksRead.value.runId ||
          run2.spec.path !== tasksRead.value.specPath ||
          run2.spec.sha256 !== tasksRead.value.specSha256
        ) {
          throw stateValidationFailed('stable run.json and tasks.json facts do not match');
        }
        assertRunInvariants(run2, { tasks: tasksRead.value.tasks });
        return { run: run2, tasks: tasksRead.value };
      }
    }
    throw new ApexError({
      code: 'STATE_SNAPSHOT_BUSY',
      stage: STATE_STAGE,
      message: `state snapshot stayed inconsistent across ${MAX_CONSISTENT_READ_ATTEMPTS} attempts`,
    });
  }

  /**
   * 存活信号是覆盖式最新值语义：同目录 temp→rename 保证读者永远看到完整
   * 内容，但不走 schema 注册表与 Domain 校验（它不是聚合，SPEC §11.2 的
   * 写协议只对状态事实生效）。
   */
  async function writeHeartbeat(fact: RunHeartbeatFact): Promise<void> {
    const bytes = serializeJson(fact);
    const tempPath = tempPathFor(heartbeatPath);
    try {
      await fs.writeFile(tempPath, bytes);
    } catch (error) {
      throw stateWriteFailed(`failed to write temporary file for ${heartbeatPath}`, error);
    }
    try {
      await renameReplacing(fs, tempPath, heartbeatPath);
    } catch (error) {
      await fs.unlink(tempPath).catch(() => undefined);
      throw stateWriteFailed(`failed to replace ${heartbeatPath}`, error);
    }
  }

  async function readHeartbeat(): Promise<RunHeartbeatFact | null | 'unreadable'> {
    let bytes: Uint8Array;
    try {
      bytes = await fs.readFile(heartbeatPath);
    } catch (error) {
      // 不存在 = 没有信号；其余 I/O 失败一律按不可读保守处理。
      return isNotFound(error) ? null : 'unreadable';
    }
    try {
      const parsed: unknown = JSON.parse(new TextDecoder('utf-8').decode(bytes));
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if (typeof record['runId'] === 'string' && typeof record['at'] === 'string') {
          return { runId: record['runId'], at: record['at'] };
        }
      }
      return 'unreadable';
    } catch {
      return 'unreadable';
    }
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
    writeHeartbeat,
    readHeartbeat,
  };
}
