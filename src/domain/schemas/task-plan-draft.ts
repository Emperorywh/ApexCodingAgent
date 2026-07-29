/**
 * TaskPlanDraft (SPEC §7.3). Returned by Planning Sessions; also the normative
 * task definition shape embedded in tasks.json and Plan Revision Snapshots.
 *
 * Semantic checks (ID uniqueness, dependency graph, revision/disposition
 * rules) live in `src/domain/plan.ts`.
 */
import { GIT_OID_PATTERN, TASK_ID_PATTERN } from '../ids.js';
import type { JSONSchemaType } from 'ajv';

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

/**
 * Schema 对象同时接受 Ajv 的编译期契约检查与运行时严格校验。
 *
 * 字段类型一旦偏离领域接口，TypeScript 会在构建阶段直接报告，而不是等到持久化时才暴露。
 */
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
    estimatedSize: { type: 'string', enum: ['small', 'medium', 'large'] },
    context: { type: 'string', minLength: 1 },
  },
} as const satisfies JSONSchemaType<PlannedTask>;

export const checkpointDispositionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['checkpointOid', 'ownerTaskId', 'rationale'],
  properties: {
    checkpointOid: { type: 'string', pattern: GIT_OID_PATTERN.source },
    ownerTaskId: { type: 'string', pattern: TASK_ID_PATTERN.source },
    rationale: { type: 'string', minLength: 1 },
  },
} as const satisfies JSONSchemaType<CheckpointDisposition>;

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
} as const satisfies JSONSchemaType<TaskPlanDraft>;
