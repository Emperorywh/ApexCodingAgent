/**
 * E2E：属主存活信号驱动的崩溃判定（SPEC §2.4、§8.1 第 12 项、§17 resume）。
 *
 * 进程猝死（关窗、强杀、断电）后 run.json 停在非终态是产品边界；存活
 * 信号把"旧进程是否还在"从纯人工排查变成系统判定：
 * - 信号超时（崩溃离场）：start 给出免 --force 指引，resume 自动接管；
 * - 信号新鲜（可能存活）：start/resume 双双继续拦截，--force 仍是人工断言；
 * 两类路径都不重做已完成的 Task，孤儿事实由同一份协调器收尾。
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunJson } from '../../src/domain/schemas/run-json.js';
import {
  COMPLETE_HELP,
  createE2EHarness,
  executionCompleted,
  FAKE_VERSION,
  finalReviewCompleted,
  planDraft,
  streamOf,
  waitForRunFact,
  type E2EHarness,
} from './helpers.js';
import { seedRepo } from '../integration/git/helpers.js';

const ISO_BEFORE = (ms: number): string => new Date(Date.now() - ms).toISOString();

/**
 * 复现一次"Execution 会话内进程猝死"：起跑、中断收尾拿到完整事实，再
 * 手工还原崩溃现场（非终态 status、activeSession、running Task、未结束
 * Episode，绕过 StateStore 写入校验，等价于磁盘上的真实残留）。
 */
async function fabricateCrashedExecutionRun(harness: E2EHarness): Promise<{
  readonly crashedRun: RunJson;
  readonly crashedSessionId: string;
}> {
  await harness.writeScenario({
    version: FAKE_VERSION,
    help: COMPLETE_HELP,
    sequence: [
      { stdoutLines: streamOf(planDraft([{ id: 'TASK-001' }])) },
      { sleepMs: 300_000, stdoutLines: streamOf(executionCompleted()) },
    ],
  });
  const driving = harness.start();
  await waitForRunFact(
    harness,
    'execution activeSession in running',
    (run) => run.status === 'running' && run.activeSession?.type === 'execution',
    { driving },
  );
  harness.interrupt.request();
  const interrupted = await driving;
  expect(interrupted.kind).toBe('failed');
  if (interrupted.kind !== 'failed') throw new Error('expected an interrupted failed run');
  const failedRun = interrupted.run;
  const crashedSessionId = failedRun.resumePoint!.sessionId!;
  const crashedEpisode = failedRun.tasks['TASK-001']!.executionEpisodes[0]!;

  const crashedRun: RunJson = {
    ...failedRun,
    status: 'running',
    currentTaskId: 'TASK-001',
    activeSession: {
      sessionId: crashedSessionId,
      type: 'execution',
      taskId: 'TASK-001',
      planRevision: failedRun.planRevision,
      specSha256: crashedEpisode.specSha256Before,
      startedAt: crashedEpisode.startedAt,
    },
    tasks: {
      ...failedRun.tasks,
      'TASK-001': {
        ...failedRun.tasks['TASK-001']!,
        status: 'running',
        failure: null,
        executionEpisodes: [
          {
            ...crashedEpisode,
            specSha256After: null,
            endedAt: null,
            outcome: null,
            summary: null,
            acceptanceEvidence: [],
            finalCheckpoint: null,
            intermediateCheckpoint: null,
            checkpointReason: null,
            error: null,
          },
        ],
      },
    },
    lastError: null,
    terminalAt: null,
    resumePoint: null,
  };
  await writeFile(join(harness.stateDir, 'run.json'), JSON.stringify(crashedRun, null, 2), 'utf8');
  return { crashedRun, crashedSessionId };
}

