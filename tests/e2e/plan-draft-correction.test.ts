/**
 * Planning 草稿确定性校验修正回路端到端测试。
 *
 * 真实运行中（尤其非 Anthropic 模型）Planner 可能返回跨字段语义不合法、
 * 但 Schema 合法的草稿——例如验收条件缺少验证步骤覆盖。这类缺陷只能由
 * 会话后的确定性校验（SPEC §7.5）检出。这里锁定修正回路语义：
 * 校验结论续接回原 Planner 会话定向修正、轮次有界、resume 不可用时
 * 回退为携带被拒草稿与校验结论的全新会话，耗尽后才允许终态失败。
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
  type E2EHarness,
  type RecordedInvocation,
} from './helpers.js';
import { seedRepo } from '../integration/git/helpers.js';

const TWO_CRITERIA = ['条件一', '条件二'] as const;

/** 修正后合法草稿：VERIFY-001 覆盖全部两条验收条件。 */
const VALID_PLAN = planDraft([
  { id: 'TASK-001', title: '实现聚焦功能', acceptanceCriteria: [...TWO_CRITERIA] },
]);

/**
 * 非法草稿变体：第二条验收条件（index 1）没有任何验证步骤覆盖，
 * 触发 "task TASK-001 acceptance criterion 1 has no verification step"。
 */
function planDraftMissingCoverage(): Record<string, unknown> {
  const draft = planDraft([
    { id: 'TASK-001', title: '实现聚焦功能', acceptanceCriteria: [...TWO_CRITERIA] },
  ]);
  const tasks = draft['tasks'] as { verificationPlan: { criterionIndexes: number[] }[] }[];
  tasks[0]!.verificationPlan[0]!.criterionIndexes = [0];
  return draft;
}

const COVERAGE_ERROR = 'task TASK-001 acceptance criterion 1 has no verification step';

/** 业务 Session 调用（排除 --version/--help 能力探测）。 */
async function businessInvocations(harness: E2EHarness): Promise<RecordedInvocation[]> {
  return (await harness.readRecords()).filter((record) => record.argv.includes('--session-id'));
}

