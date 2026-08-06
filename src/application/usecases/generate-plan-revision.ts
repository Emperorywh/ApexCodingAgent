/**
 * GeneratePlanRevision 用例（SPEC §7.1 Planning Session、§8.2 步骤 6–8、
 * §13 步骤 5–9 的 Planning 段、§3.2 SPEC 变化边界）。
 *
 * 流程：重算 SPEC SHA（§3.2 启动前边界）→ Planning 前置 Git 不变量
 * （§8.3，含 Planning 快照）→ §6.3 会话生命周期（先写 activeSession 再启动
 * 进程）→ 写 completed Session Record → Planning 副作用检测 → SPEC 结束后
 * 重算（变化则丢弃草稿、保持 planning 由驱动器重跑）→ 确定性校验草稿 →
 * 持久化候选引用。Revision 只由后续独立 Plan Review 批准后提交。
 *
 * 失败语义：会话未启动的启动期失败直接终态 failed；会话启动后的失败先
 * 尽力写失败 Session Record（已完成 Record 不可变、不补写），再清槽并把
 * Run 转 failed；外部失败不自动重试、不降级。
 *
 * 唯一的例外是草稿确定性校验打回（PLAN_INVALID / PLAN_REVISION_CONFLICT）：
 * 校验结论精确且可由模型定向修正，因此续接刚完成的 Planner 会话（原
 * transcript 保留完整 SPEC 与仓库分析），把校验错误作为反馈交还模型，
 * 最多修正 MAX_PLAN_DRAFT_CORRECTIONS 轮；仍不通过才按终态失败收尾。
 * 该回路与独立 Plan Review 的语义打回反馈回路同级，不修复草稿本身
 * （SPEC §7.5 仍原样拒绝），只是不把可修正的模型疏漏升级为整 Run 终止。
 */
import { ApexError, isApexError } from '../../domain/errors.js';
import { formatRfc3339InSystemTimeZone } from '../../domain/time.js';
import type { PlanRevisionTrigger } from '../../domain/schemas/plan-revision-snapshot.js';
import type { PlanReviewResult } from '../../domain/schemas/plan-review-result.js';
import type { RunJson } from '../../domain/schemas/run-json.js';
import type { PlannedTask, TaskPlanDraft } from '../../domain/schemas/task-plan-draft.js';
import type { TasksJson } from '../../domain/schemas/tasks-json.js';
import {
  buildPlanningCorrectionAppendix,
  buildPlanningCorrectionPrompt,
  buildPlanningPrompt,
  buildPlanningResumePrompt,
  type CompletedTaskSummary,
  type SkippedTaskSummary,
} from '../prompts/planning.js';
import type { UseCaseDeps } from '../usecase-deps.js';
import { preparePlanRevisionMerge } from './apply-plan-revision.js';
import {
  ensureFailedSessionRecord,
  sessionGitFacts,
  writeCompletedSessionRecord,
  type ActiveSessionHandle,
} from './claude-session.js';
import { invokeResumableSession, type SessionResumeHint } from './resumable-session.js';
import { persistRunBestEffort, toTerminalFailedRun } from './run-transitions.js';
import { sanitizePlanRevisionTrigger } from './plan-revision-trigger.js';

/**
 * 同一趟 Planning 内确定性校验打回的最大修正轮数。
 *
 * 首轮草稿之后最多续接修正两轮（共三份草稿），与独立 Plan Review 的
 * 返工上限同量级；计数只在单次驱动内有效，进程崩溃后经 resume 重开时
 * 重新计数——与既有 resume 语义一致，不为此扩展持久化契约。
 */
export const MAX_PLAN_DRAFT_CORRECTIONS = 2;

/**
 * 只有草稿自身的确定性缺陷才可交还模型修正；Revision 上限、状态损坏与
 * 外部基础设施问题重规划也无法消除，不在修正回路内。
 */
function isCorrectablePlanDraftError(error: unknown): error is ApexError {
  return (
    isApexError(error) &&
    (error.errorCode === 'PLAN_INVALID' || error.errorCode === 'PLAN_REVISION_CONFLICT')
  );
}

