/**
 * E2E：归档（G5 测试清单 + §4.4）。
 *
 * - 终态 Run 后新 start：history/<run-id>/ 自包含（含 Sessions 与 Logs）、
 *   Manifest 逐文件校验、settings.json 保留、根级状态清理。
 * - 幂等重归档：Manifest 与当前终态 Run 完全匹配时视为成功。
 * - Manifest 不匹配 → ARCHIVE_CONFLICT，且不暴露半个新 Run。
 */
import { describe, expect, it } from 'vitest';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
import type { RunArchiveManifest } from '../../src/domain/schemas/run-archive-manifest.js';
import type { RunJson } from '../../src/domain/schemas/run-json.js';

function oneTaskSequence(): Parameters<E2EHarness['writeScenario']>[0] {
  return {
    version: FAKE_VERSION,
    help: COMPLETE_HELP,
    sequence: [
      { stdoutLines: streamOf(planDraft([{ id: 'TASK-001' }])) },
      {
        writeFiles: [{ path: 'src/feature-a.ts', content: 'export const a = 1;\n' }],
        stdoutLines: streamOf(executionCompleted()),
      },
      { stdoutLines: streamOf(finalReviewCompleted(['TASK-001'])) },
    ],
  };
}

async function readManifest(harness: E2EHarness, runId: string): Promise<RunArchiveManifest> {
  return JSON.parse(
    await readFile(join(harness.stateDir, 'history', runId, 'archive-manifest.json'), 'utf8'),
  ) as RunArchiveManifest;
}

/**
 * 把已发布归档恢复到根级状态，模拟“发布成功后、根级清理完成前”中断。
 * 多个幂等/冲突用例共享同一事实准备逻辑，避免复制归档目录清单。
 */
async function restoreArchivedRun(harness: E2EHarness, runId: string): Promise<void> {
  const { cp } = await import('node:fs/promises');
  const archiveDir = join(harness.stateDir, 'history', runId);
  for (const name of ['run.json', 'tasks.json', 'plans', 'sessions', 'logs', 'report.md']) {
    await cp(join(archiveDir, name), join(harness.stateDir, name), { recursive: true });
  }
}

