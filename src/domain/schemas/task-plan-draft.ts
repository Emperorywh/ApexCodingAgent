/**
 * TaskPlanDraft (SPEC §7.3). Returned by Planning Sessions; also the normative
 * task definition shape embedded in tasks.json and Plan Revision Snapshots.
 *
 * Semantic checks (ID uniqueness, dependency graph, revision/disposition
 * rules) live in `src/domain/plan.ts`.
 */
import { GIT_OID_PATTERN, TASK_ID_PATTERN } from '../ids.js';

export type EstimatedSize = 'small' | 'medium' | 'large';

export interface PlannedTask {
  id: string;
  title: string;
  objective: string;
  dependsOn: string[];
  acceptanceCriteria: string[];
  verificationHints: string[];
  likelyPaths: string[];
  estimatedSize: EstimatedSize;
  context: string;
}

export interface CheckpointDisposition {
  checkpointOid: string;
  ownerTaskId: string;
  rationale: string;
}

export interface TaskPlanDraft {
  summary: string;
  assumptions: string[];
  retainedCheckpointDispositions: CheckpointDisposition[];
  tasks: PlannedTask[];
}

export const plannedTaskSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'title',
    'objective',
    'dependsOn',
    'acceptanceCriteria',
    'verificationHints',
    'likelyPaths',
    'estimatedSize',
    'context',
  ],
  properties: {
    id: { type: 'string', pattern: TASK_ID_PATTERN.source },
    title: { type: 'string', minLength: 1 },
    objective: { type: 'string', minLength: 1 },
    dependsOn: {
      type: 'array',
      items: { type: 'string', pattern: TASK_ID_PATTERN.source },
      uniqueItems: true,
    },
    acceptanceCriteria: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      minItems: 1,
    },
    verificationHints: { type: 'array', items: { type: 'string', minLength: 1 } },
    likelyPaths: {
      type: 'array',
      items: { type: 'string', format: 'git-relative-path' },
    },
    estimatedSize: { enum: ['small', 'medium', 'large'] },
    context: { type: 'string', minLength: 1 },
  },
} as const;

export const checkpointDispositionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['checkpointOid', 'ownerTaskId', 'rationale'],
  properties: {
    checkpointOid: { type: 'string', pattern: GIT_OID_PATTERN.source },
    ownerTaskId: { type: 'string', pattern: TASK_ID_PATTERN.source },
    rationale: { type: 'string', minLength: 1 },
  },
} as const;

export const taskPlanDraftSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'assumptions', 'retainedCheckpointDispositions', 'tasks'],
  properties: {
    summary: { type: 'string', minLength: 1 },
    assumptions: { type: 'array', items: { type: 'string', minLength: 1 } },
    retainedCheckpointDispositions: {
      type: 'array',
      items: checkpointDispositionSchema,
    },
    tasks: { type: 'array', items: plannedTaskSchema },
  },
} as const;
