/**
 * ApexError → ErrorRecord 的持久化映射（SPEC §11.6、§15、§18.4）。
 *
 * 稳定 errorCode/errorClass 与 stage/sessionId/taskId 取自错误本身；
 * message 与 toolSummary 进入持久化前必须过 RedactionPort（§18.4），
 * toolSummary 为 null 时保持 null（可选关联字段显式 null 铁律）。
 */
import type { ApexError } from '../../domain/errors.js';
import type { ErrorRecord } from '../../domain/schemas/error-record.js';
import type { RedactionPort } from '../ports/redaction.js';

/** 把一次失败映射为可持久化的 ErrorRecord；`at` 为程序生成的 RFC 3339 时间。 */
export function toErrorRecord(
  error: ApexError,
  at: string,
  redaction: RedactionPort,
): ErrorRecord {
  return {
    errorCode: error.errorCode,
    errorClass: error.errorClass,
    stage: error.stage,
    message: redaction.redactText(error.message),
    toolSummary: error.toolSummary === null ? null : redaction.redactText(error.toolSummary),
    sessionId: error.sessionId,
    taskId: error.taskId,
    at,
  };
}
