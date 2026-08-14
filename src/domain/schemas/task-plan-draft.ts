/**
 * Planning Session 返回的 TaskPlanDraft（SPEC §7.3）。
 *
 * 完整 PlannedTask 仍是 tasks.json 与 Plan Revision Snapshot 的权威持久化
 * 形状；Replan 草稿额外允许 retain 引用，提交前由领域合并物化为完整定义。
 * ID 唯一性、依赖图和 Revision/disposition 等语义规则集中在 plan.ts。
 */
import { GIT_OID_PATTERN, TASK_ID_PATTERN } from '../ids.js';
import { GIT_RELATIVE_PATH_PATTERN } from '../paths.js';
import type { JSONSchemaType } from 'ajv';

export const TASK_TARGET_CONTEXT_TOKENS_MAX = 480_000;
export const TASK_HARD_CONTEXT_TOKENS = 600_000;
export const TASK_MAX_AGENT_TURNS = 128;

/**
 * 2.0.25 之前版本的 hardContextLimit 政策值。
 *
 * 旧版本 Run 的 tasks.json、Plan Revision Snapshot、Session Record 内嵌
 * 草稿以及 Revision 中原样保留的 completed/pending Task 都携带该历史值；
 * 草稿 Schema 必须继续接受它，否则历史 Run 的恢复与修订会整体失效。
 */
export const TASK_HARD_CONTEXT_TOKENS_LEGACY = 300_000;

/**
 * 规划期可接受的 hardContextLimit 取值：全部历史政策值加当前政策值。
 *
 * 维护契约：上调 TASK_HARD_CONTEXT_TOKENS 时，旧值必须移入本集合并永久
 * 保留；从集合中移除任何一个值，携带该值的历史 Run 就无法再通过草稿校验。
 */
export const TASK_HARD_CONTEXT_TOKENS_ACCEPTED = [
  TASK_HARD_CONTEXT_TOKENS_LEGACY,
  TASK_HARD_CONTEXT_TOKENS,
] as const;

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

/**
 * Replan 对上一 Revision 未改 pending Task 的紧凑引用。
 *
 * 引用与完整 PlannedTask 共用 tasks 数组，使历史 Session Record 的完整
 * Task 对象无需迁移仍然合法；`disposition` 采用 const 可避免两种形状歧义。
 */
export interface RetainedTaskReference {
  readonly id: string;
  readonly disposition: 'retain';
}

/**
 * 草稿条目只允许完整任务定义或紧凑保留引用，不提供第三种隐式补丁形状。
 */
export type TaskPlanDraftEntry = PlannedTask | RetainedTaskReference;

/**
 * 通过专用判别字段区分紧凑引用与完整 Task 定义。
 */
export function isRetainedTaskReference(
  entry: TaskPlanDraftEntry,
): entry is RetainedTaskReference {
  return 'disposition' in entry && entry.disposition === 'retain';
}

export interface TaskPlanDraft {
  summary: string;
  assumptions: string[];
  retainedCheckpointDispositions: CheckpointDisposition[];
  tasks: TaskPlanDraftEntry[];
}

/**
 * Claude Planning 输出端使用的草稿形态。
 *
 * initial 对应尚无已提交 Revision 的首份计划，只能返回完整 Task；replan
 * 对应已有权威计划的重新规划，可以用 retain 引用压缩未修改的 pending Task。
 */
export type TaskPlanDraftSchemaMode = 'initial' | 'replan';

/**
 * 规划期预算 Schema：约束 Planner 的结构化输出。
 *
 * targetContextBudget/maxAgentTurns 沿用当前政策区间（历史合法值均落在
 * 区间内）；hardContextLimit 接受全部历史政策值——原样保留的 Task 必须
 * 携带其旧值，而「新任务必须使用当前值」是位置相关的语义规则，JSON
 * Schema 无法表达，由 plan.ts 的确定性校验强制执行。
 */
const taskBudgetSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['targetContextBudget', 'hardContextLimit', 'maxAgentTurns'],
  properties: {
    targetContextBudget: {
      type: 'integer',
      minimum: 10_000,
      maximum: TASK_TARGET_CONTEXT_TOKENS_MAX,
    },
    hardContextLimit: { type: 'integer', enum: [...TASK_HARD_CONTEXT_TOKENS_ACCEPTED] },
    maxAgentTurns: {
      type: 'integer',
      minimum: 8,
      maximum: TASK_MAX_AGENT_TURNS,
    },
  },
} as const;

/**
 * 持久化计划事实的预算只做完整性校验（正整数），不绑定任何政策数值。
 *
 * 预算上限是随模型代际调整的政策（2.0.25 曾把 hardContextLimit 从
 * 300000 上调到 600000）；持久化 Schema 一旦用 const/maximum 绑定当期
 * 政策，旧版本写入的合法状态就会在新版本下永久无法通过校验，resume
 * 整体失效。篡改检测由 run.json tasksSha256 的原始字节哈希链承担，
 * 不依赖字段取值范围。
 */
const persistedTaskBudgetSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['targetContextBudget', 'hardContextLimit', 'maxAgentTurns'],
  properties: {
    targetContextBudget: { type: 'integer', minimum: 1 },
    hardContextLimit: { type: 'integer', minimum: 1 },
    maxAgentTurns: { type: 'integer', minimum: 1 },
  },
} as const;

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
    budget: taskBudgetSchema,
    context: { type: 'string', minLength: 1 },
  },
} as const;

/**
 * tasks.json 与 Plan Revision Snapshot 嵌入的任务定义。
 *
 * 与规划期 plannedTaskSchema 的唯一区别是 budget 改用完整性校验：持久化
 * 文档是历史事实，必须对历次政策调整前后的合法取值保持可读。
 */
export const persistedPlannedTaskSchema = {
  ...plannedTaskSchema,
  properties: {
    ...plannedTaskSchema.properties,
    budget: persistedTaskBudgetSchema,
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

export const retainedTaskReferenceSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'disposition'],
  properties: {
    id: { type: 'string', pattern: TASK_ID_PATTERN.source },
    disposition: { type: 'string', const: 'retain' },
  },
} as const satisfies JSONSchemaType<RetainedTaskReference>;

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
    tasks: {
      type: 'array',
      items: { anyOf: [plannedTaskSchema, retainedTaskReferenceSchema] },
    },
  },
} as const;

/**
 * 初始 Planning 专用的窄 Schema。
 *
 * 持久化与历史 Session Record 继续使用 taskPlanDraftSchema；这里只收紧发给
 * Claude CLI 的 StructuredOutput 契约，避免模型先提交无法解析的 retain
 * 引用，再把缺少完整定义的草稿交给后续轻量修正会话猜测重建。
 */
export const initialTaskPlanDraftSchema = {
  ...taskPlanDraftSchema,
  properties: {
    ...taskPlanDraftSchema.properties,
    tasks: {
      type: 'array',
      items: plannedTaskSchema,
    },
  },
} as const;
