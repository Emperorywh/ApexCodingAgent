/**
 * RunFinalReview 用例（SPEC §14 Final Review 与完成、§12.3/§12.4
 * Checkpoint、§3.2 Final Review 期间 SPEC 变化五步、§14.4 报告生成）。
 *
 * 结果处理六步（§14.2）：保存 Session Record → 创建或确认 Final Review
 * Checkpoint → replan_required 转 planning → completed 生成 report.md →
 * 保存 Final Commit 与报告路径 → Run 转 completed。final_review 期间任一
 * 步失败都使 Run 转 failed；首次报告生成失败用 FINAL_REPORT_GENERATION_FAILED。
 *
 * SPEC SHA-256 边界（§3.2）：Session 启动前、正常结束后提交结论前、生成
 * 报告前。任一边界发现变化都不提交基于旧 SPEC 的结论，按五步变化流程转
 * planning 并通过新增 pending Task 表达新需求。
 */
import { ApexError } from '../../domain/errors.js';
import {
  closeFinalReviewEpisode,
  type FinalReviewEpisodeEnding,
} from '../../domain/episodes.js';
import { validateFinalReviewResultSemantics } from '../../domain/results.js';
import { applyRunEvent } from '../../domain/run-state.js';
import { formatRfc3339Utc } from '../../domain/time.js';
import type { PlanRevisionTrigger } from '../../domain/schemas/plan-revision-snapshot.js';
import type { RunJson } from '../../domain/schemas/run-json.js';
import { buildFinalReviewPrompt } from '../prompts/final-review.js';
import type { CheckpointOutcome } from '../ports/GitPort.js';
import type { UseCaseDeps } from '../usecase-deps.js';
import {
  beginSession,
  ensureFailedSessionRecord,
  invokeSession,
  sessionGitFacts,
  writeCompletedSessionRecord,
  type ActiveSessionHandle,
} from './claude-session.js';
import {
  closeFinalReviewEpisodeAsSessionError,
  persistRunBestEffort,
  toTerminalFailedRun,
} from './run-transitions.js';
import { toErrorRecord } from './error-record.js';
import { readCompletePlanRevisionHistory } from './plan-revision-history.js';

export type RunFinalReviewResult =
  /** Run 已持久化为 completed（含 report.md 与 Final Commit）。 */
  | { readonly kind: 'completed'; readonly run: RunJson }
  /** Run 已转 planning，等待新 Revision（replan_required 或 SPEC 变化）。 */
  | {
      readonly kind: 'replan-needed';
      readonly run: RunJson;
      readonly trigger: PlanRevisionTrigger;
    }
  /** Run 已持久化为 failed。 */
  | { readonly kind: 'failed'; readonly run: RunJson };

