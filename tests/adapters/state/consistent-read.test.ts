/**
 * Consistent-read protocol (SPEC §11.2): run → tasks → run with
 * stateRevision / planRevision / tasksSha256 agreement, at most 3 immediate
 * retries, then STATE_SNAPSHOT_BUSY without modifying any file.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createJsonStateStore } from '../../../src/adapters/state/json-state-store.js';
import type { StateStorePort } from '../../../src/application/ports/state-store.js';
import type { RunJson } from '../../../src/domain/schemas/run-json.js';
import type { TasksJson } from '../../../src/domain/schemas/tasks-json.js';
import { mkRun } from '../../domain/fixtures.js';
import {
  expectApexErrorAsync,
  mkCommittedRun,
  mkSnapshot,
  mkTasks,
  RUN_PATH,
  STATE_DIR,
  TASKS_PATH,
} from '../fixtures.js';
import { InMemoryFileSystem } from './in-memory-file-system.js';

let fs: InMemoryFileSystem;
let store: StateStorePort;

beforeEach(() => {
  fs = new InMemoryFileSystem();
  store = createJsonStateStore({ stateDir: STATE_DIR, fs });
});

async function commitRevision1(): Promise<void> {
  await store.writeRun(mkRun({ stateRevision: 1 }));
  await store.commitPlanRevision({
    snapshot: mkSnapshot(1),
    tasks: mkTasks(1),
    run: mkCommittedRun(1, 2),
  });
}

function runReads(): number {
  return fs.ops.filter((op) => op.op === 'readFile' && op.path === RUN_PATH).length;
}

function writeOps(): unknown[] {
  return fs.ops.filter((op) => op.op !== 'readFile' && op.op !== 'stat');
}

/** Rewrites the run.json stateRevision in the bytes a read returns. */
function withStateRevision(bytes: Uint8Array, stateRevision: number): Uint8Array {
  const run = JSON.parse(new TextDecoder().decode(bytes)) as RunJson;
  return new TextEncoder().encode(JSON.stringify({ ...run, stateRevision }, null, 2));
}

/** Rewrites the tasks.json planRevision in the bytes a read returns. */
function withPlanRevision(bytes: Uint8Array, planRevision: number): Uint8Array {
  const tasks = JSON.parse(new TextDecoder().decode(bytes)) as TasksJson;
  return new TextEncoder().encode(JSON.stringify({ ...tasks, planRevision }, null, 2));
}

describe('consistent read', () => {
  it('returns null when no run.json exists', async () => {
    expect(await store.readConsistentSnapshot()).toBeNull();
  });

  it('double-reads run.json and verifies tasks.json is absent while planRevision is 0', async () => {
    const run = mkRun();
    await store.writeRun(run);
    fs.ops.length = 0;

    expect(await store.readConsistentSnapshot()).toEqual({ run, tasks: null });
    expect(runReads()).toBe(2);
    expect(fs.ops.filter((op) => op.path === TASKS_PATH)).toEqual([
      { op: 'stat', path: TASKS_PATH },
    ]);
  });

  it('never returns revision 0 when an uncommitted tasks.json is present', async () => {
    /**
     * 模拟首次计划提交已替换 tasks.json、但尚未替换 run.json 的窗口。
     * 稳定的旧 run.json 也不能掩盖这个半提交状态。
     */
    await store.writeRun(mkRun({ stateRevision: 1 }));
    await store.writeTasks(mkTasks(1));
    fs.ops.length = 0;

    await expectApexErrorAsync(() => store.readConsistentSnapshot(), 'STATE_SNAPSHOT_BUSY');
    expect(runReads()).toBe(8);
    expect(writeOps()).toEqual([]);
  });

  it('returns a consistent run+tasks snapshot for a committed revision', async () => {
    await commitRevision1();
    const snapshot = await store.readConsistentSnapshot();
    expect(snapshot!.run.planRevision).toBe(1);
    expect(snapshot!.tasks!.planRevision).toBe(1);
    expect(snapshot!.run.tasksSha256).not.toBeNull();
  });

  it('succeeds on a later attempt when the mismatch disappears', async () => {
    await commitRevision1();
    let reads = 0;
    fs.readInterceptor = (path, bytes) => {
      if (path !== RUN_PATH) return bytes;
      reads += 1;
      // Attempt 1's second run.json read reports a newer revision once.
      return reads === 2 ? withStateRevision(bytes, 99) : bytes;
    };
    fs.ops.length = 0;

    const snapshot = await store.readConsistentSnapshot();
    expect(snapshot!.run.stateRevision).toBe(2);
    expect(runReads()).toBe(4); // 2 run reads per attempt x 2 attempts
  });

  it('gives up after 3 retries when the two run reads never agree', async () => {
    await commitRevision1();
    let reads = 0;
    fs.readInterceptor = (path, bytes) => {
      if (path !== RUN_PATH) return bytes;
      reads += 1;
      return withStateRevision(bytes, reads); // a different revision on every read
    };
    fs.ops.length = 0;

    const error = await expectApexErrorAsync(
      () => store.readConsistentSnapshot(),
      'STATE_SNAPSHOT_BUSY',
    );
    expect(error.errorClass).toBe('command_error');
    expect(runReads()).toBe(8); // 2 reads x (1 initial + 3 retries)
    expect(writeOps()).toEqual([]); // a busy snapshot never modifies files
  });

  it('fails busy when run.json and tasks.json planRevisions never match', async () => {
    await commitRevision1();
    fs.readInterceptor = (path, bytes) =>
      path === TASKS_PATH ? withPlanRevision(bytes, 7) : bytes;
    fs.ops.length = 0;

    await expectApexErrorAsync(() => store.readConsistentSnapshot(), 'STATE_SNAPSHOT_BUSY');
    expect(runReads()).toBe(8);
    expect(writeOps()).toEqual([]);
  });

  it('fails busy when tasksSha256 never matches the tasks.json bytes', async () => {
    await commitRevision1();
    // Trailing whitespace keeps the JSON valid but changes the raw bytes.
    fs.readInterceptor = (path, bytes) =>
      path === TASKS_PATH
        ? new TextEncoder().encode(`${new TextDecoder().decode(bytes)}\n`)
        : bytes;
    fs.ops.length = 0;

    await expectApexErrorAsync(() => store.readConsistentSnapshot(), 'STATE_SNAPSHOT_BUSY');
    expect(runReads()).toBe(8);
    expect(writeOps()).toEqual([]);
  });

  it('fails validation when planRevision > 0 but tasks.json is missing', async () => {
    await commitRevision1();
    fs.files.delete(TASKS_PATH);
    await expectApexErrorAsync(
      () => store.readConsistentSnapshot(),
      'STATE_VALIDATION_FAILED',
    );
  });
});
