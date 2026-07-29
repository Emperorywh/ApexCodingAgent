/**
 * E2E：resume 命令（SPEC §17 resume、§2.4 中断恢复）。
 *
 * 覆盖三类 Session 的真实续接、精确的 transcript 缺失回退、可写会话
 * 已产生提交后的 Git 接管，以及前置校验失败不消耗恢复点。
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunJson } from '../../src/domain/schemas/run-json.js';
import {
  COMPLETE_HELP,
  createE2EHarness,
  executionCompleted,
  FAKE_CLAUDE_PATH,
  FAKE_VERSION,
  finalReviewCompleted,
  planDraft,
  streamOf,
  waitForRunFact,
  type E2EHarness,
  type ScenarioElement,
} from './helpers.js';
import { seedRepo } from '../integration/git/helpers.js';

/**
 * 等待目标 Session 的 activeSession 事实成功落盘。
 *
 * 只有状态已经持久化后才请求中断，确保测试验证的是可恢复的持久化边界，
 * 而不是进程启动前的偶然竞速。
 */
async function waitForActiveSession(
  harness: E2EHarness,
  status: 'planning' | 'running' | 'final_review',
  type: 'planning' | 'execution' | 'final_review',
  options: {
    readonly predicate?: (run: RunJson) => boolean;
    /** start/resume 的 Promise；提前结算时立即暴露真实结果而非空等。 */
    readonly driving?: Promise<unknown> | undefined;
  } = {},
): Promise<void> {
  const predicate = options.predicate ?? (() => true);
  await waitForRunFact(
    harness,
    `${type} activeSession in ${status}`,
    (run) => run.status === status && run.activeSession?.type === type && predicate(run),
    { driving: options.driving },
  );
}

/** 起跑并在 Execution 长睡眠期间中断，返回失败 Run 与恢复点事实。 */
async function startAndInterruptDuringExecution(
  harness: E2EHarness,
  plan: Record<string, unknown>,
  options: {
    readonly executionScenario?: ScenarioElement;
    readonly startInput?: Parameters<E2EHarness['start']>[0];
    /**
     * activeSession 落盘后、中断请求前需要等待的额外外部事实。
     *
     * 用于验证 Claude 已经产生 Git 提交但尚未正常退出的恢复窗口。
     */
    readonly beforeInterrupt?: () => Promise<void>;
  } = {},
): Promise<RunJson> {
  await harness.writeScenario({
    version: FAKE_VERSION,
    help: COMPLETE_HELP,
    sequence: [
      { stdoutLines: streamOf(plan) },
      // Execution 长时间睡眠，等待中断。
      options.executionScenario ?? {
        sleepMs: 300_000,
        stdoutLines: streamOf(executionCompleted()),
      },
    ],
  });

  const driving = harness.start(options.startInput);
  await waitForActiveSession(harness, 'running', 'execution', { driving });
  await options.beforeInterrupt?.();
  harness.interrupt.request();
  const result = await driving;
  expect(result.kind).toBe('failed');
  if (result.kind !== 'failed') throw new Error('expected an interrupted failed run');
  return result.run;
}

