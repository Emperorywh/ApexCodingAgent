/**
 * E2E：resume 命令（SPEC §17 resume、§2.4 中断恢复）。
 *
 * 覆盖三类 Session 的真实续接、精确的 transcript 缺失回退、可写会话
 * 已产生提交后的 Git 接管，以及前置校验失败不消耗恢复点。
 */
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunJson } from '../../src/domain/schemas/run-json.js';
import type { PlannedTask } from '../../src/domain/schemas/task-plan-draft.js';
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

/**
 * 把新版本生成的普通失败夹具改写为旧版本曾经允许提交的坏计划形状。
 *
 * 真实事故中的 tasks.json 与不可变 Snapshot 都明确把 SPEC 列入 likelyPaths；
 * 测试必须同步两份权威视图并重算原始字节哈希，不能靠损坏状态文件绕过读取
 * 校验，否则验证不到 resume 的计划授权分支。
 */
async function markLegacyTaskAsSpecAuthorized(
  harness: E2EHarness,
  taskId: string,
): Promise<void> {
  const run = await harness.readRunJson();
  const tasks = await harness.readTasksJson();
  const snapshot = await harness.readPlanSnapshot(run.planRevision);
  const withSpecPath = (task: PlannedTask): PlannedTask =>
    task.id === taskId
      ? { ...task, likelyPaths: [...new Set([...task.likelyPaths, run.spec.path])] }
      : task;
  const nextTasks = { ...tasks, tasks: tasks.tasks.map(withSpecPath) };
  const nextSnapshot = { ...snapshot, tasks: snapshot.tasks.map(withSpecPath) };
  const tasksText = JSON.stringify(nextTasks, null, 2);
  const nextRun = {
    ...run,
    tasksSha256: createHash('sha256').update(tasksText, 'utf8').digest('hex'),
  };

  await writeFile(
    join(harness.stateDir, 'plans', `${run.planRevision}.json`),
    JSON.stringify(nextSnapshot, null, 2),
    'utf8',
  );
  await writeFile(join(harness.stateDir, 'tasks.json'), tasksText, 'utf8');
  await writeFile(
    join(harness.stateDir, 'run.json'),
    JSON.stringify(nextRun, null, 2),
    'utf8',
  );
}

/** 回合预算耗尽的 Execution 终止场景（真实 error_max_turns ResultMessage 形态）。 */
function turnLimitExhausted(overrides: Partial<ScenarioElement> = {}): ScenarioElement {
  return {
    stdoutLines: [
      {
        type: 'system',
        subtype: 'init',
        session_id: '{sessionId}',
        model: 'fake-model',
      },
      {
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        session_id: '{sessionId}',
        num_turns: 65,
        terminal_reason: 'max_turns',
        errors: ['Reached maximum number of turns (64)'],
      },
    ],
    exitCode: 1,
    ...overrides,
  };
}

/**
 * 真实续接事故形态：上一段会话遗留后台任务时，Claude Code 会在正式
 * ResultMessage 前输出一个 task-notification 派生 result。该事件不能让
 * 第二段预算耗尽退化为普通非零退出，否则剩余自动续接预算会被提前丢弃。
 */
