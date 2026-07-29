/**
 * TaskExecutionResult (SPEC §9.4). Returned by Execution Sessions; persisted
 * as `completedResult` inside Task Runtime State once the task completes.
 *
 * The schema is purely structural; cross-field gates (evidence coverage,
 * decision/replanReason coupling, completed ⇔ no failed tests) live in
 * `src/domain/results.ts`.
 */
import type { JSONSchemaType } from 'ajv';

export type ExecutionDecision = 'completed' | 'failed' | 'replan_required';

export interface TestReport {
  command: string;
  result: 'passed' | 'failed' | 'not_run';
}

export interface AcceptanceEvidence {
  criterionIndex: number;
  status: 'satisfied' | 'not_satisfied';
  evidence: string;
}

export interface TaskExecutionResult {
  decision: ExecutionDecision;
  summary: string;
  tests: TestReport[];
  acceptanceEvidence: AcceptanceEvidence[];
  changedAreas: string[];
  remainingRisks: string[];
  replanReason: string | null;
}

/**
 * 子结构先建立独立的 Ajv 类型契约，再由任务结果 Schema 复用。
 *
 * 这样测试结果和验收证据不会在多个持久化结构中复制字段定义。
 */
export const testReportSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['command', 'result'],
  properties: {
    command: { type: 'string', minLength: 1 },
    result: { type: 'string', enum: ['passed', 'failed', 'not_run'] },
  },
} as const satisfies JSONSchemaType<TestReport>;

export const acceptanceEvidenceSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['criterionIndex', 'status', 'evidence'],
  properties: {
    criterionIndex: { type: 'integer', minimum: 0 },
    status: { type: 'string', enum: ['satisfied', 'not_satisfied'] },
    evidence: { type: 'string', minLength: 1 },
  },
} as const satisfies JSONSchemaType<AcceptanceEvidence>;

export const taskExecutionResultSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'decision',
    'summary',
    'tests',
    'acceptanceEvidence',
    'changedAreas',
    'remainingRisks',
    'replanReason',
  ],
  properties: {
    decision: { type: 'string', enum: ['completed', 'failed', 'replan_required'] },
    summary: { type: 'string', minLength: 1 },
    tests: { type: 'array', items: testReportSchema },
    acceptanceEvidence: { type: 'array', items: acceptanceEvidenceSchema },
    changedAreas: { type: 'array', items: { type: 'string', minLength: 1 } },
    remainingRisks: { type: 'array', items: { type: 'string', minLength: 1 } },
    replanReason: { type: ['string', 'null'], minLength: 1 },
  },
} as const;
