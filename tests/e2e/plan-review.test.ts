/**
 * 独立 Plan Review 端到端测试。
 *
 * 覆盖 Reviewer 打回后 Planner 消费结构化反馈重新生成草稿、Reviewer
 * 中断后只续接自身会话、三次打回上限、只读副作用门禁、复核期间 SPEC
 * 变化丢弃候选，以及候选/反馈引用损坏时的响亮失败。
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COMPLETE_HELP,
  createE2EHarness,
  executionCompleted,
  FAKE_VERSION,
  finalReviewCompleted,
  planDraft,
  planReviewApproved,
  planReviewChecks,
  reviewIssue,
  streamOf,
  waitForRunFact,
  type RecordedInvocation,
} from './helpers.js';
import { seedRepo } from '../integration/git/helpers.js';

/** 从传给 Claude 的 JSON Schema 识别独立 Plan Review 调用。 */
function isPlanReviewInvocation(record: RecordedInvocation): boolean {
  const schemaIndex = record.argv.indexOf('--json-schema');
  if (schemaIndex < 0) return false;
  const schemaText = record.argv[schemaIndex + 1];
  if (schemaText === undefined) return false;
  const schema = JSON.parse(schemaText) as { properties?: { taskAssessments?: unknown } };
  return schema.properties?.taskAssessments !== undefined;
}

/**
 * 读取一次 Claude 调用携带的结构化输出 Schema。
 * 端到端断言据此确认 Plan Review 打回后仍使用初始计划的收窄契约。
 */
function readInvocationSchema(record: RecordedInvocation): {
  readonly properties?: {
    readonly tasks?: { readonly items?: Record<string, unknown> };
  };
} {
  const schemaIndex = record.argv.indexOf('--json-schema');
  const schemaText = schemaIndex < 0 ? undefined : record.argv[schemaIndex + 1];
  if (schemaText === undefined) throw new Error('记录中缺少 --json-schema 参数');
  return JSON.parse(schemaText) as {
    readonly properties?: {
      readonly tasks?: { readonly items?: Record<string, unknown> };
    };
  };
}

/** 语义非法的复核结论：approved 却夹带非空 issues（结构 Schema 通过、领域门禁拒绝）。 */
const PLAN_REVIEW_APPROVED_WITH_ISSUES = {
  decision: 'approved',
  summary: '计划可以提交，但结论夹带一条非阻塞性观察',
  taskAssessments: [
    {
      taskId: 'TASK-001',
      decision: 'approved',
      checks: planReviewChecks(),
      issues: [
        reviewIssue({
          category: 'verification',
          summary: '集成测试数量叙述与仓库统计不符',
          evidence: '候选计划记录的数量与测试目录可观察文件数不同',
          requiredChange: '删除无法证实的数量结论或改为可复核的仓库事实',
        }),
      ],
    },
  ],
  issues: [],
} as const;

const ONE_TASK_PLAN = planDraft([{ id: 'TASK-001', title: '实现聚焦功能' }]);
const TWO_TASK_PLAN = planDraft([
  { id: 'TASK-001', title: '实现入口能力' },
  { id: 'TASK-002', title: '实现后续能力', dependsOn: ['TASK-001'] },
]);
const TWO_TASK_CORRECTED_PLAN = planDraft([
  { id: 'TASK-001', title: '按复核意见收窄入口能力' },
  { id: 'TASK-002', title: '实现后续能力', dependsOn: ['TASK-001'] },
]);
const TWO_TASK_REGRESSED_PLAN = planDraft([
  { id: 'TASK-001', title: '按复核意见收窄入口能力' },
  { id: 'TASK-002', title: '被修正器擅自概括的后续任务', dependsOn: ['TASK-001'] },
]);
const TWO_TASK_COMPACT_REWORK = planDraft([
  { id: 'TASK-001', title: '按复核意见收窄入口能力' },
  { id: 'TASK-002', disposition: 'retain' },
]);
const PLAN_CHANGES_REQUIRED = {
  decision: 'changes_required',
  summary: '任务边界仍然过大',
  taskAssessments: [
    {
      taskId: 'TASK-001',
      decision: 'changes_required',
      checks: planReviewChecks('scope_cohesion'),
      issues: [
        reviewIssue({
          category: 'task_scope',
          summary: 'objective 同时包含实现与无关迁移工作',
          evidence: '两个交付目标可独立实施和验收',
          requiredChange: '拆分无关迁移工作并保留单一主要目标',
        }),
      ],
    },
  ],
  issues: [],
} as const;