describe('e2e archive on next start (§4.4)', () => {
  it(
    'terminal run is archived self-contained into history/<run-id>/ before the new run; settings.json is kept',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);

        // ---- Run 1：完成 ----
        await harness.writeScenario(oneTaskSequence());
        const first = await harness.start();
        expect(first.kind).toBe('completed');
        if (first.kind !== 'completed') return;
        const run1 = first.run;

        // settings.json 在归档后必须保留（§4.4）。
        await writeFile(
          join(harness.stateDir, 'settings.json'),
          JSON.stringify({ schemaVersion: 1, executionPermissionMode: 'auto', claudeCliPath: null, gitCliPath: null }),
          'utf8',
        );

        // ---- Run 2：触发归档后完成 ----
        await harness.writeScenario(oneTaskSequence());
        const second = await harness.start();
        expect(second.kind).toBe('completed');
        if (second.kind !== 'completed') return;
        const run2 = second.run;
        expect(run2.runId).not.toBe(run1.runId);

        // ---- history/<run1>/ 自包含 ----
        const archiveDir = join(harness.stateDir, 'history', run1.runId);
        const archivedRun = JSON.parse(
          await readFile(join(archiveDir, 'run.json'), 'utf8'),
        ) as RunJson;
        expect(archivedRun.runId).toBe(run1.runId);
        expect(archivedRun.status).toBe('completed');
        expect(archivedRun.terminalAt).toBe(run1.terminalAt);

        const archivedTasks = JSON.parse(await readFile(join(archiveDir, 'tasks.json'), 'utf8'));
        expect(archivedTasks.runId).toBe(run1.runId);
        expect((await stat(join(archiveDir, 'plans', '1.json'))).isFile()).toBe(true);
        const archivedSessions = await readdir(join(archiveDir, 'sessions'));
        expect(archivedSessions.filter((name) => name.endsWith('.json'))).toHaveLength(3);
        const archivedLogs = await readdir(join(archiveDir, 'logs'));
        expect(archivedLogs.filter((name) => name.endsWith('.log'))).toHaveLength(3);
        const report = await readFile(join(archiveDir, 'report.md'), 'utf8');
        expect(report).toContain(run1.runId);

        // ---- Manifest 逐文件校验：唯一、排序、字节长度与 SHA-256 ----
        const manifest = await readManifest(harness, run1.runId);
        expect(manifest.schemaVersion).toBe(1);
        expect(manifest.runId).toBe(run1.runId);
        expect(manifest.runStatus).toBe('completed');
        const paths = manifest.files.map((file) => file.path);
        expect(new Set(paths).size).toBe(paths.length);
        expect(paths).toEqual([...paths].sort());
        expect(paths).not.toContain('archive-manifest.json');
        for (const path of paths) {
          expect(path.startsWith('..')).toBe(false);
          expect(path.includes('\\')).toBe(false);
        }
        expect(paths).toContain('run.json');
        expect(paths).toContain('tasks.json');
        expect(paths).toContain('report.md');
        expect(paths).toContain('plans/1.json');
        for (const file of manifest.files) {
          const bytes = await readFile(join(archiveDir, file.path));
          expect(bytes.length).toBe(file.byteLength);
          expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
        }

        // ---- 根级状态只属于 Run 2；settings.json 保留 ----
        const rootRun = await harness.readRunJson();
        expect(rootRun.runId).toBe(run2.runId);
        expect((await stat(join(harness.stateDir, 'settings.json'))).isFile()).toBe(true);
        const rootSessions = await readdir(join(harness.stateDir, 'sessions'));
        expect(rootSessions.filter((name) => name.endsWith('.json'))).toHaveLength(3);
        // Run 2 的 Base 是旧 Run Branch（工作区停留在其上，§8.3）。
        expect(rootRun.repository.baseBranch).toBe(run1.repository.runBranch);
      } finally {
        await harness.cleanup();
      }
    },
    240_000,
  );

  it(
    're-archiving with a fully matching manifest is an idempotent success',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario(oneTaskSequence());
        const first = await harness.start();
        expect(first.kind).toBe('completed');
        if (first.kind !== 'completed') return;
        const run1 = first.run;

        // 第一次归档（直接调用归档器，随后把归档内容还原到根级，模拟
        // “发布成功但清理/新 Run 创建前中断”的幂等场景）。
        const deps = harness.makeBoundDeps();
        await deps.archiver.archiveTerminalRun(run1);
        await restoreArchivedRun(harness, run1.runId);

        // 幂等重归档：Manifest 完全匹配 → 成功且完成清理。
        const manifestBefore = await readManifest(harness, run1.runId);
        await deps.archiver.archiveTerminalRun(run1);
        const manifestAfter = await readManifest(harness, run1.runId);
        expect(manifestAfter.files).toEqual(manifestBefore.files);
        await expect(stat(join(harness.stateDir, 'run.json'))).rejects.toThrow();
      } finally {
        await harness.cleanup();
      }
    },
    240_000,
  );

  it(
    '已存在归档的文件与 Manifest 不一致时拒绝幂等成功',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario(oneTaskSequence());
        const first = await harness.start();
        expect(first.kind).toBe('completed');
        if (first.kind !== 'completed') return;

        const deps = harness.makeBoundDeps();
        await deps.archiver.archiveTerminalRun(first.run);
        await restoreArchivedRun(harness, first.run.runId);

        /**
         * Manifest 文本仍与根级事实一致，但归档本体缺少 tasks.json。
         * 重归档必须识别历史目录已损坏，不能清理仍完整的根级事实。
         */
        await rm(join(harness.stateDir, 'history', first.run.runId, 'tasks.json'));
        await expect(
          deps.archiver.archiveTerminalRun(first.run),
        ).rejects.toMatchObject({ errorCode: 'ARCHIVE_CONFLICT' });
        expect((await harness.readRunJson()).runId).toBe(first.run.runId);
        expect((await stat(join(harness.stateDir, 'tasks.json'))).isFile()).toBe(true);
      } finally {
        await harness.cleanup();
      }
    },
    240_000,
  );

  it(
    'manifest mismatch fails with ARCHIVE_CONFLICT and leaves no half-created new run',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario(oneTaskSequence());
        const first = await harness.start();
        expect(first.kind).toBe('completed');
        if (first.kind !== 'completed') return;
        const run1 = first.run;

        // 预置一个与当前终态 Run 不匹配的 history/<run-id>/。
        const archiveDir = join(harness.stateDir, 'history', run1.runId);
        const { mkdir } = await import('node:fs/promises');
        await mkdir(archiveDir, { recursive: true });
        await writeFile(
          join(archiveDir, 'archive-manifest.json'),
          JSON.stringify({
            schemaVersion: 1,
            runId: run1.runId,
            runStatus: 'completed',
            archivedAt: run1.terminalAt,
            files: [],
          }),
          'utf8',
        );

        // 新 start 必须以 ARCHIVE_CONFLICT 拒绝，且不暴露半个新 Run。
        const second = await harness.start();
        expect(second.kind).toBe('startup-failed');
        if (second.kind !== 'startup-failed') return;
        expect(second.error.errorCode).toBe('ARCHIVE_CONFLICT');
        const rootRun = await harness.readRunJson();
        expect(rootRun.runId).toBe(run1.runId);
        expect(rootRun.status).toBe('completed');
        // 工作区分支未被改动（仍是 Run 1 的 Run Branch）。
        const branch = await harness.repo.git('branch', '--show-current');
        expect(branch).toBe(run1.repository.runBranch);
      } finally {
        await harness.cleanup();
      }
    },
    240_000,
  );

  it(
    'planRevision 大于零但 tasks.json 缺失时拒绝归档且不清理源 Run',
    async () => {
      const harness = await createE2EHarness();
      try {
        await seedRepo(harness.repo);
        await harness.writeScenario(oneTaskSequence());
        const first = await harness.start();
        expect(first.kind).toBe('completed');
        if (first.kind !== 'completed') return;

        await rm(join(harness.stateDir, 'tasks.json'));
        const second = await harness.start();

        expect(second.kind).toBe('startup-failed');
        if (second.kind !== 'startup-failed') return;
        expect(second.error.errorCode).toBe('ARCHIVE_FAILED');
        const rootRun = await harness.readRunJson();
        expect(rootRun.runId).toBe(first.run.runId);
        expect(rootRun.status).toBe('completed');
        await expect(
          stat(join(harness.stateDir, 'history', first.run.runId)),
        ).rejects.toThrow();
      } finally {
        await harness.cleanup();
      }
    },
    240_000,
  );
});
