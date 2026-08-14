/**
 * run.json (SPEC §11.3). The single source of truth for Run and Task runtime
 * status. Conditional rules (terminal fields, planRevision/tasksSha256
 * coupling, per-task null rules) are enforced in `src/domain/invariants.ts`.
 */
import { GIT_OID_PATTERN, RUN_BRANCH_PATTERN, RUN_ID_PATTERN, TASK_ID_PATTERN, UUID_PATTERN } from '../ids.js';
import { activeSessionSchema, type ActiveSession } from './active-session.js';
import type { SessionType } from './active-session.js';
import { errorRecordSchema, type ErrorRecord } from './error-record.js';
import {
  finalReviewEpisodeSchema,
  type FinalReviewEpisode,
} from './final-review-episode.js';
import {
  intermediateCheckpointSchema,
  type IntermediateCheckpoint,
} from './intermediate-checkpoint.js';
import {
  planRevisionTriggerSchema,
  type PlanRevisionTrigger,
} from './plan-revision-snapshot.js';
import {
  EXECUTION_PERMISSION_MODES,
  GIT_REMOTE_NAME_PATTERN,
  type ExecutionPermissionMode,
} from './settings-json.js';
import {
  taskRuntimeStateSchema,
  type TaskRuntimeState,
} from './task-runtime-state.js';

export type RunStatus = 'planning' | 'running' | 'final_review' | 'completed' | 'failed' | 'abandoned';

export const RUN_STATUSES: readonly RunStatus[] = [
  'planning',
  'running',
  'final_review',
  'completed',
  'failed',
  'abandoned',
];

export interface RunSpecFact {
  path: string;
  sha256: string;
}

export interface RunSettings {
  executionPermissionMode: ExecutionPermissionMode;
  claudeCliPath: string | null;
  gitCliPath: string | null;
  pushRemote: string;
}

export interface RepositoryFact {
  root: string;
  baseBranch: string;
  baseBranchRef: string;
  baseCommit: string;
  runBranch: string;
  expectedHead: string;
}

/**
 * 同一未提交 Revision 允许 Planner 根据独立复核反馈执行的返工次数。
 *
 * 初始候选不是返工；三次返工分别消费前三次 changes_required，因而最多
 * 会产生四份候选并执行四次复核。把“复核次数”直接设为三会让第三份反馈
 * 没有任何修正机会，实际只完成两次返工。
 */
export const MAX_PLAN_REVIEW_REWORKS = 3;

/**
 * 持久化 reviewAttempt 统计候选被复核的次数，包含第一份初始候选。
 * Schema 与 ReviewPlanCandidate 共用该派生上限，避免持久化边界和终止判定
 * 各自维护字面量而再次出现计数语义偏差。
 */
export const MAX_PLAN_REVIEW_ATTEMPTS = MAX_PLAN_REVIEW_REWORKS + 1;

/**
 * 已通过确定性计划校验、正在等待独立 Reviewer 的草稿引用。
 *
 * 完整草稿只存在不可变 Planning Session Record 中；run.json 保存引用与
 * 审核轮次即可支持崩溃恢复，避免复制整份计划形成第二事实源。
 */
export interface PlanCandidateRef {
  readonly planRevision: number;
  readonly plannerSessionId: string;
  readonly specSha256: string;
  readonly trigger: PlanRevisionTrigger;
  readonly reviewAttempt: number;
}

/** 上一轮 Plan Review 的反馈引用，供下一趟 Planner 精确读取。 */
export interface PlanReviewFeedbackRef {
  readonly planRevision: number;
  readonly plannerSessionId: string;
  readonly reviewerSessionId: string;
  readonly reviewAttempt: number;
}

/**
 * 可续接终态失败时记录的恢复点（SPEC §2.4/§17 resume）：失败前的非终态
 * 状态、对应 Task 与 Claude Session（后者供 resume 命令经
 * `--resume --fork-session` 续接对话上下文）。仅 `resume` 命令消费；
 * 其余失败终态恒为 null。
 */
export interface ResumePoint {
  /** 中断发生时的非终态 Run 状态，也是 resume 重开的目标状态。 */
  fromStatus: 'planning' | 'running' | 'final_review';
  /** 被中断的 Task；只有中断落在 Execution 会话内时非空。 */
  taskId: string | null;
  /** 被中断的 Claude Session ID（中断落在会话内时非空）。 */
  sessionId: string | null;
  /** 被中断 Session 的正式类型；会话间断点与 sessionId 一同为 null。 */
  sessionType: SessionType | null;
}

export interface RunJson {
  schemaVersion: 1;
  stateRevision: number;
  runId: string;
  status: RunStatus;
  spec: RunSpecFact;
  planRevision: number;
  tasksSha256: string | null;
  runSettings: RunSettings;
  repository: RepositoryFact;
  currentTaskId: string | null;
  activeSession: ActiveSession | null;
  planCandidate: PlanCandidateRef | null;
  planReviewFeedback: PlanReviewFeedbackRef | null;
  tasks: Record<string, TaskRuntimeState>;
  intermediateCheckpoints: IntermediateCheckpoint[];
  finalReviewEpisodes: FinalReviewEpisode[];
  lastError: ErrorRecord | null;
  finalCommit: string | null;
  reportPath: string | null;
  resumePoint: ResumePoint | null;
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
}

const nullableGitOid = {
  anyOf: [{ type: 'null' }, { type: 'string', pattern: GIT_OID_PATTERN.source }],
} as const;

