/**
 * E2E：失败语义（G5 测试清单 + §9.6/§14/§8/§12.5）。
 *
 * Fake Claude 非零退出 / decision=failed → Run failed 且错误码正确、进程级
 * 失败不自动重试；结构化结果未过契约校验时先接力一次结果修复会话，仍非法
 * 才转 failed（进程级失败不参与修复接力）；acceptanceEvidence 门禁；
 * Final Review 失败测试门禁；Planning 副作用与受保护路径 Commit → Run
 * failed（与 G3 不变量联动）；启动检查（工作区不干净、能力缺失、非终态
 * 旧 Run）拒绝启动。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  COMPLETE_HELP,
  createE2EHarness,
  executionCompleted,
  FAKE_VERSION,
  finalReviewCompleted,
  planDraft,
  streamOf,
  waitForRunFact,
} from './helpers.js';
import { seedRepo } from '../integration/git/helpers.js';

const MISSING_SCHEMA_HELP = readFileSync(
  fileURLToPath(new URL('../fixtures/claude-help/missing-json-schema.help.txt', import.meta.url)),
  'utf8',
);

const SINGLE_TASK_PLAN = planDraft([{ id: 'TASK-001' }]);

/** 一直跑到 Planning 成功后的某个失败点。 */
function scenarioAfterPlan(
  ...rest: readonly Record<string, unknown>[]
): Record<string, unknown> {
  return {
    version: FAKE_VERSION,
    help: COMPLETE_HELP,
    sequence: [{ stdoutLines: streamOf(SINGLE_TASK_PLAN) }, ...rest],
  };
}