function turnLimitExhaustedAfterTaskNotification(): ScenarioElement {
  return {
    stdoutLines: [
      {
        type: 'system',
        subtype: 'task_notification',
        session_id: '{sessionId}',
        status: 'stopped',
      },
      {
        type: 'system',
        subtype: 'init',
        session_id: '{sessionId}',
        model: 'fake-model',
      },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: '{sessionId}',
        num_turns: 0,
        result: '',
        origin: { kind: 'task-notification' },
      },
      {
        type: 'system',
        subtype: 'init',
        session_id: '{sessionId}',
        model: 'fake-model',
      },
      {
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        session_id: '{sessionId}',
        num_turns: 97,
        terminal_reason: 'max_turns',
        errors: ['Reached maximum number of turns (96)'],
      },
    ],
    exitCode: 1,
  };
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
          sessionType: 'execution',
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
        expect(resumedInvocation!.stdin).toContain('RESUME_CAUSE: RUN_INTERRUPTED');
        const forkedSessionId = argv[argv.indexOf('--session-id') + 1]!;
        expect(forkedSessionId).not.toBe(interruptedSessionId);

        // 后续会话（TASK-002、Final Review）不再携带 --resume。
        const laterInvocations = records.slice(records.indexOf(resumedInvocation!) + 1);
        expect(laterInvocations.every((record) => !record.argv.includes('--resume'))).toBe(true);

        // Session Record 链完整：planning、被中断 execution（failed）、
        // 续接 execution、TASK-002 execution、final review。
        const sessionRecords = await harness.listSessionRecords();
        expect(sessionRecords).toHaveLength(8);
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
    'turn-limit ResultMessage automatically forks the session with a fresh budget tranche and completes without manual resume',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          sequence: [
            { stdoutLines: streamOf(planDraft([{ id: 'TASK-001' }])) },
            turnLimitExhausted({
              writeFiles: [
                {
                  path: 'src/partial.ts',
                  content: 'export const partialWork = true;\n',
                },
              ],
            }),
            { stdoutLines: streamOf(executionCompleted()) },
            { stdoutLines: streamOf(finalReviewCompleted(['TASK-001'])) },
          ],
        });

        const first = await harness.start();
        expect(first.kind).toBe('completed');
        if (first.kind !== 'completed') return;
        expect(first.run.resumePoint).toBeNull();
        expect(first.run.tasks['TASK-001']!.status).toBe('completed');

        /**
         * 预算耗尽不再终结 Run：Planner、自动 Plan Reviewer、被耗尽的
         * Execution、fork 续接的 Execution、自动 Task Reviewer 与 Final
         * Review 共六个正式 Session，全程无需人工 resume。
         */
        const invocations = (await harness.readRecords()).filter((record) =>
          record.argv.includes('--session-id'),
        );
        expect(invocations).toHaveLength(6);
        const sessionIdOf = (index: number): string =>
          invocations[index]!.argv[invocations[index]!.argv.indexOf('--session-id') + 1]!;
        const forked = invocations[3]!;
        expect(forked.argv[forked.argv.indexOf('--resume') + 1]).toBe(sessionIdOf(2));
        expect(forked.argv).toContain('--fork-session');
        const forkedSessionId = sessionIdOf(3);
        expect(forkedSessionId).not.toBe(sessionIdOf(2));
        /*
         * 续接会话携带同一额度的新预算 tranche 与预算耗尽收敛策略；
         * 自动接力来源必须如实进入模型上下文。
         */
        expect(forked.argv[forked.argv.indexOf('--max-turns') + 1]).toBe('64');
        expect(forked.stdin).toContain('RESUME_CAUSE: CLAUDE_TURN_LIMIT_REACHED');
        expect(forked.stdin).toContain('必须立即返回结构化结果');
        expect(forked.stdin).toContain('系统自动续接');

        // 前台进度如实报告预算续接，而不是把长 Task 报废。
        expect(
          harness.outputLines.some((line) => line.includes('回合预算已耗尽')),
        ).toBe(true);

        // 被耗尽会话留下失败 Record；fork 会话完成并驱动 Task 走完独立复核。
        const sessionRecords = await harness.listSessionRecords();
        const executionRecords = sessionRecords.filter(
          (record) => record.type === 'execution',
        );
        expect(executionRecords).toHaveLength(2);
        expect(executionRecords[0]!.status).toBe('failed');
        expect(executionRecords[0]!.error?.errorCode).toBe('CLAUDE_TURN_LIMIT_REACHED');
        expect(executionRecords[1]!.status).toBe('completed');
        expect(executionRecords[1]!.sessionId).toBe(forkedSessionId);

        const episodes = first.run.tasks['TASK-001']!.executionEpisodes;
        expect(episodes).toHaveLength(2);
        expect(episodes[0]!.outcome).toBe('session_error');
        expect(episodes[0]!.error?.errorCode).toBe('CLAUDE_TURN_LIMIT_REACHED');
        expect(episodes[1]!.outcome).toBe('awaiting_review');
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  it(
    'automatic budget extensions are bounded: repeated turn-limit fails with a resume point consumable by explicit resume',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          sequence: [
            { stdoutLines: streamOf(planDraft([{ id: 'TASK-001' }])) },
            turnLimitExhausted(),
            turnLimitExhaustedAfterTaskNotification(),
            turnLimitExhausted(),
          ],
        });

        const first = await harness.start();
        expect(first.kind).toBe('failed');
        if (first.kind !== 'failed') return;
        expect(first.run.lastError?.errorCode).toBe('CLAUDE_TURN_LIMIT_REACHED');
        expect(first.run.tasks['TASK-001']!.failure?.errorCode).toBe(
          'CLAUDE_TURN_LIMIT_REACHED',
        );
        expect(first.run.resumePoint).toEqual({
          fromStatus: 'running',
          taskId: 'TASK-001',
          sessionId: expect.any(String),
          sessionType: 'execution',
        });

        /**
         * 首趟 + 两次有界续接共三趟 Execution 全部耗尽后才终结：两次 fork
         * 各自续接上一趟被耗尽的会话，第三次耗尽不再自动追加预算。
         */
        const invocations = (await harness.readRecords()).filter((record) =>
          record.argv.includes('--session-id'),
        );
        expect(invocations).toHaveLength(5);
        const sessionIdOf = (index: number): string =>
          invocations[index]!.argv[invocations[index]!.argv.indexOf('--session-id') + 1]!;
        const forks = invocations.filter((record) => record.argv.includes('--resume'));
        expect(forks).toHaveLength(2);
        expect(forks[0]!.argv[forks[0]!.argv.indexOf('--resume') + 1]).toBe(sessionIdOf(2));
        expect(forks[1]!.argv[forks[1]!.argv.indexOf('--resume') + 1]).toBe(sessionIdOf(3));
        expect(first.run.resumePoint!.sessionId).toBe(sessionIdOf(4));

        // 显式 resume 仍从最后一趟被耗尽的会话 fork 续接并完成 Run。
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
        if (resumed.kind !== 'completed') return;
        expect(resumed.run.resumePoint).toBeNull();
        expect(resumed.run.tasks['TASK-001']!.status).toBe('completed');

        const resumeInvocation = (await harness.readRecords())
          .filter((record) => record.argv.includes('--resume'))
          .at(-1)!;
        expect(
          resumeInvocation.argv[resumeInvocation.argv.indexOf('--resume') + 1],
        ).toBe(sessionIdOf(4));
        expect(resumeInvocation.argv).toContain('--fork-session');
        /**
         * 真实失败原因必须跨 reopenRun 的 lastError 清空边界继续传入模型，
         * 让预算耗尽后的接力会话优先收敛，而不是按普通中断继续扩张范围。
         */
        expect(resumeInvocation.stdin).toContain(
          'RESUME_CAUSE: CLAUDE_TURN_LIMIT_REACHED',
        );
        expect(resumeInvocation.stdin).toContain('必须立即返回结构化结果');
        expect(resumeInvocation.stdin).toContain('显式 resume');
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

        /*
         * 前台保留稳定错误码和明确的回退动作。
         * 不再依赖 Adapter 的英文诊断短语，避免用户呈现反向耦合底层文案。
         */
        const progress = harness.outputLines.join('\n');
        expect(progress).toContain('CLAUDE_RESUME_UNAVAILABLE');
        expect(progress).toContain('将使用完整提示创建新会话');

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
        /**
         * 鉴权/额度失败不在本次 resume 内自动重试，但新失败 Session 仍形成
         * 下一次显式恢复点，用户修复外部条件后无需放弃整个 Run。
         */
        expect(resumed.run.resumePoint).toEqual({
          fromStatus: 'running',
          taskId: 'TASK-001',
          sessionId: expect.any(String),
          sessionType: 'execution',
        });
        expect(harness.outputLines.join('\n')).not.toContain('CLAUDE_RESUME_UNAVAILABLE');

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
    '历史 Task 提交明确授权的 SPEC 后，resume 采用 HEAD 并强制 Replan',
    async () => {
      const harness = await createE2EHarness();
      try {
        const baseCommit = await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          sequence: [
            { stdoutLines: streamOf(planDraft([{ id: 'TASK-001' }])) },
            {
              writeFiles: [
                {
                  path: 'SPEC.md',
                  content: '# Spec\n\n技术闸门已经验证并回写。\n',
                },
              ],
              commands: [
                { argv: ['git', 'add', 'SPEC.md'] },
                { argv: ['git', 'commit', '-m', 'legacy task writes SPEC'] },
              ],
              stdoutLines: streamOf(executionCompleted()),
            },
          ],
        });

        const failed = await harness.start();
        expect(failed.kind).toBe('failed');
        if (failed.kind !== 'failed') return;
        expect(failed.run.lastError?.errorCode).toBe('PROTECTED_PATH_CHANGED');
        expect(failed.run.resumePoint).toBeNull();
        const protectedHead = await harness.repo.head();
        expect(protectedHead).not.toBe(baseCommit);

        await markLegacyTaskAsSpecAuthorized(harness, 'TASK-001');
        const invocationCountBeforeResume = (await harness.readRecords()).length;
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          sequence: [
            {
              stdoutLines: streamOf(
                planDraft([
                  {
                    id: 'TASK-001',
                    title: '采用已落盘实现并完成验证',
                  },
                ]),
              ),
            },
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

        /**
         * 恢复过程没有续接已经正常结束的违规 Execution；首个业务会话是
         * Revision 2 Planner，新计划移除 SPEC 路径后才重新执行并完成 Task。
         */
        const resumeInvocations = (await harness.readRecords()).slice(
          invocationCountBeforeResume,
        );
        expect(resumeInvocations.every((record) => !record.argv.includes('--resume'))).toBe(true);
        expect(resumed.run.planRevision).toBe(2);
        expect(resumed.run.spec.sha256).not.toBe(failed.run.spec.sha256);
        expect(resumed.run.tasks['TASK-001']!.status).toBe('completed');
        expect(harness.outputLines.join('\n')).toContain('按新 SPEC 重新规划');
        expect(
          await harness.repo.git('merge-base', '--is-ancestor', protectedHead, 'HEAD'),
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
        /**
         * 抹掉存活信号：本用例验证的是"系统无法判断"形态的人工确认门槛
         * （旧版本 Run 没有信号文件，或信号随状态目录一起丢失）。新鲜信号
         * 的拦截与超时信号的免 --force 接管由 e2e/heartbeat.test.ts 覆盖。
         */
        await harness.removeHeartbeat();

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
        expect(task.executionEpisodes[1]!.outcome).toBe('awaiting_review');

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

  it(
    'push failure persists a resume point; resume retries remote delivery and completes',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          sequence: [
            { stdoutLines: streamOf(planDraft([{ id: 'TASK-001' }])) },
            // Execution 交付完成后远程消失：本地 Checkpoint 形成，推送失败。
            {
              writeFiles: [{ path: 'src/publish.ts', content: 'export const published = true;\n' }],
              commands: [{ argv: ['git', 'remote', 'remove', 'origin'] }],
              stdoutLines: streamOf(executionCompleted()),
            },
          ],
        });

        const first = await harness.start();
        expect(first.kind).toBe('failed');
        if (first.kind !== 'failed') return;
        expect(first.run.lastError?.errorCode).toBe('GIT_PUSH_FAILED');
        /**
         * 推送失败是唯一缺口：本地 Checkpoint、Session Record 与 transcript
         * 全部完好，终态必须持久化恢复点，而不是要求 abandon 后重跑。
         */
        expect(first.run.resumePoint).toEqual({
          fromStatus: 'running',
          taskId: 'TASK-001',
          sessionId: expect.any(String),
          sessionType: 'execution',
        });
        const deliveredSessionId = first.run.resumePoint!.sessionId!;
        const unpublishedCheckpoint = first.run.repository.expectedHead;

        // 用户修复远程配置后显式 resume（真实恢复前提：推送目标重新可用）。
        await harness.repo.git(
          'remote',
          'add',
          'origin',
          join(dirname(harness.repo.root), 'origin.git'),
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
        expect(
          resumed.kind,
          JSON.stringify({
            error:
              resumed.kind === 'failed'
                ? resumed.run.lastError
                : resumed.kind === 'command-failed' || resumed.kind === 'startup-failed'
                  ? {
                      code: resumed.error.errorCode,
                      stage: resumed.error.stage,
                      message: resumed.error.message,
                      toolSummary: resumed.error.toolSummary,
                    }
                  : null,
            output: harness.outputLines,
          }),
        ).toBe('completed');
        if (resumed.kind !== 'completed') return;
        expect(resumed.run.resumePoint).toBeNull();
        expect(resumed.run.tasks['TASK-001']!.status).toBe('completed');

        // 恢复会话续接的是已完成交付的原会话，并如实携带推送失败原因。
        const records = await harness.readRecords();
        const resumedInvocation = records.find((record) => record.argv.includes('--resume'));
        expect(resumedInvocation).toBeDefined();
        const argv = resumedInvocation!.argv;
        expect(argv[argv.indexOf('--resume') + 1]).toBe(deliveredSessionId);
        expect(argv).toContain('--fork-session');
        expect(resumedInvocation!.stdin).toContain('RESUME_CAUSE: GIT_PUSH_FAILED');

        /**
         * 续接会话没有产生新提交：候选复用首次失败时未推送的本地
         * Checkpoint，恢复后的推送把它与后续事实一起交付到远程。
         */
        expect(resumed.run.tasks['TASK-001']!.finalCheckpoint).toBe(unpublishedCheckpoint);
        const remoteRef = `refs/remotes/origin/${resumed.run.repository.runBranch}`;
        expect(await harness.repo.git('rev-parse', remoteRef)).toBe(resumed.run.finalCommit);
        expect(await harness.repo.git('show', `${remoteRef}:src/publish.ts`)).toContain('true');
        expect(
          (await harness.repo.gitRaw('merge-base', '--is-ancestor', unpublishedCheckpoint, remoteRef))
            .code,
        ).toBe(0);
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );
});