/**
 * run.json 显式组合全部运行事实与标准 JSON Schema 的 null 联合。
 *
 * Schema 负责结构边界，状态转换与跨字段条件仍由状态机和 invariants 模块集中维护。
 */
export const runJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'stateRevision',
    'runId',
    'status',
    'spec',
    'planRevision',
    'tasksSha256',
    'runSettings',
    'repository',
    'currentTaskId',
    'activeSession',
    'planCandidate',
    'planReviewFeedback',
    'tasks',
    'intermediateCheckpoints',
    'finalReviewEpisodes',
    'lastError',
    'finalCommit',
    'reportPath',
    'resumePoint',
    'createdAt',
    'updatedAt',
    'terminalAt',
  ],
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    stateRevision: { type: 'integer', minimum: 1 },
    runId: { type: 'string', pattern: RUN_ID_PATTERN.source },
    status: { type: 'string', enum: [...RUN_STATUSES] },
    spec: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'sha256'],
      properties: {
        path: { type: 'string', format: 'git-relative-path' },
        sha256: { type: 'string', format: 'sha256' },
      },
    },
    planRevision: { type: 'integer', minimum: 0 },
    tasksSha256: {
      anyOf: [{ type: 'null' }, { type: 'string', format: 'sha256' }],
    },
    runSettings: {
      type: 'object',
      additionalProperties: false,
      required: ['executionPermissionMode', 'claudeCliPath', 'gitCliPath', 'pushRemote'],
      properties: {
        executionPermissionMode: {
          type: 'string',
          enum: [...EXECUTION_PERMISSION_MODES],
        },
        claudeCliPath: { type: ['string', 'null'], minLength: 1 },
        gitCliPath: { type: ['string', 'null'], minLength: 1 },
        pushRemote: { type: 'string', pattern: GIT_REMOTE_NAME_PATTERN.source },
      },
    },
    repository: {
      type: 'object',
      additionalProperties: false,
      required: ['root', 'baseBranch', 'baseBranchRef', 'baseCommit', 'runBranch', 'expectedHead'],
      properties: {
        root: { type: 'string', minLength: 1 },
        baseBranch: { type: 'string', minLength: 1 },
        baseBranchRef: { type: 'string', pattern: '^refs/heads/.+$' },
        baseCommit: { type: 'string', pattern: GIT_OID_PATTERN.source },
        runBranch: { type: 'string', pattern: RUN_BRANCH_PATTERN.source },
        expectedHead: { type: 'string', pattern: GIT_OID_PATTERN.source },
      },
    },
    currentTaskId: {
      anyOf: [{ type: 'null' }, { type: 'string', pattern: TASK_ID_PATTERN.source }],
    },
    activeSession: { anyOf: [{ type: 'null' }, activeSessionSchema] },
    planCandidate: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: [
            'planRevision',
            'plannerSessionId',
            'specSha256',
            'trigger',
            'reviewAttempt',
          ],
          properties: {
            planRevision: { type: 'integer', minimum: 1 },
            plannerSessionId: { type: 'string', pattern: UUID_PATTERN.source },
            specSha256: { type: 'string', format: 'sha256' },
            trigger: planRevisionTriggerSchema,
            reviewAttempt: {
              type: 'integer',
              minimum: 1,
              maximum: MAX_PLAN_REVIEW_ATTEMPTS,
            },
          },
        },
      ],
    },
    planReviewFeedback: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: [
            'planRevision',
            'plannerSessionId',
            'reviewerSessionId',
            'reviewAttempt',
          ],
          properties: {
            planRevision: { type: 'integer', minimum: 1 },
            plannerSessionId: { type: 'string', pattern: UUID_PATTERN.source },
            reviewerSessionId: { type: 'string', pattern: UUID_PATTERN.source },
            reviewAttempt: {
              type: 'integer',
              minimum: 1,
              maximum: MAX_PLAN_REVIEW_ATTEMPTS,
            },
          },
        },
      ],
    },
    tasks: {
      type: 'object',
      propertyNames: { pattern: TASK_ID_PATTERN.source },
      additionalProperties: taskRuntimeStateSchema,
    },
    intermediateCheckpoints: { type: 'array', items: intermediateCheckpointSchema },
    finalReviewEpisodes: { type: 'array', items: finalReviewEpisodeSchema },
    lastError: { anyOf: [{ type: 'null' }, errorRecordSchema] },
    finalCommit: nullableGitOid,
    reportPath: {
      anyOf: [{ type: 'null' }, { type: 'string', format: 'git-relative-path' }],
    },
    resumePoint: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['fromStatus', 'taskId', 'sessionId', 'sessionType'],
          properties: {
            fromStatus: {
              type: 'string',
              enum: ['planning', 'running', 'final_review'],
            },
            taskId: {
              anyOf: [
                { type: 'null' },
                { type: 'string', pattern: TASK_ID_PATTERN.source },
              ],
            },
            sessionId: {
              anyOf: [
                { type: 'null' },
                { type: 'string', pattern: UUID_PATTERN.source },
              ],
            },
            sessionType: {
              anyOf: [
                { type: 'null' },
                {
                  type: 'string',
                  enum: [
                    'planning',
                    'plan_review',
                    'execution',
                    'task_review',
                    'final_review',
                  ],
                },
              ],
            },
          },
        },
      ],
    },
    createdAt: { type: 'string', format: 'rfc3339' },
    updatedAt: { type: 'string', format: 'rfc3339' },
    terminalAt: {
      anyOf: [{ type: 'null' }, { type: 'string', format: 'rfc3339' }],
    },
  },
} as const;
