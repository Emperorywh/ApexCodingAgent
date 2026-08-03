/**
 * 独立 Task Review 端到端测试：验证执行会话只能提交候选结果，Task 的完成门禁
 * 必须由不同 Session 的只读复核结论打开，并覆盖拒绝返工与越权写入两条路径。
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
  taskReviewApproved,
  waitForRunFact,
  type E2EHarness,
  type RecordedInvocation,
} from './helpers.js';
import { seedRepo } from '../integration/git/helpers.js';

const CHANGES_REQUIRED = {
  decision: 'changes_required',
  summary: '独立复核发现实现仍不满足验收条件',
  tests: [{ command: 'npm test', result: 'failed' }],
  acceptanceEvidence: [
    {
      criterionIndex: 0,
      status: 'not_satisfied',
      evidence: '仓库中的导出值仍为错误结果',
    },
  ],
  issues: ['修正导出值并重新运行 npm test'],
  replanReason: null,
} as const;

/** 从传给 Claude 的 JSON Schema 识别独立 Task Review 调用。 */
function isTaskReviewInvocation(record: RecordedInvocation): boolean {
  const schemaIndex = record.argv.indexOf('--json-schema');
  if (schemaIndex < 0) return false;
  const schemaText = record.argv[schemaIndex + 1];
  if (schemaText === undefined) return false;
  const schema = JSON.parse(schemaText) as {
    properties?: { decision?: { enum?: string[] } };
  };
  return schema.properties?.decision?.enum?.includes('approved') === true;
}

/** 从传给 Claude 的 JSON Schema 识别 Execution 调用（decision 枚举含 failed）。 */
function isExecutionInvocation(record: RecordedInvocation): boolean {
  const schemaIndex = record.argv.indexOf('--json-schema');
  if (schemaIndex < 0) return false;
  const schemaText = record.argv[schemaIndex + 1];
  if (schemaText === undefined) return false;
  const schema = JSON.parse(schemaText) as {
    properties?: { decision?: { enum?: string[] } };
  };
  return schema.properties?.decision?.enum?.includes('failed') === true;
}

/**
 * 等待「候选已持久化、Reviewer 尚未启动」的恢复窗口。
 *
 * 该窗口只存在于候选落盘到驱动器下一次循环顶部状态读取之间（毫秒级），
 * waitForRunFact 默认 100ms 轮询必然错过；本函数以 2ms 轮询紧贴 run.json。
 * 窗口被错过（Reviewer 会话已启动）时立即响亮失败，而不是空等整个预算
 * 把竞速失利掩盖成莫名其妙的超时；driving 提前结算同样立即暴露。
 */
