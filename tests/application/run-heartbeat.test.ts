/**
 * 属主存活信号的判定与写入（SPEC §2.4 崩溃判定、§17 resume 接管门槛）。
 *
 * readOwnerLiveness 覆盖全部保守方向：无信号/异 Run 信号/不可读/时钟
 * 回拨都不得误判为崩溃；classifyResumeRun 覆盖免 --force 接管只在
 * "崩溃离场"一种形态下成立。
 */
import { describe, expect, it } from 'vitest';
import {
  createRunHeartbeat,
  HEARTBEAT_STALE_MS,
  readOwnerLiveness,
} from '../../src/application/usecases/run-heartbeat.js';
import { classifyResumeRun } from '../../src/application/usecases/resume-state.js';
import type { ClockPort } from '../../src/application/ports/clock.js';
import { createNullLogger } from '../../src/application/ports/logger.js';
import { formatRfc3339InSystemTimeZone } from '../../src/domain/time.js';
import type {
  RunHeartbeatFact,
  StateStorePort,
} from '../../src/application/ports/state-store.js';
import { expectApexError, mkRun, RUN_ID, T0, UUID_1 } from '../domain/fixtures.js';

const NOW = Date.parse('2026-01-01T00:10:00.000Z');

function fakeClock(nowMs: number = NOW): ClockPort {
  return { now: () => new Date(nowMs) };
}

function storeWithHeartbeat(read: RunHeartbeatFact | null | 'unreadable'): StateStorePort {
  return { readHeartbeat: async () => read } as unknown as StateStorePort;
}

const ISO = (ms: number): string => new Date(ms).toISOString();

describe('readOwnerLiveness (§2.4)', () => {
  it('missing heartbeat file yields unknown', async () => {
    expect(await readOwnerLiveness(storeWithHeartbeat(null), fakeClock(), RUN_ID)).toEqual({
      kind: 'unknown',
    });
  });

  it('a heartbeat belonging to a different run yields unknown', async () => {
    const fact = { runId: 'RUN-123e4567-e89b-42d3-a456-426614174999', at: ISO(NOW) };
    expect(await readOwnerLiveness(storeWithHeartbeat(fact), fakeClock(), RUN_ID)).toEqual({
      kind: 'unknown',
    });
  });

  it('unreadable content is its own conservative verdict', async () => {
    expect(
      await readOwnerLiveness(storeWithHeartbeat('unreadable'), fakeClock(), RUN_ID),
    ).toEqual({ kind: 'unreadable' });
  });

  it('an unparseable timestamp degrades to unreadable rather than presumed dead', async () => {
    const fact = { runId: RUN_ID, at: 'not-a-timestamp' };
    expect(await readOwnerLiveness(storeWithHeartbeat(fact), fakeClock(), RUN_ID)).toEqual({
      kind: 'unreadable',
    });
  });

  it('a fresh heartbeat is active with its age in milliseconds', async () => {
    const fact = { runId: RUN_ID, at: ISO(NOW - 4_000) };
    expect(await readOwnerLiveness(storeWithHeartbeat(fact), fakeClock(), RUN_ID)).toEqual({
      kind: 'active',
      at: fact.at,
      ageMs: 4_000,
    });
  });

  it('a heartbeat older than the stale threshold is presumed dead', async () => {
    const fact = { runId: RUN_ID, at: ISO(NOW - HEARTBEAT_STALE_MS - 1_000) };
    expect(await readOwnerLiveness(storeWithHeartbeat(fact), fakeClock(), RUN_ID)).toEqual({
      kind: 'presumed_dead',
      at: fact.at,
      ageMs: HEARTBEAT_STALE_MS + 1_000,
    });
  });

  it('a future-dated heartbeat (clock skew) is active with clamped age, never presumed dead', async () => {
    const fact = { runId: RUN_ID, at: ISO(NOW + 60_000) };
    expect(await readOwnerLiveness(storeWithHeartbeat(fact), fakeClock(), RUN_ID)).toEqual({
      kind: 'active',
      at: fact.at,
      ageMs: 0,
    });
  });

  it('exactly at the threshold boundary is still active', async () => {
    const fact = { runId: RUN_ID, at: ISO(NOW - HEARTBEAT_STALE_MS) };
    const liveness = await readOwnerLiveness(storeWithHeartbeat(fact), fakeClock(), RUN_ID);
    expect(liveness.kind).toBe('active');
  });
});