describe('e2e resume (§17)', () => {
  it(
    'resumes an interrupted run: reopens at the recorded point and forks the interrupted Claude session',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        const failedRun = await startAndInterruptDuringExecution(
          harness,
          planDraft([{ id: 'TASK-001' }, { id: 'TASK-002', dependsOn: ['TASK-001'] }]),
        );

        // 中断收尾记录了恢复点：中断前状态、被中断 Task 与 Claude Session。
        expect(failedRun.resumePoint).toEqual({
          fromStatus: 'running',
          taskId: 'TASK-001',
          sessionId: expect.any(String),
        });
        const interruptedSessionId = failedRun.resumePoint!.sessionId!;

        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          sequence: [
            { stdoutLines: streamOf(executionCompleted()) },
            { stdoutLines: streamOf(executionCompleted()) },
            { stdoutLines: streamOf(finalReviewCompleted(['TASK-001', 'TASK-002'])) },
          ],
        });
        const resumed = await harness.resume();
        expect(
          resumed.kind,
          JSON.stringify({
            error: resumed.kind === 'failed' ? resumed.run.lastError : null,
            output: harness.outputLines,
          }),
        ).toBe('completed');
        if (resumed.kind !== 'completed') return;

        // 恢复点已消费：终态 completed 不再携带 resumePoint；两个 Task 全部完成。
        expect(resumed.run.status).toBe('completed');
        expect(resumed.run.resumePoint).toBeNull();
        expect(resumed.run.tasks['TASK-001']!.status).toBe('completed');
        expect(resumed.run.tasks['TASK-002']!.status).toBe('completed');

        // 首个恢复会话经 --resume <旧ID> --fork-session --session-id <新ID> 启动。
        const records = await harness.readRecords();
        const resumedInvocation = records.find((record) => record.argv.includes('--resume'));
        expect(resumedInvocation).toBeDefined();
        const argv = resumedInvocation!.argv;
        expect(argv[argv.indexOf('--resume') + 1]).toBe(interruptedSessionId);
        expect(argv).toContain('--fork-session');
        expect(argv).toContain('--session-id');
        const forkedSessionId = argv[argv.indexOf('--session-id') + 1]!;
        expect(forkedSessionId).not.toBe(interruptedSessionId);

        // 后续会话（TASK-002、Final Review）不再携带 --resume。
        const laterInvocations = records.slice(records.indexOf(resumedInvocation!) + 1);
        expect(laterInvocations.every((record) => !record.argv.includes('--resume'))).toBe(true);

        // Session Record 链完整：planning、被中断 execution（failed）、
        // 续接 execution、TASK-002 execution、final review。
        const sessionRecords = await harness.listSessionRecords();
        expect(sessionRecords).toHaveLength(5);
        const executionRecords = sessionRecords.filter((record) => record.type === 'execution');
        expect(executionRecords).toHaveLength(3);
        expect(executionRecords[0]!.status).toBe('failed');
        expect(executionRecords[0]!.error?.errorCode).toBe('RUN_INTERRUPTED');
        expect(executionRecords[1]!.status).toBe('completed');
        expect(executionRecords[1]!.sessionId).toBe(forkedSessionId);
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  it(
    'falls back to a fresh session when the interrupted Claude session cannot be resumed',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await startAndInterruptDuringExecution(harness, planDraft([{ id: 'TASK-001' }]));

        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          sequence: [
            // 续接会话失败（模拟 transcript 不存在）：非零退出。
            { exitCode: 1, stderrText: 'No conversation found for session ID' },
            // 有界回退：全新会话（标准完整 prompt）。
            { stdoutLines: streamOf(executionCompleted()) },
            { stdoutLines: streamOf(finalReviewCompleted(['TASK-001'])) },
          ],
        });
        const resumed = await harness.resume();
        expect(
          resumed.kind,
          JSON.stringify({
            error: resumed.kind === 'failed' ? resumed.run.lastError : null,
            output: harness.outputLines,
          }),
        ).toBe('completed');

        // 前台能看到回退事实。
        expect(harness.outputLines.join('\n')).toContain('resume unavailable');

        // 回退接力：第一趟带 --resume 失败，第二趟不带 --resume 成功。
        const records = await harness.readRecords();
        const executionInvocations = records.filter(
          (record) => !record.argv.includes('--version') && !record.argv.includes('--help'),
        );
        const resumeAttempt = executionInvocations.find((record) =>
          record.argv.includes('--resume'),
        );
        expect(resumeAttempt).toBeDefined();
        const relayInvocation = executionInvocations[executionInvocations.indexOf(resumeAttempt!) + 1]!;
        expect(relayInvocation.argv).not.toContain('--resume');
        expect(relayInvocation.argv).toContain('--session-id');

        // 失败 Record 链：被中断会话与续接失败会话都以 failed 落盘。
        const sessionRecords = await harness.listSessionRecords();
        const executionRecords = sessionRecords.filter((record) => record.type === 'execution');
        expect(executionRecords).toHaveLength(3);
        expect(executionRecords[0]!.error?.errorCode).toBe('RUN_INTERRUPTED');
        expect(executionRecords[1]!.status).toBe('failed');
        expect(executionRecords[1]!.error?.errorCode).toBe(
          'CLAUDE_RESUME_UNAVAILABLE',
        );
        expect(executionRecords[2]!.status).toBe('completed');
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  it(
    'does not retry authentication or quota failures from a resume attempt',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await startAndInterruptDuringExecution(harness, planDraft([{ id: 'TASK-001' }]));
        const invocationCountBeforeResume = (await harness.readRecords()).length;

        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          sequence: [
            {
              exitCode: 1,
              stderrText: 'authentication failed: account quota unavailable',
            },
          ],
        });
        const resumed = await harness.resume();
        expect(resumed.kind).toBe('failed');
        if (resumed.kind !== 'failed') return;
        expect(resumed.run.lastError?.errorCode).toBe('CLAUDE_EXIT_NONZERO');
        expect(harness.outputLines.join('\n')).not.toContain('resume unavailable');

        /**
         * resume 自身会执行 version/help 两次探测，但业务 Session 只能有
         * 一趟带 --resume 的调用；若错误地回退，会出现第二趟全新 Session。
         */
        const resumeRecords = (await harness.readRecords()).slice(
          invocationCountBeforeResume,
        );
        const sessionInvocations = resumeRecords.filter(
          (record) => !record.argv.includes('--version') && !record.argv.includes('--help'),
        );
        expect(sessionInvocations).toHaveLength(1);
        expect(sessionInvocations[0]!.argv).toContain('--resume');

        const executionRecords = (await harness.listSessionRecords()).filter(
          (record) => record.type === 'execution',
        );
        expect(executionRecords[1]!.error?.errorCode).toBe('CLAUDE_EXIT_NONZERO');
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  it(
    'accepts safe commits created by the interrupted execution session and advances expectedHead',
    async () => {
      const harness = await createE2EHarness();
      try {
        const baseCommit = await seedRepo(harness.repo);
        const failedRun = await startAndInterruptDuringExecution(
          harness,
          planDraft([{ id: 'TASK-001' }]),
          {
            executionScenario: {
              writeFiles: [
                {
                  path: 'src/partial.ts',
                  content: 'export const partial = true;\n',
                },
              ],
              commands: [
                { argv: ['git', 'add', 'src/partial.ts'] },
                { argv: ['git', 'commit', '-m', 'partial session work'] },
              ],
              sleepMs: 300_000,
              stdoutLines: streamOf(executionCompleted()),
            },
            beforeInterrupt: async () => {
              // Fake Claude 的会话命令真实执行 git 提交；高负载下进程接力
              // 可能远超空闲基线，预算与 waitForRunFact 对齐（60 秒）。
              for (let attempt = 0; attempt < 600; attempt += 1) {
                if ((await harness.repo.head()) !== baseCommit) return;
                await new Promise((resolve) => setTimeout(resolve, 100));
              }
              throw new Error('timed out waiting for the interrupted session commit');
            },
          },
        );
        const inFlightHead = await harness.repo.head();
        expect(inFlightHead).not.toBe(failedRun.repository.expectedHead);
        expect(
          await harness.repo.git('merge-base', '--is-ancestor', baseCommit, inFlightHead),
        ).toBe('');

        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          sequence: [
            { stdoutLines: streamOf(executionCompleted()) },
            { stdoutLines: streamOf(finalReviewCompleted(['TASK-001'])) },
          ],
        });
        const resumed = await harness.resume();
        expect(
          resumed.kind,
          JSON.stringify({
            error: resumed.kind === 'failed' ? resumed.run.lastError : null,
            output: harness.outputLines,
          }),
        ).toBe('completed');
        if (resumed.kind !== 'completed') return;
        expect(resumed.run.repository.expectedHead).toBe(await harness.repo.head());
        expect(
          await harness.repo.git('merge-base', '--is-ancestor', inFlightHead, 'HEAD'),
        ).toBe('');
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  it(
    'resumes an interrupted Planning session before creating the first plan revision',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          sequence: [
            {
              sleepMs: 300_000,
              stdoutLines: streamOf(planDraft([{ id: 'TASK-001' }])),
            },
          ],
        });
        const driving = harness.start();
        await waitForActiveSession(harness, 'planning', 'planning', { driving });
        harness.interrupt.request();
        const interrupted = await driving;
        expect(interrupted.kind).toBe('failed');
        if (interrupted.kind !== 'failed') return;
        expect(interrupted.run.resumePoint?.fromStatus).toBe('planning');
        const sessionId = interrupted.run.resumePoint!.sessionId!;

        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          sequence: [
            { stdoutLines: streamOf(planDraft([{ id: 'TASK-001' }])) },
            { stdoutLines: streamOf(executionCompleted()) },
            { stdoutLines: streamOf(finalReviewCompleted(['TASK-001'])) },
          ],
        });
        const resumed = await harness.resume();
        expect(
          resumed.kind,
          JSON.stringify({
            error: resumed.kind === 'failed' ? resumed.run.lastError : null,
            output: harness.outputLines,
          }),
        ).toBe('completed');
        const invocation = (await harness.readRecords()).find((record) =>
          record.argv.includes('--resume'),
        );
        expect(invocation?.argv[invocation.argv.indexOf('--resume') + 1]).toBe(sessionId);
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  it(
    'resumes an interrupted re-planning session with a run_resumed revision trigger',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          sequence: [
            { stdoutLines: streamOf(planDraft([{ id: 'TASK-001' }])) },
            {
              stdoutLines: streamOf(
                executionCompleted(1, {
                  decision: 'replan_required',
                  summary: '需要根据实现发现重新规划',
                  replanReason: '仓库事实要求调整任务边界',
                }),
              ),
            },
            {
              sleepMs: 300_000,
              stdoutLines: streamOf(planDraft([{ id: 'TASK-001' }])),
            },
          ],
        });
        const driving = harness.start();
        /**
         * 初始 Planning 也会短暂满足类型条件；必须等待 planRevision=1，
         * 才能确认中断落在 Execution 触发的第二轮 Planning。
         */
        await waitForActiveSession(harness, 'planning', 'planning', {
          predicate: (run) => run.planRevision === 1,
          driving,
        });
        harness.interrupt.request();
        const interrupted = await driving;
        expect(interrupted.kind).toBe('failed');
        if (interrupted.kind !== 'failed') return;
        expect(interrupted.run.resumePoint?.fromStatus).toBe('planning');

        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          sequence: [
            { stdoutLines: streamOf(planDraft([{ id: 'TASK-001' }])) },
            { stdoutLines: streamOf(executionCompleted()) },
            { stdoutLines: streamOf(finalReviewCompleted(['TASK-001'])) },
          ],
        });
        const resumed = await harness.resume();
        expect(resumed.kind).toBe('completed');
        if (resumed.kind !== 'completed') return;
        expect(resumed.run.planRevision).toBe(2);
        expect((await harness.readPlanSnapshot(2)).trigger).toEqual({
          type: 'run_resumed',
          reason: 'planning resumed after interrupt',
          sourceSessionId: interrupted.run.resumePoint!.sessionId,
        });
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  it(
    'resumes an interrupted Final Review session without replaying completed tasks',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          sequence: [
            { stdoutLines: streamOf(planDraft([{ id: 'TASK-001' }])) },
            { stdoutLines: streamOf(executionCompleted()) },
            {
              sleepMs: 300_000,
              stdoutLines: streamOf(finalReviewCompleted(['TASK-001'])),
            },
          ],
        });
        const driving = harness.start();
        await waitForActiveSession(harness, 'final_review', 'final_review', { driving });
        harness.interrupt.request();
        const interrupted = await driving;
        expect(interrupted.kind).toBe('failed');
        if (interrupted.kind !== 'failed') return;
        expect(interrupted.run.resumePoint?.fromStatus).toBe('final_review');
        expect(interrupted.run.tasks['TASK-001']!.status).toBe('completed');
        const sessionId = interrupted.run.resumePoint!.sessionId!;
        const invocationCountBeforeResume = (await harness.readRecords()).length;

        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          sequence: [
            { stdoutLines: streamOf(finalReviewCompleted(['TASK-001'])) },
          ],
        });
        const resumed = await harness.resume();
        expect(resumed.kind).toBe('completed');

        const resumeRecords = (await harness.readRecords()).slice(
          invocationCountBeforeResume,
        );
        const sessionInvocations = resumeRecords.filter(
          (record) => !record.argv.includes('--version') && !record.argv.includes('--help'),
        );
        expect(sessionInvocations).toHaveLength(1);
        const invocation = sessionInvocations[0]!;
        expect(invocation.argv[invocation.argv.indexOf('--resume') + 1]).toBe(sessionId);
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  it(
    'preserves the original resume point when Git prevalidation fails and can retry after repair',
    async () => {
      const harness = await createE2EHarness();
      try {
        const baseCommit = await seedRepo(harness.repo);
        const failedRun = await startAndInterruptDuringExecution(
          harness,
          planDraft([{ id: 'TASK-001' }]),
        );
        const baseTree = await harness.repo.git('rev-parse', `${baseCommit}^{tree}`);
        const movedBase = await harness.repo.git(
          'commit-tree',
          baseTree,
          '-p',
          baseCommit,
          '-m',
          'move base ref',
        );
        await harness.repo.git('update-ref', failedRun.repository.baseBranchRef, movedBase);

        const refused = await harness.resume();
        expect(refused.kind).toBe('command-failed');
        if (refused.kind !== 'command-failed') return;
        expect(refused.error.errorCode).toBe('GIT_HISTORY_DIVERGED');
        expect(await harness.readRunJson()).toEqual(failedRun);

        // 用户修复 Git 引用后，完全相同的恢复点仍可再次消费并跑到终态。
        await harness.repo.git(
          'update-ref',
          failedRun.repository.baseBranchRef,
          baseCommit,
        );
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          sequence: [
            { stdoutLines: streamOf(executionCompleted()) },
            { stdoutLines: streamOf(finalReviewCompleted(['TASK-001'])) },
          ],
        });
        const resumed = await harness.resume();
        expect(resumed.kind).toBe('completed');
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  it(
    'reuses the original Run Git and Claude CLI paths when resume has no explicit override',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await startAndInterruptDuringExecution(
          harness,
          planDraft([{ id: 'TASK-001' }]),
          {
            startInput: {
              claudeCliPath: FAKE_CLAUDE_PATH,
              gitCliPath: 'git',
            },
          },
        );
        harness.gitPortPaths.length = 0;
        harness.claudePortPaths.length = 0;

        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          sequence: [
            { stdoutLines: streamOf(executionCompleted()) },
            { stdoutLines: streamOf(finalReviewCompleted(['TASK-001'])) },
          ],
        });
        const resumed = await harness.resume();
        expect(resumed.kind).toBe('completed');
        expect(harness.gitPortPaths).toEqual(['git']);
        expect(harness.claudePortPaths).toEqual([FAKE_CLAUDE_PATH]);
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  it(
    'takes over a crashed non-terminal run only with --force and closes its open facts',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        const failedRun = await startAndInterruptDuringExecution(
          harness,
          planDraft([{ id: 'TASK-001' }]),
        );
        const crashedSessionId = failedRun.resumePoint!.sessionId!;
        const crashedEpisode = failedRun.tasks['TASK-001']!.executionEpisodes[0]!;

        // 手工还原崩溃现场：非终态 status、activeSession、running Task、
        // 未结束 Episode（绕过 StateStore 写入校验，等价于进程猝死后磁盘上
        // 的实际残留）。
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
        await writeFile(
          join(harness.stateDir, 'run.json'),
          JSON.stringify(crashedRun, null, 2),
          'utf8',
        );

        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          sequence: [
            { stdoutLines: streamOf(executionCompleted()) },
            { stdoutLines: streamOf(finalReviewCompleted(['TASK-001'])) },
          ],
        });

        // 无 --force：拒绝且不修改任何状态。
        const refused = await harness.resume();
        expect(refused.kind).toBe('command-failed');
        if (refused.kind !== 'command-failed') return;
        expect(refused.error.errorCode).toBe('RESUME_REQUIRES_FORCE');
        const untouched = await harness.readRunJson();
        expect(untouched.status).toBe('running');
        expect(untouched.activeSession?.sessionId).toBe(crashedSessionId);

        // --force：警告旧进程风险、接管未竟事实后继续到 completed。
        const resumed = await harness.resume({ force: true });
        expect(resumed.kind).toBe('completed');
        if (resumed.kind !== 'completed') return;
        expect(harness.outputLines.join('\n')).toContain('无法判断');

        // 崩溃遗留的未结束 Episode 被关闭为 session_error；续接会话完成。
        const task = resumed.run.tasks['TASK-001']!;
        expect(task.status).toBe('completed');
        expect(task.executionEpisodes).toHaveLength(2);
        expect(task.executionEpisodes[0]!.outcome).toBe('session_error');
        expect(task.executionEpisodes[0]!.error?.errorCode).toBe('RUN_INTERRUPTED');
        expect(task.executionEpisodes[1]!.outcome).toBe('completed');

        // 接管后的首个会话同样经 --resume --fork-session 续接崩溃会话。
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
});
