/**
 * Central registry of the 18 built-in schemas (SPEC §11.5), all versioned at
 * `schemaVersion: 1`. Exposes the single `validate(schemaName, data)` entry
 * used by every layer; cross-field conditional rules beyond JSON Schema live
 * in `src/domain/invariants.ts`, `plan.ts` and `results.ts`.
 */
import type { ErrorObject, ValidateFunction } from 'ajv';
import { ApexError, type ErrorCode } from '../errors.js';
import { activeSessionSchema } from './active-session.js';
import { errorRecordSchema } from './error-record.js';
import { finalReviewEpisodeSchema } from './final-review-episode.js';
import { finalReviewResultSchema } from './final-review-result.js';
import { createAjv } from './formats.js';
import { intermediateCheckpointSchema } from './intermediate-checkpoint.js';
import { planRevisionSnapshotSchema } from './plan-revision-snapshot.js';
import { planReviewResultSchema } from './plan-review-result.js';
import { runArchiveManifestSchema } from './run-archive-manifest.js';
import { runJsonSchema } from './run-json.js';
import { sessionRecordSchema } from './session-record.js';
import { settingsJsonSchema } from './settings-json.js';
import { taskExecutionEpisodeSchema } from './task-execution-episode.js';
import { taskExecutionResultSchema } from './task-execution-result.js';
import {
  initialTaskPlanDraftSchema,
  taskPlanDraftSchema,
  type TaskPlanDraftSchemaMode,
} from './task-plan-draft.js';
import { taskRuntimeStateSchema } from './task-runtime-state.js';
import { taskReviewEpisodeSchema } from './task-review-episode.js';
import { taskReviewResultSchema } from './task-review-result.js';
import { tasksJsonSchema } from './tasks-json.js';

export const SCHEMA_NAMES = [
  'TaskPlanDraft',
  'PlanReviewResult',
  'TaskExecutionResult',
  'TaskReviewResult',
  'FinalReviewResult',
  'ActiveSession',
  'TaskRuntimeState',
  'TaskExecutionEpisode',
  'TaskReviewEpisode',
  'FinalReviewEpisode',
  'IntermediateCheckpoint',
  'ErrorRecord',
  'TasksJson',
  'PlanRevisionSnapshot',
  'RunJson',
  'SessionRecord',
  'RunArchiveManifest',
  'SettingsJson',
] as const;

export type SchemaName = (typeof SCHEMA_NAMES)[number];

export const SCHEMA_VERSION = 1 as const;

interface SchemaDefinition {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly schema: Readonly<Record<string, unknown>>;
}

const SCHEMA_DEFINITIONS: Record<SchemaName, SchemaDefinition> = {
  TaskPlanDraft: { schemaVersion: SCHEMA_VERSION, schema: taskPlanDraftSchema },
  PlanReviewResult: { schemaVersion: SCHEMA_VERSION, schema: planReviewResultSchema },
  TaskExecutionResult: { schemaVersion: SCHEMA_VERSION, schema: taskExecutionResultSchema },
  TaskReviewResult: { schemaVersion: SCHEMA_VERSION, schema: taskReviewResultSchema },
  FinalReviewResult: { schemaVersion: SCHEMA_VERSION, schema: finalReviewResultSchema },
  ActiveSession: { schemaVersion: SCHEMA_VERSION, schema: activeSessionSchema },
  TaskRuntimeState: { schemaVersion: SCHEMA_VERSION, schema: taskRuntimeStateSchema },
  TaskExecutionEpisode: { schemaVersion: SCHEMA_VERSION, schema: taskExecutionEpisodeSchema },
  TaskReviewEpisode: { schemaVersion: SCHEMA_VERSION, schema: taskReviewEpisodeSchema },
  FinalReviewEpisode: { schemaVersion: SCHEMA_VERSION, schema: finalReviewEpisodeSchema },
  IntermediateCheckpoint: { schemaVersion: SCHEMA_VERSION, schema: intermediateCheckpointSchema },
  ErrorRecord: { schemaVersion: SCHEMA_VERSION, schema: errorRecordSchema },
  TasksJson: { schemaVersion: SCHEMA_VERSION, schema: tasksJsonSchema },
  PlanRevisionSnapshot: { schemaVersion: SCHEMA_VERSION, schema: planRevisionSnapshotSchema },
  RunJson: { schemaVersion: SCHEMA_VERSION, schema: runJsonSchema },
  SessionRecord: { schemaVersion: SCHEMA_VERSION, schema: sessionRecordSchema },
  RunArchiveManifest: { schemaVersion: SCHEMA_VERSION, schema: runArchiveManifestSchema },
  SettingsJson: { schemaVersion: SCHEMA_VERSION, schema: settingsJsonSchema },
};

