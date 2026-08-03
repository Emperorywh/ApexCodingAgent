/**
 * Plan Revision Snapshot (SPEC §11.6). Immutable per-revision history under
 * `plans/<plan-revision>.json`.
 */
import { RUN_ID_PATTERN, UUID_PATTERN } from '../ids.js';
import {
  checkpointDispositionSchema,
  plannedTaskSchema,
  type CheckpointDisposition,
  type PlannedTask,
} from './task-plan-draft.js';

export type PlanRevisionTriggerType =
  | 'initial'
  | 'execution_replan'
  | 'task_review_replan'
  | 'spec_changed'
  | 'final_review_replan'
  | 'run_resumed';

export const PLAN_REVISION_TRIGGER_TYPES: readonly PlanRevisionTriggerType[] = [
  'initial',
  'execution_replan',
  'task_review_replan',
  'spec_changed',
  'final_review_replan',
  'run_resumed',
];

export interface PlanRevisionTrigger {
  type: PlanRevisionTriggerType;
  reason: string;
  sourceSessionId: string | null;
}

export interface PlanRevisionSnapshot {
  schemaVersion: 1;
  runId: string;
  planRevision: number;
  parentPlanRevision: number | null;
  trigger: PlanRevisionTrigger;
  specPath: string;
  specSha256: string;
  generatedAt: string;
  plannerSessionId: string;
  planReviewerSessionId: string;
  summary: string;
  assumptions: string[];
  retainedCheckpointDispositions: CheckpointDisposition[];
  tasks: PlannedTask[];
}

/**
 * Revision 触发事实被计划候选与最终快照共同复用。
 *
 * 统一 Schema 可以保证 Reviewer 批准的候选在提交前后保留同一触发来源，
 * 避免 Plan Review 中断恢复时由应用层重新猜测 trigger。
 */
export const planRevisionTriggerSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'reason', 'sourceSessionId'],
  properties: {
    type: { type: 'string', enum: [...PLAN_REVISION_TRIGGER_TYPES] },
    reason: { type: 'string', minLength: 1 },
    sourceSessionId: {
      anyOf: [{ type: 'null' }, { type: 'string', pattern: UUID_PATTERN.source }],
    },
  },
} as const;

/**
 * 计划快照复用已经类型化的计划子结构，避免重复计划字段。
 *
 * 触发事实与模型计划由同一持久化边界组合，避免独立 Schema 发生漂移。
 */
export const planRevisionSnapshotSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'runId',
    'planRevision',
    'parentPlanRevision',
    'trigger',
    'specPath',
    'specSha256',
    'generatedAt',
    'plannerSessionId',
    'planReviewerSessionId',
    'summary',
    'assumptions',
    'retainedCheckpointDispositions',
    'tasks',
  ],
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    runId: { type: 'string', pattern: RUN_ID_PATTERN.source },
    planRevision: { type: 'integer', minimum: 1 },
    parentPlanRevision: { anyOf: [{ type: 'null' }, { type: 'integer', minimum: 1 }] },
    trigger: planRevisionTriggerSchema,
    specPath: { type: 'string', format: 'git-relative-path' },
    specSha256: { type: 'string', format: 'sha256' },
    generatedAt: { type: 'string', format: 'rfc3339' },
    plannerSessionId: { type: 'string', pattern: UUID_PATTERN.source },
    planReviewerSessionId: { type: 'string', pattern: UUID_PATTERN.source },
    summary: { type: 'string', minLength: 1 },
    assumptions: { type: 'array', items: { type: 'string', minLength: 1 } },
    retainedCheckpointDispositions: {
      type: 'array',
      items: checkpointDispositionSchema,
    },
    tasks: { type: 'array', items: plannedTaskSchema },
  },
} as const;
