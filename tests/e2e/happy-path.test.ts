/**
 * E2E Happy Path（G5 测试清单）：planning → 2 个 Task（含依赖序）→
 * final review → report.md → Run completed。逐字段断言
 * run.json / tasks.json / plans / sessions / report，以及 Git Checkpoint
 * 事实与权限模式参数（auto 与 bypassPermissions）。
 */
import { describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  COMPLETE_HELP,
  createE2EHarness,
  executionCompleted,
  FAKE_VERSION,
  finalReviewCompleted,
  planDraft,
  streamOf,
  type E2EHarness,
} from './helpers.js';
import { seedRepo } from '../integration/git/helpers.js';

const TWO_TASK_PLAN = planDraft([
  { id: 'TASK-001', title: '实现功能 A' },
  { id: 'TASK-002', title: '实现功能 B', dependsOn: ['TASK-001'] },
]);

function happySequence(): Parameters<E2EHarness['writeScenario']>[0] {
  return {
    version: FAKE_VERSION,
    help: COMPLETE_HELP,
    sequence: [
      { stdoutLines: streamOf(TWO_TASK_PLAN) },
      {
        writeFiles: [{ path: 'src/feature-a.ts', content: 'export const a = 1;\n' }],
        stdoutLines: streamOf(executionCompleted()),
      },
      {
        writeFiles: [{ path: 'src/feature-b.ts', content: 'export const b = 2;\n' }],
        stdoutLines: streamOf(executionCompleted()),
      },
      { stdoutLines: streamOf(finalReviewCompleted(['TASK-001', 'TASK-002'])) },
    ],
  };
}

