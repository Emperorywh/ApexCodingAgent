/**
 * invokeSession 的用户反馈测试（SPEC §17 start 进度语义）：
 * - Session 开始/结束各一行阶段行（类型、Revision、Task、耗时、结果）；
 * - Session 运行期间按 sessionHeartbeatMs 产出心跳行（已耗时、最近事件、
 *   已接收字节），settle 后不再产出；
 * - 默认只即时输出关键工具动作，思考、系统事件与成功结果留在完整日志；
 * - 结构化事件通过 sequence 去重，避免底层 stdout 分块导致重复展示；
 * - 失败行携带稳定 errorCode。
 */
import { describe, expect, it, vi } from 'vitest';
import { createInterruptController } from '../../src/application/interrupt.js';
import { createNullLogger } from '../../src/application/ports/logger.js';
import {
  ClaudeInvocationError,
  type ClaudeInvocationFact,
  type ClaudeStreamActivity,
} from '../../src/application/ports/ClaudeRuntimePort.js';
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
    expect(lines[0]).toBe('◆ 规划 · 计划版本 1 · 会话 123e4567');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('✓ 规划完成 · 用时 0s');
    expect(lines[1]).toContain('模型 fake-model');
  });

  it('会话运行期间输出心跳行（已耗时 + 流活跃事实），settle 后不再输出', async () => {
    let capturedRequest: {
      onStreamActivity?: (activity: ClaudeStreamActivity) => void;
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

    capturedRequest!.onStreamActivity?.({
      receivedStdoutBytes: 512,
      lastEventType: 'assistant',
      displayEvent: null,
      model: null,
      provider: null,
    });
    clock.nowMs += 15_000;
    waitResolvers[0]!();
    await settleMicrotasks();

    const heartbeats = lines.filter((line) => line.includes(' running '));
    const compactHeartbeats = lines.filter((line) => line.includes('Claude 仍在工作'));
    expect(heartbeats).toHaveLength(0);
    expect(compactHeartbeats).toHaveLength(1);
    expect(compactHeartbeats[0]).toContain('已运行 15s');
    expect(compactHeartbeats[0]).toContain('已接收 512 B');
    expect(waitResolvers.length).toBeGreaterThanOrEqual(2);

    // 会话 settle 后：结束行出现，后续 wait 到期也不再产出心跳
    resolveInvoke!(makeFact());
    const fact = await pending;
    expect(fact.exitCode).toBe(0);
    for (const resolve of waitResolvers.splice(0)) resolve();
    await settleMicrotasks();
    expect(lines.filter((line) => line.includes('Claude 仍在工作'))).toHaveLength(1);
    expect(lines.some((line) => line.includes('用时 15s'))).toBe(true);
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

    expect(lines[0]).toContain('◆ 规划');
    expect(lines[1]).toContain('✗ 规划失败 · 用时 0s · CLAUDE_EXIT_NONZERO');
  });

  it('默认只打印工具动作，隐藏 thinking 与其他低信噪比事件', async () => {
    let capturedRequest: {
      onStreamActivity?: (activity: ClaudeStreamActivity) => void;
    } | null = null;
    let resolveInvoke: ((fact: ClaudeInvocationFact<'planning'>) => void) | null = null;
    const { deps, lines } = createDeps(
      (request) =>
        new Promise((resolve) => {
          capturedRequest = request as typeof capturedRequest;
          resolveInvoke = resolve;
        }),
    );

    const pending = invokeSession(deps, handle, input);

    capturedRequest!.onStreamActivity?.({
      receivedStdoutBytes: 100,
      lastEventType: 'assistant',
      displayEvent: { sequence: 1, kind: 'thinking', label: '思考', detail: '先读 SPEC' },
      model: null,
      provider: null,
    });
    /*
     * 同一结构化事件快照因 stdout 分块重复上报时不得重复输出。
     * sequence 是事件身份，不能退化为比较可能重复出现的展示字符串。
     */
    capturedRequest!.onStreamActivity?.({
      receivedStdoutBytes: 100,
      lastEventType: 'assistant',
      displayEvent: { sequence: 1, kind: 'thinking', label: '思考', detail: '先读 SPEC' },
      model: null,
      provider: null,
    });
    capturedRequest!.onStreamActivity?.({
      receivedStdoutBytes: 260,
      lastEventType: 'assistant',
      displayEvent: { sequence: 2, kind: 'tool', label: 'Read', detail: 'C:/repo/docs/SPEC.md' },
      model: null,
      provider: null,
    });
    // 无可摘要事件：不输出事件行。
    capturedRequest!.onStreamActivity?.({
      receivedStdoutBytes: 300,
      lastEventType: 'assistant',
      displayEvent: null,
      model: null,
      provider: null,
    });

    resolveInvoke!(makeFact());
    await pending;

    const eventLines = lines.filter((line) => line.includes('→'));
    expect(eventLines).toEqual(['  → 读取  ./docs/SPEC.md']);
    expect(lines.some((line) => line.includes('先读 SPEC'))).toBe(false);
  });

  it('init 元数据首次非空时输出一行模型信息，且不重复输出', async () => {
    let capturedRequest: {
      onStreamActivity?: (activity: ClaudeStreamActivity) => void;
    } | null = null;
    let resolveInvoke: ((fact: ClaudeInvocationFact<'planning'>) => void) | null = null;
    const { deps, lines } = createDeps(
      (request) =>
        new Promise((resolve) => {
          capturedRequest = request as typeof capturedRequest;
          resolveInvoke = resolve;
        }),
    );

    const pending = invokeSession(deps, handle, input);

    // init 事件到达前：没有模型行。
    capturedRequest!.onStreamActivity?.({
      receivedStdoutBytes: 10,
      lastEventType: null,
      displayEvent: null,
      model: null,
      provider: null,
    });
    expect(lines.some((line) => line.includes('模型 '))).toBe(false);

    capturedRequest!.onStreamActivity?.({
      receivedStdoutBytes: 80,
      lastEventType: 'system',
      displayEvent: { sequence: 1, kind: 'system', label: 'init', detail: null },
      model: 'claude-fake-model-1',
      provider: 'fake-provider',
    });
    // 分块重复上报同一 init 元数据：不重复输出。
    capturedRequest!.onStreamActivity?.({
      receivedStdoutBytes: 90,
      lastEventType: 'system',
      displayEvent: { sequence: 1, kind: 'system', label: 'init', detail: null },
      model: 'claude-fake-model-1',
      provider: 'fake-provider',
    });

    resolveInvoke!(makeFact());
    await pending;

    const modelLines = lines.filter((line) => line.includes('模型 claude-fake-model-1'));
    expect(modelLines).toHaveLength(1);
    expect(modelLines[0]).toBe(
      '  模型 claude-fake-model-1 · Provider fake-provider',
    );
  });

  it('provider 缺失时模型行只携带 model', async () => {
    let capturedRequest: {
      onStreamActivity?: (activity: ClaudeStreamActivity) => void;
    } | null = null;
    let resolveInvoke: ((fact: ClaudeInvocationFact<'planning'>) => void) | null = null;
    const { deps, lines } = createDeps(
      (request) =>
        new Promise((resolve) => {
          capturedRequest = request as typeof capturedRequest;
          resolveInvoke = resolve;
        }),
    );

    const pending = invokeSession(deps, handle, input);
    capturedRequest!.onStreamActivity?.({
      receivedStdoutBytes: 80,
      lastEventType: 'system',
      displayEvent: { sequence: 1, kind: 'system', label: 'init', detail: null },
      model: 'claude-fake-model-1',
      provider: null,
    });

    resolveInvoke!(makeFact());
    await pending;

    const modelLines = lines.filter((line) => line.includes('模型 claude-fake-model-1'));
    expect(modelLines).toHaveLength(1);
    expect(modelLines[0]).toBe('  模型 claude-fake-model-1');
  });
});
