/**
 * Error Record (SPEC §11.6). All optional association fields are explicitly
 * `null` when absent — they must never be omitted.
 */
import { ERROR_CLASSES, ERROR_CODES, type ErrorClass, type ErrorCode } from '../errors.js';
import { TASK_ID_PATTERN, UUID_PATTERN } from '../ids.js';

export interface ErrorRecord {
  errorCode: ErrorCode;
  errorClass: ErrorClass;
  stage: string;
  message: string;
  toolSummary: string | null;
  sessionId: string | null;
  taskId: string | null;
  at: string;
}

/**
 * 错误记录的稳定代码集合复用领域常量，避免维护第二份枚举。
 *
 * 显式 null 联合保留标准 JSON Schema 表达，并由契约测试覆盖可空关联字段。
 */
export const errorRecordSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'errorCode',
    'errorClass',
    'stage',
    'message',
    'toolSummary',
    'sessionId',
    'taskId',
    'at',
  ],
  properties: {
    errorCode: { type: 'string', enum: [...ERROR_CODES] },
    errorClass: { type: 'string', enum: [...ERROR_CLASSES] },
    stage: { type: 'string', minLength: 1 },
    message: { type: 'string', minLength: 1 },
    toolSummary: {
      anyOf: [
        { type: 'null' },
        { type: 'string', minLength: 1 },
      ],
    },
    sessionId: {
      anyOf: [
        { type: 'null' },
        { type: 'string', pattern: UUID_PATTERN.source },
      ],
    },
    taskId: {
      anyOf: [
        { type: 'null' },
        { type: 'string', pattern: TASK_ID_PATTERN.source },
      ],
    },
    at: { type: 'string', format: 'rfc3339' },
  },
} as const;