describe('e2e happy path', () => {
  it(
    'planning -> 2 tasks -> final review -> report -> completed',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario(happySequence());

        const result = await harness.start();
        expect(result.kind).toBe('completed');
        if (result.kind !== 'completed') return;
        const run = result.run;

        // ---- run.json 逐字段 ----
        expect(run.status).toBe('completed');
        expect(run.planRevision).toBe(1);
        expect(run.tasksSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(run.currentTaskId).toBeNull();
        expect(run.activeSession).toBeNull();
        expect(run.finalCommit).toMatch(/^[0-9a-f]{40}$/);
        expect(run.reportPath).toBe('report.md');
        expect(run.terminalAt).not.toBeNull();
        expect(run.lastError).toBeNull();
        expect(run.runSettings.executionPermissionMode).toBe('auto');
        expect(run.repository.runBranch).toBe(`apex-coding-agent/${run.runId}`);
        expect(Object.keys(run.tasks).sort()).toEqual(['TASK-001', 'TASK-002']);
        for (const taskId of ['TASK-001', 'TASK-002']) {
          const state = run.tasks[taskId]!;
          expect(state.status).toBe('completed');
          expect(state.completedResult?.decision).toBe('completed');
          expect(state.finalCheckpoint).toMatch(/^[0-9a-f]{40}$/);
          expect(state.executionEpisodes).toHaveLength(1);
          expect(state.executionEpisodes[0]!.outcome).toBe('completed');
          expect(state.executionEpisodes[0]!.finalCheckpoint).toBe(state.finalCheckpoint);
        }
        expect(run.finalReviewEpisodes).toHaveLength(1);
        expect(run.finalReviewEpisodes[0]!.decision).toBe('completed');
        expect(run.finalReviewEpisodes[0]!.checkpointRole).toBe('final-review-final');
        expect(run.finalReviewEpisodes[0]!.checkpoint).toBe(run.finalCommit);

        // ---- tasks.json / plans ----
        const tasks = await harness.readTasksJson();
        expect(tasks.planRevision).toBe(1);
        expect(tasks.runId).toBe(run.runId);
        expect(tasks.tasks.map((task) => task.id)).toEqual(['TASK-001', 'TASK-002']);
        const snapshot = await harness.readPlanSnapshot(1);
        expect(snapshot.trigger).toEqual({ type: 'initial', reason: '初始计划', sourceSessionId: null });
        expect(snapshot.parentPlanRevision).toBeNull();

        // ---- sessions：4 个 completed Record，退出码 0 ----
        const records = await harness.listSessionRecords();
        expect(records).toHaveLength(4);
        expect(records.map((record) => record.type)).toEqual([
          'planning',
          'execution',
          'execution',
          'final_review',
        ]);
        for (const record of records) {
          expect(record.status).toBe('completed');
          expect(record.exitCode).toBe(0);
          expect(record.structuredResult).not.toBeNull();
          expect(record.claude.version).toBe(FAKE_VERSION);
        }
        expect(records[1]!.taskId).toBe('TASK-001');
        expect(records[2]!.taskId).toBe('TASK-002');
        expect(tasks.plannerSessionId).toBe(records[0]!.sessionId);

        // ---- report.md ----
        const report = await harness.readReport();
        expect(report).toContain(run.runId);
        expect(report).toContain('TASK-001');
        expect(report).toContain('TASK-002');
        expect(report).toContain(run.finalCommit!);
        expect(report).toContain(run.repository.runBranch);

        // ---- Git 事实：Run Branch 为当前分支，Checkpoint Commit 含 Trailer ----
        const branch = await harness.repo.git('branch', '--show-current');
        expect(branch).toBe(run.repository.runBranch);
        const messages = await harness.repo.git('log', '--format=%s', 'main..HEAD');
        expect(messages).toContain('apex-coding-agent(TASK-001): 实现功能 A');
        expect(messages).toContain('apex-coding-agent(TASK-002): 实现功能 B');
        const trailers = await harness.repo.git('log', '--format=%(trailers)', '-1');
        expect(trailers).toContain(`ApexCodingAgent-Run: ${run.runId}`);
        expect(trailers).toContain('ApexCodingAgent-Task: TASK-002');
        expect(trailers).toContain('ApexCodingAgent-Plan-Revision: 1');
        // 工作区干净（SPEC 与状态目录未入库）。
        const status = await harness.repo.git('status', '--porcelain');
        expect(status).toBe('');
        const tracked = await harness.repo.git('ls-files');
        expect(tracked).not.toContain('.apex-coding-agent');

        // ---- 进度摘要行 ----
        expect(harness.outputLines.some((line) => line.includes('planning -> running'))).toBe(true);
        expect(harness.outputLines.some((line) => line.includes('TASK-001 -> completed'))).toBe(true);
        expect(harness.outputLines.some((line) => line.includes('running -> final_review'))).toBe(true);
        expect(harness.outputLines.some((line) => line.includes('final_review -> completed'))).toBe(true);

        // ---- 参数数组：planning=plan，execution/final_review=auto ----
        const invocations = await harness.readRecords();
        const sessions = invocations.filter((record) => record.argv.includes('--session-id'));
        expect(sessions).toHaveLength(4);
        const permissionOf = (record: (typeof sessions)[number]) =>
          record.argv[record.argv.indexOf('--permission-mode') + 1];
        expect(permissionOf(sessions[0]!)).toBe('plan');
        expect(permissionOf(sessions[1]!)).toBe('auto');
        expect(permissionOf(sessions[2]!)).toBe('auto');
        expect(permissionOf(sessions[3]!)).toBe('auto');
        for (const record of sessions) {
          expect(record.cwd).toBe(harness.repo.root);
          expect(record.argv[0]).toBe('-p');
          expect(record.argv).toContain('--output-format');
          expect(record.argv).toContain('stream-json');
          expect(record.argv).toContain('--json-schema');
          // §9.3：默认不得传限制型参数。
          expect(record.argv.join(' ')).not.toContain('--strict-mcp-config');
          expect(record.argv.join(' ')).not.toContain('--tools');
        }
      } finally {
        await harness.cleanup();
      }
    },
    120_000,
  );

  it(
    '--full-access uses bypassPermissions for execution/final review and shows the risk notice',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario(happySequence());

        const result = await harness.start({ fullAccess: true });
        expect(result.kind).toBe('completed');
        if (result.kind !== 'completed') return;
        expect(result.run.runSettings.executionPermissionMode).toBe('bypassPermissions');

        // §16：bypassPermissions 必须显示风险提示；Planning 恒 plan。
        expect(harness.outputLines.some((line) => line.includes('bypassPermissions'))).toBe(true);
        const invocations = await harness.readRecords();
        const sessions = invocations.filter((record) => record.argv.includes('--session-id'));
        const permissionOf = (record: (typeof sessions)[number]) =>
          record.argv[record.argv.indexOf('--permission-mode') + 1];
        expect(permissionOf(sessions[0]!)).toBe('plan');
        expect(permissionOf(sessions[1]!)).toBe('bypassPermissions');
        expect(permissionOf(sessions[2]!)).toBe('bypassPermissions');
        expect(permissionOf(sessions[3]!)).toBe('bypassPermissions');
      } finally {
        await harness.cleanup();
      }
    },
    120_000,
  );

  it(
    'settings.json 不能代替本次命令的 --full-access 显式授权',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await mkdir(harness.stateDir, { recursive: true });
        await writeFile(
          join(harness.stateDir, 'settings.json'),
          JSON.stringify({
            schemaVersion: 1,
            executionPermissionMode: 'bypassPermissions',
            claudeCliPath: null,
            gitCliPath: null,
          }),
          'utf8',
        );

        const result = await harness.start();

        expect(result.kind).toBe('startup-failed');
        if (result.kind !== 'startup-failed') return;
        expect(result.error.errorCode).toBe('SETTINGS_INVALID');
        expect(result.error.message).toContain('--full-access');
        await expect(harness.readRunJson()).rejects.toThrow();
      } finally {
        await harness.cleanup();
      }
    },
    120_000,
  );
});
