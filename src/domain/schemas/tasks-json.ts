/**
 * tasks.json (SPEC §7.4). The current Task Plan; system facts (schemaVersion,
 * runId, planRevision, spec facts, timestamps, planner session) are filled by
 * the Coordinator, never by the model.
 */
import { RUN_ID_PATTERN, UUID_PATTERN } from '../ids.js';
import {
  checkpointDispositionSchema,
  plannedTaskSchema,
  type CheckpointDisposition,
  type PlannedTask,
} from './task-plan-draft.js';

export interface TasksJson {
  schemaVersion: 1;
  runId: string;
  planRevision: number;
  specPath: string;
  specSha256: string;
  generatedAt: string;
  plannerSessionId: string;
  summary: string;
  assumptions: string[];
  retainedCheckpointDispositions: CheckpointDisposition[];
  tasks: PlannedTask[];
}

export const tasksJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'runId',
    'planRevision',
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