const ajv = createAjv();
const VALIDATORS = new Map<SchemaName, ValidateFunction>(
  SCHEMA_NAMES.map((name) => [name, ajv.compile(SCHEMA_DEFINITIONS[name].schema)]),
);
/**
 * 初始草稿是 Claude 调用期的窄契约，不加入持久化 Schema 注册表。
 *
 * 这样不会改变 SPEC §11.5 的内置文档数量，也不会让历史 Session Record
 * 因为曾经合法包含 Replan retain 引用而失去可读性。
 */
const INITIAL_TASK_PLAN_DRAFT_VALIDATOR = ajv.compile(initialTaskPlanDraftSchema);

export interface SchemaValidationIssue {
  readonly path: string;
  readonly keyword: string;
  readonly message: string;
}

export type SchemaValidationResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly issues: readonly SchemaValidationIssue[] };

function toIssue(error: ErrorObject): SchemaValidationIssue {
  return {
    path: error.instancePath === '' ? '/' : error.instancePath,
    keyword: error.keyword,
    message: error.message ?? 'schema violation',
  };
}

/** 把任意已编译 Schema 的 Ajv 结果归一化为领域层统一的校验结果。 */
function validateWith(
  validator: ValidateFunction,
  data: unknown,
): SchemaValidationResult {
  if (validator(data)) {
    return { valid: true };
  }
  return { valid: false, issues: (validator.errors ?? []).map(toIssue) };
}

/** Unified schema validation entry (SPEC §11.5). */
export function validate(schemaName: SchemaName, data: unknown): SchemaValidationResult {
  const validator = VALIDATORS.get(schemaName);
  if (!validator) {
    throw new ApexError({
      code: 'STATE_VALIDATION_FAILED',
      stage: 'state',
      message: `unknown built-in schema: ${schemaName}`,
    });
  }
  return validateWith(validator, data);
}

/**
 * 按 Planning 所处阶段校验调用期草稿契约。
 * initial 用于验证外发 StructuredOutput 窄契约；入站仍按通用草稿读取，
 * 让 Application 能对外部 CLI 的 retain 漂移执行确定性恢复。
 */
export function validateTaskPlanDraftSchema(
  mode: TaskPlanDraftSchemaMode,
  data: unknown,
): SchemaValidationResult {
  return mode === 'initial'
    ? validateWith(INITIAL_TASK_PLAN_DRAFT_VALIDATOR, data)
    : validate('TaskPlanDraft', data);
}

/**
 * Validates and throws {@link ApexError} with the caller-supplied stable
 * error code when invalid — the code depends on where validation happens
 * (e.g. PLAN_INVALID for drafts, CLAUDE_RESULT_INVALID for results,
 * STATE_VALIDATION_FAILED for persisted state).
 */
export function assertSchemaValid(
  schemaName: SchemaName,
  data: unknown,
  failure: { readonly code: ErrorCode; readonly stage: string },
): void {
  const result = validate(schemaName, data);
  if (result.valid) return;
  const detail = result.issues
    .map((issue) => `${issue.path} (${issue.keyword}): ${issue.message}`)
    .join('; ');
  throw new ApexError({
    code: failure.code,
    stage: failure.stage,
    message: `${schemaName} schema validation failed: ${detail}`,
  });
}

/** Raw JSON Schema object, e.g. for Claude `--json-schema` invocations. */
export function getSchemaJson(schemaName: SchemaName): Readonly<Record<string, unknown>> {
  return SCHEMA_DEFINITIONS[schemaName].schema;
}

/**
 * 返回 Claude Planning 的阶段化 StructuredOutput Schema。
 * 调用者只能选择 initial 或 replan，不能自行拼装一份与领域校验漂移的 Schema。
 */
export function getTaskPlanDraftSchemaJson(
  mode: TaskPlanDraftSchemaMode,
): Readonly<Record<string, unknown>> {
  return mode === 'initial' ? initialTaskPlanDraftSchema : taskPlanDraftSchema;
}

export function getSchemaVersion(schemaName: SchemaName): number {
  return SCHEMA_DEFINITIONS[schemaName].schemaVersion;
}