/** 两任务候选的合法打回结果：只要求修改 TASK-001，TASK-002 明确保留。 */
const TWO_TASK_CHANGES_REQUIRED = {
  decision: 'changes_required',
  summary: '入口任务边界仍然过大',
  taskAssessments: [
    {
      taskId: 'TASK-001',
      decision: 'changes_required',
      checks: planReviewChecks('scope_cohesion'),
      issues: [
        reviewIssue({
          category: 'task_scope',
          summary: '入口任务包含两个可独立验收的目标',
          evidence: '目标描述同时覆盖入口能力与后续能力',
          requiredChange: '收窄 TASK-001，保持 TASK-002 原定义',
        }),
      ],
    },
    {
      taskId: 'TASK-002',
      decision: 'approved',
      checks: planReviewChecks(),
      issues: [],
    },
  ],
  issues: [],
} as const;

describe('e2e independent plan review', () => {
  it(
    'changes_required 保存结构化反馈，重新 Planning 后由第二个 Reviewer 批准',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          autoApprovePlanReviews: false,
          sequence: [
            { stdoutLines: streamOf(ONE_TASK_PLAN) },
            { stdoutLines: streamOf(PLAN_CHANGES_REQUIRED) },
            { stdoutLines: streamOf(ONE_TASK_PLAN) },
            { stdoutLines: streamOf(planReviewApproved(['TASK-001'])) },
            {
              writeFiles: [{ path: 'src/focused.ts', content: 'export const focused = true;\n' }],
              stdoutLines: streamOf(executionCompleted()),
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
          'plan_review',
          'planning',
          'plan_review',
          'execution',
          'task_review',
          'final_review',
        ]);
        expect(records[1]!.structuredResult).toMatchObject({ decision: 'changes_required' });
        expect(records[3]!.structuredResult).toMatchObject({ decision: 'approved' });

        const tasks = await harness.readTasksJson();
        expect(tasks.plannerSessionId).toBe(records[2]!.sessionId);
        expect(tasks.planReviewerSessionId).toBe(records[3]!.sessionId);
        expect(result.run.planCandidate).toBeNull();
        expect(result.run.planReviewFeedback).toBeNull();

        const invocations = (await harness.readRecords()).filter((record) =>
          record.argv.includes('--session-id'),
        );
        expect(invocations[2]!.stdin).toContain('PLAN_REVIEW_FEEDBACK');
        expect(invocations[2]!.stdin).toContain('objective 同时包含实现与无关迁移工作');
        expect(invocations[2]!.stdin).toContain('INITIAL_PLAN_CONTRACT');
        expect(invocations[2]!.stdin).toContain('禁止使用 {id, disposition: "retain"}');
        expect(readInvocationSchema(invocations[2]!).properties?.tasks?.items).not.toHaveProperty(
          'anyOf',
        );
      } finally {
        await harness.cleanup();
      }
    },
    120_000,
  );

  it(
    '初始复核返工误用 retain 时按上一份完整候选物化，并由自包含修正稿继续',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          autoApprovePlanReviews: false,
          sequence: [
            { stdoutLines: streamOf(TWO_TASK_PLAN) },
            { stdoutLines: streamOf(TWO_TASK_CHANGES_REQUIRED) },
            { stdoutLines: streamOf(TWO_TASK_COMPACT_REWORK) },
            { stdoutLines: streamOf(TWO_TASK_REGRESSED_PLAN) },
            { stdoutLines: streamOf(TWO_TASK_CORRECTED_PLAN) },
            { stdoutLines: streamOf(planReviewApproved(['TASK-001', 'TASK-002'])) },
            {
              writeFiles: [{ path: 'src/entry.ts', content: 'export const entry = true;\n' }],
              stdoutLines: streamOf(executionCompleted()),
            },
            {
              writeFiles: [{ path: 'src/follow-up.ts', content: 'export const followUp = true;\n' }],
              stdoutLines: streamOf(executionCompleted()),
            },
            { stdoutLines: streamOf(finalReviewCompleted(['TASK-001', 'TASK-002'])) },
          ],
        });

        const result = await harness.start();
        expect(result.kind, JSON.stringify(result)).toBe('completed');
        if (result.kind !== 'completed') return;

        const records = await harness.listSessionRecords();
        const planningRecords = records.filter((record) => record.type === 'planning');
        expect(planningRecords).toHaveLength(4);

        /**
         * 紧凑返工稿保留为不可变会话证据；下一趟 Planning 收到系统物化的
         * 完整 TASK-002，并且最终提交引用该自包含修正会话而不是紧凑会话。
         */
        expect(planningRecords[1]!.structuredResult).toMatchObject(TWO_TASK_COMPACT_REWORK);
        const invocations = (await harness.readRecords()).filter((record) =>
          record.argv.includes('--session-id'),
        );
        expect(invocations[3]!.stdin).toContain('确定性展开为权威 Task 定义');
        expect(invocations[3]!.stdin).toContain('TASK-002');
        expect(invocations[3]!.stdin).toContain('实现后续能力');
        expect(planningRecords[2]!.structuredResult).toMatchObject(TWO_TASK_REGRESSED_PLAN);
        expect(invocations[4]!.stdin).toContain(
          'planning correction changed authoritative materialized tasks: TASK-002',
        );
        expect(invocations[4]!.stdin).toContain('实现后续能力');
        expect(invocations[4]!.stdin).not.toContain('被修正器擅自概括的后续任务');

        const tasks = await harness.readTasksJson();
        expect(tasks.plannerSessionId).toBe(planningRecords[3]!.sessionId);
        expect(tasks.tasks.map((task) => task.title)).toEqual([
          '按复核意见收窄入口能力',
          '实现后续能力',
        ]);
        expect(harness.outputLines.join('\n')).toContain(
          '启动轻量 Planner 定向修正（第 2/2 轮）',
        );
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  it(
    '中断 Plan Reviewer 后保留候选引用，resume 只续接原 Reviewer 会话',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          autoApprovePlanReviews: false,
          sequence: [
            { stdoutLines: streamOf(ONE_TASK_PLAN) },
            {
              sleepMs: 300_000,
              stdoutLines: streamOf(planReviewApproved(['TASK-001'])),
            },
          ],
        });

        const driving = harness.start();
        await waitForRunFact(
          harness,
          'plan_review activeSession',
          (run) => run.activeSession?.type === 'plan_review',
          { driving },
        );
        const active = await harness.readRunJson();
        const interruptedReviewerId = active.activeSession!.sessionId;
        harness.interrupt.request();
        const interrupted = await driving;
        expect(interrupted.kind).toBe('failed');
        if (interrupted.kind !== 'failed') return;
        expect(interrupted.run.resumePoint?.sessionType).toBe('plan_review');
        expect(interrupted.run.planCandidate).not.toBeNull();
        expect(interrupted.run.planCandidate?.plannerSessionId).toBeTypeOf('string');

        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          autoApprovePlanReviews: false,
          sequence: [
            { stdoutLines: streamOf(planReviewApproved(['TASK-001'])) },
            {
              writeFiles: [{ path: 'src/resumed.ts', content: 'export const resumed = true;\n' }],
              stdoutLines: streamOf(executionCompleted()),
            },
            { stdoutLines: streamOf(finalReviewCompleted(['TASK-001'])) },
          ],
        });
        const resumed = await harness.resume();
        expect(resumed.kind, JSON.stringify(resumed)).toBe('completed');
        if (resumed.kind !== 'completed') return;

        const resumeInvocations = (await harness.readRecords()).filter((record) =>
          record.argv.includes('--resume'),
        );
        expect(resumeInvocations).toHaveLength(1);
        expect(
          resumeInvocations[0]!.argv[resumeInvocations[0]!.argv.indexOf('--resume') + 1],
        ).toBe(interruptedReviewerId);
        expect(resumeInvocations[0]!.stdin).toContain('只续接 Reviewer 自己的复核上下文');

        const tasks = await harness.readTasksJson();
        const reviewRecords = (await harness.listSessionRecords()).filter(
          (record) => record.type === 'plan_review',
        );
        expect(reviewRecords).toHaveLength(2);
        expect(reviewRecords[0]!.status).toBe('failed');
        expect(reviewRecords[1]!.status).toBe('completed');
        expect(tasks.planReviewerSessionId).toBe(reviewRecords[1]!.sessionId);
      } finally {
        await harness.cleanup();
      }
    },
    120_000,
  );

  it(
    '同一 Revision 连续三次 changes_required 后以稳定错误停止',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          autoApprovePlanReviews: false,
          sequence: [
            { stdoutLines: streamOf(ONE_TASK_PLAN) },
            { stdoutLines: streamOf(PLAN_CHANGES_REQUIRED) },
            { stdoutLines: streamOf(ONE_TASK_PLAN) },
            { stdoutLines: streamOf(PLAN_CHANGES_REQUIRED) },
            { stdoutLines: streamOf(ONE_TASK_PLAN) },
            { stdoutLines: streamOf(PLAN_CHANGES_REQUIRED) },
          ],
        });

        const result = await harness.start();
        expect(result.kind).toBe('failed');
        if (result.kind !== 'failed') return;
        expect(result.run.lastError?.errorCode).toBe('PLAN_REVIEW_REWORK_LIMIT_EXCEEDED');
        expect(result.run.planRevision).toBe(0);
        expect(result.run.tasksSha256).toBeNull();
        expect(result.run.planCandidate).toBeNull();
        expect(result.run.planReviewFeedback).toBeNull();
        expect((await harness.listSessionRecords()).map((record) => record.type)).toEqual([
          'planning',
          'plan_review',
          'planning',
          'plan_review',
          'planning',
          'plan_review',
        ]);
      } finally {
        await harness.cleanup();
      }
    },
    120_000,
  );
});

