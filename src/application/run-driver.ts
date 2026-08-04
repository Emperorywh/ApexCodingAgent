/**
 * Run 驱动器（SPEC §5.4 运行模型、§2.4 中断收尾的应用层部分、§17 start
 * 进度摘要）：前台串行调度循环 planning → 独立 plan_review → 每个 Task
 * 的 execution → 独立 task_review → final_review → 终态。
 *
 * - 顶层 Task 串行、同一时刻最多一个 Claude Session；每次重要状态迁移输出
 *   一个经脱敏的标题/事实里程碑块。
 * - Plan Revision 触发原因（trigger）在进程内随循环传递：Execution/Final
 *   Review 给出的 replan 原因在下一轮 Planning 中使用；提交后清零。
 * - `requestInterrupt()` 只转发给中断控制器：停止启动新 Session、经绑定的
 *   abort 杀直接子进程；有界等待与收尾在会话原语（invokeSession）内完成。
 *   中断落在会话之外时（循环顶部检查），直接把当前 Run 收尾为 failed
 *   （RUN_INTERRUPTED）。
 */
import { ApexError, isApexError, type ErrorCode } from '../domain/errors.js';
import { isTerminalRunStatus } from '../domain/run-state.js';
import { formatRfc3339InSystemTimeZone } from '../domain/time.js';
import { selectTaskAwaitingReview } from '../domain/task-state.js';
import type { PlanRevisionTrigger } from '../domain/schemas/plan-revision-snapshot.js';
import type { ResumePoint, RunJson } from '../domain/schemas/run-json.js';
import {
  renderFinalReviewStarted,
  renderPlanCommitted,
  renderPlanReviewChangesRequired,
  renderPlanReviewStarted,
  renderReplanRequested,
  renderSpecReplanning,
  renderTaskCompleted,
  renderTaskReviewChangesRequired,
  renderTaskReviewStarted,
  type ProgressBlock,
} from './presentation/progress.js';
import type { UseCaseDeps } from './usecase-deps.js';
import { createExecuteNextTask, type ExecutionResumeHint } from './usecases/execute-next-task.js';
import { createGeneratePlanRevision } from './usecases/generate-plan-revision.js';
import { createReviewPlanCandidate } from './usecases/review-plan-candidate.js';
import { createRunFinalReview } from './usecases/run-final-review.js';
import { createReviewTask } from './usecases/review-task.js';
import { persistRunBestEffort, toTerminalFailedRun } from './usecases/run-transitions.js';

export interface RunDriver {
  /** 驱动当前 Run 到终态并返回终态 run.json。 */
  driveToTerminal(): Promise<RunJson>;
  /** 第一次中断信号（§2.4）：停止新 Session 并请求终止直接子进程。 */
  requestInterrupt(): void;
}

export interface RunDriverOptions {
  /**
   * resume 命令重开 Run 时传入的完整恢复上下文（SPEC §17 resume）。
   * point 决定调度位置，cause 保留重开前的失败语义，避免续接提示把回合
   * 耗尽、前台中断和普通非零退出错误地合并成同一种恢复策略：
   * - fromStatus 为 planning：首个 Revision 保持 initial，已有 Revision
   *   时首个 Planning 使用 run_resumed；存在 Session ID 时续接原对话；
   * - fromStatus 为 running 且 taskId/sessionId 非空：按 sessionType 只续接
   *   被中断的 Execution 或 Task Review；Reviewer 恢复点绝不传给 Execution；
   * - fromStatus 为 final_review：首个 Final Review 会话续接原对话；
   * - 会话之间的恢复点没有 Session ID，按正常新会话继续。
   */
  readonly resume?: {
    readonly point: ResumePoint;
    readonly cause: ErrorCode;
  };
}

const INITIAL_TRIGGER: PlanRevisionTrigger = {
  type: 'initial',
  reason: '初始计划',
  sourceSessionId: null,
};

