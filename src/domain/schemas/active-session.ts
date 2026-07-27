/**
 * Active Session (SPEC §11.3). The `activeSession` handoff slot inside
 * run.json — a fact record, not a process liveness probe.
 */
import { TASK_ID_PATTERN, UUID_PATTERN } from '../ids.js';

export type SessionType = 'planning' | 'execution' | 'final_review';

export interface ActiveSession {
  sessionId: string;
  type: SessionType;
  taskId: string | null;
  planRevision: number;
  specSha256: string;
  startedAt: string;
}

export const activeSessionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['sessionId', 'type', 'taskId', 'planRevision', 'specSha256', 'startedAt'],
  properties: {
    sessionId: { type: 'string', pattern: UUID_PATTERN.source },
    type: { enum: ['planning', 'execution', 'final_review'] },
    taskId: { anyOf: [{ type: 'null' }, { type: 'string', pattern: TASK_ID_PATTERN.source }] },
    planRevision: { type: 'integer', minimum: 1 },
    specSha256: { type: 'string', format: 'sha256' },
    startedAt: { type: 'string', format: 'rfc3339' },
  },
} as const;