export type GeneratePlanRevisionResult =
  /** 草稿已通过确定性校验并持久化引用，等待独立 Plan Review。 */
  | { readonly kind: 'review-needed'; readonly run: RunJson }
  /** SPEC 在 Planning 期间变化：草稿已丢弃，Run 保持 planning，由驱动器重跑。 */
  | { readonly kind: 'spec-changed'; readonly run: RunJson }
  /** Run 已持久化为 failed。 */
  | { readonly kind: 'failed'; readonly run: RunJson };

export interface GeneratePlanRevisionOptions {
  /** resume 命令传入的被中断 Planning Session ID，仅消费一次。 */
  readonly resumeFromSessionId?: string;
}

function completedTaskSummaries(run: RunJson, tasks: TasksJson | null): CompletedTaskSummary[] {
  if (tasks === null) return [];
  const definitionById = new Map(tasks.tasks.map((task) => [task.id, task]));
  return Object.values(run.tasks)
    .filter((state) => state.status === 'completed')
    .map((state) => ({
      definition: definitionById.get(state.taskId)!,
      resultSummary: state.completedResult!.summary,
      finalCheckpoint: state.finalCheckpoint!,
    }));
}

function pendingTasks(run: RunJson, tasks: TasksJson | null): PlannedTask[] {
  if (tasks === null) return [];
  return tasks.tasks.filter((task) => run.tasks[task.id]?.status === 'pending');
}

function skippedTaskSummaries(run: RunJson): SkippedTaskSummary[] {
  return Object.values(run.tasks)
    .filter((state) => state.status === 'skipped')
    .map((state) => ({ taskId: state.taskId, skipReason: state.skipReason! }));
}

/**
 * 从两个不可变 Session Record 恢复上一轮计划复核反馈。
 *
 * run.json 只保存引用；这里严格核对类型、状态与 Revision，任何交叉引用
 * 损坏都响亮失败，不回退为没有反馈的新规划。
 */
async function readPlanReviewFeedback(
  deps: UseCaseDeps,
  run: RunJson,
): Promise<{
  readonly rejectedDraft: TaskPlanDraft;
  readonly review: PlanReviewResult;
} | null> {
  const ref = run.planReviewFeedback;
  if (ref === null) return null;
  const [planner, reviewer] = await Promise.all([
    deps.stateStore.readSessionRecord(ref.plannerSessionId),
    deps.stateStore.readSessionRecord(ref.reviewerSessionId),
  ]);
  if (
    planner === null ||
    planner.type !== 'planning' ||
    planner.status !== 'completed' ||
    planner.planRevision !== ref.planRevision ||
    planner.structuredResult === null ||
    reviewer === null ||
    reviewer.type !== 'plan_review' ||
    reviewer.status !== 'completed' ||
    reviewer.planRevision !== ref.planRevision ||
    reviewer.structuredResult === null
  ) {
    throw new ApexError({
      code: 'STATE_VALIDATION_FAILED',
      stage: 'planning',
      message: `plan review feedback for revision ${ref.planRevision} has invalid session references`,
    });
  }
  return {
    rejectedDraft: planner.structuredResult as TaskPlanDraft,
    review: reviewer.structuredResult as PlanReviewResult,
  };
}

