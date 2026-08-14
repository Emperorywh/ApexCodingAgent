/**
 * Plan Revision 应用层门禁：保护路径校验必须作用于合并后的完整待执行视图，
 * 不能只检查 Planner 本轮展开的完整定义。
 */
import { describe, it } from 'vitest';
import { preparePlanRevisionMerge } from '../../src/application/usecases/apply-plan-revision.js';
import type { TasksJson } from '../../src/domain/schemas/tasks-json.js';
import {
  expectApexError,
  mkDraft,
  mkRun,
  mkTask,
  mkTaskState,
  SHA256_A,
  T0,
  UUID_1,
  UUID_2,
} from '../domain/fixtures.js';

describe('preparePlanRevisionMerge 保护路径门禁', () => {
  it('拒绝 Replan 通过 retain 继续携带旧的 SPEC 自修改 Task', () => {
    const protectedTask = mkTask('TASK-001', [], {
      likelyPaths: ['docs/SPEC.md'],
    });
    const run = mkRun({
      planRevision: 1,
      tasksSha256: SHA256_A,
      tasks: { 'TASK-001': mkTaskState('TASK-001', 'pending') },
    });
    const currentTasks: TasksJson = {
      schemaVersion: 1,
      runId: run.runId,
      planRevision: 1,
      specPath: run.spec.path,
      specSha256: run.spec.sha256,
      generatedAt: T0,
      plannerSessionId: UUID_1,
      planReviewerSessionId: UUID_2,
      summary: '历史计划',
      assumptions: [],
      retainedCheckpointDispositions: [],
      tasks: [protectedTask],
    };

    /**
     * retain 本身只有 ID，若在 merge 前检查草稿就看不到旧定义；应用层必须
     * 先物化权威 pending Task，再执行保护路径断言。
     */
    expectApexError(
      () =>
        preparePlanRevisionMerge(
          run,
          currentTasks,
          mkDraft([{ id: 'TASK-001', disposition: 'retain' }]),
        ),
      'PLAN_INVALID',
    );
  });
});
