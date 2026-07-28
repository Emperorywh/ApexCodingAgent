/**
 * E2E：Replan 与 SPEC 变化（G5 测试清单 + §3.2/§13/§6.5）。
 *
 * - Execution 返回 replan_required：中间 Checkpoint 保存 → Task 回 pending
 *   → 新 Revision 接管 → 继续执行；同一 Task 多 Episode 全保留。
 * - SPEC 在 Execution 期间变化：六步流程断言。
 * - SPEC 在 Final Review 期间变化：五步流程断言。
 * - 新 Revision 省略 pending Task → skipped 且拒绝 ID 复用；
 *   disposition 缺失 → 拒绝 Revision。
 */
import { describe, expect, it } from 'vitest';
import {
  COMPLETE_HELP,
  createE2EHarness,
  executionCompleted,
  FAKE_VERSION,
  finalReviewCompleted,
  planDraft,
  streamOf,
} from './helpers.js';
import { seedRepo } from '../integration/git/helpers.js';

const REPLAN_RESULT = {
  decision: 'replan_required',
  summary: '架构前置条件变化，需要重新规划',
  tests: [],
  acceptanceEvidence: [{ criterionIndex: 0, status: 'not_satisfied', evidence: '尚未完成' }],
  changedAreas: ['src'],
  remainingRisks: [],
  replanReason: '发现需要先抽象配置层',
};

