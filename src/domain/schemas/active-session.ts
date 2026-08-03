/**
 * Active Session (SPEC §11.3). The `activeSession` handoff slot inside
 * run.json — a fact record, not a process liveness probe.
 */
import { TASK_ID_PATTERN, UUID_PATTERN } from '../ids.js';

export type SessionType =
  | 'planning'
  | 'plan_review'
  | 'execution'
  | 'task_review'
  | 'final_review';

export interface ActiveSession {
  sessionId: string;
  type: SessionType;
  taskId: string | null;
  planRevision: number;
  specSha256: string;
  startedAt: string;
}

/**
 * 活动会话 Schema 保持标准 JSON Schema 的显式 null 联合。
 *
 * Ajv 泛型无法无损表达该联合，因此由集中 Schema 契约测试防止接口漂移。
 */
export const activeSessionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['sessionId', 'type', 'taskId', 'planRevision', 'specSha256', 'startedAt'],
  properties: {
    sessionId: { type: 'string', pattern: UUID_PATTERN.source },
    type: {
      type: 'string',
      enum: ['planning', 'plan_review', 'execution', 'task_review', 'final_review'],
    },
    taskId: {
      anyOf: [
        { type: 'null' },
        { type: 'string', pattern: TASK_ID_PATTERN.source },
      ],
    },
    planRevision: { type: 'integer', minimum: 1 },
    specSha256: { type: 'string', format: 'sha256' },
    startedAt: { type: 'string', format: 'rfc3339' },
  },
} as const;
