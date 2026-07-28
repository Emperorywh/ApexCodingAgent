/**
 * JSON State Store: write protocol, failure mapping, stateRevision semantics,
 * immutable snapshots/records and the Plan Revision commit order (SPEC §11.2).
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createJsonStateStore } from '../../../src/adapters/state/json-state-store.js';
import type { StateStorePort } from '../../../src/application/ports/state-store.js';
import { mkErrorRecord, mkRun, UUID_2 } from '../../domain/fixtures.js';
import {
  DEFAULT_PLAN_TASKS,
  expectApexErrorAsync,
  mkCommittedRun,
  mkSessionRecord,
  mkSnapshot,
  mkTasks,
  RUN_PATH,
  SESSION_PATH,
  SNAPSHOT_PATH,
  STATE_DIR,
  TASKS_PATH,
} from '../fixtures.js';
import { InMemoryFileSystem } from './in-memory-file-system.js';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

let fs: InMemoryFileSystem;
let store: StateStorePort;

beforeEach(() => {
  fs = new InMemoryFileSystem();
  store = createJsonStateStore({ stateDir: STATE_DIR, fs });
});

describe('run.json writes', () => {
  it('round-trips a planRevision-0 run as UTF-8 without BOM', async () => {
    const run = mkRun();
    await store.writeRun(run);

    const bytes = fs.files.get(RUN_PATH)!;
    expect([...bytes.slice(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(fs.readText(RUN_PATH).startsWith('{\n  "schemaVersion": 1,')).toBe(true);
    expect(await store.readRun()).toEqual(run);
    expect(await store.readConsistentSnapshot()).toEqual({ run, tasks: null });
  });

  it('enforces strictly increasing stateRevision', async () => {
    await store.writeRun(mkRun({ stateRevision: 1 }));
    // Same revision is rejected.
    await expectApexErrorAsync(
      () => store.writeRun(mkRun({ stateRevision: 1 })),
      'STATE_VALIDATION_FAILED',
    );
    // A gap is still strictly increasing and therefore allowed.
    await store.writeRun(mkRun({ stateRevision: 3 }));
    await expectApexErrorAsync(
      () => store.writeRun(mkRun({ stateRevision: 2 })),
      'STATE_VALIDATION_FAILED',
    );
    expect((await store.readRun())!.stateRevision).toBe(3);
  });

  it('rejects schema-invalid runs before touching the filesystem', async () => {
    await expectApexErrorAsync(
      () => store.writeRun(mkRun({ runId: 'not-a-run-id' })),
      'STATE_VALIDATION_FAILED',
    );
    expect(fs.ops.filter((op) => op.op === 'writeFile' || op.op === 'rename')).toEqual([]);
    expect(fs.files.has(RUN_PATH)).toBe(false);
  });

  it('rejects Domain invariant violations before any write', async () => {
    // planRevision 0 is only legal while initially planning (SPEC §11.3).
    await expectApexErrorAsync(
      () => store.writeRun(mkRun({ status: 'running' })),
      'STATE_VALIDATION_FAILED',
    );
    expect(fs.ops.filter((op) => op.op === 'writeFile')).toEqual([]);
  });

  it('requires tasks.json to be absent while planRevision is 0', async () => {
    await store.writeTasks(mkTasks(1));
    await expectApexErrorAsync(() => store.writeRun(mkRun()), 'STATE_VALIDATION_FAILED');
  });

  it('requires tasksSha256 to match the current tasks.json bytes', async () => {
    await store.writeTasks(mkTasks(1));
    const run = {
      ...mkCommittedRun(1, 1),
      tasksSha256: '0'.repeat(64),
    };
    await expectApexErrorAsync(() => store.writeRun(run), 'STATE_VALIDATION_FAILED');
  });
});

describe('write protocol failure mapping (SPEC §11.2)', () => {
  it('maps temp-file write failures to STATE_WRITE_FAILED and leaves no target', async () => {
    fs.injectFailure({ op: 'writeFile', pathIncludes: 'run.json', error: new Error('disk full') });
    await expectApexErrorAsync(() => store.writeRun(mkRun()), 'STATE_WRITE_FAILED');
    expect(fs.files.has(RUN_PATH)).toBe(false);
  });

  it('maps rename failures to STATE_WRITE_FAILED and cleans up the temp file', async () => {
    fs.injectFailure({ op: 'rename', pathIncludes: 'run.json', error: new Error('access denied') });
    await expectApexErrorAsync(() => store.writeRun(mkRun()), 'STATE_WRITE_FAILED');
    expect(fs.files.has(RUN_PATH)).toBe(false);
    expect([...fs.files.keys()].filter((path) => path.includes('.tmp-'))).toEqual([]);
  });

  it('maps reopen failures to STATE_WRITE_FAILED', async () => {
    await store.writeRun(mkRun({ stateRevision: 1 }));
    fs.injectFailure({
      op: 'readFile',
      pathIncludes: 'run.json',
      afterMatchingCalls: 1, // the existing-run read passes, the reopen fails
      error: new Error('i/o error'),
    });
    await expectApexErrorAsync(
      () => store.writeRun(mkRun({ stateRevision: 2 })),
      'STATE_WRITE_FAILED',
    );
  });

  it('maps post-replacement validation failures to STATE_VALIDATION_FAILED', async () => {
    await store.writeRun(mkRun({ stateRevision: 1 }));
    let runReads = 0;
    fs.readInterceptor = (path, bytes) => {
      if (path !== RUN_PATH) return bytes;
      runReads += 1;
      // The existing-run read passes; the reopen returns schema-invalid JSON.
      return runReads === 2 ? new TextEncoder().encode('{ "definitely": "not a run" }') : bytes;
    };
    await expectApexErrorAsync(
      () => store.writeRun(mkRun({ stateRevision: 2 })),
      'STATE_VALIDATION_FAILED',
    );
  });

  it('maps invalid stored JSON to STATE_VALIDATION_FAILED on read', async () => {
    fs.files.set(RUN_PATH, new TextEncoder().encode('not json at all'));
    await expectApexErrorAsync(() => store.readRun(), 'STATE_VALIDATION_FAILED');
    expect(await store.readTasks()).toBeNull();
  });
});

describe('tasks.json writes', () => {
  it('returns the SHA-256 of the raw tasks.json bytes', async () => {
    const tasks = mkTasks(1);
    const sha = await store.writeTasks(tasks);
    expect(sha).toBe(sha256(fs.files.get(TASKS_PATH)!));
    expect(await store.readTasks()).toEqual(tasks);
  });
});

describe('immutable plan snapshots and session records', () => {
  it('writes and reads plan snapshots; refuses to overwrite them', async () => {
    const snapshot = mkSnapshot(1);
    await store.writePlanSnapshot(snapshot);
    expect(await store.readPlanSnapshot(1)).toEqual(snapshot);
    expect(await store.readPlanSnapshot(2)).toBeNull();
    await expectApexErrorAsync(
      () => store.writePlanSnapshot(mkSnapshot(1)),
      'STATE_WRITE_FAILED',
    );
  });

  it('writes and reads session records; refuses to overwrite them', async () => {
    const record = mkSessionRecord();
    await store.writeSessionRecord(record);
    expect(await store.readSessionRecord(record.sessionId)).toEqual(record);
    expect(await store.readSessionRecord(UUID_2)).toBeNull();
    await expectApexErrorAsync(
      () => store.writeSessionRecord(mkSessionRecord()),
      'STATE_WRITE_FAILED',
    );
  });

  it('rejects rule-violating session records before any write', async () => {
    // A completed session must have error null (SPEC §11.4).
    const record = mkSessionRecord({ error: mkErrorRecord() });
    await expectApexErrorAsync(
      () => store.writeSessionRecord(record),
      'STATE_VALIDATION_FAILED',
    );
    expect(fs.files.has(SESSION_PATH(record.sessionId))).toBe(false);
  });
});

describe('plan revision commit (SPEC §11.2)', () => {
  it('commits in order: snapshot -> tasks.json -> sha256 -> run.json', async () => {
    await store.writeRun(mkRun({ stateRevision: 1 }));
    fs.ops.length = 0;

    await store.commitPlanRevision({
      snapshot: mkSnapshot(1),
      tasks: mkTasks(1),
      run: mkCommittedRun(1, 2),
    });

    const renameTargets = fs.ops.filter((op) => op.op === 'rename').map((op) => op.to);
    expect(renameTargets).toEqual([SNAPSHOT_PATH(1), TASKS_PATH, RUN_PATH]);

    const run = (await store.readRun())!;
    expect(run.planRevision).toBe(1);
    expect(run.tasksSha256).toBe(sha256(fs.files.get(TASKS_PATH)!));

    const snapshot = await store.readConsistentSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.run.planRevision).toBe(1);
    expect(snapshot!.tasks!.tasks.map((task) => task.id)).toEqual(
      DEFAULT_PLAN_TASKS.map((task) => task.id),
    );
  });

  it('validates everything before the first write (no half revision)', async () => {
    await store.writeRun(mkRun({ stateRevision: 1 }));
    fs.ops.length = 0;
    await expectApexErrorAsync(
      () =>
        store.commitPlanRevision({
          snapshot: mkSnapshot(1),
          tasks: mkTasks(2), // mismatched revision
          run: mkCommittedRun(1, 2),
        }),
      'STATE_VALIDATION_FAILED',
    );
    expect(fs.ops.filter((op) => op.op === 'writeFile' || op.op === 'rename')).toEqual([]);
    expect(fs.files.has(SNAPSHOT_PATH(1))).toBe(false);
    expect(fs.files.has(TASKS_PATH)).toBe(false);
  });

  it('keeps the old revision observable when the tasks.json replacement fails', async () => {
    await store.writeRun(mkRun({ stateRevision: 1 }));
    fs.injectFailure({ op: 'rename', pathIncludes: 'tasks.json', error: new Error('i/o error') });

    await expectApexErrorAsync(
      () =>
        store.commitPlanRevision({
          snapshot: mkSnapshot(1),
          tasks: mkTasks(1),
          run: mkCommittedRun(1, 2),
        }),
      'STATE_WRITE_FAILED',
    );

    // The commit point (run.json) was never reached: revision 1 is not
    // observable; the orphaned immutable snapshot is harmless.
    expect(fs.files.has(SNAPSHOT_PATH(1))).toBe(true);
    expect(fs.files.has(TASKS_PATH)).toBe(false);
    const snapshot = await store.readConsistentSnapshot();
    expect(snapshot!.run.stateRevision).toBe(1);
    expect(snapshot!.run.planRevision).toBe(0);
    expect(snapshot!.tasks).toBeNull();
  });

  it('never exposes a spliced snapshot when the run.json commit point fails', async () => {
    await store.writeRun(mkRun({ stateRevision: 1 }));
    await store.commitPlanRevision({
      snapshot: mkSnapshot(1),
      tasks: mkTasks(1),
      run: mkCommittedRun(1, 2),
    });

    fs.injectFailure({ op: 'writeFile', pathIncludes: 'run.json', error: new Error('disk full') });
    await expectApexErrorAsync(
      () =>
        store.commitPlanRevision({
          snapshot: mkSnapshot(2),
          tasks: mkTasks(2),
          run: mkCommittedRun(2, 3),
        }),
      'STATE_WRITE_FAILED',
    );

    // tasks.json moved to revision 2 but run.json still says revision 1:
    // the consistent read must refuse the splice instead of showing it.
    await expectApexErrorAsync(() => store.readConsistentSnapshot(), 'STATE_SNAPSHOT_BUSY');
  });
});