describe('e2e replan_required', () => {
  it(
    'intermediate checkpoint preserved, task back to pending, revision 2 adopts it, both episodes kept',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          sequence: [
            // 1. 初始 Planning：TASK-001 + TASK-002。
            {
              stdoutLines: streamOf(
                planDraft([{ id: 'TASK-001' }, { id: 'TASK-002', dependsOn: ['TASK-001'] }]),
              ),
            },
            // 2. TASK-001 执行：产生仓库变更并返回 replan_required。
            {
              writeFiles: [{ path: 'src/draft-work.ts', content: 'export const draft = 1;\n' }],
              stdoutLines: streamOf(REPLAN_RESULT),
            },
            // 3. 第二次 Planning：接管中间 Checkpoint（占位符由 Fake Claude
            //    从 run.json 读取替换），TASK-001 定义修改。
            {
              stdoutLines: streamOf(
                planDraft(
                  [
                    { id: 'TASK-001', title: '实现功能 A（含配置层）' },
                    { id: 'TASK-002', dependsOn: ['TASK-001'] },
                  ],
                  {
                    summary: '修订计划',
                    dispositions: [
                      {
                        checkpointOid: '{firstIntermediateCheckpointOid}',
                        ownerTaskId: 'TASK-001',
                        rationale: 'TASK-001 继续采用其中间变更',
                      },
                    ],
                  },
                ),
              ),
            },
            // 4-5. 两个 Task 依次完成。
            {
              writeFiles: [{ path: 'src/feature-a.ts', content: 'export const a = 1;\n' }],
              stdoutLines: streamOf(executionCompleted()),
            },
            {
              writeFiles: [{ path: 'src/feature-b.ts', content: 'export const b = 2;\n' }],
              stdoutLines: streamOf(executionCompleted()),
            },
            // 6. Final Review 完成。
            { stdoutLines: streamOf(finalReviewCompleted(['TASK-001', 'TASK-002'])) },
          ],
        });

        const result = await harness.start();
        expect(result.kind).toBe('completed');
        if (result.kind !== 'completed') return;
        const run = result.run;

        // Revision 2 已提交；触发原因为 execution_replan 且带来源 Session。
        expect(run.planRevision).toBe(2);
        const snapshot2 = await harness.readPlanSnapshot(2);
        expect(snapshot2.trigger.type).toBe('execution_replan');
        expect(snapshot2.trigger.reason).toBe('发现需要先抽象配置层');
        expect(snapshot2.trigger.sourceSessionId).not.toBeNull();

        // 中间 Checkpoint 被 TASK-001 接管（completed 后视为已吸收）。
        expect(run.intermediateCheckpoints).toHaveLength(1);
        expect(run.intermediateCheckpoints[0]!.role).toBe('task-intermediate');
        expect(run.intermediateCheckpoints[0]!.taskId).toBe('TASK-001');
        expect(run.intermediateCheckpoints[0]!.ownerTaskId).toBe('TASK-001');

        // 中间 Checkpoint 提交真实存在于 Run Branch 历史中。
        const messages = await harness.repo.git('log', '--format=%s', 'main..HEAD');
        expect(messages).toContain('apex-coding-agent(TASK-001): preserve intermediate work');

        // 同一 Task 的两个 Episode 全保留：replan_required + completed。
        const task1 = run.tasks['TASK-001']!;
        expect(task1.status).toBe('completed');
        expect(task1.executionEpisodes).toHaveLength(2);
        expect(task1.executionEpisodes[0]!.outcome).toBe('replan_required');
        expect(task1.executionEpisodes[0]!.intermediateCheckpoint).toBe(
          run.intermediateCheckpoints[0]!.oid,
        );
        expect(task1.executionEpisodes[1]!.outcome).toBe('completed');
        // 定义更新为新 Revision 的版本。
        const tasks = await harness.readTasksJson();
        expect(tasks.tasks.find((task) => task.id === 'TASK-001')!.title).toBe(
          '实现功能 A（含配置层）',
        );

        // Session Record：6 个（2 planning + 3 execution[同一 Task 两次] + 1 final review）。
        const records = await harness.listSessionRecords();
        expect(records).toHaveLength(6);
        expect(records.map((record) => record.type)).toEqual([
          'planning',
          'execution',
          'planning',
          'execution',
          'execution',
          'final_review',
        ]);
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  it(
    'omitted pending task becomes skipped and its ID cannot be reused; missing disposition rejects the revision',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          sequence: [
            // 1. 初始 Planning：TASK-001 + TASK-002（独立）。
            { stdoutLines: streamOf(planDraft([{ id: 'TASK-001' }, { id: 'TASK-002' }])) },
            // 2. TASK-001 请求 replan（无仓库变更 → 无中间 Checkpoint）。
            { stdoutLines: streamOf(REPLAN_RESULT) },
            // 3. Revision 2：省略 TASK-002（→ skipped），无 disposition（无未
            //    吸收 Checkpoint，合法）。
            { stdoutLines: streamOf(planDraft([{ id: 'TASK-001' }], { summary: '收缩计划' })) },
            // 4. TASK-001 完成。
            {
              writeFiles: [{ path: 'src/feature-a.ts', content: 'export const a = 1;\n' }],
              stdoutLines: streamOf(executionCompleted()),
            },
            // 5. Final Review 只复核当前计划的 completed Task。
            { stdoutLines: streamOf(finalReviewCompleted(['TASK-001'])) },
          ],
        });

        const result = await harness.start();
        expect(result.kind).toBe('completed');
        if (result.kind !== 'completed') return;
        const run = result.run;

        expect(run.planRevision).toBe(2);
        expect(run.tasks['TASK-002']!.status).toBe('skipped');
        expect(run.tasks['TASK-002']!.skipReason).toContain('Omitted by plan revision 2');
        expect(run.tasks['TASK-001']!.status).toBe('completed');
        expect(Object.keys(run.tasks).sort()).toEqual(['TASK-001', 'TASK-002']);
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  it(
    'a revision reusing a skipped task ID is rejected with PLAN_REVISION_CONFLICT and fails the run',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          sequence: [
            { stdoutLines: streamOf(planDraft([{ id: 'TASK-001' }, { id: 'TASK-002' }])) },
            { stdoutLines: streamOf(REPLAN_RESULT) },
            // Revision 2：省略 TASK-002（→ skipped）。
            { stdoutLines: streamOf(planDraft([{ id: 'TASK-001' }], { summary: '收缩计划' })) },
            // TASK-001 再次请求 replan。
            { stdoutLines: streamOf(REPLAN_RESULT) },
            // Revision 3：复用已 skipped 的 TASK-002 ID → 必须拒绝。
            {
              stdoutLines: streamOf(
                planDraft([{ id: 'TASK-001' }, { id: 'TASK-002', title: '复用旧 ID 的新任务' }]),
              ),
            },
          ],
        });

        const result = await harness.start();
        expect(result.kind).toBe('failed');
        if (result.kind !== 'failed') return;
        expect(result.run.lastError?.errorCode).toBe('PLAN_REVISION_CONFLICT');
        expect(result.run.tasks['TASK-002']!.status).toBe('skipped');
        // 不自动重试：共 5 个 Session（2 Planning + 2 Execution + 被拒绝的
        // 第三次 Planning），失败后不再消耗更多会话。
        const records = await harness.readRecords();
        expect(records.filter((record) => record.argv.includes('--session-id'))).toHaveLength(5);
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  it(
    'a revision leaving an intermediate checkpoint without disposition is rejected',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          sequence: [
            { stdoutLines: streamOf(planDraft([{ id: 'TASK-001' }])) },
            // TASK-001 replan 且产生仓库变更 → 形成未吸收中间 Checkpoint。
            {
              writeFiles: [{ path: 'src/draft-work.ts', content: 'export const draft = 1;\n' }],
              stdoutLines: streamOf(REPLAN_RESULT),
            },
            // Revision 2 不含 disposition → PLAN_REVISION_CONFLICT。
            { stdoutLines: streamOf(planDraft([{ id: 'TASK-001' }], { summary: '缺归属计划' })) },
          ],
        });

        const result = await harness.start();
        expect(result.kind).toBe('failed');
        if (result.kind !== 'failed') return;
        expect(result.run.lastError?.errorCode).toBe('PLAN_REVISION_CONFLICT');
        expect(result.run.lastError?.message).toContain('no disposition');
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );
});

