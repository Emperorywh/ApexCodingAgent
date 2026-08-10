/**
 * ExecuteNextTask 调度失败的错误分类回归。
 *
 * 已提交计划无法产生可运行 Task 是运行态一致性损坏，不能复用 Planner
 * 草稿的 PLAN_INVALID 恢复语义；否则 resume 会重开 running 并原地失败。
 */
import { describe, expect, it, vi } from 'vitest';
import { createRedactor } from '../../src/adapters/redaction/redactor.js';
import { createNullLogger } from '../../src/application/ports/logger.js';
import type { UseCaseDeps } from '../../src/application/usecase-deps.js';
import { createExecuteNextTask } from '../../src/application/usecases/execute-next-task.js';
import { mkRun, mkTask, mkTaskState, T1 } from '../domain/fixtures.js';
import { mkTasks } from '../adapters/fixtures.js';

describe('ExecuteNextTask scheduling failure classification', () => {
  it('does not persist a resumable PLAN_INVALID point for stalled runtime state', async () => {
    const task = mkTask('TASK-001');
    const run = mkRun({
      status: 'running',
      planRevision: 1,
      tasks: { 'TASK-001': mkTaskState('TASK-001', 'failed') },
    });
    const writeRun = vi.fn(async () => undefined);
    const deps = {
      stateStore: {
        readRun: vi.fn(async () => run),
        readTasks: vi.fn(async () => mkTasks(1, [task])),
        writeRun,
      },
      clock: { now: () => new Date(T1) },
      redaction: createRedactor(),
      logger: createNullLogger(),
      output: {
        writeLine: vi.fn(),
        updateStatus: vi.fn(),
        clearStatus: vi.fn(),
      },
    } as unknown as UseCaseDeps;

    const result = await createExecuteNextTask(deps).execute();

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.run.lastError?.errorCode).toBe('STATE_VALIDATION_FAILED');
    expect(result.run.lastError?.stage).toBe('scheduling');
    expect(result.run.resumePoint).toBeNull();
    expect(writeRun).toHaveBeenCalledWith(result.run);
  });
});
