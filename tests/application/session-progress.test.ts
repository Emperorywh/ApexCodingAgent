/**
 * invokeSession 的用户反馈测试（SPEC §17 start 进度语义）：
 * - Session 开始/结束各一行阶段行（类型、Revision、Task、耗时、结果）；
 * - Session 运行期间按 sessionHeartbeatMs 产出心跳行（已耗时、最近事件、
 *   已接收字节），settle 后不再产出；
 * - 失败行携带稳定 errorCode。
 */
import { describe, expect, it, vi } from 'vitest';
import { createInterruptController } from '../../src/application/interrupt.js';
import { createNullLogger } from '../../src/application/ports/logger.js';
import { ClaudeInvocationError, type ClaudeInvocationFact } from '../../src/application/ports/ClaudeRuntimePort.js';
import {
  invokeSession,
  type ActiveSessionHandle,
  type BeginSessionInput,
} from '../../src/application/usecases/claude-session.js';
import type { UseCaseDeps } from '../../src/application/usecase-deps.js';
import type { RunJson } from '../../src/domain/schemas/run-json.js';
import type { TaskPlanDraft } from '../../src/domain/schemas/task-plan-draft.js';

const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';

const input: BeginSessionInput<'planning'> = {
  type: 'planning',
  taskId: null,
  planRevision: 1,
  specSha256: 'a'.repeat(64),
  prompt: 'plan',
  permissionMode: 'plan',
  repositoryRoot: 'C:/repo',
};

const handle: ActiveSessionHandle<'planning'> = {
  sessionId: SESSION_ID,
  type: 'planning',
  taskId: null,
  planRevision: 1,
  specSha256: input.specSha256,
  startedAt: '2026-07-28T00:00:00.000Z',
  run: {} as RunJson,
};

function makeFact(): ClaudeInvocationFact<'planning'> {
  return {
    sessionId: SESSION_ID,
    type: 'planning',
    exitCode: 0,
    structuredResult: {} as TaskPlanDraft,
    claudeVersion: '1.0.0',
    model: 'fake-model',
    provider: 'fake-provider',
    stderrSummary: null,
    logPath: `logs/${SESSION_ID}.log`,
  };
}

interface FakeDeps {
  readonly deps: UseCaseDeps;
  readonly lines: string[];
  readonly waitResolvers: Array<() => void>;
  readonly invoke: ReturnType<typeof vi.fn>;
  readonly clock: { nowMs: number };
}

function createDeps(invokeImpl: (request: unknown) => Promise<unknown>): FakeDeps {
  const lines: string[] = [];
  const waitResolvers: Array<() => void> = [];
  const clock = { nowMs: 0 };
  const invoke = vi.fn(invokeImpl);
  const deps = {
    output: { writeLine: (line: string) => lines.push(line) },
    redaction: { redactText: (text: string) => text },
    logger: createNullLogger(),
    clock: { now: () => new Date(clock.nowMs) },
    wait: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          waitResolvers.push(resolve);
        }),
    ),
    interrupt: createInterruptController(),
    interruptWaitMs: 10_000,
    sessionHeartbeatMs: 15_000,
    claude: { invoke, abort: vi.fn() },
    capabilityReport: { version: 'test', capabilities: [] },
  } as unknown as UseCaseDeps;
  return { deps, lines, waitResolvers, invoke, clock };
}

/** 让已排队的微任务与 then 链全部 settle。 */
async function settleMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

describe('invokeSession 用户反馈', () => {
  it('会话开始与正常结束各输出一行阶段行', async () => {
    const { deps, lines } = createDeps(async () => makeFact());

    const fact = await invokeSession(deps, handle, input);

    expect(fact.model).toBe('fake-model');
    expect(lines[0]).toBe('[apex] session 123e4567 planning started (plan revision 1)');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('[apex] session 123e4567 planning finished in 0s');
    expect(lines[1]).toContain('model fake-model');
    expect(lines[1]).toContain('exit 0');
  });

  it('会话运行期间输出心跳行（已耗时 + 流活跃事实），settle 后不再输出', async () => {
    let capturedRequest: {
      onStreamActivity?: (activity: { receivedStdoutBytes: number; lastEventType: string | null }) => void;
    } | null = null;
    let resolveInvoke: ((fact: ClaudeInvocationFact<'planning'>) => void) | null = null;
    const { deps, lines, waitResolvers, clock } = createDeps(
      (request) =>
        new Promise((resolve) => {
          capturedRequest = request as typeof capturedRequest;
          resolveInvoke = resolve;
        }),
    );

    const pending = invokeSession(deps, handle, input);
    // 心跳循环已挂起在第一次 wait 上
    expect(waitResolvers).toHaveLength(1);

    capturedRequest!.onStreamActivity?.({ receivedStdoutBytes: 512, lastEventType: 'assistant' });
    clock.nowMs += 15_000;
    waitResolvers[0]!();
    await settleMicrotasks();

    const heartbeats = lines.filter((line) => line.includes(' running '));
    expect(heartbeats).toHaveLength(1);
    expect(heartbeats[0]).toContain('[apex] session 123e4567 planning running 15s');
    expect(heartbeats[0]).toContain('last event assistant');
    expect(heartbeats[0]).toContain('received 512 bytes');
    expect(waitResolvers.length).toBeGreaterThanOrEqual(2);

    // 会话 settle 后：结束行出现，后续 wait 到期也不再产出心跳
    resolveInvoke!(makeFact());
    const fact = await pending;
    expect(fact.exitCode).toBe(0);
    for (const resolve of waitResolvers.splice(0)) resolve();
    await settleMicrotasks();
    expect(lines.filter((line) => line.includes(' running '))).toHaveLength(1);
    expect(lines.some((line) => line.includes('finished in 15s'))).toBe(true);
  });

  it('调用失败时输出带稳定 errorCode 的失败行', async () => {
    const failure = new ClaudeInvocationError({
      code: 'CLAUDE_EXIT_NONZERO',
      stage: 'planning',
      message: 'claude exited 1',
      sessionId: SESSION_ID,
      taskId: null,
      processExitCode: 1,
      claudeVersion: '1.0.0',
    });
    const { deps, lines } = createDeps(async () => {
      throw failure;
    });

    await expect(invokeSession(deps, handle, input)).rejects.toBe(failure);

    expect(lines[0]).toContain('started');
    expect(lines[1]).toContain('[apex] session 123e4567 planning failed after 0s (CLAUDE_EXIT_NONZERO)');
  });
});