export function createRunFinalReview(deps: UseCaseDeps): {
  execute(): Promise<RunFinalReviewResult>;
} {
  const now = (): string => formatRfc3339Utc(deps.clock.now());

  async function failTerminal(run: RunJson, error: ApexError): Promise<RunFinalReviewResult> {
    const terminal = toTerminalFailedRun(run, error, now(), deps.redaction);
    await persistRunBestEffort(deps, terminal);
    return { kind: 'failed', run: terminal };
  }

  /** 会话启动后的失败收尾：尽力写失败 Record、关 FR Episode 为 session_error、清槽、Run failed。 */
  async function failWithSession(
    handle: ActiveSessionHandle<'final_review'>,
    error: ApexError,
  ): Promise<RunFinalReviewResult> {
    await ensureFailedSessionRecord(deps, handle, error);
    const closed = closeFinalReviewEpisodeAsSessionError(
      handle.run,
      handle.sessionId,
      error,
      now(),
      handle.specSha256,
      deps.redaction,
    );
    return failTerminal(closed, error);
  }

  /**
   * Final Review Checkpoint 已成功后的失败收尾。
   *
   * 此时 Git HEAD 已经前移，不能再使用 Session 启动时的 repository 事实。
   * 失败 Run 将该提交作为 Final Review 中间 Checkpoint 留在 Episode 中，
   * 并同步 expectedHead；这样报告与后续诊断不会遗漏已真实存在的提交。
   */
  async function failAfterCheckpoint(
    handle: ActiveSessionHandle<'final_review'>,
    error: ApexError,
    checkpoint: CheckpointOutcome,
  ): Promise<RunFinalReviewResult> {
    await ensureFailedSessionRecord(deps, handle, error);
    const at = now();
    const summary = deps.redaction.redactText(error.message) || error.errorCode;
    const closed: RunJson = {
      ...handle.run,
      finalReviewEpisodes: closeFinalReviewEpisode(
        handle.run.finalReviewEpisodes,
        handle.sessionId,
        {
          specSha256After: handle.specSha256,
          endedAt: at,
          decision: 'session_error',
          summary,
          reviewedTaskIds: [],
          changedAreas: [],
          checkpointRole: 'final-review-intermediate',
          checkpoint: checkpoint.finalOid,
          checkpointReason: checkpoint.reason,
          error: toErrorRecord(error, at, deps.redaction),
        },
      ),
      repository: { ...handle.run.repository, expectedHead: checkpoint.finalOid },
    };
    return failTerminal(closed, error);
  }

  /** 关闭当前 Final Review Episode（纯函数段）。 */
  function closeEpisode(
    run: RunJson,
    sessionId: string,
    ending: Omit<FinalReviewEpisodeEnding, 'specSha256After' | 'endedAt'>,
    specSha256After: string,
  ): RunJson {
    return {
      ...run,
      finalReviewEpisodes: closeFinalReviewEpisode(run.finalReviewEpisodes, sessionId, {
        ...ending,
        specSha256After,
        endedAt: now(),
      }),
    };
  }

  /** §3.2 变化流程的公共收尾：§12.3 中间 Checkpoint + Episode + Run 转 planning。 */
  async function finishSpecChanged(
    run: RunJson,
    handle: ActiveSessionHandle<'final_review'>,
    sessionStartHead: string,
    specSha256After: string,
    episodeInput: Omit<FinalReviewEpisodeEnding, 'specSha256After' | 'endedAt' | 'checkpointRole' | 'checkpoint' | 'checkpointReason'>,
    trigger: Omit<PlanRevisionTrigger, 'sourceSessionId'>,
  ): Promise<RunFinalReviewResult> {
    let checkpoint;
    try {
      checkpoint = await deps.git.createIntermediateCheckpoint(run.repository.root, {
        facts: sessionGitFacts(run),
        sessionStartHead,
        runId: run.runId,
        planRevision: run.planRevision,
        sessionId: handle.sessionId,
        source: { kind: 'final-review' },
      });
    } catch (error) {
      return failWithSession(handle, error as ApexError);
    }
    let next = closeEpisode(handle.run, handle.sessionId, {
      ...episodeInput,
      checkpointRole: checkpoint.noChanges ? null : 'final-review-intermediate',
      checkpoint: checkpoint.noChanges ? null : checkpoint.finalOid,
      checkpointReason: checkpoint.reason,
    }, specSha256After);
    next = {
      ...next,
      status: applyRunEvent(next.status, 'SPEC_CHANGED'),
      activeSession: null,
      currentTaskId: null,
      // §12.3 第 5 步：中间 Checkpoint 追加到 run.json（无变更则不追加）。
      intermediateCheckpoints: checkpoint.noChanges
        ? next.intermediateCheckpoints
        : [
            ...next.intermediateCheckpoints,
            {
              oid: checkpoint.finalOid,
              role: 'final-review-intermediate' as const,
              sourceSessionId: handle.sessionId,
              taskId: null,
              planRevision: run.planRevision,
              summary: 'SPEC changed during final review',
              ownerTaskId: null,
            },
          ],
      repository: { ...next.repository, expectedHead: checkpoint.finalOid },
      stateRevision: next.stateRevision + 1,
      updatedAt: now(),
    };
    await deps.stateStore.writeRun(next);
    return {
      kind: 'replan-needed',
      run: next,
      trigger: { ...trigger, sourceSessionId: handle.sessionId },
    };
  }

  async function execute(): Promise<RunFinalReviewResult> {
    const run = await deps.stateStore.readRun();
    if (run === null || run.status !== 'final_review') {
      throw new ApexError({
        code: 'STATE_VALIDATION_FAILED',
        stage: 'final_review',
        message: `RunFinalReview requires a final_review run, got ${run?.status ?? 'none'}`,
      });
    }
    const tasks = await deps.stateStore.readTasks();
    if (tasks === null) {
      throw new ApexError({
        code: 'STATE_VALIDATION_FAILED',
        stage: 'final_review',
        message: 'final_review run requires tasks.json',
      });
    }
    const root = run.repository.root;

    // §3.2：Session 启动前重算 SPEC SHA-256。
    const specBefore = await deps.git.readSpecFact(root, run.spec.path);
    if (specBefore.sha256 !== run.spec.sha256) {
      const replanning: RunJson = {
        ...run,
        status: applyRunEvent(run.status, 'SPEC_CHANGED'),
        stateRevision: run.stateRevision + 1,
        updatedAt: now(),
      };
      await deps.stateStore.writeRun(replanning);
      return {
        kind: 'replan-needed',
        run: replanning,
        trigger: {
          type: 'spec_changed',
          reason: 'SPEC changed outside a session',
          sourceSessionId: null,
        },
      };
    }

    let startFact;
    try {
      startFact = await deps.git.assertSessionStart(root, sessionGitFacts(run));
    } catch (error) {
      return failTerminal(run, error as ApexError);
    }

    const prompt = buildFinalReviewPrompt({
      repositoryRoot: root,
      runBranch: run.repository.runBranch,
      specPath: run.spec.path,
      specSha256: specBefore.sha256,
      planRevision: run.planRevision,
      completedTasks: tasks.tasks.map((task) => {
        const state = run.tasks[task.id]!;
        return {
          definition: task,
          resultSummary: state.completedResult!.summary,
          acceptanceEvidence: state.completedResult!.acceptanceEvidence,
          finalCheckpoint: state.finalCheckpoint!,
          tests: state.completedResult!.tests,
        };
      }),
      skippedTasks: Object.values(run.tasks)
        .filter((state) => state.status === 'skipped')
        .map((state) => ({ taskId: state.taskId, skipReason: state.skipReason! })),
      intermediateCheckpoints: run.intermediateCheckpoints,
    });

    // §6.3：写 activeSession + 未结束 FR Episode，保存后启动进程。
    const sessionInput = {
      type: 'final_review' as const,
      taskId: null,
      planRevision: run.planRevision,
      specSha256: specBefore.sha256,
      prompt,
      permissionMode: run.runSettings.executionPermissionMode,
      repositoryRoot: root,
    };
    const handle = await beginSession(deps, run, sessionInput);

    let fact;
    try {
      fact = await invokeSession(deps, handle, sessionInput);
    } catch (error) {
      return failWithSession(handle, error as ApexError);
    }

    /**
     * Session Record 写入与结束后的 SPEC 重读共同属于 Final Review Session
     * 收尾阶段；任一步失败都关闭未结束 Episode，而不是交给驱动器的通用
     * failed 转换留下半结束事实。
     */
    let specAfter;
    try {
      await writeCompletedSessionRecord(deps, handle, fact);
      specAfter = await deps.git.readSpecFact(root, run.spec.path);
    } catch (error) {
      return failWithSession(handle, error as ApexError);
    }
    const result = fact.structuredResult;
    if (specAfter.sha256 !== specBefore.sha256) {
      // §3.2 Final Review 期间 SPEC 变化五步。
      return finishSpecChanged(run, handle, startFact.head, specAfter.sha256, {
        decision: 'spec_changed',
        summary: deps.redaction.redactText(result.summary) || 'spec changed during final review',
        reviewedTaskIds: [...result.reviewedTaskIds],
        changedAreas: deps.redaction.redactStructured(result.changedAreas),
        error: null,
      }, {
        type: 'spec_changed',
        reason: 'SPEC changed during final review',
      });
    }

    // §14.1 语义校验：reviewedTaskIds 精确匹配、completed 无失败测试等。
    try {
      validateFinalReviewResultSemantics(result, tasks.tasks.map((task) => task.id));
    } catch (error) {
      return failWithSession(handle, error as ApexError);
    }

    if (result.decision === 'replan_required') {
      // §12.4 第 4 步 + §14.2 第 3 步：中间 Checkpoint，Run 转 planning。
      let checkpoint;
      try {
        checkpoint = await deps.git.createIntermediateCheckpoint(root, {
          facts: sessionGitFacts(run),
          sessionStartHead: startFact.head,
          runId: run.runId,
          planRevision: run.planRevision,
          sessionId: handle.sessionId,
          source: { kind: 'final-review' },
        });
      } catch (error) {
        return failWithSession(handle, error as ApexError);
      }
      let next = closeEpisode(handle.run, handle.sessionId, {
        decision: 'replan_required',
        summary: deps.redaction.redactText(result.summary) || 'replan required',
        reviewedTaskIds: [...result.reviewedTaskIds],
        changedAreas: deps.redaction.redactStructured(result.changedAreas),
        checkpointRole: checkpoint.noChanges ? null : 'final-review-intermediate',
        checkpoint: checkpoint.noChanges ? null : checkpoint.finalOid,
        checkpointReason: checkpoint.reason,
        error: null,
      }, specAfter.sha256);
      next = {
        ...next,
        status: applyRunEvent(next.status, 'REPLAN_REQUESTED'),
        activeSession: null,
        currentTaskId: null,
        // §12.3 第 5 步：中间 Checkpoint 追加到 run.json（无变更则不追加）。
        intermediateCheckpoints: checkpoint.noChanges
          ? next.intermediateCheckpoints
          : [
              ...next.intermediateCheckpoints,
              {
                oid: checkpoint.finalOid,
                role: 'final-review-intermediate' as const,
                sourceSessionId: handle.sessionId,
                taskId: null,
                planRevision: run.planRevision,
                summary: `replan required by final review: ${deps.redaction.redactText(result.replanReason ?? '')}`,
                ownerTaskId: null,
              },
            ],
        repository: { ...next.repository, expectedHead: checkpoint.finalOid },
        stateRevision: next.stateRevision + 1,
        updatedAt: now(),
      };
      await deps.stateStore.writeRun(next);
      return {
        kind: 'replan-needed',
        run: next,
        trigger: {
          type: 'final_review_replan',
          reason: result.replanReason!,
          sourceSessionId: handle.sessionId,
        },
      };
    }

    // §14.2 第 2 步 + §12.4：创建或确认 Final Review Checkpoint。
    let checkpoint;
    try {
      checkpoint = await deps.git.createFinalReviewCheckpoint(root, {
        facts: sessionGitFacts(run),
        sessionStartHead: startFact.head,
        runId: run.runId,
        planRevision: run.planRevision,
        sessionId: handle.sessionId,
      });
    } catch (error) {
      return failWithSession(handle, error as ApexError);
    }
    /**
     * Checkpoint 可能耗时并允许外部编辑 SPEC，因此在真正生成报告之前再次
     * 重算哈希。若此窗口发生变化，刚产生的提交由 §12.3 流程转为受接管的
     * 中间 Checkpoint，不提交旧 SPEC 下的 completed 结论。
     */
    let specAtReportBoundary;
    try {
      specAtReportBoundary = await deps.git.readSpecFact(root, run.spec.path);
    } catch (error) {
      return failAfterCheckpoint(handle, error as ApexError, checkpoint);
    }
    if (specAtReportBoundary.sha256 !== specBefore.sha256) {
      return finishSpecChanged(run, handle, startFact.head, specAtReportBoundary.sha256, {
        decision: 'spec_changed',
        summary: deps.redaction.redactText(result.summary) || 'spec changed before final report',
        reviewedTaskIds: [...result.reviewedTaskIds],
        changedAreas: deps.redaction.redactStructured(result.changedAreas),
        error: null,
      }, {
        type: 'spec_changed',
        reason: 'SPEC changed before final report generation',
      });
    }

    const closedEpisode = closeEpisode(handle.run, handle.sessionId, {
      decision: 'completed',
      summary: deps.redaction.redactText(result.summary) || 'final review completed',
      reviewedTaskIds: [...result.reviewedTaskIds],
      changedAreas: deps.redaction.redactStructured(result.changedAreas),
      checkpointRole: 'final-review-final',
      checkpoint: checkpoint.finalOid,
      checkpointReason: checkpoint.reason,
      error: null,
    }, specAfter.sha256);
    const withEpisode: RunJson = {
      ...closedEpisode,
      repository: { ...closedEpisode.repository, expectedHead: checkpoint.finalOid },
    };

    // §14.2 第 4–6 步：从事实源生成 report.md，保存 Final Commit 与报告
    // 路径，Run 转 completed（§14.3 成功条件由 run.json 不变量兜底）。
    const candidate: RunJson = {
      ...withEpisode,
      status: applyRunEvent(withEpisode.status, 'FINAL_REVIEW_COMPLETED'),
      activeSession: null,
      currentTaskId: null,
      repository: { ...withEpisode.repository, expectedHead: checkpoint.finalOid },
      finalCommit: checkpoint.finalOid,
      reportPath: 'report.md',
      terminalAt: now(),
      stateRevision: withEpisode.stateRevision + 1,
      updatedAt: now(),
    };
    let planRevisions;
    try {
      planRevisions = await readCompletePlanRevisionHistory(deps.stateStore, run);
    } catch (error) {
      return failTerminal(withEpisode, error as ApexError);
    }
    let gitFact;
    try {
      gitFact = await deps.git.readRepositoryStatus(root);
    } catch (error) {
      return failTerminal(withEpisode, error as ApexError);
    }
    try {
      await deps.reporter.generateReport({
        run: candidate,
        tasks,
        planRevisions,
        git: {
          currentBranch: gitFact.head.branch,
          headOid: gitFact.head.oid,
          statusEntries: gitFact.statusEntries,
        },
        finalReviewResult: deps.redaction.redactStructured(result),
      });
    } catch (error) {
      // §14.2：首次报告生成失败 → FINAL_REPORT_GENERATION_FAILED → Run failed。
      const reportError =
        error instanceof ApexError
          ? error
          : new ApexError({
              code: 'FINAL_REPORT_GENERATION_FAILED',
              stage: 'report',
              message: error instanceof Error ? error.message : String(error),
              cause: error,
            });
      return failTerminal(withEpisode, reportError);
    }
    try {
      await deps.stateStore.writeRun(candidate);
    } catch (error) {
      return failTerminal(withEpisode, error as ApexError);
    }
    return { kind: 'completed', run: candidate };
  }

  return { execute };
}
