/**
 * Plan Review 报告历史装配。
 *
 * Session Record 是每次 Reviewer 尝试的不可变事实。本模块只负责从状态
 * 端口读取、核对 Run 归属并投影为 Reporter 专用 DTO；Reporter 因而无需
 * 依赖 State Store，也不会从 Claude 日志或瞬态 run 字段推断审核历史。
 */
import { ApexError } from '../../domain/errors.js';
import type { PlanReviewResult } from '../../domain/schemas/plan-review-result.js';
import type {
  PlanReviewReportEntry,
} from '../ports/ReporterPort.js';
import type { StateStorePort } from '../ports/state-store.js';

/**
 * 读取当前 Run 的全部 Plan Review Session，并按开始时间、Session ID
 * 稳定排序。completed 记录保留结构化结果，failed 记录保留稳定错误事实。
 */
export async function readPlanReviewReportHistory(
  stateStore: StateStorePort,
  runId: string,
): Promise<readonly PlanReviewReportEntry[]> {
  const records = await stateStore.listSessionRecords();
  const reviewRecords = records
    .filter((record) => record.type === 'plan_review')
    .sort(
      (left, right) =>
        left.startedAt.localeCompare(right.startedAt) ||
        left.sessionId.localeCompare(right.sessionId),
    );

  return reviewRecords.map((record): PlanReviewReportEntry => {
    if (record.runId !== runId) {
      throw new ApexError({
        code: 'STATE_VALIDATION_FAILED',
        stage: 'report',
        message:
          `plan review session ${record.sessionId} belongs to run ${record.runId}, ` +
          `expected ${runId}`,
      });
    }
    if (record.status === 'completed') {
      return {
        sessionId: record.sessionId,
        planRevision: record.planRevision,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        status: 'completed',
        result: record.structuredResult as PlanReviewResult,
        error: null,
      };
    }
    return {
      sessionId: record.sessionId,
      planRevision: record.planRevision,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      status: 'failed',
      result: null,
      error: record.error!,
    };
  });
}