describe('e2e claude failure mapping (§9.6)', () => {
  it(
    'nonzero exit fails the task and the run with CLAUDE_EXIT_NONZERO; no automatic retry',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario(
          scenarioAfterPlan({
            stderrText: 'provider failure: out of quota',
            exitCode: 3,
            stdoutLines: streamOf(executionCompleted()),
          }),
        );

        const result = await harness.start();
        expect(result.kind).toBe('failed');
        if (result.kind !== 'failed') return;
        const run = result.run;
        expect(run.lastError?.errorCode).toBe('CLAUDE_EXIT_NONZERO');
        expect(run.tasks['TASK-001']!.status).toBe('failed');
        expect(run.tasks['TASK-001']!.failure?.errorCode).toBe('CLAUDE_EXIT_NONZERO');
        expect(run.tasks['TASK-001']!.executionEpisodes[0]!.outcome).toBe('session_error');
        // 失败 Session Record：exitCode 3、无结构化结果。
        const records = await harness.listSessionRecords();
        expect(records).toHaveLength(2);
        expect(records[1]!.status).toBe('failed');
        expect(records[1]!.exitCode).toBe(3);
        expect(records[1]!.structuredResult).toBeNull();
        expect(records[1]!.error?.errorCode).toBe('CLAUDE_EXIT_NONZERO');
        // 不自动重试：只有 2 个 Session。
        const invocations = await harness.readRecords();
        expect(invocations.filter((record) => record.argv.includes('--session-id'))).toHaveLength(2);
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  it(
    'structurally invalid result fails with CLAUDE_RESULT_INVALID after the repair session also fails',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario(
          scenarioAfterPlan(
            { stdoutLines: streamOf({ ...executionCompleted(), decision: 'sometimes' }) },
            // 结果修复会话同样返回结构非法结果：耗尽接力次数后转 failed。
            { stdoutLines: streamOf({ ...executionCompleted(), decision: 'sometimes' }) },
          ),
        );

        const result = await harness.start();
        expect(result.kind).toBe('failed');
        if (result.kind !== 'failed') return;
        expect(result.run.lastError?.errorCode).toBe('CLAUDE_RESULT_INVALID');
        // planning + 执行 + 结果修复：共 3 个 Session。
        const invocations = await harness.readRecords();
        expect(invocations.filter((record) => record.argv.includes('--session-id'))).toHaveLength(3);
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  it(
    'decision=failed maps to CLAUDE_REPORTED_FAILURE with a completed session record',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario(
          scenarioAfterPlan({
            stdoutLines: streamOf({
              decision: 'failed',
              summary: '依赖的第三方接口不可用，无法完成',
              tests: [{ command: 'npm test', result: 'not_run' }],
              acceptanceEvidence: [{ criterionIndex: 0, status: 'not_satisfied', evidence: '接口不可用' }],
              changedAreas: [],
              remainingRisks: ['第三方不可用'],
              replanReason: null,
            }),
          }),
        );

        const result = await harness.start();
        expect(result.kind).toBe('failed');
        if (result.kind !== 'failed') return;
        const run = result.run;
        expect(run.lastError?.errorCode).toBe('CLAUDE_REPORTED_FAILURE');
        const task = run.tasks['TASK-001']!;
        expect(task.status).toBe('failed');
        expect(task.failure?.errorCode).toBe('CLAUDE_REPORTED_FAILURE');
        expect(task.executionEpisodes[0]!.outcome).toBe('failed');
        expect(task.executionEpisodes[0]!.error?.errorCode).toBe('CLAUDE_REPORTED_FAILURE');
        // decision=failed 是合法结果：Session Record 为 completed 且保留结果。
        const records = await harness.listSessionRecords();
        expect(records[1]!.status).toBe('completed');
        expect(records[1]!.structuredResult).toMatchObject({ decision: 'failed' });
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  it(
    'missing acceptanceEvidence blocks completion with CLAUDE_RESULT_INVALID',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario(
          scenarioAfterPlan(
            {
              writeFiles: [{ path: 'src/feature-a.ts', content: 'export const a = 1;\n' }],
              stdoutLines: streamOf(executionCompleted(1, { acceptanceEvidence: [] })),
            },
            // 结果修复会话仍然缺验收证据：耗尽接力次数后转 failed。
            { stdoutLines: streamOf(executionCompleted(1, { acceptanceEvidence: [] })) },
          ),
        );

        const result = await harness.start();
        expect(result.kind).toBe('failed');
        if (result.kind !== 'failed') return;
        expect(result.run.lastError?.errorCode).toBe('CLAUDE_RESULT_INVALID');
        expect(result.run.tasks['TASK-001']!.status).toBe('failed');
        // 两个 Episode 都以 session_error 关闭（首次 + 修复接力）。
        const episodes = result.run.tasks['TASK-001']!.executionEpisodes;
        expect(episodes).toHaveLength(2);
        expect(episodes[0]!.outcome).toBe('session_error');
        expect(episodes[1]!.outcome).toBe('session_error');
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  it(
    'not_satisfied evidence blocks a completed decision',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario(
          scenarioAfterPlan(
            {
              stdoutLines: streamOf(
                executionCompleted(1, {
                  acceptanceEvidence: [{ criterionIndex: 0, status: 'not_satisfied', evidence: '未满足' }],
                }),
              ),
            },
            // 结果修复会话仍返回 not_satisfied：耗尽接力次数后转 failed。
            {
              stdoutLines: streamOf(
                executionCompleted(1, {
                  acceptanceEvidence: [{ criterionIndex: 0, status: 'not_satisfied', evidence: '未满足' }],
                }),
              ),
            },
          ),
        );

        const result = await harness.start();
        expect(result.kind).toBe('failed');
        if (result.kind !== 'failed') return;
        expect(result.run.lastError?.errorCode).toBe('CLAUDE_RESULT_INVALID');
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  it(
    'completed with non-null replanReason is normalized to null and completes without a repair session',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario(
          scenarioAfterPlan(
            {
              writeFiles: [{ path: 'src/feature-a.ts', content: 'export const a = 1;\n' }],
              // 与现网故障同形：decision=completed 但 replanReason 非 null
              // （模型把 required 字段填成占位字符串）。
              stdoutLines: streamOf(executionCompleted(1, { replanReason: '误填的原因' })),
            },
            { stdoutLines: streamOf(finalReviewCompleted(['TASK-001'])) },
          ),
        );

        const result = await harness.start();
        expect(result.kind).toBe('completed');
        if (result.kind !== 'completed') return;
        const run = result.run;
        expect(run.status).toBe('completed');
        expect(run.tasks['TASK-001']!.status).toBe('completed');
        // 提交的业务结果已归一为 null。
        expect(run.tasks['TASK-001']!.completedResult?.replanReason).toBeNull();

        // 噪声字段不再触发结果修复接力：唯一 Episode 直接 completed。
        const episodes = run.tasks['TASK-001']!.executionEpisodes;
        expect(episodes).toHaveLength(1);
        expect(episodes[0]!.outcome).toBe('completed');

        // planning + 执行 + final review：共 3 个 Session，无修复会话。
        const invocations = await harness.readRecords();
        const sessions = invocations.filter((record) => record.argv.includes('--session-id'));
        expect(sessions).toHaveLength(3);
        expect(
          harness.outputLines.some((line) => line.includes('starting result-repair session')),
        ).toBe(false);

        // Session Record 是模型输出的不可变事实：保留原始占位值，不归一。
        const records = await harness.listSessionRecords();
        expect(records).toHaveLength(3);
        expect(records[1]!.status).toBe('completed');
        expect(records[1]!.structuredResult).toMatchObject({
          decision: 'completed',
          replanReason: '误填的原因',
        });
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  it(
    'final review reporting a failed test must not complete the run (FINAL_REVIEW_RESULT_INVALID)',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario(
          scenarioAfterPlan(
            {
              writeFiles: [{ path: 'src/feature-a.ts', content: 'export const a = 1;\n' }],
              stdoutLines: streamOf(executionCompleted()),
            },
            {
              stdoutLines: streamOf(
                finalReviewCompleted(['TASK-001'], {
                  tests: [{ command: 'npm test', result: 'failed' }],
                }),
              ),
            },
          ),
        );

        const result = await harness.start();
        expect(result.kind).toBe('failed');
        if (result.kind !== 'failed') return;
        const run = result.run;
        expect(run.lastError?.errorCode).toBe('FINAL_REVIEW_RESULT_INVALID');
        expect(run.status).toBe('failed');
        expect(run.finalReviewEpisodes[0]!.decision).toBe('session_error');
        expect(run.finalCommit).toBeNull();
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  it(
    'Session 正常返回后的 SPEC 重读失败仍完整关闭 Task 与 Episode',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario(
          scenarioAfterPlan({
            /**
             * 进程返回合法 completed 结果前删除权威 SPEC，命中“completed
             * Session Record 已写入、结束边界重读失败”的专用收尾路径。
             */
            commands: [
              {
                argv: [
                  process.execPath,
                  '-e',
                  "require('node:fs').unlinkSync('SPEC.md')",
                ],
              },
            ],
            stdoutLines: streamOf(executionCompleted()),
          }),
        );

        const result = await harness.start();

        expect(result.kind).toBe('failed');
        if (result.kind !== 'failed') return;
        const task = result.run.tasks['TASK-001']!;
        expect(task.status).toBe('failed');
        expect(task.executionEpisodes[0]!.endedAt).not.toBeNull();
        expect(task.executionEpisodes[0]!.outcome).toBe('session_error');
        expect(result.run.activeSession).toBeNull();
        expect(result.run.currentTaskId).toBeNull();
        const records = await harness.listSessionRecords();
        expect(records[1]!.status).toBe('completed');
        expect(records[1]!.structuredResult).toMatchObject({ decision: 'completed' });
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );
});

describe('e2e planning and protected-path failures (G3 invariants)', () => {
  it(
    'planning side effects fail the run with PLANNING_SIDE_EFFECT_DETECTED',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          sequence: [
            // Planning Session 违规写出项目文件。
            {
              writeFiles: [{ path: 'src/illegal.ts', content: 'export const x = 1;\n' }],
              stdoutLines: streamOf(SINGLE_TASK_PLAN),
            },
          ],
        });

        const result = await harness.start();
        expect(result.kind).toBe('failed');
        if (result.kind !== 'failed') return;
        expect(result.run.lastError?.errorCode).toBe('PLANNING_SIDE_EFFECT_DETECTED');
        expect(result.run.planRevision).toBe(0);
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  it(
    'a claude commit containing SPEC fails the run with PROTECTED_PATH_CHANGED',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario(
          scenarioAfterPlan({
            writeFiles: [{ path: 'SPEC.md', content: '# hijacked spec\n' }],
            commands: [
              { argv: ['git', 'add', 'SPEC.md'] },
              { argv: ['git', 'commit', '-m', 'claude commits SPEC'] },
            ],
            stdoutLines: streamOf(executionCompleted()),
          }),
        );

        const result = await harness.start();
        expect(result.kind).toBe('failed');
        if (result.kind !== 'failed') return;
        expect(result.run.lastError?.errorCode).toBe('PROTECTED_PATH_CHANGED');
        expect(result.run.tasks['TASK-001']!.status).toBe('failed');
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  it(
    'planning nonzero exit fails the run before any revision exists',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: COMPLETE_HELP,
          sequence: [{ stderrText: 'provider down', exitCode: 5, stdoutLines: streamOf(SINGLE_TASK_PLAN) }],
        });

        const result = await harness.start();
        expect(result.kind).toBe('failed');
        if (result.kind !== 'failed') return;
        const run = result.run;
        expect(run.lastError?.errorCode).toBe('CLAUDE_EXIT_NONZERO');
        expect(run.planRevision).toBe(0);
        expect(run.tasksSha256).toBeNull();
        expect(Object.keys(run.tasks)).toHaveLength(0);
        // tasks.json 不存在（Revision 1 未提交）。
        await expect(harness.readTasksJson()).rejects.toThrow();
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );
});

describe('e2e startup validation (§8.1)', () => {
  it(
    'dirty working tree refuses to start with WORKING_TREE_DIRTY and creates no run',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.repo.writeFile('src/dirty.ts', 'export const dirty = 1;\n');
        await harness.writeScenario({ version: FAKE_VERSION, help: COMPLETE_HELP, sequence: [] });

        const result = await harness.start();
        expect(result.kind).toBe('startup-failed');
        if (result.kind !== 'startup-failed') return;
        expect(result.error.errorCode).toBe('WORKING_TREE_DIRTY');
        // 未创建新 Run。
        await expect(harness.readRunJson()).rejects.toThrow();
        // 不自动清理工作区：脏文件仍在。
        const status = await harness.repo.git('status', '--porcelain');
        expect(status).toContain('src/dirty.ts');
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  it(
    'missing claude capability refuses to start and lists the gap',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario({
          version: FAKE_VERSION,
          help: MISSING_SCHEMA_HELP,
          sequence: [],
        });

        const result = await harness.start();
        expect(result.kind).toBe('startup-failed');
        if (result.kind !== 'startup-failed') return;
        expect(result.error.errorCode).toBe('CLAUDE_CAPABILITY_MISSING');
        await expect(harness.readRunJson()).rejects.toThrow();
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  it(
    'a non-terminal existing run refuses a new start with RUN_ALREADY_ACTIVE_OR_INTERRUPTED',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        // 第一个 start 在 Execution 中长期睡眠；第二个 start 在其期间发起。
        await harness.writeScenario(
          scenarioAfterPlan({ sleepMs: 60_000, stdoutLines: streamOf(executionCompleted()) }),
        );
        const first = harness.start();
        // 等待第一个 Run 进入 Execution（run.json 存在且非终态）。
        await waitForRunFact(
          harness,
          'execution activeSession in running',
          (run) => run.status === 'running' && run.activeSession !== null,
          { driving: first },
        );

        const second = await harness.start();
        expect(second.kind).toBe('startup-failed');
        if (second.kind === 'startup-failed') {
          expect(second.error.errorCode).toBe('RUN_ALREADY_ACTIVE_OR_INTERRUPTED');
          // 第一个 Run 的存活信号新鲜：拒绝文案明确指出属主进程仍存活。
          expect(second.error.message).toContain('still alive');
        }

        // 收尾：中断第一个 Run（有界结束为 failed）。
        harness.interrupt.request();
        const firstResult = await first;
        expect(firstResult.kind).toBe('failed');
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );
});
