/**
 * status 渲染回归测试（SPEC §17、Plan Revision 历史 Task 不变量）。
 *
 * 当前 tasks.json 只保存最新计划，但 run.json 会永久保留被后续 Revision
 * 省略并转为 skipped 的历史 Task；渲染必须展示同一组完整事实。
 */
import { describe, expect, it } from 'vitest';
import type { RepositoryStatusFact } from '../../../src/application/ports/GitPort.js';
import type { TasksJson } from '../../../src/domain/schemas/tasks-json.js';
import { renderStatus } from '../../../src/interfaces/cli/status-render.js';
import {
  mkRun,
  mkTask,
  mkTaskState,
  OID_B,
  RUN_ID,
  SHA256_A,
  T0,
  UUID_1,
} from '../../domain/fixtures.js';

describe('renderStatus 历史 Task 展示', () => {
  it('总数、状态计数和渲染行包含被新 Revision 移出的 skipped Task', () => {
    const run = mkRun({
      status: 'running',
      planRevision: 2,
      tasksSha256: 'c'.repeat(64),
      tasks: {
        'TASK-001': mkTaskState('TASK-001', 'skipped'),
        'TASK-002': mkTaskState('TASK-002', 'pending'),
      },
    });
    const tasks: TasksJson = {
      schemaVersion: 1,
      runId: RUN_ID,
      planRevision: 2,
      specPath: 'docs/SPEC.md',
      specSha256: SHA256_A,
      generatedAt: T0,
      plannerSessionId: UUID_1,
      summary: 'Revision 2',
      assumptions: [],
      retainedCheckpointDispositions: [],
      tasks: [mkTask('TASK-002')],
    };
    const git: RepositoryStatusFact = {
      head: { oid: OID_B, branch: run.repository.runBranch },
      statusEntries: [],
    };

    const lines = renderStatus({ run, tasks }, git);
    expect(lines).toContain('Tasks: 2 total (skipped 1, pending 1)');
    const currentTaskLine = lines.findIndex((line) => line.includes('TASK-002'));
    const historicalTaskLine = lines.findIndex((line) => line.includes('TASK-001'));
    expect(currentTaskLine).toBeGreaterThan(-1);
    expect(historicalTaskLine).toBeGreaterThan(currentTaskLine);
    expect(lines[historicalTaskLine]).toContain('skipped');
  });
});