describe('e2e owner heartbeat (§2.4)', () => {
  it(
    'start over a presumed-crashed run points to resume without --force',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        const { crashedRun } = await fabricateCrashedExecutionRun(harness);
        // 崩溃离场：最后一拍停在 60 秒前（阈值 30 秒）。
        await harness.writeHeartbeat({ runId: crashedRun.runId, at: ISO_BEFORE(60_000) });

        await harness.writeScenario({ version: FAKE_VERSION, help: COMPLETE_HELP, sequence: [] });
        const refused = await harness.start();
        expect(refused.kind).toBe('startup-failed');
        if (refused.kind !== 'startup-failed') return;
        expect(refused.error.errorCode).toBe('RUN_ALREADY_ACTIVE_OR_INTERRUPTED');
        expect(refused.error.message).toContain('presumed crashed');
        expect(refused.error.message).toContain('no --force needed');
        // 拒绝不修改任何状态：崩溃现场保持原样。
        expect((await harness.readRunJson()).status).toBe('running');
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  it(
    'resume without --force takes over a run whose owner heartbeat went stale',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        const { crashedRun, crashedSessionId } = await fabricateCrashedExecutionRun(harness);
        await harness.writeHeartbeat({ runId: crashedRun.runId, at: ISO_BEFORE(60_000) });

        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          sequence: [
            { stdoutLines: streamOf(executionCompleted()) },
            { stdoutLines: streamOf(finalReviewCompleted(['TASK-001'])) },
          ],
        });
        // 无 --force：崩溃离场判定生效，自动接管。
        const resumed = await harness.resume();
        expect(
          resumed.kind,
          JSON.stringify({
            error: resumed.kind === 'failed' ? resumed.run.lastError : null,
            output: harness.outputLines,
          }),
        ).toBe('completed');
        if (resumed.kind !== 'completed') return;

        // 前台提示给出崩溃依据，而不是"无法判断"的人工确认警告。
        const output = harness.outputLines.join('\n');
        expect(output).toContain('判定为崩溃离场');
        expect(output).not.toContain('无法判断');

        // 崩溃遗留的未结束 Episode 被关闭为 session_error；续接会话完成。
        const task = resumed.run.tasks['TASK-001']!;
        expect(task.status).toBe('completed');
        expect(task.executionEpisodes).toHaveLength(2);
        expect(task.executionEpisodes[0]!.outcome).toBe('session_error');
        expect(task.executionEpisodes[0]!.error?.errorCode).toBe('RUN_INTERRUPTED');
        expect(task.executionEpisodes[1]!.outcome).toBe('completed');

        // 接管后的首个会话经 --resume --fork-session 续接崩溃会话。
        const records = await harness.readRecords();
        const resumedInvocation = records.find((record) => record.argv.includes('--resume'));
        expect(resumedInvocation).toBeDefined();
        expect(resumedInvocation!.argv[resumedInvocation!.argv.indexOf('--resume') + 1]).toBe(
          crashedSessionId,
        );
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  it(
    'a fresh heartbeat keeps start and resume refusing with a live-owner message until --force',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        const { crashedRun } = await fabricateCrashedExecutionRun(harness);
        const freshen = () =>
          harness.writeHeartbeat({ runId: crashedRun.runId, at: new Date().toISOString() });

        // 信号新鲜：resume 无 --force 拒绝，文案明说属主可能仍存活。
        await freshen();
        const refusedResume = await harness.resume();
        expect(refusedResume.kind).toBe('command-failed');
        if (refusedResume.kind !== 'command-failed') return;
        expect(refusedResume.error.errorCode).toBe('RESUME_REQUIRES_FORCE');
        expect(refusedResume.error.message).toContain('still alive');
        expect((await harness.readRunJson()).status).toBe('running');

        // 信号新鲜：start 同样拒绝并指出属主仍存活。
        await freshen();
        await harness.writeScenario({ version: FAKE_VERSION, help: COMPLETE_HELP, sequence: [] });
        const refusedStart = await harness.start();
        expect(refusedStart.kind).toBe('startup-failed');
        if (refusedStart.kind !== 'startup-failed') return;
        expect(refusedStart.error.errorCode).toBe('RUN_ALREADY_ACTIVE_OR_INTERRUPTED');
        expect(refusedStart.error.message).toContain('still alive');

        // 显式 --force 是人工断言：带着存活风险提示接管并跑到终态。
        await freshen();
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          sequence: [
            { stdoutLines: streamOf(executionCompleted()) },
            { stdoutLines: streamOf(finalReviewCompleted(['TASK-001'])) },
          ],
        });
        const resumed = await harness.resume({ force: true });
        expect(resumed.kind).toBe('completed');
        expect(harness.outputLines.join('\n')).toContain('仍有存活信号');
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );
});