async function waitForCandidateWindow(
  harness: E2EHarness,
  driving: Promise<unknown>,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  let settled = false;
  void driving.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (;;) {
    try {
      const run = await harness.readRunJson();
      if (run.activeSession?.type === 'task_review') {
        throw new Error(
          'candidate window missed: the task_review session already started ' +
            '(the interrupt request lost the race against the driver loop)',
        );
      }
      if (
        run.activeSession === null &&
        run.currentTaskId !== null &&
        run.tasks['TASK-001']?.candidateCheckpoint != null
      ) {
        return;
      }
    } catch (error) {
      // run.json 尚未创建时继续轮询；其余错误（含窗口错过）立即抛出。
      if (error instanceof Error && error.message.startsWith('candidate window missed')) {
        throw error;
      }
    }
    if (settled) {
      throw new Error('run drive settled before the candidate window');
    }
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for the candidate window');
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe('e2e independent task review', () => {
  it(
    '复核拒绝后重新执行，并且只有第二个独立复核批准后 Task 才完成',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          autoApproveTaskReviews: false,
          sequence: [
            { stdoutLines: streamOf(planDraft([{ id: 'TASK-001' }])) },
            {
              writeFiles: [{ path: 'src/feature.ts', content: 'export const value = 0;\n' }],
              stdoutLines: streamOf(executionCompleted()),
            },
            { stdoutLines: streamOf(CHANGES_REQUIRED) },
            {
              writeFiles: [{ path: 'src/feature.ts', content: 'export const value = 1;\n' }],
              stdoutLines: streamOf(executionCompleted()),
            },
            { stdoutLines: streamOf(taskReviewApproved()) },
            { stdoutLines: streamOf(finalReviewCompleted(['TASK-001'])) },
          ],
        });

        const result = await harness.start();
        expect(result.kind).toBe('completed');
        if (result.kind !== 'completed') return;

        const task = result.run.tasks['TASK-001']!;
        expect(task.status).toBe('completed');
        expect(task.executionEpisodes).toHaveLength(2);
        expect(task.executionEpisodes.map((episode) => episode.outcome)).toEqual([
          'awaiting_review',
          'awaiting_review',
        ]);
        expect(task.taskReviewEpisodes.map((episode) => episode.outcome)).toEqual([
          'changes_required',
          'approved',
        ]);
        expect(task.finalCheckpoint).toBe(task.taskReviewEpisodes[1]!.candidateCheckpoint);
        expect(task.taskReviewEpisodes[0]!.sessionId).not.toBe(
          task.taskReviewEpisodes[0]!.executionSessionId,
        );
        expect(task.taskReviewEpisodes[1]!.sessionId).not.toBe(
          task.taskReviewEpisodes[1]!.executionSessionId,
        );

        const invocations = (await harness.readRecords()).filter((record) =>
          record.argv.includes('--session-id'),
        );
        const reviewInvocations = invocations.filter(isTaskReviewInvocation);
        expect(reviewInvocations).toHaveLength(2);
        for (const invocation of reviewInvocations) {
          expect(invocation.argv).not.toContain('--resume');
          expect(invocation.stdin).not.toContain('CANDIDATE_EXECUTION_RESULT');
          expect(invocation.stdin).not.toContain('任务完成');
        }
        for (const episode of task.taskReviewEpisodes) {
          const invocation = reviewInvocations.find((record) =>
            record.argv.includes(episode.sessionId),
          );
          expect(invocation).toBeDefined();
          expect(invocation!.stdin).not.toContain(episode.executionSessionId);
        }

        // 打回后的第二趟 Execution 必须携带上一轮复核的 REVIEW_FEEDBACK 小节
        // （含 Reviewer 的 issues 原文）；首趟执行没有复核结论，不含该小节。
        const executionInvocations = invocations.filter(isExecutionInvocation);
        expect(executionInvocations).toHaveLength(2);
        expect(executionInvocations[0]!.stdin).not.toContain('REVIEW_FEEDBACK');
        expect(executionInvocations[1]!.stdin).toContain('REVIEW_FEEDBACK');
        expect(executionInvocations[1]!.stdin).toContain('修正导出值并重新运行 npm test');
      } finally {
        await harness.cleanup();
      }
    },
    120_000,
  );

  it(
    '复核会话修改工作树时以稳定错误失败，不能批准 Task',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          autoApproveTaskReviews: false,
          sequence: [
            { stdoutLines: streamOf(planDraft([{ id: 'TASK-001' }])) },
            {
              writeFiles: [{ path: 'src/feature.ts', content: 'export const value = 1;\n' }],
              stdoutLines: streamOf(executionCompleted()),
            },
            {
              writeFiles: [
                { path: 'src/reviewer-write.ts', content: 'export const forbidden = true;\n' },
              ],
              stdoutLines: streamOf(taskReviewApproved()),
            },
          ],
        });

        const result = await harness.start();
        expect(result.kind).toBe('failed');
        if (result.kind !== 'failed') return;
        expect(result.run.lastError?.errorCode).toBe('TASK_REVIEW_SIDE_EFFECT_DETECTED');

        const task = result.run.tasks['TASK-001']!;
        expect(task.status).not.toBe('completed');
        expect(task.completedResult).toBeNull();
        expect(task.finalCheckpoint).toBeNull();
        expect(task.taskReviewEpisodes).toHaveLength(1);
        expect(task.taskReviewEpisodes[0]!.outcome).toBe('session_error');
        expect(task.taskReviewEpisodes[0]!.error?.errorCode).toBe(
          'TASK_REVIEW_SIDE_EFFECT_DETECTED',
        );
      } finally {
        await harness.cleanup();
      }
    },
    120_000,
  );

  it(
    '中断后只续接 Reviewer 自身会话，不重跑或续接 Execution 会话',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          autoApproveTaskReviews: false,
          sequence: [
            { stdoutLines: streamOf(planDraft([{ id: 'TASK-001' }])) },
            {
              writeFiles: [{ path: 'src/feature.ts', content: 'export const value = 1;\n' }],
              stdoutLines: streamOf(executionCompleted()),
            },
            { sleepMs: 300_000, stdoutLines: streamOf(taskReviewApproved()) },
          ],
        });

        const driving = harness.start();
        await waitForRunFact(
          harness,
          'task_review activeSession',
          (run) => run.activeSession?.type === 'task_review',
          { driving },
        );
        harness.interrupt.request();
        const interrupted = await driving;
        expect(interrupted.kind).toBe('failed');
        if (interrupted.kind !== 'failed') return;

        const resumePoint = interrupted.run.resumePoint;
        expect(resumePoint?.sessionType).toBe('task_review');
        expect(resumePoint?.sessionId).not.toBeNull();
        const taskBeforeResume = interrupted.run.tasks['TASK-001']!;
        expect(taskBeforeResume.candidateResult?.decision).toBe('completed');
        expect(taskBeforeResume.candidateCheckpoint).not.toBeNull();
        expect(taskBeforeResume.executionEpisodes).toHaveLength(1);

        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          autoApproveTaskReviews: false,
          sequence: [
            { stdoutLines: streamOf(taskReviewApproved()) },
            { stdoutLines: streamOf(finalReviewCompleted(['TASK-001'])) },
          ],
        });
        const resumed = await harness.resume();
        expect(resumed.kind).toBe('completed');
        if (resumed.kind !== 'completed') return;

        const task = resumed.run.tasks['TASK-001']!;
        expect(task.executionEpisodes).toHaveLength(1);
        expect(task.taskReviewEpisodes.map((episode) => episode.outcome)).toEqual([
          'session_error',
          'approved',
        ]);
        const invocations = await harness.readRecords();
        const resumedInvocation = invocations.find((record) => record.argv.includes('--resume'));
        expect(resumedInvocation).toBeDefined();
        expect(
          resumedInvocation!.argv[resumedInvocation!.argv.indexOf('--resume') + 1],
        ).toBe(resumePoint!.sessionId);
        expect(isTaskReviewInvocation(resumedInvocation!)).toBe(true);
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  it(
    '复核要求重规划时以 task_review_replan 触发新 Revision 并最终完成',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          autoApproveTaskReviews: false,
          sequence: [
            { stdoutLines: streamOf(planDraft([{ id: 'TASK-001' }])) },
            {
              writeFiles: [{ path: 'src/feature.ts', content: 'export const value = 1;\n' }],
              stdoutLines: streamOf(executionCompleted()),
            },
            // 独立复核基于仓库事实要求重规划；候选 Checkpoint 保留为中间事实。
            {
              stdoutLines: streamOf({
                decision: 'replan_required',
                summary: '复核发现计划边界与仓库事实不符',
                tests: [{ command: 'npm test', result: 'not_run' }],
                acceptanceEvidence: [
                  {
                    criterionIndex: 0,
                    status: 'not_satisfied',
                    evidence: '当前计划边界无法承载需求',
                  },
                ],
                issues: [],
                replanReason: '需要先引入抽象层再实现功能',
              }),
            },
            // Revision 2：接管复核保留的候选 Checkpoint（占位符由 Fake Claude 替换）。
            {
              stdoutLines: streamOf(
                planDraft([{ id: 'TASK-001', title: '含抽象层的功能实现' }], {
                  summary: '复核触发的修订计划',
                  dispositions: [
                    {
                      checkpointOid: '{firstIntermediateCheckpointOid}',
                      ownerTaskId: 'TASK-001',
                      rationale: '继续采用复核打回前的候选变更',
                    },
                  ],
                }),
              ),
            },
            {
              writeFiles: [{ path: 'src/feature.ts', content: 'export const value = 2;\n' }],
              stdoutLines: streamOf(executionCompleted()),
            },
            { stdoutLines: streamOf(taskReviewApproved()) },
            { stdoutLines: streamOf(finalReviewCompleted(['TASK-001'])) },
          ],
        });

        const result = await harness.start();
        expect(result.kind).toBe('completed');
        if (result.kind !== 'completed') return;
        const run = result.run;

        // Revision 2 由独立复核触发（而非 Execution 自报）。
        expect(run.planRevision).toBe(2);
        const snapshot2 = await harness.readPlanSnapshot(2);
        expect(snapshot2.trigger.type).toBe('task_review_replan');
        expect(snapshot2.trigger.reason).toBe('需要先引入抽象层再实现功能');

        const task = run.tasks['TASK-001']!;
        expect(task.status).toBe('completed');
        expect(task.taskReviewEpisodes.map((episode) => episode.outcome)).toEqual([
          'replan_required',
          'approved',
        ]);
        expect(snapshot2.trigger.sourceSessionId).toBe(task.taskReviewEpisodes[0]!.sessionId);
        expect(task.executionEpisodes.map((episode) => episode.outcome)).toEqual([
          'awaiting_review',
          'awaiting_review',
        ]);
        // 被打回候选的 Checkpoint 作为中间事实保留，并被修订计划的同一 Task 接管。
        expect(run.intermediateCheckpoints).toHaveLength(1);
        expect(run.intermediateCheckpoints[0]!.oid).toBe(
          task.taskReviewEpisodes[0]!.candidateCheckpoint,
        );
        expect(run.intermediateCheckpoints[0]!.ownerTaskId).toBe('TASK-001');
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  it(
    '复核会话期间 SPEC 变化时丢弃复核结论，Task 回 pending 并触发重规划',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          autoApproveTaskReviews: false,
          sequence: [
            { stdoutLines: streamOf(planDraft([{ id: 'TASK-001' }])) },
            {
              writeFiles: [{ path: 'src/feature.ts', content: 'export const value = 1;\n' }],
              stdoutLines: streamOf(executionCompleted()),
            },
            // 复核期间 SPEC 被改写：批准结论必须作废（SPEC 受保护，不触发
            // 只读门禁；由 specBefore/specAfter 哈希边界检出）。
            {
              writeFiles: [{ path: 'SPEC.md', content: '# Spec v2\n\n新增需求。\n' }],
              stdoutLines: streamOf(taskReviewApproved()),
            },
            // Revision 2（spec_changed 触发）：接管候选 Checkpoint。
            {
              stdoutLines: streamOf(
                planDraft([{ id: 'TASK-001', title: '按 v2 实现功能' }], {
                  summary: 'SPEC v2 修订计划',
                  dispositions: [
                    {
                      checkpointOid: '{firstIntermediateCheckpointOid}',
                      ownerTaskId: 'TASK-001',
                      rationale: '继续采用 SPEC 变化前的候选变更',
                    },
                  ],
                }),
              ),
            },
            {
              writeFiles: [{ path: 'src/feature.ts', content: 'export const value = 2;\n' }],
              stdoutLines: streamOf(executionCompleted()),
            },
            { stdoutLines: streamOf(taskReviewApproved()) },
            { stdoutLines: streamOf(finalReviewCompleted(['TASK-001'])) },
          ],
        });

        const result = await harness.start();
        expect(result.kind).toBe('completed');
        if (result.kind !== 'completed') return;
        const run = result.run;

        // 基于旧 SPEC 的批准结论未提交：第一个复核 Episode 是 spec_changed，
        // Task 回过 pending 后重新执行并由新复核批准。
        const task = run.tasks['TASK-001']!;
        expect(task.status).toBe('completed');
        expect(task.taskReviewEpisodes.map((episode) => episode.outcome)).toEqual([
          'spec_changed',
          'approved',
        ]);
        expect(task.executionEpisodes.map((episode) => episode.outcome)).toEqual([
          'awaiting_review',
          'awaiting_review',
        ]);

        // SPEC 变化触发 Revision 2，来源 Session 是第一个 Reviewer。
        expect(run.planRevision).toBe(2);
        const snapshot2 = await harness.readPlanSnapshot(2);
        expect(snapshot2.trigger.type).toBe('spec_changed');
        expect(snapshot2.trigger.sourceSessionId).toBe(task.taskReviewEpisodes[0]!.sessionId);

        // SPEC 从未被提交：Run Branch 历史中不含 SPEC 变更。
        const specLog = await harness.repo.git('log', '--format=%s', 'main..HEAD', '--', 'SPEC.md');
        expect(specLog).toBe('');
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  it(
    '中断落在候选已落盘、Reviewer 未启动的窗口时保留候选，resume 由全新 Reviewer 复核',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          autoApproveTaskReviews: false,
          sequence: [
            { stdoutLines: streamOf(planDraft([{ id: 'TASK-001' }])) },
            {
              writeFiles: [{ path: 'src/feature.ts', content: 'export const value = 1;\n' }],
              stdoutLines: streamOf(executionCompleted()),
            },
            // Reviewer 长睡眠：窗口错过时中断会落在复核会话内（另一形态），
            // 窗口捕获助手会立即响亮失败而不是误用该形态。
            { sleepMs: 300_000, stdoutLines: streamOf(taskReviewApproved()) },
          ],
        });

        const driving = harness.start();
        await waitForCandidateWindow(harness, driving);
        harness.interrupt.request();
        const interrupted = await driving;
        expect(interrupted.kind).toBe('failed');
        if (interrupted.kind !== 'failed') return;

        // 窗口中断的恢复点：没有可续接的 Reviewer 会话（sessionId 为 null），
        // 但 sessionType 仍记为 task_review；被中断 Task 转 failed 并保留候选。
        expect(interrupted.run.lastError?.errorCode).toBe('RUN_INTERRUPTED');
        expect(interrupted.run.resumePoint).toEqual({
          fromStatus: 'running',
          taskId: 'TASK-001',
          sessionId: null,
          sessionType: 'task_review',
        });
        const taskBeforeResume = interrupted.run.tasks['TASK-001']!;
        expect(taskBeforeResume.status).toBe('failed');
        expect(taskBeforeResume.failure?.errorCode).toBe('RUN_INTERRUPTED');
        expect(taskBeforeResume.candidateResult?.decision).toBe('completed');
        expect(taskBeforeResume.candidateCheckpoint).not.toBeNull();
        // 窗口中 Reviewer 从未启动：没有任何复核 Episode。
        expect(taskBeforeResume.taskReviewEpisodes).toHaveLength(0);

        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          autoApproveTaskReviews: false,
          sequence: [
            { stdoutLines: streamOf(taskReviewApproved()) },
            { stdoutLines: streamOf(finalReviewCompleted(['TASK-001'])) },
          ],
        });
        const resumed = await harness.resume();
        expect(resumed.kind).toBe('completed');
        if (resumed.kind !== 'completed') return;

        // resume 后 Task 回 running，由全新 Reviewer 复核已保留的候选：
        // Episode 链只有新批准一个，且 Execution 不会重跑。
        const task = resumed.run.tasks['TASK-001']!;
        expect(task.status).toBe('completed');
        expect(task.taskReviewEpisodes.map((episode) => episode.outcome)).toEqual(['approved']);
        expect(task.executionEpisodes).toHaveLength(1);
        const reviewInvocations = (await harness.readRecords())
          .filter((record) => record.argv.includes('--session-id'))
          .filter(isTaskReviewInvocation);
        expect(reviewInvocations).toHaveLength(1);
        expect(reviewInvocations[0]!.argv).not.toContain('--resume');
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  it(
    '崩溃落在复核会话中时按心跳过期自动接管，续接原 Reviewer 会话完成复核',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          autoApproveTaskReviews: false,
          sequence: [
            { stdoutLines: streamOf(planDraft([{ id: 'TASK-001' }])) },
            {
              writeFiles: [{ path: 'src/feature.ts', content: 'export const value = 1;\n' }],
              stdoutLines: streamOf(executionCompleted()),
            },
            { sleepMs: 300_000, stdoutLines: streamOf(taskReviewApproved()) },
          ],
        });

        const driving = harness.start();
        await waitForRunFact(
          harness,
          'task_review activeSession',
          (run) => run.activeSession?.type === 'task_review',
          { driving },
        );
        harness.interrupt.request();
        const interrupted = await driving;
        expect(interrupted.kind).toBe('failed');
        if (interrupted.kind !== 'failed') return;

        /*
         * 以中断拿到的完整事实手工还原崩溃现场（绕过 StateStore 写入校验，
         * 等价于进程猝死后磁盘上的实际残留）：非终态 status、activeSession
         * 指向复核会话、Task running 带候选、复核 Episode 未结束。
         */
        const failedRun = interrupted.run;
        const reviewerSessionId = failedRun.resumePoint!.sessionId!;
        const crashedEpisode = failedRun.tasks['TASK-001']!.taskReviewEpisodes[0]!;
        const candidateCheckpoint = failedRun.tasks['TASK-001']!.candidateCheckpoint!;
        const crashedRun: RunJson = {
          ...failedRun,
          status: 'running',
          currentTaskId: 'TASK-001',
          activeSession: {
            sessionId: reviewerSessionId,
            type: 'task_review',
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
              taskReviewEpisodes: [
                {
                  ...crashedEpisode,
                  specSha256After: null,
                  endedAt: null,
                  outcome: null,
                  summary: null,
                  tests: [],
                  acceptanceEvidence: [],
                  issues: [],
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
        // 崩溃离场：最后一拍停在 60 秒前（阈值 30 秒），resume 免 --force 自动接管。
        await harness.writeHeartbeat({
          runId: crashedRun.runId,
          at: new Date(Date.now() - 60_000).toISOString(),
        });

        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          autoApproveTaskReviews: false,
          sequence: [
            { stdoutLines: streamOf(taskReviewApproved()) },
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

        // 未结束的复核 Episode 被 reconcile 关闭为 session_error；Task 保持
        // running 候选保留，由续接的 Reviewer 批准同一候选 Checkpoint。
        const task = resumed.run.tasks['TASK-001']!;
        expect(task.taskReviewEpisodes.map((episode) => episode.outcome)).toEqual([
          'session_error',
          'approved',
        ]);
        expect(task.taskReviewEpisodes[0]!.error?.errorCode).toBe('RUN_INTERRUPTED');
        expect(task.taskReviewEpisodes[0]!.sessionId).toBe(reviewerSessionId);
        expect(task.taskReviewEpisodes[1]!.candidateCheckpoint).toBe(candidateCheckpoint);
        expect(task.status).toBe('completed');
        expect(task.finalCheckpoint).toBe(candidateCheckpoint);
        expect(task.executionEpisodes).toHaveLength(1);

        // 接管后的首个复核会话经 --resume <原 Reviewer 会话> 续接。
        const records = await harness.readRecords();
        const resumedInvocation = records.find((record) => record.argv.includes('--resume'));
        expect(resumedInvocation).toBeDefined();
        expect(
          resumedInvocation!.argv[resumedInvocation!.argv.indexOf('--resume') + 1],
        ).toBe(reviewerSessionId);
        expect(isTaskReviewInvocation(resumedInvocation!)).toBe(true);
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  it(
    '复核结果未过语义校验时接力一次修复会话，修复合法后批准完成',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          autoApproveTaskReviews: false,
          sequence: [
            { stdoutLines: streamOf(planDraft([{ id: 'TASK-001' }])) },
            {
              writeFiles: [{ path: 'src/feature.ts', content: 'export const value = 1;\n' }],
              stdoutLines: streamOf(executionCompleted()),
            },
            // 语义非法：approved 却携带非空 issues（结构 Schema 通过、领域门禁拒绝）。
            {
              stdoutLines: streamOf({
                decision: 'approved',
                summary: '复核结论携带了不该存在的问题清单',
                tests: [{ command: 'npm test', result: 'passed' }],
                acceptanceEvidence: [
                  { criterionIndex: 0, status: 'satisfied', evidence: '独立复核证据 0' },
                ],
                issues: ['approved 不允许携带非空 issues'],
                replanReason: null,
              }),
            },
            // 修复会话返回合法 approved。
            { stdoutLines: streamOf(taskReviewApproved()) },
            { stdoutLines: streamOf(finalReviewCompleted(['TASK-001'])) },
          ],
        });

        const result = await harness.start();
        expect(result.kind).toBe('completed');
        if (result.kind !== 'completed') return;

        // 非法结论的 Episode 关闭为 session_error；修复会话的批准完成 Task。
        const task = result.run.tasks['TASK-001']!;
        expect(task.status).toBe('completed');
        expect(task.completedResult).not.toBeNull();
        expect(task.taskReviewEpisodes.map((episode) => episode.outcome)).toEqual([
          'session_error',
          'approved',
        ]);
        expect(task.taskReviewEpisodes[0]!.error?.errorCode).toBe('TASK_REVIEW_RESULT_INVALID');

        // 修复会话真实启动：第二趟复核调用使用修复提示词（含校验错误上下文）。
        const reviewInvocations = (await harness.readRecords())
          .filter((record) => record.argv.includes('--session-id'))
          .filter(isTaskReviewInvocation);
        expect(reviewInvocations).toHaveLength(2);
        expect(reviewInvocations[1]!.stdin).toContain('TaskReviewResult 未通过契约校验');
        expect(reviewInvocations[1]!.argv).not.toContain('--resume');
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  it(
    '同一 Task 连续三次 changes_required 后以 TASK_REVIEW_REWORK_LIMIT_EXCEEDED 终止',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          autoApproveTaskReviews: false,
          sequence: [
            { stdoutLines: streamOf(planDraft([{ id: 'TASK-001' }])) },
            {
              writeFiles: [{ path: 'src/feature.ts', content: 'export const value = 0;\n' }],
              stdoutLines: streamOf(executionCompleted()),
            },
            { stdoutLines: streamOf(CHANGES_REQUIRED) },
            {
              writeFiles: [{ path: 'src/feature.ts', content: 'export const value = 1;\n' }],
              stdoutLines: streamOf(executionCompleted()),
            },
            { stdoutLines: streamOf(CHANGES_REQUIRED) },
            {
              writeFiles: [{ path: 'src/feature.ts', content: 'export const value = 2;\n' }],
              stdoutLines: streamOf(executionCompleted()),
            },
            { stdoutLines: streamOf(CHANGES_REQUIRED) },
          ],
        });

        const result = await harness.start();
        expect(result.kind).toBe('failed');
        if (result.kind !== 'failed') return;

        expect(result.run.lastError?.errorCode).toBe('TASK_REVIEW_REWORK_LIMIT_EXCEEDED');
        const task = result.run.tasks['TASK-001']!;
        expect(task.status).toBe('failed');
        expect(task.failure?.errorCode).toBe('TASK_REVIEW_REWORK_LIMIT_EXCEEDED');
        // 候选字段清空：failed Task 不再携带可被误认为待批准的候选。
        expect(task.candidateResult).toBeNull();
        expect(task.candidateCheckpoint).toBeNull();
        // 三次复核全部打回，三次 Execution 都只到候选。
        expect(task.taskReviewEpisodes.map((episode) => episode.outcome)).toEqual([
          'changes_required',
          'changes_required',
          'changes_required',
        ]);
        expect(task.executionEpisodes.map((episode) => episode.outcome)).toEqual([
          'awaiting_review',
          'awaiting_review',
          'awaiting_review',
        ]);
        // 三个候选 Checkpoint 全部保留在 intermediateCheckpoints 供审计。
        const candidateOids = task.taskReviewEpisodes.map((episode) => episode.candidateCheckpoint);
        expect(new Set(candidateOids).size).toBe(3);
        expect(result.run.intermediateCheckpoints.map((checkpoint) => checkpoint.oid)).toEqual(
          expect.arrayContaining(candidateOids),
        );
        // 返工终止后不再启动任何新会话（序列未耗尽到 final review）。
        const reviewInvocations = (await harness.readRecords())
          .filter((record) => record.argv.includes('--session-id'))
          .filter(isTaskReviewInvocation);
        expect(reviewInvocations).toHaveLength(3);
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );
});
