/**
 * Intermediate Checkpoint (SPEC §11.3). A commit produced by a replan /
 * spec-change flow that is not a completed task result and must be explicitly
 * adopted by a pending task.
 */
import { GIT_OID_PATTERN, TASK_ID_PATTERN, UUID_PATTERN } from '../ids.js';

export type IntermediateCheckpointRole = 'task-intermediate' | 'final-review-intermediate';

export interface IntermediateCheckpoint {
  oid: string;
  role: IntermediateCheckpointRole;
  sourceSessionId: string;
  taskId: string | null;
  planRevision: number;
  summary: string;
  ownerTaskId: string | null;
}

export const intermediateCheckpointSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['oid', 'role', 'sourceSessionId', 'taskId', 'planRevision', 'summary', 'ownerTaskId'],
  properties: {
    oid: { type: 'string', pattern: GIT_OID_PATTERN.source },
    role: { enum: ['task-intermediate', 'final-review-intermediate'] },
    sourceSessionId: { type: 'string', pattern: UUID_PATTERN.source },
    taskId: { anyOf: [{ type: 'null' }, { type: 'string', pattern: TASK_ID_PATTERN.source }] },
    planRevision: { type: 'integer', minimum: 1 },
    summary: { type: 'string', minLength: 1 },
    ownerTaskId: { anyOf: [{ type: 'null' }, { type: 'string', pattern: TASK_ID_PATTERN.source }] },
  },
} as const;