describe('e2e planning draft correction loop', () => {
  it(
    '草稿缺验收覆盖时续接原 Planner 会话定向修正，修正稿进入独立复核',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          sequence: [
            { stdoutLines: streamOf(planDraftMissingCoverage()) },
            { stdoutLines: streamOf(VALID_PLAN) },
            {
              writeFiles: [{ path: 'src/focused.ts', content: 'export const focused = true;\n' }],
              stdoutLines: streamOf(executionCompleted(2)),
            },
            { stdoutLines: streamOf(finalReviewCompleted(['TASK-001'])) },
          ],
        });

        const result = await harness.start();
        expect(result.kind, JSON.stringify(result)).toBe('completed');
        if (result.kind !== 'completed') return;

        const records = await harness.listSessionRecords();
        expect(records.map((record) => record.type)).toEqual([
          'planning',
          'planning',
          'plan_review',
          'execution',
          'task_review',
          'final_review',
        ]);
        // 被拒草稿的会话事实原样保留：completed、含非法结构化结果，不回写。
        expect(records[0]!.status).toBe('completed');
        expect(records[1]!.status).toBe('completed');

        // 修正会话以 --resume --fork-session 续接被拒草稿所在的会话，
        // 提示词只携带精确校验结论。
        const invocations = await businessInvocations(harness);
        const correction = invocations[1]!;
        expect(correction.argv).toContain('--fork-session');
        const resumeIndex = correction.argv.indexOf('--resume');
        expect(resumeIndex).toBeGreaterThanOrEqual(0);
        expect(correction.argv[resumeIndex + 1]).toBe(records[0]!.sessionId);
        expect(correction.stdin).toContain('VALIDATION_ERROR');
        expect(correction.stdin).toContain(COVERAGE_ERROR);

        // 前台告知修正事实；提交的计划来自修正会话。
        expect(harness.outputLines.join('\n')).toContain('续接 Planner 定向修正（第 1/2 轮）');
        const tasks = await harness.readTasksJson();
        expect(tasks.plannerSessionId).toBe(records[1]!.sessionId);
        expect(result.run.planCandidate).toBeNull();
      } finally {
        await harness.cleanup();
      }
    },
    120_000,
  );

  it(
    '连续修正仍不合法时按既有终态语义失败，不形成无界回路',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          sequence: [
            { stdoutLines: streamOf(planDraftMissingCoverage()) },
            { stdoutLines: streamOf(planDraftMissingCoverage()) },
            { stdoutLines: streamOf(planDraftMissingCoverage()) },
          ],
        });

        const result = await harness.start();
        expect(result.kind).toBe('failed');
        if (result.kind !== 'failed') return;
        expect(result.run.lastError?.errorCode).toBe('PLAN_INVALID');
        expect(result.run.lastError?.message).toContain(COVERAGE_ERROR);
        expect(result.run.planRevision).toBe(0);
        expect(result.run.planCandidate).toBeNull();

        // 首轮 + 两轮修正，共三趟 Planning；修正轮次各自续接上一趟会话。
        const records = await harness.listSessionRecords();
        expect(records.map((record) => record.type)).toEqual([
          'planning',
          'planning',
          'planning',
        ]);
        const invocations = await businessInvocations(harness);
        expect(invocations).toHaveLength(3);
        expect(invocations[1]!.argv[invocations[1]!.argv.indexOf('--resume') + 1]).toBe(
          records[0]!.sessionId,
        );
        expect(invocations[2]!.argv[invocations[2]!.argv.indexOf('--resume') + 1]).toBe(
          records[1]!.sessionId,
        );

        const progress = harness.outputLines.join('\n');
        expect(progress).toContain('续接 Planner 定向修正（第 1/2 轮）');
        expect(progress).toContain('续接 Planner 定向修正（第 2/2 轮）');
      } finally {
        await harness.cleanup();
      }
    },
    120_000,
  );

  it(
    '修正续接不可用时回退为携带被拒草稿与校验结论的全新会话',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          sequence: [
            { stdoutLines: streamOf(planDraftMissingCoverage()) },
            // 续接失败（模拟 transcript 不存在）：触发有界回退。
            { exitCode: 1, stderrText: 'No conversation found for session ID' },
            { stdoutLines: streamOf(VALID_PLAN) },
            {
              writeFiles: [{ path: 'src/focused.ts', content: 'export const focused = true;\n' }],
              stdoutLines: streamOf(executionCompleted(2)),
            },
            { stdoutLines: streamOf(finalReviewCompleted(['TASK-001'])) },
          ],
        });

        const result = await harness.start();
        expect(result.kind, JSON.stringify(result)).toBe('completed');
        if (result.kind !== 'completed') return;

        // 回退事实前台可见；续接失败的会话以 failed Record 落盘。
        const progress = harness.outputLines.join('\n');
        expect(progress).toContain('CLAUDE_RESUME_UNAVAILABLE');
        expect(progress).toContain('将使用完整提示创建新会话');
        const planningRecords = (await harness.listSessionRecords()).filter(
          (record) => record.type === 'planning',
        );
        expect(planningRecords.map((record) => record.status)).toEqual([
          'completed',
          'failed',
          'completed',
        ]);
        expect(planningRecords[1]!.error?.errorCode).toBe('CLAUDE_RESUME_UNAVAILABLE');

        // 全新修正会话不带 --resume，提示词在完整规划基线之上追加
        // 被拒草稿与确定性校验结论。
        const invocations = await businessInvocations(harness);
        const fallback = invocations[2]!;
        expect(fallback.argv).not.toContain('--resume');
        expect(fallback.stdin).toContain('你是 ApexCodingAgent 的规划器');
        expect(fallback.stdin).toContain('PLAN_DRAFT_CORRECTION');
        expect(fallback.stdin).toContain('REJECTED_DRAFT');
        expect(fallback.stdin).toContain(COVERAGE_ERROR);

        const tasks = await harness.readTasksJson();
        expect(tasks.plannerSessionId).toBe(planningRecords[2]!.sessionId);
      } finally {
        await harness.cleanup();
      }
    },
    120_000,
  );
});