describe('e2e SPEC changes', () => {
  it(
    'SPEC changed during execution: six-step flow, task back to pending, new revision takes over the checkpoint',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          sequence: [
            { stdoutLines: streamOf(planDraft([{ id: 'TASK-001' }])) },
            // TASK-001 执行期间改写 SPEC（同时产生项目变更）。
            {
              writeFiles: [
                { path: 'SPEC.md', content: '# Spec v2\n\n新增需求。\n' },
                { path: 'src/draft-work.ts', content: 'export const draft = 1;\n' },
              ],
              stdoutLines: streamOf(executionCompleted()),
            },
            // Revision 2（spec_changed 触发）：接管中间 Checkpoint。
            {
              stdoutLines: streamOf(
                planDraft([{ id: 'TASK-001', title: '按 v2 实现功能 A' }], {
                  summary: 'SPEC v2 计划',
                  dispositions: [
                    {
                      checkpointOid: '{firstIntermediateCheckpointOid}',
                      ownerTaskId: 'TASK-001',
                      rationale: '继续采用 SPEC 变化前的中间变更',
                    },
                  ],
                }),
              ),
            },
            {
              writeFiles: [{ path: 'src/feature-a.ts', content: 'export const a = 1;\n' }],
              stdoutLines: streamOf(executionCompleted()),
            },
            { stdoutLines: streamOf(finalReviewCompleted(['TASK-001'])) },
          ],
        });

        const result = await harness.start();
        expect(result.kind).toBe('completed');
        if (result.kind !== 'completed') return;
        const run = result.run;

        // 六步关键事实：旧 SPEC 的结论未提交（第一个 Episode 是 spec_changed
        // 而非 completed），Task 回过 pending，中间 Checkpoint 被接管。
        const task1 = run.tasks['TASK-001']!;
        expect(task1.executionEpisodes).toHaveLength(2);
        expect(task1.executionEpisodes[0]!.outcome).toBe('spec_changed');
        expect(task1.executionEpisodes[0]!.intermediateCheckpoint).toBe(
          run.intermediateCheckpoints[0]!.oid,
        );
        expect(task1.executionEpisodes[1]!.outcome).toBe('completed');

        // SPEC 变化触发 Revision 2，run.json 记录新 SPEC SHA。
        expect(run.planRevision).toBe(2);
        const snapshot2 = await harness.readPlanSnapshot(2);
        expect(snapshot2.trigger.type).toBe('spec_changed');
        expect(snapshot2.trigger.sourceSessionId).toBe(task1.executionEpisodes[0]!.sessionId);
        const tasks = await harness.readTasksJson();
        expect(tasks.specSha256).toBe(run.spec.sha256);
        expect(typeof tasks.specSha256).toBe('string');

        // SPEC 从未被提交：Run Branch 历史中不含 SPEC 变更。
        const specLog = await harness.repo.git('log', '--format=%s', 'main..HEAD', '--', 'SPEC.md');
        expect(specLog).toBe('');
        const messages = await harness.repo.git('log', '--format=%s', 'main..HEAD');
        expect(messages).toContain('apex-coding-agent(TASK-001): preserve intermediate work');
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  it(
    'SPEC changed during final review: five-step flow, review conclusion discarded, new pending task takes over',
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
              writeFiles: [{ path: 'src/feature-a.ts', content: 'export const a = 1;\n' }],
              stdoutLines: streamOf(executionCompleted()),
            },
            // Final Review 期间改写 SPEC 并产生项目变更。
            {
              writeFiles: [
                { path: 'SPEC.md', content: '# Spec v2\n\n新增需求。\n' },
                { path: 'src/review-note.ts', content: 'export const note = 1;\n' },
              ],
              stdoutLines: streamOf(finalReviewCompleted(['TASK-001'])),
            },
            // Revision 2：新增 pending Task 表达新需求并接管中间 Checkpoint。
            {
              stdoutLines: streamOf(
                planDraft([{ id: 'TASK-001' }, { id: 'TASK-002', title: '实现 v2 新增需求', dependsOn: ['TASK-001'] }], {
                  summary: 'SPEC v2 补充计划',
                  dispositions: [
                    {
                      checkpointOid: '{firstIntermediateCheckpointOid}',
                      ownerTaskId: 'TASK-002',
                      rationale: '新需求 Task 接管 Final Review 中间变更',
                    },
                  ],
                }),
              ),
            },
            {
              writeFiles: [{ path: 'src/feature-b.ts', content: 'export const b = 2;\n' }],
              stdoutLines: streamOf(executionCompleted()),
            },
            { stdoutLines: streamOf(finalReviewCompleted(['TASK-001', 'TASK-002'])) },
          ],
        });

        const result = await harness.start();
        expect(result.kind).toBe('completed');
        if (result.kind !== 'completed') return;
        const run = result.run;

        // 五步关键事实：第一个 Final Review Episode 是 spec_changed（结论未
        // 提交），中间 Checkpoint 角色为 final-review-intermediate，新增的
        // pending Task 接管并完成。
        expect(run.planRevision).toBe(2);
        expect(run.finalReviewEpisodes).toHaveLength(2);
        expect(run.finalReviewEpisodes[0]!.decision).toBe('spec_changed');
        expect(run.finalReviewEpisodes[0]!.checkpointRole).toBe('final-review-intermediate');
        expect(run.finalReviewEpisodes[1]!.decision).toBe('completed');
        expect(run.intermediateCheckpoints[0]!.role).toBe('final-review-intermediate');
        expect(run.intermediateCheckpoints[0]!.taskId).toBeNull();
        expect(run.intermediateCheckpoints[0]!.ownerTaskId).toBe('TASK-002');
        expect(run.tasks['TASK-002']!.status).toBe('completed');
        // completed Task 未被改写。
        expect(run.tasks['TASK-001']!.status).toBe('completed');
        expect(run.tasks['TASK-001']!.executionEpisodes).toHaveLength(1);
        const snapshot2 = await harness.readPlanSnapshot(2);
        expect(snapshot2.trigger.type).toBe('spec_changed');
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );
});
