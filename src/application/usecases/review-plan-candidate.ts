/**
 * 独立 Plan Review 用例：读取已持久化草稿引用，在全新只读 Session 中复核，
 * 只有 approved 才提交 Plan Revision；changes_required 则保存结构化反馈并
 * 回到下一趟 Planning。草稿与复核结果始终来自不可变 Session Record。
 */
import { ApexError, type ErrorCode } from '../../domain/errors.js';
import {
  isPlanReviewResultInvalid,
  validatePlanReviewResultSemantics,
} from '../../domain/results.js';
import type { PlanReviewResult } from '../../domain/schemas/plan-review-result.js';
import {
  MAX_PLAN_REVIEW_ATTEMPTS,
  MAX_PLAN_REVIEW_REWORKS,
  type RunJson,
} from '../../domain/schemas/run-json.js';
import {
  isRetainedTaskReference,
  type PlannedTask,
  type TaskPlanDraft,
} from '../../domain/schemas/task-plan-draft.js';
import { formatRfc3339InSystemTimeZone } from '../../domain/time.js';
import {
  buildPlanReviewPrompt,
  buildPlanReviewRepairPrompt,
  buildPlanReviewResumePrompt,
} from '../prompts/plan-review.js';
import type { UseCaseDeps } from '../usecase-deps.js';
import {
  applyPlanRevision,
  completedTaskSummaries,
  preparePlanRevisionMerge,
} from './apply-plan-revision.js';
import {
  ensureFailedSessionRecord,
  sessionGitFacts,
  writeCompletedSessionRecord,
  type ActiveSessionHandle,
} from './claude-session.js';
import { invokeResumableSession } from './resumable-session.js';
import { persistRunBestEffort, toTerminalFailedRun } from './run-transitions.js';

export interface ReviewPlanCandidateOptions {
  /** resume 命令传入的被中断 Plan Review Session，只消费一次。 */
  readonly resumeFromSessionId?: string;
  /** 重开前 Run 的稳定失败原因，供续接提示如实陈述断点语境。 */
  readonly resumeCause?: ErrorCode;
}

export type ReviewPlanCandidateResult =
  | { readonly kind: 'committed'; readonly run: RunJson }
  | {
      readonly kind: 'changes-required';
      readonly run: RunJson;
      readonly reviewAttempt: number;
    }
  | { readonly kind: 'spec-changed'; readonly run: RunJson }
  | { readonly kind: 'failed'; readonly run: RunJson };

/**
 * 复核结果修复会话的有界次数（与 Execution / Task Review 结果修复同一语义）：
 * 进程正常结束但 PlanReviewResult 未过契约校验时接力一次；连续两次不合法
 * 说明结果通道系统性失配，按原路径转 failed。
 */
const MAX_RESULT_REPAIR_ATTEMPTS = 1;

