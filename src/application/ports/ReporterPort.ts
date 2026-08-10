/**
 * ReporterPort (SPEC §5.2 Application Ports, §14.4 Final Report). Generates
 * `.apex-coding-agent/report.md` strictly from committed facts — run.json,
 * tasks.json, Plan Revision Snapshots, immutable Session Records and read-only Git facts. The Reporter
 * never reads Claude free-text logs to infer state (SPEC §5.5) and never
 * claims independent security or process-recovery verification that has no
 * evidence in those facts (SPEC §14.4).
 *
 * The implementation lives in `src/adapters/reporter/`; the whole document
 * passes the RedactionPort before it is written (SPEC §18.4).
 */
import type { FinalReviewResult } from '../../domain/schemas/final-review-result.js';
import type { ErrorRecord } from '../../domain/schemas/error-record.js';
import type { PlanReviewResult } from '../../domain/schemas/plan-review-result.js';
import type { PlanRevisionSnapshot } from '../../domain/schemas/plan-revision-snapshot.js';
import type { RunJson } from '../../domain/schemas/run-json.js';
import type { TasksJson } from '../../domain/schemas/tasks-json.js';

/**
 * 报告所需的 Git 只读事实（例如来自 `GitPort.readRepositoryStatus`）。
 * Reporter 只消费事实，不对仓库做任何不变量断言。
 */
export interface ReportGitFact {
  /** HEAD 附着的分支短名；detached 为 null。 */
  readonly currentBranch: string | null;
  /** 当前 HEAD 完整 OID。 */
  readonly headOid: string;
  /** `git status --porcelain` 原始行。 */
  readonly statusEntries: readonly string[];
}

/**
 * 单次 Plan Review Session 的报告事实。
 *
 * completed 结果可能是最终批准、业务打回或后来被结果修复接力拒绝的输出；
 * 报告按 Session 尝试如实展示，不把模型输出误称为已提交 Plan Revision。
 */
export type PlanReviewReportEntry =
  | {
      readonly sessionId: string;
      readonly planRevision: number;
      readonly startedAt: string;
      readonly endedAt: string;
      readonly status: 'completed';
      readonly result: PlanReviewResult;
      readonly error: null;
    }
  | {
      readonly sessionId: string;
      readonly planRevision: number;
      readonly startedAt: string;
      readonly endedAt: string;
      readonly status: 'failed';
      readonly result: null;
      readonly error: ErrorRecord;
    };

export interface GenerateReportInput {
  readonly run: RunJson;
  /** planRevision 0 时（异常路径）为 null。 */
  readonly tasks: TasksJson | null;
  /** 按 Revision 升序。 */
  readonly planRevisions: readonly PlanRevisionSnapshot[];
  /** 按开始时间稳定排序的全部 Plan Review Session 尝试。 */
  readonly planReviewHistory: readonly PlanReviewReportEntry[];
  readonly git: ReportGitFact;
  /**
   * 最后一次 Final Review 的结构化结果（来自其 completed Session Record，
   * 已脱敏）；无 Final Review 或记录缺失时为 null。报告的"Claude 报告的
   * 测试结果"同时覆盖各 Task 与 Final Review 的 tests（§14.4）。
   */
  readonly finalReviewResult: FinalReviewResult | null;
}

export interface ReporterPort {
  /** 写入 .apex-coding-agent/report.md 并返回状态目录相对路径 "report.md"。 */
  generateReport(input: GenerateReportInput): Promise<string>;
}
