/**
 * TaskPlanDraft (SPEC §7.3). Returned by Planning Sessions; also the normative
 * task definition shape embedded in tasks.json and Plan Revision Snapshots.
 *
 * Semantic checks (ID uniqueness, dependency graph, revision/disposition
 * rules) live in `src/domain/plan.ts`.
 */
import { GIT_OID_PATTERN, TASK_ID_PATTERN } from '../ids.js';
import { GIT_RELATIVE_PATH_PATTERN } from '../paths.js';
import type { JSONSchemaType } from 'ajv';

export const TASK_TARGET_CONTEXT_TOKENS_MAX = 480_000;
export const TASK_HARD_CONTEXT_TOKENS = 600_000;
export const TASK_MAX_AGENT_TURNS = 128;

export type VerificationKind = 'command' | 'static_analysis' | 'manual';

/**
 * 单条验证步骤把验收条件、执行方式和期望证据显式关联起来。
 *
 * command 只保存无需 Shell 拼接的仓库命令说明，真正执行仍由 Claude Code
 * 按仓库规则完成；static_analysis/manual 必须把 command 与 timeoutSeconds
 * 保持为 null，跨字段规则由 plan.ts 统一校验。
 */
export interface VerificationStep {
  readonly id: string;
  readonly kind: VerificationKind;
  readonly criterionIndexes: number[];
  readonly procedure: string;
  readonly expectedEvidence: string;
  readonly command: string | null;
  readonly timeoutSeconds: number | null;
}

/**
 * Task 预算是 Planning 与 Execution 共享的注意力边界。
 *
 * 正常目标最多使用 48 万上下文 token，60 万是不可提高的硬边界；
 * maxAgentTurns 同时下沉为 Claude CLI 的运行时回合上限。两个 context
 * 数值字段单位均为 token，但字段名不含凭据敏感词，避免被统一脱敏边界改写。
 */
export interface TaskBudget {
  readonly targetContextBudget: number;
  readonly hardContextLimit: number;
  readonly maxAgentTurns: number;
}

export interface PlannedTask {
  readonly id: string;
  readonly title: string;
  readonly objective: string;
  readonly nonGoals: string[];
  readonly dependsOn: string[];
  readonly acceptanceCriteria: string[];
  readonly verificationPlan: VerificationStep[];
  readonly likelyPaths: string[];
  readonly budget: TaskBudget;
  readonly context: string;
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
 * Schema 对象由 Ajv 执行运行时严格校验，并由领域语义校验补足跨字段规则。
 *
 * 可空字段使用 JSON Schema 联合类型；当前 Ajv 的 JSONSchemaType 泛型无法
 * 正确表达嵌套可空成员，因此结构正确性由 Schema 回归测试锁定。
 */
export const plannedTaskSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'title',
    'objective',
    'nonGoals',
    'dependsOn',
    'acceptanceCriteria',
    'verificationPlan',
    'likelyPaths',
    'budget',
    'context',
  ],
  properties: {
    id: { type: 'string', pattern: TASK_ID_PATTERN.source },
    title: { type: 'string', minLength: 1 },
    objective: { type: 'string', minLength: 1 },
    nonGoals: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      minItems: 1,
      uniqueItems: true,
    },
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
    verificationPlan: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'kind',
          'criterionIndexes',
          'procedure',
          'expectedEvidence',
          'command',
          'timeoutSeconds',
        ],
        properties: {
          id: { type: 'string', pattern: '^VERIFY-[0-9]{3}$' },
          kind: { type: 'string', enum: ['command', 'static_analysis', 'manual'] },
          criterionIndexes: {
            type: 'array',
            items: { type: 'integer', minimum: 0 },
            minItems: 1,
            uniqueItems: true,
          },
          procedure: { type: 'string', minLength: 1 },
          expectedEvidence: { type: 'string', minLength: 1 },
          command: { type: ['string', 'null'], minLength: 1 },
          timeoutSeconds: {
            anyOf: [{ type: 'null' }, { type: 'integer', minimum: 1, maximum: 3_600 }],
          },
        },
      },
    },
    likelyPaths: {
      type: 'array',
      items: {
        type: 'string',
        format: 'git-relative-path',
        pattern: GIT_RELATIVE_PATH_PATTERN.source,
        description:
          '仓库根目录下的 Git 相对路径；使用正斜杠，文件和目录均不得以斜杠结尾，且不得包含 . 或 .. 路径段',
      },
    },
    budget: {
      type: 'object',
      additionalProperties: false,
      required: ['targetContextBudget', 'hardContextLimit', 'maxAgentTurns'],
      properties: {
        targetContextBudget: {
          type: 'integer',
          minimum: 10_000,
          maximum: TASK_TARGET_CONTEXT_TOKENS_MAX,
        },
        hardContextLimit: { type: 'integer', const: TASK_HARD_CONTEXT_TOKENS },
        maxAgentTurns: {
          type: 'integer',
          minimum: 8,
          maximum: TASK_MAX_AGENT_TURNS,
        },
      },
    },
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
} as const;
