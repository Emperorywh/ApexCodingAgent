/**
 * E2E：前台中断（G5 测试清单 + §2.4 中断收尾六步）。
 *
 * 执行中长睡眠 Fake Claude + requestInterrupt → 有界收尾：停止新 Session、
 * 杀直接子进程、有界等待、保存失败 Record、结束未结束 Episode、原 running
 * Task 转 failed、清槽、Run 转 failed（RUN_INTERRUPTED）。退出语义（第二次
 * 中断、退出码）属于 G6。
 */
import { describe, expect, it } from 'vitest';
import {
  COMPLETE_HELP,
  createE2EHarness,
  executionCompleted,
  FAKE_VERSION,
  planDraft,
  streamOf,
} from './helpers.js';
import { seedRepo } from '../integration/git/helpers.js';

describe('e2e foreground interrupt (§2.4)', () => {
  it(
    'interrupt during a long execution settles within the bounded window with RUN_INTERRUPTED facts',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          sequence: [
            { stdoutLines: streamOf(planDraft([{ id: 'TASK-001' }, { id: 'TASK-002', dependsOn: ['TASK-001'] }])) },
            // TASK-001 长时间睡眠，等待中断。
            { sleepMs: 300_000, stdoutLines: streamOf(executionCompleted()) },
          ],
        });

        const startedAt = Date.now();
        const driving = harness.start();
        // 等待进入 Execution（activeSession 已写入）。
        for (let attempt = 0; attempt < 100; attempt += 1) {
          try {
            const run = await harness.readRunJson();
            if (run.status === 'running' && run.activeSession !== null) break;
          } catch {
            // run.json 尚未创建
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        harness.interrupt.request();
        const result = await driving;
        const elapsedMs = Date.now() - startedAt;

        // 有界收尾：远小于 10 秒等待上限 + 睡眠时长。
        expect(elapsedMs).toBeLessThan(60_000);
        expect(result.kind).toBe('failed');
        if (result.kind !== 'failed') return;
        const run = result.run;

        // 第 6 步：Run 转 failed，错误码 RUN_INTERRUPTED。
        expect(run.lastError?.errorCode).toBe('RUN_INTERRUPTED');
        expect(run.status).toBe('failed');
        expect(run.terminalAt).not.toBeNull();
        // 第 5 步：原 running Task 转 failed，清槽。
        expect(run.activeSession).toBeNull();
        expect(run.currentTaskId).toBeNull();
        const task = run.tasks['TASK-001']!;
        expect(task.status).toBe('failed');
        expect(task.failure?.errorCode).toBe('RUN_INTERRUPTED');
        // 第 4 步：未结束 Episode 结束为 session_error。
        expect(task.executionEpisodes[0]!.outcome).toBe('session_error');
        expect(task.executionEpisodes[0]!.error?.errorCode).toBe('RUN_INTERRUPTED');
        // 失败 Session Record：进程被信号结束，exitCode 为 null（不伪造整数）。
        const records = await harness.listSessionRecords();
        expect(records).toHaveLength(2);
        expect(records[1]!.status).toBe('failed');
        expect(records[1]!.exitCode).toBeNull();
        expect(records[1]!.error?.errorCode).toBe('RUN_INTERRUPTED');
        // TASK-002 保持 pending，未启动新 Session。
        expect(run.tasks['TASK-002']!.status).toBe('pending');
        expect(records.filter((record) => record.type === 'execution')).toHaveLength(1);
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  it(
    'interrupt during planning fails the run before any revision exists',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          sequence: [{ sleepMs: 300_000, stdoutLines: streamOf(planDraft([{ id: 'TASK-001' }])) }],
        });

        const driving = harness.start();
        for (let attempt = 0; attempt < 100; attempt += 1) {
          try {
            const run = await harness.readRunJson();
            if (run.activeSession !== null) break;
          } catch {
            // run.json 尚未创建
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        harness.interrupt.request();
        const result = await driving;
        expect(result.kind).toBe('failed');
        if (result.kind !== 'failed') return;
        expect(result.run.lastError?.errorCode).toBe('RUN_INTERRUPTED');
        expect(result.run.planRevision).toBe(0);
        expect(result.run.tasksSha256).toBeNull();
        expect(result.run.activeSession).toBeNull();
        const records = await harness.listSessionRecords();
        expect(records).toHaveLength(1);
        expect(records[0]!.status).toBe('failed');
        expect(records[0]!.error?.errorCode).toBe('RUN_INTERRUPTED');
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );
});