describe('classifyResumeRun with owner liveness (§17 resume)', () => {
  const active = { kind: 'active', at: ISO(NOW - 1_000), ageMs: 1_000 } as const;
  const presumedDead = {
    kind: 'presumed_dead',
    at: ISO(NOW - 60_000),
    ageMs: 60_000,
  } as const;
  const runningRun = () =>
    mkRun({
      status: 'running',
      planRevision: 1,
      tasksSha256: 'a'.repeat(64),
      currentTaskId: null,
    });

  it('terminal interrupted runs resume via the recorded point regardless of liveness', () => {
    const run = mkRun({
      status: 'failed',
      terminalAt: '2026-01-01T01:00:00Z',
      resumePoint: {
        fromStatus: 'running',
        taskId: null,
        sessionId: null,
        sessionType: null,
      },
    });
    const classification = classifyResumeRun(run, false, active);
    expect(classification.requiresOrphanReconciliation).toBe(false);
    expect(classification.point.fromStatus).toBe('running');
    expect(classification.liveness).toBeNull();
  });

  it('terminal runs without an interrupt resume point stay non-resumable', () => {
    expectApexError(
      () => classifyResumeRun(mkRun({ status: 'failed', terminalAt: '2026-01-01T01:00:00Z' }), false, presumedDead),
      'RUN_NOT_RESUMABLE',
    );
  });

  it('a presumed-dead owner is taken over without --force', () => {
    const classification = classifyResumeRun(runningRun(), false, presumedDead);
    expect(classification.requiresOrphanReconciliation).toBe(true);
    expect(classification.point.fromStatus).toBe('running');
    expect(classification.liveness).toBe(presumedDead);
  });

  it('an active owner still requires --force and says the process is alive', () => {
    const error = expectApexError(
      () => classifyResumeRun(runningRun(), false, active),
      'RESUME_REQUIRES_FORCE',
    );
    expect(error.message).toContain('still alive');
  });

  it('an unreadable heartbeat still requires --force', () => {
    const error = expectApexError(
      () => classifyResumeRun(runningRun(), false, { kind: 'unreadable' }),
      'RESUME_REQUIRES_FORCE',
    );
    expect(error.message).toContain('unreadable');
  });

  it('a missing heartbeat keeps the legacy --force gate message', () => {
    const error = expectApexError(
      () => classifyResumeRun(runningRun(), false, { kind: 'unknown' }),
      'RESUME_REQUIRES_FORCE',
    );
    expect(error.message).toContain('possibly still owned by a crashed process');
  });

  it.each([active, presumedDead, { kind: 'unreadable' } as const, { kind: 'unknown' } as const])(
    'explicit --force always takes over (liveness %j)',
    (liveness) => {
      const classification = classifyResumeRun(runningRun(), true, liveness);
      expect(classification.requiresOrphanReconciliation).toBe(true);
      expect(classification.liveness).toBe(liveness);
    },
  );
});

describe('createRunHeartbeat (§2.4)', () => {
  function makeTicker(failWrites = false) {
    const written: RunHeartbeatFact[] = [];
    const store = {
      writeHeartbeat: async (fact: RunHeartbeatFact) => {
        if (failWrites) throw new Error('disk full');
        written.push(fact);
      },
    } as unknown as StateStorePort;
    const ticks: Array<() => void> = [];
    let cleared = false;
    const scheduleInterval = (callback: () => void, _intervalMs: number): (() => void) => {
      ticks.push(callback);
      return () => {
        cleared = true;
      };
    };
    const heartbeat = createRunHeartbeat({
      stateStore: store,
      clock: fakeClock(),
      runId: RUN_ID,
      logger: createNullLogger(),
      intervalMs: 1_000,
      scheduleInterval,
    });
    const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
    return { written, ticks, cleared: () => cleared, heartbeat, settled };
  }

  it('start writes the first beat immediately and schedules periodic beats', async () => {
    const { written, ticks, heartbeat, settled } = makeTicker();
    expect(written).toHaveLength(0);
    heartbeat.start();
    await settled();
    expect(written).toHaveLength(1);
    /*
     * 心跳参与恢复接管判定，但其持久化格式仍必须与其他程序时间一致，
     * 使用当前操作系统时区且保持同一个绝对时间点。
     */
    expect(written[0]).toEqual({
      runId: RUN_ID,
      at: formatRfc3339InSystemTimeZone(new Date(NOW)),
    });
    expect(ticks).toHaveLength(1);
    // 上一拍未写完时重叠的 tick 会被跳过：先落盘再触发下一拍。
    ticks[0]!();
    await settled();
    ticks[0]!();
    await settled();
    expect(written).toHaveLength(3);
    heartbeat.close();
  });

  it('a tick fired while the previous write is still in flight is skipped', async () => {
    const { written, ticks, heartbeat, settled } = makeTicker();
    heartbeat.start();
    // 第一拍尚未落盘时连点两次：都不应堆积写请求。
    ticks[0]!();
    ticks[0]!();
    await settled();
    expect(written).toHaveLength(1);
    heartbeat.close();
  });

  it('close clears the scheduler and is idempotent', async () => {
    const { ticks, cleared, heartbeat, settled } = makeTicker();
    heartbeat.start();
    await settled();
    heartbeat.close();
    heartbeat.close();
    expect(cleared()).toBe(true);
    expect(ticks).toHaveLength(1);
  });

  it('a repeated start does not double-schedule', async () => {
    const { ticks, heartbeat, settled } = makeTicker();
    heartbeat.start();
    heartbeat.start();
    await settled();
    expect(ticks).toHaveLength(1);
    heartbeat.close();
  });

  it('write failures are swallowed (best-effort) and never reject the caller', async () => {
    const { heartbeat, settled } = makeTicker(true);
    heartbeat.start();
    await settled();
    heartbeat.close();
  });
});
