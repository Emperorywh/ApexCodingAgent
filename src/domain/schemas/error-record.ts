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
    errorCode: { enum: [...ERROR_CODES] },
    errorClass: { enum: [...ERROR_CLASSES] },
    stage: { type: 'string', minLength: 1 },
    message: { type: 'string', minLength: 1 },
    toolSummary: { type: ['string', 'null'], minLength: 1 },
    sessionId: { anyOf: [{ type: 'null' }, { type: 'string', pattern: UUID_PATTERN.source }] },
    taskId: { anyOf: [{ type: 'null' }, { type: 'string', pattern: TASK_ID_PATTERN.source }] },
    at: { type: 'string', format: 'rfc3339' },
  },
} as const;
