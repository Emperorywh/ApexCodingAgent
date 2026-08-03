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
  mkErrorRecord,
  mkResult,
  mkRun,
  mkTask,
  mkTaskState,
  OID_B,
  RUN_ID,
  SHA256_A,
  T0,
  T1,
  UUID_1,
  UUID_2,
} from '../../domain/fixtures.js';

describe('renderStatus', () => {
  it('进度、状态计数和任务行包含被新 Revision 移出的 skipped Task', () => {
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
      planReviewerSessionId: UUID_2,
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
    expect(lines).toContain('→ 执行中 · RUN-123e4567-e89b-42d3-a456-426614174000');
    expect(lines).toContain('◆ 任务进度');
    expect(lines).toContain('  ░░░░░░░░░░░░░░░░░░░░░░░░  0/2 · 0%');
    expect(lines).toContain('  待处理 1 · 已跳过 1');
    expect(lines).toContain('◆ 任务 · 2');

    /**
     * 当前计划仍先于历史任务；历史任务没有当前标题，但跳过原因必须保留，
     * 从而让计划修订后的完整任务事实仍然可审计。
     */
    const currentTaskLine = lines.findIndex((line) => line.includes('TASK-002'));
    const historicalTaskLine = lines.findIndex((line) => line.includes('TASK-001'));
    expect(currentTaskLine).toBeGreaterThan(-1);
    expect(historicalTaskLine).toBeGreaterThan(currentTaskLine);
    expect(lines[currentTaskLine]).toBe('  ◇ TASK-002  Title TASK-002');
    expect(lines[historicalTaskLine]).toBe(
      '  ⊘ TASK-001 · Omitted by plan revision 2',
    );
  });

  it('失败状态优先展示诊断与恢复入口，并压缩正常 Git HEAD 的重复分支', () => {
    const interrupted = mkErrorRecord({
      errorCode: 'RUN_INTERRUPTED',
      errorClass: 'run_error',
      stage: 'execution',
      message: 'foreground interrupt requested',
    });
    const run = mkRun({
      status: 'failed',
      planRevision: 1,
      terminalAt: T1,
      updatedAt: T1,
      tasks: {
        'TASK-001': mkTaskState('TASK-001', 'completed'),
        'TASK-002': mkTaskState('TASK-002', 'failed', { failure: interrupted }),
        'TASK-003': mkTaskState('TASK-003', 'pending'),
      },
      lastError: interrupted,
      resumePoint: {
        fromStatus: 'running',
        taskId: 'TASK-002',
        sessionId: UUID_1,
        sessionType: 'execution',
      },
    });
    const tasks: TasksJson = {
      schemaVersion: 1,
      runId: RUN_ID,
      planRevision: 1,
      specPath: 'docs/SPEC.md',
      specSha256: SHA256_A,
      generatedAt: T0,
      plannerSessionId: UUID_1,
      planReviewerSessionId: UUID_2,
      summary: 'Initial plan',
      assumptions: [],
      retainedCheckpointDispositions: [],
      tasks: [mkTask('TASK-001'), mkTask('TASK-002'), mkTask('TASK-003')],
    };
    const git: RepositoryStatusFact = {
      head: { oid: OID_B, branch: run.repository.runBranch },
      statusEntries: [],
    };

    const lines = renderStatus({ run, tasks }, git);
    expect(lines).toContain(`✗ 运行失败 · ${RUN_ID}`);
    expect(lines).toContain('! 最近错误 · RUN_INTERRUPTED · execution');
    expect(lines).toContain('  → 恢复运行  ApexCodingAgent resume');
    expect(lines).toContain('  已完成 1 · 失败 1 · 待处理 1');
    expect(lines).toContain(`  HEAD      ${OID_B.slice(0, 12)}`);
    expect(lines).not.toContain(
      `  HEAD      ${OID_B.slice(0, 12)} · ${run.repository.runBranch}`,
    );
  });

  it('Execution 候选落盘后明确展示待独立复核，而不是已完成', () => {
    const run = mkRun({
      status: 'running',
      planRevision: 1,
      currentTaskId: 'TASK-001',
      tasks: {
        'TASK-001': mkTaskState('TASK-001', 'running', {
          candidateResult: mkResult(),
          candidateCheckpoint: OID_B,
        }),
      },
    });
    const tasks: TasksJson = {
      schemaVersion: 1,
      runId: RUN_ID,
      planRevision: 1,
      specPath: 'docs/SPEC.md',
      specSha256: SHA256_A,
      generatedAt: T0,
      plannerSessionId: UUID_1,
      planReviewerSessionId: UUID_2,
      summary: 'Initial plan',
      assumptions: [],
      retainedCheckpointDispositions: [],
      tasks: [mkTask('TASK-001')],
    };
    const git: RepositoryStatusFact = {
      head: { oid: OID_B, branch: run.repository.runBranch },
      statusEntries: [],
    };

    const lines = renderStatus({ run, tasks }, git);
    expect(lines).toContain(`  → TASK-001  Title TASK-001 · 待独立复核 ${OID_B.slice(0, 12)}`);
    expect(lines).not.toContain('  ✓ TASK-001');
  });
});
