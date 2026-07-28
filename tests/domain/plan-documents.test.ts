/**
 * Plan Revision 三文档聚合一致性测试。
 *
 * 这些用例覆盖 Snapshot 触发来源、Revision 连续性，以及 Snapshot、
 * tasks.json、run.json 之间重复计划事实的完整一致性。
 */
import { describe, expect, it } from 'vitest';
import {
  assertPlanRevisionCommitCoherent,
  assertPlanRevisionDocumentsCoherent,
  assertPlanRevisionSnapshotRules,
} from '../../src/domain/plan-documents.js';
import type { RunJson } from '../../src/domain/schemas/run-json.js';
import {
  expectApexError,
  SHA256_A,
  UUID_1,
} from './fixtures.js';
import {
  DEFAULT_PLAN_TASKS,
  mkCommittedRun,
  mkSnapshot,
  mkTasks,
} from '../adapters/fixtures.js';

function committedRun(planRevision: number, stateRevision: number): RunJson {
  return {
    ...mkCommittedRun(planRevision, stateRevision),
    tasksSha256: SHA256_A,
  };
}

describe('Plan Revision Snapshot rules', () => {
  it('accepts initial revision 1 and a non-initial later revision', () => {
    expect(() => assertPlanRevisionSnapshotRules(mkSnapshot(1))).not.toThrow();
    expect(() => assertPlanRevisionSnapshotRules(mkSnapshot(2))).not.toThrow();
  });

  it('rejects invalid trigger provenance', () => {
    expectApexError(
      () =>
        assertPlanRevisionSnapshotRules({
          ...mkSnapshot(1),
          trigger: {
            type: 'initial',
            reason: 'initial planning',
            sourceSessionId: UUID_1,
          },
        }),
      'STATE_VALIDATION_FAILED',
    );
    expectApexError(
      () =>
        assertPlanRevisionSnapshotRules({
          ...mkSnapshot(2),
          trigger: {
            type: 'execution_replan',
            reason: 'execution requested replan',
            sourceSessionId: null,
          },
        }),
      'STATE_VALIDATION_FAILED',
    );
  });
});

describe('Plan Revision document coherence', () => {
  it('accepts documents carrying the same complete plan facts', () => {
    expect(() =>
      assertPlanRevisionDocumentsCoherent(mkSnapshot(1), mkTasks(1)),
    ).not.toThrow();
  });

  it('rejects task-definition drift even when outer identifiers match', () => {
    const changedTasks = [
      { ...DEFAULT_PLAN_TASKS[0]!, objective: 'Different objective' },
      DEFAULT_PLAN_TASKS[1]!,
    ];
    expectApexError(
      () => assertPlanRevisionDocumentsCoherent(mkSnapshot(1), mkTasks(1, changedTasks)),
      'STATE_VALIDATION_FAILED',
    );
  });

  it('requires the next contiguous revision and a stable authoritative SPEC path', () => {
    const current = committedRun(1, 2);
    expect(() =>
      assertPlanRevisionCommitCoherent(
        current,
        mkSnapshot(2),
        mkTasks(2),
        committedRun(2, 3),
      ),
    ).not.toThrow();

    expectApexError(
      () =>
        assertPlanRevisionCommitCoherent(
          current,
          mkSnapshot(3),
          mkTasks(3),
          committedRun(3, 3),
        ),
      'STATE_VALIDATION_FAILED',
    );
    expectApexError(
      () =>
        assertPlanRevisionCommitCoherent(
          current,
          mkSnapshot(2),
          mkTasks(2),
          {
            ...committedRun(2, 3),
            spec: { path: 'docs/OTHER.md', sha256: SHA256_A },
          },
        ),
      'STATE_VALIDATION_FAILED',
    );
  });
});