describe('e2e independent plan review — 边界与失败语义', () => {
  it(
    '复核结果未过语义校验时接力一次修复会话，修复合法后提交计划',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          autoApprovePlanReviews: false,
          sequence: [
            { stdoutLines: streamOf(ONE_TASK_PLAN) },
            { stdoutLines: streamOf(PLAN_REVIEW_APPROVED_WITH_ISSUES) },
            // 修复会话返回合法 approved。
            { stdoutLines: streamOf(planReviewApproved(['TASK-001'])) },
            {
              writeFiles: [{ path: 'src/focused.ts', content: 'export const focused = true;\n' }],
              stdoutLines: streamOf(executionCompleted()),
            },
            { stdoutLines: streamOf(finalReviewCompleted(['TASK-001'])) },
          ],
        });

        const result = await harness.start();
        expect(result.kind, JSON.stringify(result)).toBe('completed');
        if (result.kind !== 'completed') return;

        // 非法结论所在会话与修复会话各一条 plan_review Record；批准来自修复会话。
        const records = await harness.listSessionRecords();
        expect(records.map((record) => record.type)).toEqual([
          'planning',
          'plan_review',
          'plan_review',
          'execution',
          'task_review',
          'final_review',
        ]);
        const tasks = await harness.readTasksJson();
        expect(tasks.planReviewerSessionId).toBe(records[2]!.sessionId);

        // 修复会话真实启动：第二趟复核调用使用修复提示词（含校验错误与非法
        // 结果原文），不续接上一趟会话。
        const reviewInvocations = (await harness.readRecords())
          .filter((record) => record.argv.includes('--session-id'))
          .filter(isPlanReviewInvocation);
        expect(reviewInvocations).toHaveLength(2);
        expect(reviewInvocations[1]!.stdin).toContain('PlanReviewResult 未通过契约校验');
        expect(reviewInvocations[1]!.stdin).toContain(
          'approved task assessment TASK-001 requires every check satisfied and no issues',
        );
        expect(reviewInvocations[1]!.stdin).toContain('非阻塞性观察');
        expect(reviewInvocations[1]!.argv).not.toContain('--resume');
      } finally {
        await harness.cleanup();
      }
    },
    120_000,
  );

  it(
    '修复会话仍返回非法结果时保留候选与恢复点，resume 续接复核会话后提交计划',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          autoApprovePlanReviews: false,
          sequence: [
            { stdoutLines: streamOf(ONE_TASK_PLAN) },
            { stdoutLines: streamOf(PLAN_REVIEW_APPROVED_WITH_ISSUES) },
            // 修复会话同样返回语义非法结果：耗尽接力次数后转 failed。
            { stdoutLines: streamOf(PLAN_REVIEW_APPROVED_WITH_ISSUES) },
          ],
        });

        const result = await harness.start();
        expect(result.kind).toBe('failed');
        if (result.kind !== 'failed') return;
        expect(result.run.lastError?.errorCode).toBe('PLAN_REVIEW_RESULT_INVALID');
        expect(result.run.planRevision).toBe(0);
        expect(result.run.tasksSha256).toBeNull();
        /**
         * 结果契约失败不得报废 Run（2026-08 真实 Run 复盘）：候选草稿引用
         * 与恢复点必须持久化，恢复点续接最后返回非法结果的修复会话；
         * 计划尚未提交，planReviewFeedback 不存在。
         */
        expect(result.run.planCandidate).not.toBeNull();
        expect(result.run.planCandidate?.reviewAttempt).toBe(1);
        expect(result.run.planReviewFeedback).toBeNull();
        const failedRecords = await harness.listSessionRecords();
        expect(failedRecords.map((record) => record.type)).toEqual([
          'planning',
          'plan_review',
          'plan_review',
        ]);
        expect(result.run.planCandidate?.plannerSessionId).toBe(failedRecords[0]!.sessionId);
        expect(result.run.resumePoint).toEqual({
          fromStatus: 'planning',
          taskId: null,
          sessionId: failedRecords[2]!.sessionId,
          sessionType: 'plan_review',
        });

        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          autoApprovePlanReviews: false,
          sequence: [
            { stdoutLines: streamOf(planReviewApproved(['TASK-001'])) },
            {
              writeFiles: [{ path: 'src/focused.ts', content: 'export const focused = true;\n' }],
              stdoutLines: streamOf(executionCompleted()),
            },
            { stdoutLines: streamOf(finalReviewCompleted(['TASK-001'])) },
          ],
        });
        const resumed = await harness.resume();
        expect(resumed.kind, JSON.stringify(resumed)).toBe('completed');
        if (resumed.kind !== 'completed') return;

        // resume 的首趟复核调用经 --resume 续接修复会话，提示词如实陈述
        // 契约失败原因；计划由该续接会话批准后提交。
        const resumeInvocations = (await harness.readRecords()).filter((record) =>
          record.argv.includes('--resume'),
        );
        expect(resumeInvocations).toHaveLength(1);
        expect(
          resumeInvocations[0]!.argv[resumeInvocations[0]!.argv.indexOf('--resume') + 1],
        ).toBe(failedRecords[2]!.sessionId);
        expect(resumeInvocations[0]!.stdin).toContain('未通过契约校验');
        expect(resumeInvocations[0]!.stdin).not.toContain('被前台中断');

        const reviewRecords = (await harness.listSessionRecords()).filter(
          (record) => record.type === 'plan_review',
        );
        expect(reviewRecords).toHaveLength(3);
        const tasks = await harness.readTasksJson();
        expect(tasks.planReviewerSessionId).toBe(reviewRecords[2]!.sessionId);
      } finally {
        await harness.cleanup();
      }
    },
    120_000,
  );

  it(
    '复核会话修改工作树时以稳定错误失败，候选不得提交',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          autoApprovePlanReviews: false,
          sequence: [
            { stdoutLines: streamOf(ONE_TASK_PLAN) },
            {
              writeFiles: [{ path: 'src/evil.ts', content: 'export const evil = true;\n' }],
              stdoutLines: streamOf(planReviewApproved(['TASK-001'])),
            },
          ],
        });

        const result = await harness.start();
        expect(result.kind).toBe('failed');
        if (result.kind !== 'failed') return;
        expect(result.run.lastError?.errorCode).toBe('PLAN_REVIEW_SIDE_EFFECT_DETECTED');
        expect(result.run.planRevision).toBe(0);
        expect(result.run.tasksSha256).toBeNull();
        expect(result.run.planCandidate).toBeNull();
        expect(result.run.planReviewFeedback).toBeNull();
        const records = await harness.listSessionRecords();
        expect(records.map((record) => record.type)).toEqual(['planning', 'plan_review']);
      } finally {
        await harness.cleanup();
      }
    },
    120_000,
  );

  it(
    '复核会话期间 SPEC 变化时丢弃候选批准结论，以新 SPEC 重新规划',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          autoApprovePlanReviews: false,
          sequence: [
            { stdoutLines: streamOf(ONE_TASK_PLAN) },
            // SPEC 是受保护路径，不触发只读门禁；由 specBefore/specAfter 哈希边界检出。
            {
              writeFiles: [{ path: 'SPEC.md', content: '# Spec v2\n\n新增需求。\n' }],
              stdoutLines: streamOf(planReviewApproved(['TASK-001'])),
            },
            {
              stdoutLines: streamOf(
                planDraft([{ id: 'TASK-001', title: '按 v2 实现功能' }], {
                  summary: 'SPEC v2 修订计划',
                }),
              ),
            },
            { stdoutLines: streamOf(planReviewApproved(['TASK-001'])) },
            {
              writeFiles: [{ path: 'src/feature.ts', content: 'export const value = 2;\n' }],
              stdoutLines: streamOf(executionCompleted()),
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
          'plan_review',
          'planning',
          'plan_review',
          'execution',
          'task_review',
          'final_review',
        ]);

        // 第一个 Reviewer 的批准结论未提交：Revision 1 来自第二趟 Planning，
        // 基于变化后的 SPEC，由第二个独立 Reviewer 批准。
        const tasks = await harness.readTasksJson();
        expect(tasks.summary).toBe('SPEC v2 修订计划');
        expect(tasks.plannerSessionId).toBe(records[2]!.sessionId);
        expect(tasks.planReviewerSessionId).toBe(records[3]!.sessionId);
        const snapshot = await harness.readPlanSnapshot(1);
        expect(snapshot.specSha256).not.toBe(records[0]!.specSha256);
        expect(result.run.planCandidate).toBeNull();
        expect(result.run.planReviewFeedback).toBeNull();

        // SPEC 从未被提交：Run Branch 历史中不含 SPEC 变更。
        const specLog = await harness.repo.git(
          'log',
          '--format=%s',
          'main..HEAD',
          '--',
          'SPEC.md',
        );
        expect(specLog).toBe('');
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  it(
    '候选引用的 Planning Record 损坏时复核以 STATE_VALIDATION_FAILED 响亮失败',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          autoApprovePlanReviews: false,
          sequence: [
            { stdoutLines: streamOf(ONE_TASK_PLAN) },
            { sleepMs: 300_000, stdoutLines: streamOf(planReviewApproved(['TASK-001'])) },
          ],
        });

        const driving = harness.start();
        await waitForRunFact(
          harness,
          'plan_review activeSession',
          (run) => run.activeSession?.type === 'plan_review',
          { driving },
        );
        const active = await harness.readRunJson();
        const plannerSessionId = active.planCandidate!.plannerSessionId;
        harness.interrupt.request();
        const interrupted = await driving;
        expect(interrupted.kind).toBe('failed');
        if (interrupted.kind !== 'failed') return;
        expect(interrupted.run.planCandidate).not.toBeNull();

        // 候选引用指向的不可变 Planning Record 丢失：不得回退为无候选重规划。
        await rm(join(harness.stateDir, 'sessions', `${plannerSessionId}.json`));
        await harness.writeScenario({ version: FAKE_VERSION, help: COMPLETE_HELP });
        const resumed = await harness.resume();
        expect(resumed.kind).toBe('failed');
        if (resumed.kind !== 'failed') return;
        expect(resumed.run.lastError?.errorCode).toBe('STATE_VALIDATION_FAILED');
        expect(resumed.run.planCandidate).toBeNull();
        expect(resumed.run.planReviewFeedback).toBeNull();
      } finally {
        await harness.cleanup();
      }
    },
    120_000,
  );

  it(
    '反馈引用的 Session Record 损坏时重新 Planning 以 STATE_VALIDATION_FAILED 响亮失败',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          autoApprovePlanReviews: false,
          sequence: [
            { stdoutLines: streamOf(ONE_TASK_PLAN) },
            { stdoutLines: streamOf(PLAN_CHANGES_REQUIRED) },
            { sleepMs: 300_000, stdoutLines: streamOf(ONE_TASK_PLAN) },
          ],
        });

        const driving = harness.start();
        await waitForRunFact(
          harness,
          'second planning session with persisted feedback',
          (run) => run.planReviewFeedback !== null && run.activeSession?.type === 'planning',
          { driving },
        );
        const active = await harness.readRunJson();
        const plannerSessionId = active.planReviewFeedback!.plannerSessionId;
        harness.interrupt.request();
        const interrupted = await driving;
        expect(interrupted.kind).toBe('failed');
        if (interrupted.kind !== 'failed') return;
        expect(interrupted.run.planReviewFeedback).not.toBeNull();

        // 反馈引用指向的 Planning Record 丢失：不得静默当作无反馈重新规划。
        await rm(join(harness.stateDir, 'sessions', `${plannerSessionId}.json`));
        await harness.writeScenario({ version: FAKE_VERSION, help: COMPLETE_HELP });
        const resumed = await harness.resume();
        expect(resumed.kind).toBe('failed');
        if (resumed.kind !== 'failed') return;
        expect(resumed.run.lastError?.errorCode).toBe('STATE_VALIDATION_FAILED');
        expect(resumed.run.planCandidate).toBeNull();
        expect(resumed.run.planReviewFeedback).toBeNull();
      } finally {
        await harness.cleanup();
      }
    },
    120_000,
  );
});