export function createRunDriver(deps: UseCaseDeps, options?: RunDriverOptions): RunDriver {
  const generatePlanRevision = createGeneratePlanRevision(deps);
  const reviewPlanCandidate = createReviewPlanCandidate(deps);
  const executeNextTask = createExecuteNextTask(deps);
  const reviewTask = createReviewTask(deps);
  const runFinalReview = createRunFinalReview(deps);

  /** resume 恢复上下文：首次进入对应分支时消费一次，随后失效。 */
  const resumeContext = options?.resume ?? null;
  const resumePoint = resumeContext?.point ?? null;
  let planningResumeSessionId =
    resumePoint?.sessionType === 'planning' ? resumePoint.sessionId : null;
  let planReviewResumeSessionId =
    resumePoint?.sessionType === 'plan_review' ? resumePoint.sessionId : null;
  let planningResumePending = resumePoint?.fromStatus === 'planning';
  let executionResumeHint: ExecutionResumeHint | null =
    resumeContext !== null &&
    resumePoint !== null &&
    resumePoint.fromStatus === 'running' &&
    resumePoint.sessionType === 'execution' &&
    resumePoint.taskId !== null &&
    resumePoint.sessionId !== null
      ? {
          sessionId: resumePoint.sessionId,
          taskId: resumePoint.taskId,
          cause: resumeContext.cause,
        }
      : null;
  let taskReviewResumeSessionId =
    resumePoint?.sessionType === 'task_review' ? resumePoint.sessionId : null;
  let finalReviewResumeSessionId =
    resumePoint?.sessionType === 'final_review' ? resumePoint.sessionId : null;

  function progress(block: ProgressBlock): void {
    /*
     * 阶段摘要已经由 presentation 模块携带统一标题、缩进和空行层级。
     * 这里逐行执行脱敏与端口转发，不重新拼接多行字符串，也不解释业务事实。
     */
    for (const line of block) {
      deps.output.writeLine(deps.redaction.redactText(line));
    }
  }

  /** 意外失败兜底：尽力把当前 Run 收尾为 failed（state_error 仅输出诊断）。 */
  async function failUnexpected(error: unknown): Promise<RunJson> {
    const apex = isApexError(error)
      ? error
      : new ApexError({
          code: 'STATE_VALIDATION_FAILED',
          stage: 'driver',
          message: error instanceof Error ? error.message : String(error),
          cause: error,
        });
    deps.logger.log('error', 'driver.unexpected_error', {
      errorCode: apex.errorCode,
      stage: apex.stage,
      message: apex.message,
      stack: apex.stack ?? null,
    });
    const run = await deps.stateStore.readRun().catch(() => null);
    if (run === null || isTerminalRunStatus(run.status)) {
      throw apex;
    }
    const terminal = toTerminalFailedRun(
      run,
      apex,
      formatRfc3339InSystemTimeZone(deps.clock.now()),
      deps.redaction,
    );
    await persistRunBestEffort(deps, terminal);
    return terminal;
  }

  async function driveToTerminal(): Promise<RunJson> {
    let trigger: PlanRevisionTrigger = INITIAL_TRIGGER;
    for (;;) {
      const run = await deps.stateStore.readRun();
      if (run === null) {
        throw new ApexError({
          code: 'STATE_VALIDATION_FAILED',
          stage: 'driver',
          message: 'run.json disappeared while driving the run',
        });
      }
      if (isTerminalRunStatus(run.status)) return run;

      deps.logger.log('debug', 'driver.status', {
        runId: run.runId,
        status: run.status,
        stateRevision: run.stateRevision,
        planRevision: run.planRevision,
      });

      // §2.4：中断落在会话之外（无 activeSession）时直接有界收尾。
      if (deps.interrupt.requested && run.activeSession === null) {
        const interrupted = new ApexError({
          code: 'RUN_INTERRUPTED',
          stage: 'driver',
          message: 'foreground interrupt requested between sessions',
        });
        const terminal = toTerminalFailedRun(
          run,
          interrupted,
          formatRfc3339InSystemTimeZone(deps.clock.now()),
          deps.redaction,
        );
        await persistRunBestEffort(deps, terminal);
        return terminal;
      }

      try {
        switch (run.status) {
          case 'planning': {
            /**
             * 已持久化草稿必须先经过全新只读 Reviewer；只有没有候选时才允许
             * 启动下一趟 Planner，确保 Revision 提交点永远位于独立复核之后。
             */
            if (run.planCandidate !== null) {
              trigger = run.planCandidate.trigger;
              const review = await reviewPlanCandidate.execute(
                planReviewResumeSessionId === null
                  ? undefined
                  : { resumeFromSessionId: planReviewResumeSessionId },
              );
              planReviewResumeSessionId = null;
              planningResumePending = false;
              if (review.kind === 'committed') {
                deps.logger.log('debug', 'driver.plan_committed', {
                  runId: review.run.runId,
                  planRevision: review.run.planRevision,
                  taskCount: Object.keys(review.run.tasks).length,
                  approvedByIndependentReview: true,
                });
                progress(
                  renderPlanCommitted(
                    review.run.planRevision,
                    Object.keys(review.run.tasks).length,
                  ),
                );
                trigger = INITIAL_TRIGGER;
              } else if (review.kind === 'changes-required') {
                progress(renderPlanReviewChangesRequired(review.reviewAttempt));
              } else if (review.kind === 'spec-changed') {
                progress(renderSpecReplanning());
              } else {
                return review.run;
              }
              break;
            }
            /**
             * 首个 Revision 的领域不变量要求 trigger=initial；中断只改变
             * 会话执行方式，不改变“这是初始计划”的业务事实。已有 Revision
             * 后恢复 Planning 才使用 run_resumed 记录本次触发来源。
             */
            if (
              resumePoint !== null &&
              resumePoint.fromStatus === 'planning' &&
              planningResumePending
            ) {
              trigger = runPlanningResumeTrigger(resumePoint, run.planRevision);
            }
            const result = await generatePlanRevision.execute(
              trigger,
              planningResumeSessionId === null
                ? undefined
                : { resumeFromSessionId: planningResumeSessionId },
            );
            planningResumeSessionId = null;
            planningResumePending = false;
            if (result.kind === 'review-needed') {
              const stagedRevision = result.run.planCandidate?.planRevision ?? run.planRevision + 1;
              deps.logger.log('debug', 'driver.plan_review_needed', {
                runId: run.runId,
                planRevision: stagedRevision,
              });
              progress(renderPlanReviewStarted(stagedRevision));
            } else if (result.kind === 'spec-changed') {
              progress(renderSpecReplanning());
            } else {
              deps.logger.log('error', 'driver.run_failed', {
                runId: run.runId,
                status: 'planning',
                errorCode: result.run.lastError?.errorCode ?? 'unknown',
              });
              return result.run;
            }
            break;
          }
          case 'running': {
            const reviewTaskId = selectTaskAwaitingReview(run.tasks);
            if (reviewTaskId !== null) {
              const review = await reviewTask.execute(
                taskReviewResumeSessionId === null
                  ? undefined
                  : { resumeFromSessionId: taskReviewResumeSessionId },
              );
              taskReviewResumeSessionId = null;
              if (review.kind === 'task-completed') {
                const checkpoint = review.run.tasks[review.taskId]?.finalCheckpoint ?? '';
                deps.logger.log('debug', 'driver.task_completed', {
                  runId: run.runId,
                  taskId: review.taskId,
                  checkpoint,
                  approvedByIndependentReview: true,
                });
                progress(renderTaskCompleted(review.taskId, checkpoint));
              } else if (review.kind === 'changes-required') {
                deps.logger.log('warn', 'driver.task_review_changes_required', {
                  runId: run.runId,
                  taskId: review.taskId,
                });
                progress(renderTaskReviewChangesRequired(review.taskId));
              } else if (review.kind === 'replan-needed') {
                trigger = review.trigger;
                deps.logger.log('debug', 'driver.replan', {
                  runId: run.runId,
                  status: 'running',
                  trigger: review.trigger.type,
                  reason: review.trigger.reason,
                });
                progress(renderReplanRequested(review.trigger.type));
              } else {
                deps.logger.log('error', 'driver.run_failed', {
                  runId: run.runId,
                  status: 'running',
                  errorCode: review.run.lastError?.errorCode ?? 'unknown',
                });
                return review.run;
              }
              break;
            }
            const result = await executeNextTask.execute(
              executionResumeHint === null ? undefined : { resume: executionResumeHint },
            );
            executionResumeHint = null;
            if (result.kind === 'review-needed') {
              const checkpoint = result.run.tasks[result.taskId]?.candidateCheckpoint ?? '';
              deps.logger.log('debug', 'driver.task_review_needed', {
                runId: run.runId,
                taskId: result.taskId,
                checkpoint,
              });
              progress(renderTaskReviewStarted(result.taskId, checkpoint));
            } else if (result.kind === 'replan-needed') {
              trigger = result.trigger;
              deps.logger.log('debug', 'driver.replan', {
                runId: run.runId,
                status: 'running',
                trigger: result.trigger.type,
                reason: result.trigger.reason,
              });
              progress(renderReplanRequested(result.trigger.type));
            } else if (result.kind === 'final-review') {
              progress(renderFinalReviewStarted());
            } else {
              deps.logger.log('error', 'driver.run_failed', {
                runId: run.runId,
                status: 'running',
                errorCode: result.run.lastError?.errorCode ?? 'unknown',
              });
              return result.run;
            }
            break;
          }
          case 'final_review': {
            const result = await runFinalReview.execute(
              finalReviewResumeSessionId === null
                ? undefined
                : { resumeFromSessionId: finalReviewResumeSessionId },
            );
            finalReviewResumeSessionId = null;
            if (result.kind === 'completed') {
              deps.logger.log('debug', 'driver.run_completed', {
                runId: run.runId,
                reportPath: result.run.reportPath ?? 'report.md',
              });
              /*
               * Final Review 的 Session 完成行已经表达阶段结论；Run 的唯一
               * 命令终态由 CLI 根据 StartRun/ResumeRun 返回值统一封口。
               */
              return result.run;
            }
            if (result.kind === 'replan-needed') {
              trigger = result.trigger;
              deps.logger.log('debug', 'driver.replan', {
                runId: run.runId,
                status: 'final_review',
                trigger: result.trigger.type,
                reason: result.trigger.reason,
              });
              progress(renderReplanRequested(result.trigger.type));
            } else {
              deps.logger.log('error', 'driver.run_failed', {
                runId: run.runId,
                status: 'final_review',
                errorCode: result.run.lastError?.errorCode ?? 'unknown',
              });
              return result.run;
            }
            break;
          }
        }
      } catch (error) {
        return failUnexpected(error);
      }
    }
  }

  return {
    driveToTerminal,
    requestInterrupt(): void {
      deps.interrupt.request();
    },
  };
}

/**
 * Planning 恢复的 Revision trigger 由已提交 Revision 数决定。
 *
 * 该纯函数把“初始计划被中断”和“重规划被中断”明确分开，避免以恢复命令
 * 覆盖首个 Revision 必须保留的 initial 领域事实。
 */
function runPlanningResumeTrigger(
  resumePoint: ResumePoint,
  currentPlanRevision: number,
): PlanRevisionTrigger {
  return currentPlanRevision === 0
    ? INITIAL_TRIGGER
    : {
        type: 'run_resumed',
        reason: 'planning resumed after interrupt',
        sourceSessionId: resumePoint.sessionId,
      };
}