export function createGeneratePlanRevision(deps: UseCaseDeps): {
  execute(
    trigger: PlanRevisionTrigger,
    options?: GeneratePlanRevisionOptions,
  ): Promise<GeneratePlanRevisionResult>;
} {
  const now = (): string => formatRfc3339InSystemTimeZone(deps.clock.now());

  /** 终态失败收尾：清槽、lastError、terminalAt，尽力持久化（§15 state_error）。 */
  async function failTerminal(run: RunJson, error: ApexError): Promise<GeneratePlanRevisionResult> {
    deps.logger.log('error', 'planning.run_failed', {
      errorCode: error.errorCode,
      stage: error.stage,
      message: error.message,
    });
    const terminal = toTerminalFailedRun(run, error, now(), deps.redaction);
    await persistRunBestEffort(deps, terminal);
    return { kind: 'failed', run: terminal };
  }

  /** 会话启动后的失败收尾（§6.3 第 7 步 + §9.6）：先写失败 Record 再清槽。 */
  async function failWithSession(
    handle: ActiveSessionHandle<'planning'>,
    error: ApexError,
  ): Promise<GeneratePlanRevisionResult> {
    await ensureFailedSessionRecord(deps, handle, error);
    return failTerminal(handle.run, error);
  }

  async function execute(
    trigger: PlanRevisionTrigger,
    options?: GeneratePlanRevisionOptions,
  ): Promise<GeneratePlanRevisionResult> {
    /*
     * Trigger 在用例入口只清洗一次，后续日志、Planning Prompt 与不可变
     * Snapshot 共用同一安全事实，杜绝 replanReason 在分支间发生语义漂移。
     */
    const safeTrigger = sanitizePlanRevisionTrigger(trigger, deps.redaction);
    const run = await deps.stateStore.readRun();
    if (run === null || run.status !== 'planning') {
      throw new ApexError({
        code: 'STATE_VALIDATION_FAILED',
        stage: 'planning',
        message: `GeneratePlanRevision requires a planning run, got ${run?.status ?? 'none'}`,
      });
    }
    if (run.planCandidate !== null) {
      throw new ApexError({
        code: 'STATE_VALIDATION_FAILED',
        stage: 'planning',
        message: 'GeneratePlanRevision cannot replace a candidate awaiting independent review',
      });
    }
    const tasks = await deps.stateStore.readTasks();
    const root = run.repository.root;
    deps.logger.log('debug', 'planning.begin', {
      trigger: safeTrigger.type,
      reason: safeTrigger.reason,
      nextRevision: run.planRevision + 1,
    });

    // §3.2：Planning Session 启动前重算 SPEC SHA-256。
    let specBefore;
    try {
      specBefore = await deps.git.readSpecFact(root, run.spec.path);
    } catch (error) {
      return failTerminal(run, error as ApexError);
    }

    let planReviewFeedback;
    try {
      planReviewFeedback = await readPlanReviewFeedback(deps, run);
    } catch (error) {
      return failTerminal(run, error as ApexError);
    }
    const prompt = buildPlanningPrompt({
      repositoryRoot: root,
      runBranch: run.repository.runBranch,
      specPath: run.spec.path,
      specSha256: specBefore.sha256,
      previousPlan: tasks,
      completedTasks: completedTaskSummaries(run, tasks),
      pendingTasks: pendingTasks(run, tasks),
      skippedTasks: skippedTaskSummaries(run),
      replanTrigger: safeTrigger.type === 'initial' ? null : safeTrigger,
      unabsorbedCheckpoints: run.intermediateCheckpoints.filter((checkpoint) => {
        if (checkpoint.ownerTaskId === null) return true;
        return run.tasks[checkpoint.ownerTaskId]?.status !== 'completed';
      }),
      planReviewFeedback,
    });

    const sessionBase = {
      type: 'planning',
      taskId: null,
      planRevision: run.planRevision + 1,
      specSha256: specBefore.sha256,
      permissionMode: 'plan',
      repositoryRoot: root,
    } as const;

    /*
     * 确定性校验修正回路：首轮消费 resume 命令传入的一次性续接提示；草稿
     * 被确定性校验（SPEC §7.5）打回时改为续接刚完成的 Planner 会话——原
     * transcript 保留完整 SPEC 与仓库分析，模型凭精确校验结论定向修正，
     * 而不是丢弃整趟规划。每轮会话重新执行 §8.3 前置不变量，只读边界与
     * SPEC 复核语义与首轮完全一致；轮次有界，耗尽后按终态失败收尾。
     */
    let resumeHint: SessionResumeHint | null =
      options?.resumeFromSessionId === undefined
        ? null
        : {
            sessionId: options.resumeFromSessionId,
            prompt: buildPlanningResumePrompt(),
          };
    let freshPrompt = prompt;
    let sessionRun = run;
    let corrections = 0;

    for (;;) {
      // §8.3：Planning 前置 Git 不变量 + Planning 快照。
      let startFact;
      try {
        startFact = await deps.git.assertSessionStart(root, sessionGitFacts(sessionRun), {
          readOnlySessionType: 'planning',
        });
      } catch (error) {
        return failTerminal(sessionRun, error as ApexError);
      }

      const invocation = await invokeResumableSession(deps, {
        run: sessionRun,
        session: sessionBase,
        freshPrompt,
        resume: resumeHint,
        // Planning 没有 Episode；失败 Record 已由协调器保存，新 activeSession
        // 会在同一个 run.json 提交点直接接管旧槽位。
        closeResumeAttempt: (handle) => handle.run,
      });
      if (invocation.kind === 'failed') {
        return failWithSession(invocation.handle, invocation.error);
      }
      const { handle, fact } = invocation;

      // §6.3 第 5 步：先写 completed Session Record，再提交业务结果。
      try {
        await writeCompletedSessionRecord(deps, handle, fact);
      } catch (error) {
        return failWithSession(handle, error as ApexError);
      }

      // §8.3：Planning 副作用检测（不自动回滚）。
      try {
        await deps.git.assertSessionEnd(root, sessionGitFacts(sessionRun), startFact);
      } catch (error) {
        return failWithSession(handle, error as ApexError);
      }

      // §3.2：Session 正常结束后、提交结果前重算 SPEC SHA-256。
      let specAfter;
      try {
        specAfter = await deps.git.readSpecFact(root, run.spec.path);
      } catch (error) {
        return failWithSession(handle, error as ApexError);
      }
      if (specAfter.sha256 !== specBefore.sha256) {
        // SPEC 在 Planning 期间变化：草稿基于旧 SPEC，丢弃；SPEC_CHANGED
        // planning→planning 不换状态，清槽后由驱动器用新 SPEC 重跑。
        deps.logger.log('debug', 'planning.spec_changed', {
          sessionId: handle.sessionId,
          nextRevision: run.planRevision + 1,
        });
        const stayed: RunJson = {
          ...handle.run,
          activeSession: null,
          stateRevision: handle.run.stateRevision + 1,
          updatedAt: now(),
        };
        await deps.stateStore.writeRun(stayed);
        return { kind: 'spec-changed', run: stayed };
      }

      let draft: TaskPlanDraft | null = null;
      try {
        draft = deps.redaction.redactStructured(fact.structuredResult);
        preparePlanRevisionMerge(handle.run, tasks, draft);
        const reviewAttempt = (run.planReviewFeedback?.reviewAttempt ?? 0) + 1;
        const staged: RunJson = {
          ...handle.run,
          activeSession: null,
          planCandidate: {
            planRevision: run.planRevision + 1,
            plannerSessionId: handle.sessionId,
            specSha256: specBefore.sha256,
            trigger: safeTrigger,
            reviewAttempt,
          },
          planReviewFeedback: null,
          stateRevision: handle.run.stateRevision + 1,
          updatedAt: now(),
        };
        await deps.stateStore.writeRun(staged);
        deps.logger.log('debug', 'planning.candidate_staged', {
          sessionId: handle.sessionId,
          planRevision: staged.planCandidate!.planRevision,
          taskCount: draft.tasks.length,
          reviewAttempt,
        });
        return { kind: 'review-needed', run: staged };
      } catch (error) {
        if (
          draft !== null &&
          corrections < MAX_PLAN_DRAFT_CORRECTIONS &&
          isCorrectablePlanDraftError(error)
        ) {
          corrections += 1;
          // 校验消息嵌入模型生成的草稿事实，进入提示词与终端前统一脱敏。
          const safeMessage = deps.redaction.redactText(error.message);
          deps.logger.log('warn', 'planning.draft_correction', {
            sessionId: handle.sessionId,
            errorCode: error.errorCode,
            message: safeMessage,
            correction: corrections,
          });
          deps.output.writeLine(
            deps.redaction.redactText(
              `↻ 计划草稿未通过确定性校验 · ${error.errorCode} · ` +
                `续接 Planner 定向修正（第 ${corrections}/${MAX_PLAN_DRAFT_CORRECTIONS} 轮）· ${safeMessage}`,
            ),
          );
          resumeHint = {
            sessionId: handle.sessionId,
            prompt: buildPlanningCorrectionPrompt(safeMessage),
          };
          // resume 不可用时的全新会话没有原 transcript，必须随完整规划
          // 提示重新注入被拒草稿与校验结论。
          freshPrompt = `${prompt}\n\n${buildPlanningCorrectionAppendix(draft, safeMessage)}`;
          sessionRun = handle.run;
          continue;
        }
        return failWithSession(handle, error as ApexError);
      }
    }
  }

  return { execute };
}
