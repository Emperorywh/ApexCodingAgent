/**
 * GenerateReport 的状态读取边界回归测试。
 *
 * 报告只能消费 StateStore 提供的一次一致性快照；若重新分别读取 run/tasks，
 * 并发写入时可能把两个 stateRevision 的事实拼成一份不存在的报告。
 */
import { describe, expect, it, vi } from 'vitest';
import { createGenerateReport } from '../../src/application/usecases/generate-report.js';
import type { StateStorePort } from '../../src/application/ports/state-store.js';
import type { GitPort } from '../../src/application/ports/GitPort.js';
import type { ReporterPort } from '../../src/application/ports/ReporterPort.js';
import { mkErrorRecord, mkRun, SHA256_A, T1 } from '../domain/fixtures.js';

describe('GenerateReport consistent snapshot', () => {
  it('只读取一次一致性快照，不再分别读取 run.json 与 tasks.json', async () => {
    const run = mkRun({
      status: 'failed',
      terminalAt: T1,
      lastError: mkErrorRecord(),
    });
    const readConsistentSnapshot = vi.fn(async () => ({ run, tasks: null }));
    const readRun = vi.fn(() => {
      throw new Error('readRun must not be called');
    });
    const readTasks = vi.fn(() => {
      throw new Error('readTasks must not be called');
    });
    const stateStore = {
      readConsistentSnapshot,
      readRun,
      readTasks,
      readPlanSnapshot: vi.fn(),
      readSessionRecord: vi.fn(),
    } as unknown as StateStorePort;
    const git = {
      readSpecFact: vi.fn(async () => ({ path: run.spec.path, sha256: SHA256_A })),
      readRepositoryStatus: vi.fn(async () => ({
        head: { branch: run.repository.runBranch, oid: run.repository.expectedHead },
        statusEntries: [],
      })),
    } as unknown as GitPort;
    const reporter = {
      generateReport: vi.fn(async () => 'report.md'),
    } as unknown as ReporterPort;

    const result = await createGenerateReport({ stateStore, git, reporter }).execute();

    expect(result.runId).toBe(run.runId);
    expect(result.reportPath).toBe('report.md');
    expect(readConsistentSnapshot).toHaveBeenCalledTimes(1);
    expect(readRun).not.toHaveBeenCalled();
    expect(readTasks).not.toHaveBeenCalled();
  });
});
