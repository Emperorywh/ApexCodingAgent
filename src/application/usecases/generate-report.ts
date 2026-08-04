/**
 * GenerateReport 用例（SPEC §14.4 Final Report、§17 report 命令语义）。
 *
 * 只为终态 Run 生成或重新生成 report.md；命令失败使用 REPORT_COMMAND_FAILED，
 * 不得把 completed 改为 failed，也不得修改任何终态字段——本用例不写
 * run.json，只从已提交事实重建报告（§5.5：Reporter 只读已提交事实）。
 */
import { ApexError, isApexError } from '../../domain/errors.js';
import { isTerminalRunStatus } from '../../domain/run-state.js';
import type { FinalReviewResult } from '../../domain/schemas/final-review-result.js';
import type { GitPort } from '../ports/GitPort.js';
import type { ReporterPort } from '../ports/ReporterPort.js';
import type { StateStorePort } from '../ports/state-store.js';
import { readCompletePlanRevisionHistory } from './plan-revision-history.js';

export interface GenerateReportDeps {
  readonly stateStore: StateStorePort;
  readonly git: GitPort;
  readonly reporter: ReporterPort;
}

export interface GenerateReportResult {
  /** 已确认处于终态、作为本次报告事实来源的 Run。 */
  readonly runId: string;
  readonly reportPath: string;
}

function reportCommandFailed(message: string, cause?: unknown): ApexError {
  return new ApexError({ code: 'REPORT_COMMAND_FAILED', stage: 'report', message, cause });
}

export function createGenerateReport(deps: GenerateReportDeps): {
  execute(): Promise<GenerateReportResult>;
} {
  async function execute(): Promise<GenerateReportResult> {
    /**
     * SPEC §11.2：report 必须从一次 run → tasks → run 的一致性快照读取，
     * 不能分别读取两个可变文件。STATE_SNAPSHOT_BUSY 保持原稳定错误码；
     * 稳定但损坏的聚合映射为命令状态非法。
     */
    let snapshot;
    try {
      snapshot = await deps.stateStore.readConsistentSnapshot();
    } catch (error) {
      if (isApexError(error) && error.errorCode === 'STATE_VALIDATION_FAILED') {
        throw new ApexError({
          code: 'COMMAND_STATE_INVALID',
          stage: 'report',
          message: `run state is not a strictly valid consistent snapshot: ${error.message}`,
          cause: error,
        });
      }
      throw error;
    }
    if (snapshot === null) {
      throw new ApexError({
        code: 'RUN_NOT_FOUND',
        stage: 'report',
        message: 'no run.json exists; nothing to report',
      });
    }
    const { run, tasks } = snapshot;
    if (!isTerminalRunStatus(run.status)) {
      throw new ApexError({
        code: 'REPORT_NOT_AVAILABLE',
        stage: 'report',
        message: `run ${run.runId} is ${run.status}; report is only available for terminal runs`,
      });
    }

    let planRevisions;
    let finalReviewResult: FinalReviewResult | null;
    try {
      planRevisions = await readCompletePlanRevisionHistory(deps.stateStore, run);

      // Final Review 的 tests 只存在于其不可变 Session Record 结构化结果中。
      finalReviewResult = null;
      const lastReview = run.finalReviewEpisodes.at(-1);
      if (lastReview !== undefined) {
        const record = await deps.stateStore.readSessionRecord(lastReview.sessionId);
        if (record?.structuredResult != null && record.type === 'final_review') {
          finalReviewResult = record.structuredResult as FinalReviewResult;
        }
      }
    } catch (error) {
      if (isApexError(error) && error.errorCode === 'STATE_VALIDATION_FAILED') {
        throw new ApexError({
          code: 'COMMAND_STATE_INVALID',
          stage: 'report',
          message: `committed report facts are incomplete or invalid: ${error.message}`,
          cause: error,
        });
      }
      throw error;
    }

    let reportPath: string;
    try {
      /**
       * SPEC §3.2：每次生成最终报告前重算权威 SPEC。终态 Run 不允许因
       * SPEC 后续变化而改写快照，因此不一致时只让本次 report 命令失败。
       */
      const currentSpec = await deps.git.readSpecFact(run.repository.root, run.spec.path);
      if (currentSpec.sha256 !== run.spec.sha256) {
        throw reportCommandFailed(
          `SPEC ${run.spec.path} changed after run ${run.runId} became terminal`,
        );
      }
      const gitFact = await deps.git.readRepositoryStatus(run.repository.root);
      reportPath = await deps.reporter.generateReport({
        run,
        tasks,
        planRevisions,
        git: {
          currentBranch: gitFact.head.branch,
          headOid: gitFact.head.oid,
          statusEntries: gitFact.statusEntries,
        },
        finalReviewResult,
      });
    } catch (error) {
      if (isApexError(error) && error.errorCode === 'REPORT_COMMAND_FAILED') {
        throw error;
      }
      throw reportCommandFailed(
        error instanceof Error ? error.message : String(error),
        error,
      );
    }
    /*
     * CLI 终态摘要只能使用本次一致性快照已经确认的 Run ID。
     * 显式返回该事实，避免 Interface 为展示报告归属再次读取 run.json。
     */
    return { runId: run.runId, reportPath };
  }

  return { execute };
}
