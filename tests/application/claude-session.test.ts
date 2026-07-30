/**
 * Claude Session 启动边界回归测试。
 *
 * 中断控制器可能在驱动器检查之后、真正 spawn 之前置位；该窗口必须阻止
 * ClaudeRuntimePort.invoke，而不是启动新进程后只等待超时。
 */
import { describe, expect, it, vi } from 'vitest';
import { createRedactor } from '../../src/adapters/redaction/redactor.js';
import { createInterruptController } from '../../src/application/interrupt.js';
import {
  invokeSession,
  writeCompletedSessionRecord,
  type ActiveSessionHandle,
  type BeginSessionInput,
} from '../../src/application/usecases/claude-session.js';
import type { UseCaseDeps } from '../../src/application/usecase-deps.js';
import type { RunJson } from '../../src/domain/schemas/run-json.js';
import type { SessionRecord } from '../../src/domain/schemas/session-record.js';
import { mkRun, mkResult } from '../domain/fixtures.js';

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

describe('completed Session Record safety boundary', () => {
  it('redacts adapter metadata and structured output before persistence', async () => {
    /*
     * Application 不能假定所有 ClaudeRuntimePort 实现都像生产 Adapter 一样
     * 正确脱敏；Session Record 组装层必须再次建立安全领域事实。
     */
    const writeSessionRecord = vi.fn((record: SessionRecord) => {
      /*
       * Spy 显式保留 StateStorePort 的参数类型，使后续断言读取的记录仍有
       * 完整领域类型，而不是退化为无参数 Mock。
       */
      void record;
      return Promise.resolve();
    });
    const redaction = createRedactor();
    const deps = {
      redaction,
      clock: { now: () => new Date('2026-07-28T00:01:00.000Z') },
      stateStore: { writeSessionRecord },
      logger: { log: vi.fn(), flush: vi.fn(() => Promise.resolve()) },
    } as unknown as UseCaseDeps;
    const run = mkRun();
    const handle: ActiveSessionHandle<'execution'> = {
      sessionId: '123e4567-e89b-42d3-a456-426614174000',
      type: 'execution',
      taskId: 'TASK-001',
      planRevision: 1,
      specSha256: 'a'.repeat(64),
      startedAt: '2026-07-28T00:00:00.000Z',
      run,
    };
    const secret = 'sk-proj-abcdefghijklmnop';

    await writeCompletedSessionRecord(deps, handle, {
      sessionId: handle.sessionId,
      type: 'execution',
      exitCode: 0,
      structuredResult: mkResult({ summary: `result ${secret}` }),
      claudeVersion: `1.0.0 ${secret}`,
      model: `model ${secret}`,
      provider: `Bearer synthetic-provider-token`,
      stderrSummary: null,
      logPath: `logs/${handle.sessionId}.log`,
    });

    expect(writeSessionRecord).toHaveBeenCalledOnce();
    const record = writeSessionRecord.mock.calls[0]![0];
    expect(record.claude).toEqual({
      version: '1.0.0 [REDACTED]',
      model: 'model [REDACTED]',
      provider: 'Bearer [REDACTED]',
    });
    /*
     * completed 记录按领域不变式必须携带结构化结果；显式收窄同时让断言
     * 不依赖不安全的非空断言。
     */
    expect(record.structuredResult).not.toBeNull();
    if (record.structuredResult === null) throw new Error('completed result is missing');
    expect(record.structuredResult.summary).toBe('result [REDACTED]');
    expect(JSON.stringify(record)).not.toContain(secret);
  });
});
