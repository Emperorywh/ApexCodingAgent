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
  | 'spec_changed'
  | 'final_review_replan'
  | 'run_resumed';

export const PLAN_REVISION_TRIGGER_TYPES: readonly PlanRevisionTriggerType[] = [
  'initial',
  'execution_replan',
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
  summary: string;
  assumptions: string[];
  retainedCheckpointDispositions: CheckpointDisposition[];
  tasks: PlannedTask[];
}

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
    trigger: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'reason', 'sourceSessionId'],
      properties: {
        type: { enum: [...PLAN_REVISION_TRIGGER_TYPES] },
        reason: { type: 'string', minLength: 1 },
        sourceSessionId: {
          anyOf: [{ type: 'null' }, { type: 'string', pattern: UUID_PATTERN.source }],
        },
      },
    },
    specPath: { type: 'string', format: 'git-relative-path' },
    specSha256: { type: 'string', format: 'sha256' },
    generatedAt: { type: 'string', format: 'rfc3339' },
    plannerSessionId: { type: 'string', pattern: UUID_PATTERN.source },
    summary: { type: 'string', minLength: 1 },
    assumptions: { type: 'array', items: { type: 'string', minLength: 1 } },
    retainedCheckpointDispositions: {
      type: 'array',
      items: checkpointDispositionSchema,
    },
    tasks: { type: 'array', items: plannedTaskSchema },
  },
} as const;
