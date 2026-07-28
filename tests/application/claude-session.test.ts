/**
 * Claude Session 启动边界回归测试。
 *
 * 中断控制器可能在驱动器检查之后、真正 spawn 之前置位；该窗口必须阻止
 * ClaudeRuntimePort.invoke，而不是启动新进程后只等待超时。
 */
import { describe, expect, it, vi } from 'vitest';
import { createInterruptController } from '../../src/application/interrupt.js';
import {
  invokeSession,
  type ActiveSessionHandle,
  type BeginSessionInput,
} from '../../src/application/usecases/claude-session.js';
import type { UseCaseDeps } from '../../src/application/usecase-deps.js';
import type { RunJson } from '../../src/domain/schemas/run-json.js';

describe('invokeSession interrupt gate', () => {
  it('已请求中断时不启动新的 Claude 进程', async () => {
    const interrupt = createInterruptController();
    const invoke = vi.fn();
    const abort = vi.fn();
    const deps = {
      interrupt,
      claude: { invoke, abort },
      capabilityReport: { version: 'test', capabilities: [] },
      wait: vi.fn(() => Promise.resolve()),
      interruptWaitMs: 10_000,
    } as unknown as UseCaseDeps;
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
      sessionId: '123e4567-e89b-42d3-a456-426614174000',
      type: 'planning',
      taskId: null,
      planRevision: 1,
      specSha256: input.specSha256,
      startedAt: '2026-07-28T00:00:00.000Z',
      run: {} as RunJson,
    };

    interrupt.request();

    await expect(invokeSession(deps, handle, input)).rejects.toMatchObject({
      errorCode: 'RUN_INTERRUPTED',
      processExitCode: null,
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
  });
});
