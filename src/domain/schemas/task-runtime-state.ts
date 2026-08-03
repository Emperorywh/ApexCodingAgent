/**
 * Task Runtime State (SPEC §11.3). Runtime status of one task inside
 * run.json — deliberately separate from the Task Plan definition.
 * Status-dependent null rules are enforced in `src/domain/invariants.ts`.
 */
import { GIT_OID_PATTERN, TASK_ID_PATTERN } from '../ids.js';
import { errorRecordSchema, type ErrorRecord } from './error-record.js';
import {
  taskExecutionEpisodeSchema,
  type TaskExecutionEpisode,
} from './task-execution-episode.js';
import {
  taskExecutionResultSchema,
  type TaskExecutionResult,
} from './task-execution-result.js';
import {
  taskReviewEpisodeSchema,
  type TaskReviewEpisode,
} from './task-review-episode.js';

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export const TASK_STATUSES: readonly TaskStatus[] = [
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
];

export interface TaskRuntimeState {
  taskId: string;
  status: TaskStatus;
  executionEpisodes: TaskExecutionEpisode[];
  taskReviewEpisodes: TaskReviewEpisode[];
  candidateResult: TaskExecutionResult | null;
  candidateCheckpoint: string | null;
  completedResult: TaskExecutionResult | null;
  finalCheckpoint: string | null;
  skipReason: string | null;
  failure: ErrorRecord | null;
}

/**
 * 任务运行态组合 Episode、结果与错误子结构，避免重复字段定义。
 *
 * 状态相关的可空约束仍由 invariants 模块统一执行，避免跨层重复状态规则。
 */
export const taskRuntimeStateSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'taskId',
    'status',
    'executionEpisodes',
    'taskReviewEpisodes',
    'candidateResult',
    'candidateCheckpoint',
    'completedResult',
    'finalCheckpoint',
    'skipReason',
    'failure',
  ],
  properties: {
    taskId: { type: 'string', pattern: TASK_ID_PATTERN.source },
    status: { type: 'string', enum: [...TASK_STATUSES] },
    executionEpisodes: { type: 'array', items: taskExecutionEpisodeSchema },
    taskReviewEpisodes: { type: 'array', items: taskReviewEpisodeSchema },
    candidateResult: { anyOf: [{ type: 'null' }, taskExecutionResultSchema] },
    candidateCheckpoint: {
      anyOf: [{ type: 'null' }, { type: 'string', pattern: GIT_OID_PATTERN.source }],
    },
    completedResult: { anyOf: [{ type: 'null' }, taskExecutionResultSchema] },
    finalCheckpoint: {
      anyOf: [{ type: 'null' }, { type: 'string', pattern: GIT_OID_PATTERN.source }],
    },
    skipReason: { type: ['string', 'null'], minLength: 1 },
    failure: { anyOf: [{ type: 'null' }, errorRecordSchema] },
  },
} as const;