export function createReviewPlanCandidate(deps: UseCaseDeps): {
  execute(options?: ReviewPlanCandidateOptions): Promise<ReviewPlanCandidateResult>;
} {
  const now = (): string => formatRfc3339InSystemTimeZone(deps.clock.now());

  async function failTerminal(
    run: RunJson,
    error: ApexError,
  ): Promise<ReviewPlanCandidateResult> {
    deps.logger.log('error', 'plan_review.run_failed', {
      errorCode: error.errorCode,
      stage: error.stage,
      message: error.message,
    });
    const terminal = toTerminalFailedRun(run, error, now(), deps.redaction);
    await persistRunBestEffort(deps, terminal);
    return { kind: 'failed', run: terminal };
  }

  async function failWithSession(
    handle: ActiveSessionHandle<'plan_review'>,
    error: ApexError,
  ): Promise<ReviewPlanCandidateResult> {
    await ensureFailedSessionRecord(deps, handle, error);
    return failTerminal(handle.run, error);
  }

  /** 严格解析候选引用所指向的 Planning Session Record。 */
  async function readCandidateDraft(run: RunJson): Promise<TaskPlanDraft> {
    const candidate = run.planCandidate;
    if (candidate === null) {
      throw new ApexError({
        code: 'STATE_VALIDATION_FAILED',
        stage: 'plan_review',
        message: 'Plan Review requires a persisted plan candidate',
      });
    }
    const record = await deps.stateStore.readSessionRecord(candidate.plannerSessionId);
    if (
      record === null ||
      record.type !== 'planning' ||
      record.status !== 'completed' ||
      record.planRevision !== candidate.planRevision ||
      record.specSha256 !== candidate.specSha256 ||
      record.structuredResult === null
    ) {
      throw new ApexError({
        code: 'STATE_VALIDATION_FAILED',
        stage: 'plan_review',
        message: `plan candidate references invalid Planning Session ${candidate.plannerSessionId}`,
      });
    }
    return record.structuredResult as TaskPlanDraft;
  }

  async function discardCandidateForSpecChange(run: RunJson): Promise<ReviewPlanCandidateResult> {
    const next: RunJson = {
      ...run,
      activeSession: null,
      planCandidate: null,
      planReviewFeedback: null,
      stateRevision: run.stateRevision + 1,
      updatedAt: now(),
    };
    await deps.stateStore.writeRun(next);
    return { kind: 'spec-changed', run: next };
  }

  async function execute(
    options?: ReviewPlanCandidateOptions,
  ): Promise<ReviewPlanCandidateResult> {
    const run = await deps.stateStore.readRun();
    if (run === null || run.status !== 'planning' || run.planCandidate === null) {
      throw new ApexError({
        code: 'STATE_VALIDATION_FAILED',
        stage: 'plan_review',
        message: 'ReviewPlanCandidate requires a planning run with a persisted candidate',
      });
    }
    const candidate = run.planCandidate;
    const tasks = await deps.stateStore.readTasks();
    let draft: TaskPlanDraft;
    let candidateTasks: ReturnType<typeof preparePlanRevisionMerge>['candidateTasks'];
    let retainedPendingTasks: PlannedTask[];
    /**
     * Reviewer 只评估草稿完整表达的变化（修改的 pending 与新增 Task）。
     * completed 与 retain 引用的未改 Task 都由合并投射，已经在
     * 上一 Revision 通过复核，不再重复放大候选和 taskAssessments。
     */
    let candidateDraft: TaskPlanDraft;
    try {
      draft = await readCandidateDraft(run);
      const merge = preparePlanRevisionMerge(run, tasks, draft);
      candidateTasks = merge.candidateTasks;
      candidateDraft = { ...draft, tasks: merge.candidateTasks };
      const retainedReferenceIds = new Set(
        draft.tasks.filter(isRetainedTaskReference).map((reference) => reference.id),
      );
      retainedPendingTasks = merge.tasks.filter((task) => retainedReferenceIds.has(task.id));
    } catch (error) {
      return failTerminal(run, error as ApexError);
    }

    const root = run.repository.root;
    let specBefore;
    try {
      specBefore = await deps.git.readSpecFact(root, run.spec.path);
    } catch (error) {
      return failTerminal(run, error as ApexError);
    }
    if (specBefore.sha256 !== candidate.specSha256) {
      return discardCandidateForSpecChange(run);
    }

    let startFact;
    try {
      startFact = await deps.git.assertSessionStart(root, sessionGitFacts(run), {
        readOnlySessionType: 'plan_review',
      });
    } catch (error) {
      return failTerminal(run, error as ApexError);
    }

    const prompt = buildPlanReviewPrompt({
      repositoryRoot: root,
      runBranch: run.repository.runBranch,
      specPath: run.spec.path,
      specSha256: specBefore.sha256,
      planRevision: candidate.planRevision,
      draft: candidateDraft,
      retainedPendingTasks,
      completedTasks: completedTaskSummaries(run, tasks),
    });

    /** 修复接力行：让前台看到复核结果为何被拒以及修复会话的启动。 */
    const progressResultRepair = (
      handle: ActiveSessionHandle<'plan_review'>,
      error: ApexError,
      attempt: number,
    ): void => {
      deps.output.writeLine(
        deps.redaction.redactText(
          `↻ 计划复核结果校验失败 · 会话 ${handle.sessionId.slice(0, 8)} · ` +
            `正在启动修复会话 ${attempt}/${MAX_RESULT_REPAIR_ATTEMPTS} · ${error.message}`,
        ),
      );
      deps.logger.log('warn', 'plan_review.result_repair', {
        sessionId: handle.sessionId,
        attempt,
        message: error.message,
      });
    };

    /** 修复会话提示词：附校验错误与（可解析时的）非法结果原文。 */
    const buildRepairPrompt = (error: ApexError, result: PlanReviewResult | null): string =>
      buildPlanReviewRepairPrompt({
        repositoryRoot: root,
        runBranch: run.repository.runBranch,
        specPath: run.spec.path,
        specSha256: specBefore.sha256,
        planRevision: candidate.planRevision,
        draft: candidateDraft,
        validationError: error.message,
        invalidResultJson: result === null ? null : JSON.stringify(result, null, 2),
      });

    /**
     * 单趟复核 + 领域语义门禁；结果契约失败时以有界修复会话接力（与
     * Execution / Task Review 结果修复同一形态）。Plan Review 没有 Episode，
     * 接力只需清掉 activeSession 并补失败 Record。鉴权、网络、普通非零退出
     * 和流失败都不自动重试；resume hint 仅首趟生效。
     */
    let sessionRun = run;
    let sessionPrompt = prompt;
    let repairAttempt = 0;
    let handle: ActiveSessionHandle<'plan_review'>;
    let result: PlanReviewResult;
    for (;;) {
      const invocation = await invokeResumableSession(deps, {
        run: sessionRun,
        session: {
          type: 'plan_review',
          taskId: null,
          planRevision: candidate.planRevision,
          specSha256: specBefore.sha256,
          permissionMode: 'plan',
          repositoryRoot: root,
        },
        freshPrompt: sessionPrompt,
        resume:
          repairAttempt === 0 && options?.resumeFromSessionId !== undefined
            ? {
                sessionId: options.resumeFromSessionId,
                prompt: buildPlanReviewResumePrompt({
                  cause: options.resumeCause ?? 'RUN_INTERRUPTED',
                }),
              }
            : null,
        closeResumeAttempt: (relayHandle) => relayHandle.run,
      });
      if (invocation.kind === 'failed') {
        const { handle: failedHandle, error: apex } = invocation;
        if (isPlanReviewResultInvalid(apex) && repairAttempt < MAX_RESULT_REPAIR_ATTEMPTS) {
          // 结构 Schema 未过：补失败 Record，接力结果修复会话。
          await ensureFailedSessionRecord(deps, failedHandle, apex);
          repairAttempt += 1;
          sessionRun = { ...failedHandle.run, activeSession: null };
          sessionPrompt = buildRepairPrompt(apex, null);
          progressResultRepair(failedHandle, apex, repairAttempt);
          continue;
        }
        return failWithSession(failedHandle, apex);
      }
      const { handle: completedHandle, fact } = invocation;

      let specAfter;
      try {
        await writeCompletedSessionRecord(deps, completedHandle, fact);
        await deps.git.assertSessionEnd(root, sessionGitFacts(run), startFact);
        specAfter = await deps.git.readSpecFact(root, run.spec.path);
      } catch (error) {
        return failWithSession(completedHandle, error as ApexError);
      }
      if (specAfter.sha256 !== specBefore.sha256) {
        return discardCandidateForSpecChange(completedHandle.run);
      }

      const rawResult: PlanReviewResult = fact.structuredResult;
      try {
        validatePlanReviewResultSemantics(
          rawResult,
          candidateTasks,
        );
      } catch (error) {
        const apex = error as ApexError;
        if (repairAttempt < MAX_RESULT_REPAIR_ATTEMPTS) {
          repairAttempt += 1;
          sessionRun = { ...completedHandle.run, activeSession: null };
          sessionPrompt = buildRepairPrompt(apex, rawResult);
          progressResultRepair(completedHandle, apex, repairAttempt);
          continue;
        }
        return failWithSession(completedHandle, apex);
      }
      handle = completedHandle;
      result = rawResult;
      break;
    }

    if (result.decision === 'approved') {
      try {
        const committed = await applyPlanRevision(deps, handle.run, tasks, {
          draft,
          trigger: candidate.trigger,
          plannerSessionId: candidate.plannerSessionId,
          planReviewerSessionId: handle.sessionId,
          specSha256: candidate.specSha256,
          repositoryRoot: root,
        });
        deps.logger.log('debug', 'plan_review.approved', {
          sessionId: handle.sessionId,
          plannerSessionId: candidate.plannerSessionId,
          planRevision: committed.planRevision,
          reviewAttempt: candidate.reviewAttempt,
        });
        return { kind: 'committed', run: committed };
      } catch (error) {
        return failWithSession(handle, error as ApexError);
      }
    }

    /**
     * reviewAttempt=1 对应初始候选，不消耗返工额度。只有第四份候选仍被
     * 打回时，才表示三次 Planner 返工均未通过；第三份反馈必须先交给
     * Planner，不能在反馈刚产生时直接把 Run 判为“不收敛”。
     */
    if (candidate.reviewAttempt >= MAX_PLAN_REVIEW_ATTEMPTS) {
      return failWithSession(
        handle,
        new ApexError({
          code: 'PLAN_REVIEW_REWORK_LIMIT_EXCEEDED',
          stage: 'plan_review',
          message:
            `independent plan review still requested changes after ` +
            `${MAX_PLAN_REVIEW_REWORKS} replanning rounds ` +
            `(${candidate.reviewAttempt} reviews) for revision ${candidate.planRevision}; ` +
            `planning is not converging`,
          sessionId: handle.sessionId,
        }),
      );
    }

    const next: RunJson = {
      ...handle.run,
      activeSession: null,
      planCandidate: null,
      planReviewFeedback: {
        planRevision: candidate.planRevision,
        plannerSessionId: candidate.plannerSessionId,
        reviewerSessionId: handle.sessionId,
        reviewAttempt: candidate.reviewAttempt,
      },
      stateRevision: handle.run.stateRevision + 1,
      updatedAt: now(),
    };
    await deps.stateStore.writeRun(next);
    deps.logger.log('warn', 'plan_review.changes_required', {
      sessionId: handle.sessionId,
      plannerSessionId: candidate.plannerSessionId,
      planRevision: candidate.planRevision,
      reviewAttempt: candidate.reviewAttempt,
      issueCount:
        result.issues.length +
        result.taskAssessments.reduce((count, assessment) => count + assessment.issues.length, 0),
    });
    return {
      kind: 'changes-required',
      run: next,
      reviewAttempt: candidate.reviewAttempt,
    };
  }

  return { execute };
}
