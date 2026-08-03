/**
 * Plan Revision 持久化文档的一致性规则。
 *
 * Snapshot、tasks.json 与 run.json 会重复保存同一批计划事实。这里把
 * 三者的字段一致性、Revision 连续性和触发来源规则集中到 Domain，
 * StateStore 只负责按既定顺序提交已经通过校验的聚合。
 */
import { ApexError } from './errors.js';
import { plannedTaskEquals } from './plan.js';
import type { PlanRevisionSnapshot } from './schemas/plan-revision-snapshot.js';
import type { RunJson } from './schemas/run-json.js';
import type { CheckpointDisposition } from './schemas/task-plan-draft.js';
import type { TasksJson } from './schemas/tasks-json.js';

function violation(message: string): ApexError {
  return new ApexError({
    code: 'STATE_VALIDATION_FAILED',
    stage: 'state',
    message,
  });
}

function assertCondition(condition: boolean, message: string): void {
  if (!condition) throw violation(message);
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function dispositionsEqual(
  left: readonly CheckpointDisposition[],
  right: readonly CheckpointDisposition[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        value.checkpointOid === other.checkpointOid &&
        value.ownerTaskId === other.ownerTaskId &&
        value.rationale === other.rationale
      );
    })
  );
}

/**
 * 校验单个不可变 Snapshot 的 Revision 与触发来源条件。
 */
export function assertPlanRevisionSnapshotRules(snapshot: PlanRevisionSnapshot): void {
  assertCondition(
    snapshot.plannerSessionId !== snapshot.planReviewerSessionId,
    'planner and plan reviewer must use different sessions',
  );
  if (snapshot.planRevision === 1) {
    assertCondition(
      snapshot.parentPlanRevision === null,
      'plan revision 1 requires parentPlanRevision null',
    );
    assertCondition(
      snapshot.trigger.type === 'initial',
      'plan revision 1 requires trigger type initial',
    );
  } else {
    assertCondition(
      snapshot.parentPlanRevision === snapshot.planRevision - 1,
      `plan revision ${snapshot.planRevision} requires parentPlanRevision ${snapshot.planRevision - 1}`,
    );
    assertCondition(
      snapshot.trigger.type !== 'initial',
      `plan revision ${snapshot.planRevision} must not use trigger type initial`,
    );
  }

  if (snapshot.trigger.type === 'initial') {
    assertCondition(
      snapshot.trigger.sourceSessionId === null,
      'initial plan revision requires sourceSessionId null',
    );
  }
  if (
    snapshot.trigger.type === 'execution_replan' ||
    snapshot.trigger.type === 'final_review_replan'
  ) {
    assertCondition(
      snapshot.trigger.sourceSessionId !== null,
      `${snapshot.trigger.type} requires a sourceSessionId`,
    );
  }
}

/**
 * 校验 Snapshot 与 tasks.json 中全部重复事实逐字段一致。
 */
export function assertPlanRevisionDocumentsCoherent(
  snapshot: PlanRevisionSnapshot,
  tasks: TasksJson,
): void {
  assertPlanRevisionSnapshotRules(snapshot);
  assertCondition(snapshot.schemaVersion === tasks.schemaVersion, 'plan schemaVersion mismatch');
  assertCondition(snapshot.runId === tasks.runId, 'plan runId mismatch');
  assertCondition(snapshot.planRevision === tasks.planRevision, 'plan revision mismatch');
  assertCondition(snapshot.specPath === tasks.specPath, 'plan specPath mismatch');
  assertCondition(snapshot.specSha256 === tasks.specSha256, 'plan specSha256 mismatch');
  assertCondition(snapshot.generatedAt === tasks.generatedAt, 'plan generatedAt mismatch');
  assertCondition(
    snapshot.plannerSessionId === tasks.plannerSessionId,
    'plan plannerSessionId mismatch',
  );
  assertCondition(
    snapshot.planReviewerSessionId === tasks.planReviewerSessionId,
    'plan planReviewerSessionId mismatch',
  );
  assertCondition(snapshot.summary === tasks.summary, 'plan summary mismatch');
  assertCondition(
    stringArraysEqual(snapshot.assumptions, tasks.assumptions),
    'plan assumptions mismatch',
  );
  assertCondition(
    dispositionsEqual(
      snapshot.retainedCheckpointDispositions,
      tasks.retainedCheckpointDispositions,
    ),
    'plan retainedCheckpointDispositions mismatch',
  );
  assertCondition(
    snapshot.tasks.length === tasks.tasks.length &&
      snapshot.tasks.every((task, index) => {
        const current = tasks.tasks[index];
        return current !== undefined && plannedTaskEquals(task, current);
      }),
    'plan task definitions mismatch',
  );
}

/**
 * 校验一次 Plan Revision 提交相对当前 Run 连续且三份文档一致。
 */
export function assertPlanRevisionCommitCoherent(
  currentRun: RunJson,
  snapshot: PlanRevisionSnapshot,
  tasks: TasksJson,
  candidateRun: RunJson,
): void {
  assertPlanRevisionDocumentsCoherent(snapshot, tasks);
  const expectedRevision = currentRun.planRevision + 1;
  assertCondition(
    snapshot.planRevision === expectedRevision,
    `next plan revision must be ${expectedRevision}, got ${snapshot.planRevision}`,
  );
  assertCondition(
    snapshot.parentPlanRevision ===
      (currentRun.planRevision === 0 ? null : currentRun.planRevision),
    `plan revision ${snapshot.planRevision} has the wrong parent revision`,
  );
  assertCondition(currentRun.runId === candidateRun.runId, 'plan commit changed runId');
  assertCondition(tasks.runId === candidateRun.runId, 'plan documents and run.json runId mismatch');
  assertCondition(
    tasks.planRevision === candidateRun.planRevision,
    'tasks.json and run.json planRevision mismatch',
  );
  assertCondition(
    currentRun.spec.path === candidateRun.spec.path,
    'plan commit changed the authoritative SPEC path',
  );
  assertCondition(tasks.specPath === candidateRun.spec.path, 'plan documents specPath mismatch');
  assertCondition(
    tasks.specSha256 === candidateRun.spec.sha256,
    'plan documents specSha256 mismatch',
  );
}
