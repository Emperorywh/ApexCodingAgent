/**
 * 独立 Plan Review 用例：读取已持久化草稿引用，在全新只读 Session 中复核，
 * 只有 approved 才提交 Plan Revision；changes_required 则保存结构化反馈并
 * 回到下一趟 Planning。草稿与复核结果始终来自不可变 Session Record。
 */
import { ApexError } from '../../domain/errors.js';
import { validatePlanReviewResultSemantics } from '../../domain/results.js';
import type { PlanReviewResult } from '../../domain/schemas/plan-review-result.js';
import { MAX_PLAN_REVIEW_ATTEMPTS, type RunJson } from '../../domain/schemas/run-json.js';
import type { TaskPlanDraft } from '../../domain/schemas/task-plan-draft.js';
import { formatRfc3339InSystemTimeZone } from '../../domain/time.js';
import {
  buildPlanReviewPrompt,
  buildPlanReviewResumePrompt,
} from '../prompts/plan-review.js';
import type { UseCaseDeps } from '../usecase-deps.js';
import { applyPlanRevision, preparePlanRevisionMerge } from './apply-plan-revision.js';
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
    try {
      draft = await readCandidateDraft(run);
      preparePlanRevisionMerge(run, tasks, draft);
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
      draft,
    });
    const invocation = await invokeResumableSession(deps, {
      run,
      session: {
        type: 'plan_review',
        taskId: null,
        planRevision: candidate.planRevision,
        specSha256: specBefore.sha256,
        permissionMode: 'plan',
        repositoryRoot: root,
      },
      freshPrompt: prompt,
      resume:
        options?.resumeFromSessionId === undefined
          ? null
          : {
              sessionId: options.resumeFromSessionId,
              prompt: buildPlanReviewResumePrompt(),
            },
      closeResumeAttempt: (handle) => handle.run,
    });
    if (invocation.kind === 'failed') {
      return failWithSession(invocation.handle, invocation.error);
    }
    const { handle, fact } = invocation;

    try {
      await writeCompletedSessionRecord(deps, handle, fact);
      await deps.git.assertSessionEnd(root, sessionGitFacts(run), startFact);
    } catch (error) {
      return failWithSession(handle, error as ApexError);
    }

    let specAfter;
    try {
      specAfter = await deps.git.readSpecFact(root, run.spec.path);
    } catch (error) {
      return failWithSession(handle, error as ApexError);
    }
    if (specAfter.sha256 !== specBefore.sha256) {
      return discardCandidateForSpecChange(handle.run);
    }

    const result: PlanReviewResult = fact.structuredResult;
    try {
      validatePlanReviewResultSemantics(
        result,
        draft.tasks.map((task) => task.id),
      );
    } catch (error) {
      return failWithSession(handle, error as ApexError);
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

    if (candidate.reviewAttempt >= MAX_PLAN_REVIEW_ATTEMPTS) {
      return failWithSession(
        handle,
        new ApexError({
          code: 'PLAN_REVIEW_REWORK_LIMIT_EXCEEDED',
          stage: 'plan_review',
          message:
            `independent plan review requested changes ${candidate.reviewAttempt} times ` +
            `for revision ${candidate.planRevision}; planning is not converging`,
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
