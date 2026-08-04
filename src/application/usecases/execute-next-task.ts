/**
 * ExecuteNextTask 用例（SPEC §9 Task 执行全章、§12.2/§12.3 Checkpoint、
 * §13 Replan 步骤 1–4、§3.2 Execution 期间 SPEC 变化六步、§2.4 中断收尾）。
 *
 * 单趟执行：选择 Ready Task → §6.3 会话生命周期 → 按 decision 提交业务结果。
 * 所有失败路径都先把可获得的事实（Session Record、Episode、Git 事实）落盘，
 * 再把 Task 与 Run 转 failed；进程级失败不自动重试。唯二例外：
 * 1. 进程正常结束但结构化结果未过契约校验（Schema 或 §9.4 字段规则）时，
 *    以一次有界的结果修复会话接力——修复会话只重新返回合法结果，仍不合法
 *    才按原路径转 failed，避免已完成的工作因格式瑕疵整体报废；
 * 2. resume 命令重开 Run 后的第一趟会话（resume hint）：以
 *    `--resume --fork-session` 续接被中断的 Claude 会话；续接本身失败时
 *    仅在 Adapter 明确确认 transcript 不可用时，有界回退一趟全新会话
 *    （标准完整 prompt）；其他失败不自动重试。
 *
 * SPEC SHA-256 边界（§3.2）：Task 启动前（变化则转 planning 触发新 Revision）、
 * Session 正常结束后提交结果前（变化走六步变化流程）。
 */
import { ApexError, type ErrorCode } from '../../domain/errors.js';
import {
  closeExecutionEpisode,
  type ExecutionEpisodeEnding,
} from '../../domain/episodes.js';
import {
  isClaudeResultInvalid,
  normalizeExecutionResult,
  validateExecutionResultSemantics,
} from '../../domain/results.js';
import { applyRunEvent } from '../../domain/run-state.js';
import {
  assertTaskTransition,
  selectReadyTask,
  type TaskTransitionReason,
} from '../../domain/task-state.js';
import { formatRfc3339InSystemTimeZone } from '../../domain/time.js';
import type { PlanRevisionTrigger } from '../../domain/schemas/plan-revision-snapshot.js';
import type { RunJson } from '../../domain/schemas/run-json.js';
import type { TaskExecutionResult } from '../../domain/schemas/task-execution-result.js';
import type { PlannedTask } from '../../domain/schemas/task-plan-draft.js';
import { buildExecutionPrompt, buildExecutionResultRepairPrompt, buildExecutionResumePrompt, type TaskReviewFeedback } from '../prompts/execution.js';
import type { CheckpointOutcome, SessionStartFact, SpecFact } from '../ports/GitPort.js';
import type { UseCaseDeps } from '../usecase-deps.js';
import {
  ensureFailedSessionRecord,
  sessionGitFacts,
  writeCompletedSessionRecord,
  type ActiveSessionHandle,
} from './claude-session.js';
import { toErrorRecord } from './error-record.js';
import { invokeResumableSession } from './resumable-session.js';
import { persistRunBestEffort, toTerminalFailedRun } from './run-transitions.js';
import { publishCheckpoint } from './publish-checkpoint.js';

export type ExecuteNextTaskResult =
  /** Execution 候选结果与 Checkpoint 已持久化，等待独立 Task Review。 */
  | { readonly kind: 'review-needed'; readonly run: RunJson; readonly taskId: string }
  /** Run 已转 planning，等待新 Revision（replan_required 或 SPEC 变化）。 */
  | {
      readonly kind: 'replan-needed';
      readonly run: RunJson;
      readonly trigger: PlanRevisionTrigger;
    }
  /** 当前计划全部 Task completed，Run 已转 final_review。 */
  | { readonly kind: 'final-review'; readonly run: RunJson }
  /** Run 已持久化为 failed。 */
  | { readonly kind: 'failed'; readonly run: RunJson };

/**
 * 结果修复会话的有界次数：进程正常结束但结构化结果未过契约校验时接力
 * 一次；连续两次不合法说明结果通道系统性失配，按原路径转 failed。
 */
const MAX_RESULT_REPAIR_ATTEMPTS = 1;

/** invokeUntilValidResult 的产出：合法结果三元组，或已收尾的终态结果。 */
type SessionLoopOutcome =
  | {
      readonly kind: 'valid';
      readonly handle: ActiveSessionHandle<'execution'>;
      readonly result: TaskExecutionResult;
      readonly specAfter: SpecFact;
    }
  | { readonly kind: 'settled'; readonly settled: ExecuteNextTaskResult };

/**
 * resume 命令重开 Run 后由驱动器传入的续接提示：被中断 Execution 会话的
 * Claude Session ID 与 Task ID。仅在本次选中的 Task 与 hint 一致时生效。
 */
export interface ExecutionResumeHint {
  readonly sessionId: string;
  readonly taskId: string;
  /** 重开前 Run 的稳定失败原因，用于选择续接会话的收敛策略。 */
  readonly cause: ErrorCode;
}

export interface ExecuteNextTaskOptions {
  readonly resume?: ExecutionResumeHint;
}

export function createExecuteNextTask(deps: UseCaseDeps): {
  execute(options?: ExecuteNextTaskOptions): Promise<ExecuteNextTaskResult>;
} {
  const now = (): string => formatRfc3339InSystemTimeZone(deps.clock.now());

  /** 终态失败收尾：清槽、lastError、terminalAt，尽力持久化（§15 state_error）。 */
  async function failTerminal(run: RunJson, error: ApexError): Promise<ExecuteNextTaskResult> {
    deps.logger.log('error', 'execution.run_failed', {
      errorCode: error.errorCode,
      stage: error.stage,
      message: error.message,
    });
    const terminal = toTerminalFailedRun(run, error, now(), deps.redaction);
    await persistRunBestEffort(deps, terminal);
    return { kind: 'failed', run: terminal };
  }

  /** Task 转 failed（纯函数段）：合法 reason + 非空 ErrorRecord。 */
  function markTaskFailed(
    run: RunJson,
    taskId: string,
    reason: TaskTransitionReason,
    error: ApexError,
  ): RunJson {
    const task = run.tasks[taskId]!;
    assertTaskTransition(task.status, 'failed', reason);
    return {
      ...run,
      tasks: {
        ...run.tasks,
        [taskId]: { ...task, status: 'failed', failure: toErrorRecord(error, now(), deps.redaction) },
      },
    };
  }

  /** 关闭当前 Execution Episode（纯函数段）。 */
  function closeEpisode(
    run: RunJson,
    taskId: string,
    sessionId: string,
    ending: Omit<ExecutionEpisodeEnding, 'specSha256After' | 'endedAt'>,
    specSha256After: string,
  ): RunJson {
    const task = run.tasks[taskId]!;
    const executionEpisodes = closeExecutionEpisode(task.executionEpisodes, sessionId, {
      ...ending,
      specSha256After,
      endedAt: now(),
    });
    return { ...run, tasks: { ...run.tasks, [taskId]: { ...task, executionEpisodes } } };
  }

  /**
   * 会话启动后的失败收尾（§9.6、§6.3 第 7 步）：completed Record 未写入时
   * 先写失败 Record；关 Episode 为 session_error；Task 转 failed；清槽；
   * Run 转 failed。
   */
  async function failWithSession(
    handle: ActiveSessionHandle<'execution'>,
    error: ApexError,
    taskFailureReason: TaskTransitionReason,
    options?: { readonly episodeOutcome?: 'failed' | 'session_error' },
  ): Promise<ExecuteNextTaskResult> {
    const taskId = handle.taskId!;
    deps.logger.log('error', 'execution.session_failed', {
      sessionId: handle.sessionId,
      taskId,
      errorCode: error.errorCode,
      taskFailureReason,
    });
    await ensureFailedSessionRecord(deps, handle, error);
    let next = closeEpisode(
      handle.run,
      taskId,
      handle.sessionId,
      {
        outcome: options?.episodeOutcome ?? 'session_error',
        summary: deps.redaction.redactText(error.message) || error.errorCode,
        acceptanceEvidence: [],
        finalCheckpoint: null,
        intermediateCheckpoint: null,
        checkpointReason: `error: session ended before any checkpoint (${error.errorCode})`,
        error: toErrorRecord(error, now(), deps.redaction),
      },
      handle.specSha256,
    );
    next = markTaskFailed(next, taskId, taskFailureReason, error);
    return failTerminal(next, error);
  }

  /**
   * 本地 Checkpoint 已形成、远程发布失败后的事实保全。
   *
   * 有实际变更时把 OID 记录为 Task 中间 Checkpoint，并同步 expectedHead；
   * Task 仍以 checkpoint_failed 终止，不能声称远程交付已经成功。
   */
  async function failAfterCheckpoint(
    handle: ActiveSessionHandle<'execution'>,
    error: ApexError,
    checkpoint: CheckpointOutcome,
    specSha256After: string,
  ): Promise<ExecuteNextTaskResult> {
    const taskId = handle.taskId!;
    await ensureFailedSessionRecord(deps, handle, error);
    const hasLocalChanges = !checkpoint.noChanges;
    let next = closeEpisode(
      handle.run,
      taskId,
      handle.sessionId,
      {
        outcome: 'failed',
        summary: deps.redaction.redactText(error.message) || error.errorCode,
        acceptanceEvidence: [],
        finalCheckpoint: null,
        intermediateCheckpoint: hasLocalChanges ? checkpoint.finalOid : null,
        checkpointReason: hasLocalChanges
          ? checkpoint.reason
          : `remote_publication_failed_after_${checkpoint.reason}`,
        error: toErrorRecord(error, now(), deps.redaction),
      },
      specSha256After,
    );
    next = {
      ...next,
      intermediateCheckpoints: hasLocalChanges
        ? [
            ...next.intermediateCheckpoints,
            {
              oid: checkpoint.finalOid,
              role: 'task-intermediate' as const,
              sourceSessionId: handle.sessionId,
              taskId,
              planRevision: handle.planRevision,
              summary: `remote publication failed after local checkpoint for ${taskId}`,
              ownerTaskId: null,
            },
          ]
        : next.intermediateCheckpoints,
      repository: { ...next.repository, expectedHead: checkpoint.finalOid },
    };
    next = markTaskFailed(next, taskId, 'checkpoint_failed', error);
    return failTerminal(next, error);
  }

  async function execute(options?: ExecuteNextTaskOptions): Promise<ExecuteNextTaskResult> {
    const run = await deps.stateStore.readRun();
    if (run === null || run.status !== 'running') {
      throw new ApexError({
        code: 'STATE_VALIDATION_FAILED',
        stage: 'execution',
        message: `ExecuteNextTask requires a running run, got ${run?.status ?? 'none'}`,
      });
    }
    const tasks = await deps.stateStore.readTasks();
    if (tasks === null) {
      throw new ApexError({
        code: 'STATE_VALIDATION_FAILED',
        stage: 'execution',
        message: 'running run requires tasks.json',
      });
    }
    const root = run.repository.root;

    // §9.1：选择第一个依赖完成且 pending 的 Task。
    const readyTaskId = selectReadyTask('running', tasks.tasks, run.tasks);
    if (readyTaskId === null) {
      const allCompleted = tasks.tasks.every((task) => run.tasks[task.id]?.status === 'completed');
      if (allCompleted) {
        deps.logger.log('debug', 'execution.all_tasks_completed', {
          taskCount: tasks.tasks.length,
        });
        const reviewing: RunJson = {
          ...run,
          status: applyRunEvent(run.status, 'ALL_TASKS_COMPLETED'),
          stateRevision: run.stateRevision + 1,
          updatedAt: now(),
        };
        await deps.stateStore.writeRun(reviewing);
        return { kind: 'final-review', run: reviewing };
      }
      // 存在 failed Task 或无法解释的 pending Task（§9.1）。
      return failTerminal(
        run,
        new ApexError({
          code: 'PLAN_INVALID',
          stage: 'scheduling',
          message: 'no runnable task: the plan contains failed or unexplainable pending tasks',
        }),
      );
    }
    const taskDef: PlannedTask = tasks.tasks.find((task) => task.id === readyTaskId)!;
    deps.logger.log('debug', 'execution.task.selected', {
      taskId: readyTaskId,
      planRevision: run.planRevision,
    });

    // §3.2：Session 启动前重算 SPEC SHA-256。
    const specBefore = await deps.git.readSpecFact(root, run.spec.path);
    if (specBefore.sha256 !== run.spec.sha256) {
      // SPEC 在 Session 外变化：尚未启动任何会话，直接转 planning 触发新 Revision。
      deps.logger.log('debug', 'execution.spec_changed', { boundary: 'outside_session' });
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

    // §8.3：会话前 Git 不变量。
    let startFact: SessionStartFact;
    try {
      startFact = await deps.git.assertSessionStart(root, sessionGitFacts(run));
    } catch (error) {
      return failTerminal(run, error as ApexError);
    }
    deps.logger.log('debug', 'execution.session_start.asserted', {
      taskId: readyTaskId,
      head: startFact.head,
    });

    /**
     * 上一轮独立复核打回（最后一个 Review Episode 为 changes_required）时，
     * 把复核摘要、未满足证据、失败测试与问题清单注入修复执行的 Prompt；
     * 首次执行或复核尚未产生结论时为 null。Episode 字段落盘前已脱敏。
     */
    const lastReviewEpisode = run.tasks[readyTaskId]?.taskReviewEpisodes.at(-1);
    const reviewFeedback: TaskReviewFeedback | null =
      lastReviewEpisode !== undefined && lastReviewEpisode.outcome === 'changes_required'
        ? {
            summary: lastReviewEpisode.summary ?? '',
            issues: lastReviewEpisode.issues,
            failedTests: lastReviewEpisode.tests.filter((test) => test.result === 'failed'),
            unsatisfiedEvidence: lastReviewEpisode.acceptanceEvidence.filter(
              (evidence) => evidence.status === 'not_satisfied',
            ),
          }
        : null;
    const prompt = buildExecutionPrompt({
      repositoryRoot: root,
      runBranch: run.repository.runBranch,
      specPath: run.spec.path,
      specSha256: specBefore.sha256,
      planRevision: run.planRevision,
      task: taskDef,
      completedTasks: tasks.tasks
        .filter((task) => run.tasks[task.id]?.status === 'completed')
        .map((task) => ({
          definition: task,
          resultSummary: run.tasks[task.id]!.completedResult!.summary,
          finalCheckpoint: run.tasks[task.id]!.finalCheckpoint!,
        })),
      adoptedCheckpoints: run.intermediateCheckpoints.filter(
        (checkpoint) => checkpoint.ownerTaskId === readyTaskId,
      ),
      reviewFeedback,
    });

    /**
     * resume hint（§17 resume）只在本次选中的 Task 与被中断 Task 一致时
     * 生效；不一致说明调度已偏离断点，丢弃 hint 并记调试日志，不影响
     * 正常执行。
     */
    const resumeHint: ExecutionResumeHint | null =
      options?.resume !== undefined && options.resume.taskId === readyTaskId
        ? options.resume
        : null;
    if (options?.resume !== undefined && resumeHint === null) {
      deps.logger.log('debug', 'execution.resume_hint_dropped', {
        hintTaskId: options.resume.taskId,
        selectedTaskId: readyTaskId,
      });
    }

    /**
     * 接力收尾（结果修复 / resume 回退共用）：关闭当前 Episode 为
     * session_error（Task 保持 running，由接力会话接管 activeSession 后
     * 追加新 Episode）。
     */
    const closeEpisodeForRelay = (
      handle: ActiveSessionHandle<'execution'>,
      error: ApexError,
      checkpointReason: string,
    ): RunJson =>
      closeEpisode(
        handle.run,
        readyTaskId,
        handle.sessionId,
        {
          outcome: 'session_error',
          summary: deps.redaction.redactText(error.message) || error.errorCode,
          acceptanceEvidence: [],
          finalCheckpoint: null,
          intermediateCheckpoint: null,
          checkpointReason,
          error: toErrorRecord(error, now(), deps.redaction),
        },
        handle.specSha256,
      );

    /** 修复接力行：让前台看到结果为何被拒以及修复会话的启动。 */
    const progressResultRepair = (
      handle: ActiveSessionHandle<'execution'>,
      error: ApexError,
      attempt: number,
    ): void => {
      deps.output.writeLine(
        deps.redaction.redactText(
          `↻ 执行结果校验失败 · 会话 ${handle.sessionId.slice(0, 8)} · ` +
            `正在启动修复会话 ${attempt}/${MAX_RESULT_REPAIR_ATTEMPTS} · ${error.message}`,
        ),
      );
      deps.logger.log('warn', 'execution.result_repair', {
        sessionId: handle.sessionId,
        taskId: readyTaskId,
        attempt,
        message: error.message,
      });
    };

    /** 修复会话提示词：附校验错误与（可解析时的）非法结果原文。 */
    const buildRepairPrompt = (error: ApexError, result: TaskExecutionResult | null): string =>
      buildExecutionResultRepairPrompt({
        repositoryRoot: root,
        runBranch: run.repository.runBranch,
        task: taskDef,
        validationError: error.message,
        invalidResultJson: result === null ? null : JSON.stringify(result, null, 2),
      });

    /**
     * 单趟 Execution Session + §9.4 校验；结果契约失败时有界接力修复会话。
     * §6.3 顺序对每趟会话独立成立：先持久化 activeSession 与未结束
     * Episode 再启动进程；接续会话复用 running Task（keepTaskRunning），
     * 被接替的 Episode 已先关闭为 session_error。
     *
     * resume hint 存在时首趟为续接会话（--resume --fork-session）；
     * transcript 明确不可用时由共享协调器回退一趟标准完整 prompt。
     * 鉴权、网络、额度、普通非零退出和流失败都不自动重试。
     */
    const invokeUntilValidResult = async (
      resumePrompt: string | null,
      resumeFromSessionId: string | null,
    ): Promise<SessionLoopOutcome> => {
      let sessionPrompt = prompt;
      let repairAttempt = 0;
      let sessionRun = run;
      for (;;) {
        const sessionBase = {
          type: 'execution' as const,
          taskId: readyTaskId,
          planRevision: run.planRevision,
          specSha256: specBefore.sha256,
          permissionMode: run.runSettings.executionPermissionMode,
          repositoryRoot: root,
          /*
           * Planning 给出的 Task 回合预算在进程边界强制执行；结果修复也沿用
           * 同一上限，避免修复分支绕开预算后造成注意力漂移。
           */
          maxTurns: taskDef.budget.maxAgentTurns,
        };
        const invocation = await invokeResumableSession(deps, {
          run: sessionRun,
          session: sessionBase,
          freshPrompt: sessionPrompt,
          resume:
            repairAttempt === 0 &&
            resumeFromSessionId !== null &&
            resumePrompt !== null
              ? { sessionId: resumeFromSessionId, prompt: resumePrompt }
              : null,
          ...(repairAttempt > 0
            ? { initialBeginOptions: { keepTaskRunning: true } }
            : {}),
          fallbackBeginOptions: { keepTaskRunning: true },
          closeResumeAttempt: (handle, error) =>
            closeEpisodeForRelay(
              handle,
              error,
              `error: claude session resume failed (${error.errorCode})`,
            ),
        });
        if (invocation.kind === 'failed') {
          const { handle, error: apex } = invocation;
          if (isClaudeResultInvalid(apex) && repairAttempt < MAX_RESULT_REPAIR_ATTEMPTS) {
            // 结构 Schema 未过：补失败 Record、关 Episode，接力结果修复会话。
            await ensureFailedSessionRecord(deps, handle, apex);
            repairAttempt += 1;
            sessionRun = closeEpisodeForRelay(
              handle,
              apex,
              `error: result failed contract validation (${apex.errorCode})`,
            );
            sessionPrompt = buildRepairPrompt(apex, null);
            progressResultRepair(handle, apex, repairAttempt);
            continue;
          }
          const settled = await failWithSession(
            handle,
            apex,
            apex.errorCode === 'RUN_INTERRUPTED' ? 'run_interrupted' : 'claude_call_failed',
          );
          return { kind: 'settled', settled };
        }
        const { handle, fact } = invocation;

        /**
         * §6.3 第 5 步与 §3.2 结束边界属于同一个 Session 收尾阶段。
         * 任一持久化或重读错误都必须进入 failWithSession，确保 Episode 关闭、
         * running Task 转 failed，并清除接力槽。
         */
        let specAfter;
        try {
          await writeCompletedSessionRecord(deps, handle, fact);
          specAfter = await deps.git.readSpecFact(root, run.spec.path);
        } catch (error) {
          const settled = await failWithSession(handle, error as ApexError, 'claude_call_failed');
          return { kind: 'settled', settled };
        }
        const rawResult: TaskExecutionResult = fact.structuredResult;
        // 契约边界归一化：completed/failed 下模型误填的 replanReason 是死
        // 数据，归一为 null 而不是让整趟已验证的工作因格式噪声报废。
        const result = normalizeExecutionResult(rawResult);
        if (result !== rawResult) {
          deps.logger.log('warn', 'execution.result_normalized', {
            sessionId: handle.sessionId,
            taskId: readyTaskId,
            decision: rawResult.decision,
            droppedReplanReason: deps.redaction.redactText(rawResult.replanReason ?? ''),
          });
        }

        if (specAfter.sha256 !== specBefore.sha256) {
          // §3.2 Execution 期间 SPEC 变化六步：保存会话事实、不提交基于旧 SPEC
          // 的结论、§12.3 中间 Checkpoint 或无变更事实、Task 回 pending、Run 转
          // planning、由新 Revision 接管中间 Checkpoint。
          let checkpoint;
          try {
            checkpoint = await deps.git.createIntermediateCheckpoint(root, {
              facts: sessionGitFacts(run),
              sessionStartHead: startFact.head,
              runId: run.runId,
              planRevision: run.planRevision,
              sessionId: handle.sessionId,
              source: { kind: 'task', taskId: readyTaskId },
            });
          } catch (error) {
            const settled = await failWithSession(handle, error as ApexError, 'checkpoint_failed');
            return { kind: 'settled', settled };
          }
          try {
            await publishCheckpoint(deps, run, checkpoint, 'task-intermediate');
          } catch (error) {
            const settled = await failAfterCheckpoint(
              handle,
              error as ApexError,
              checkpoint,
              specAfter.sha256,
            );
            return { kind: 'settled', settled };
          }
          deps.logger.log('debug', 'execution.spec_changed', {
            boundary: 'after_session',
            taskId: readyTaskId,
            checkpoint: checkpoint.noChanges ? null : checkpoint.finalOid,
          });
          let next = closeEpisode(
            handle.run,
            readyTaskId,
            handle.sessionId,
            {
              outcome: 'spec_changed',
              summary: deps.redaction.redactText(result.summary) || 'spec changed during session',
              acceptanceEvidence: deps.redaction.redactStructured(result.acceptanceEvidence),
              finalCheckpoint: null,
              intermediateCheckpoint: checkpoint.noChanges ? null : checkpoint.finalOid,
              checkpointReason: checkpoint.reason,
              error: null,
            },
            specAfter.sha256,
          );
          const task = next.tasks[readyTaskId]!;
          assertTaskTransition(task.status, 'pending', 'spec_changed');
          next = {
            ...next,
            status: applyRunEvent(next.status, 'SPEC_CHANGED'),
            currentTaskId: null,
            activeSession: null,
            tasks: { ...next.tasks, [readyTaskId]: { ...task, status: 'pending' } },
            // §12.3 第 5 步：中间 Checkpoint 追加到 run.json（无变更则不追加）。
            intermediateCheckpoints: checkpoint.noChanges
              ? next.intermediateCheckpoints
              : [
                  ...next.intermediateCheckpoints,
                  {
                    oid: checkpoint.finalOid,
                    role: 'task-intermediate' as const,
                    sourceSessionId: handle.sessionId,
                    taskId: readyTaskId,
                    planRevision: run.planRevision,
                    summary: `SPEC changed during execution of ${readyTaskId}`,
                    ownerTaskId: null,
                  },
                ],
            repository: { ...next.repository, expectedHead: checkpoint.finalOid },
            stateRevision: next.stateRevision + 1,
            updatedAt: now(),
          };
          await deps.stateStore.writeRun(next);
          return {
            kind: 'settled',
            settled: {
              kind: 'replan-needed',
              run: next,
              trigger: {
                type: 'spec_changed',
                reason: `SPEC changed during execution of ${readyTaskId}`,
                sourceSessionId: handle.sessionId,
              },
            },
          };
        }

        // §9.4 字段规则语义校验（结构 Schema 已由适配器校验）。
        try {
          validateExecutionResultSemantics(result, taskDef);
        } catch (error) {
          const apex = error as ApexError;
          if (repairAttempt < MAX_RESULT_REPAIR_ATTEMPTS) {
            repairAttempt += 1;
            sessionRun = closeEpisodeForRelay(
              handle,
              apex,
              `error: result failed contract validation (${apex.errorCode})`,
            );
            sessionPrompt = buildRepairPrompt(apex, result);
            progressResultRepair(handle, apex, repairAttempt);
            continue;
          }
          const settled = await failWithSession(handle, apex, 'result_invalid');
          return { kind: 'settled', settled };
        }

        return { kind: 'valid', handle, result, specAfter };
      }
    };

    const sessionOutcome = await invokeUntilValidResult(
      resumeHint === null
        ? null
        : buildExecutionResumePrompt({ task: taskDef, cause: resumeHint.cause }),
      resumeHint === null ? null : resumeHint.sessionId,
    );
    if (sessionOutcome.kind === 'settled') return sessionOutcome.settled;
    const { handle, result, specAfter } = sessionOutcome;

    if (result.decision === 'failed') {
      // §9.6：decision == failed 是合法结果，映射 CLAUDE_REPORTED_FAILURE。
      deps.logger.log('debug', 'execution.claude_reported_failure', {
        taskId: readyTaskId,
        sessionId: handle.sessionId,
      });
      const reported = new ApexError({
        code: 'CLAUDE_REPORTED_FAILURE',
        stage: 'execution',
        message: `claude reported failure for ${readyTaskId}: ${result.summary}`,
        sessionId: handle.sessionId,
        taskId: readyTaskId,
      });
      const taskId = readyTaskId;
      let next = closeEpisode(
        handle.run,
        taskId,
        handle.sessionId,
        {
          outcome: 'failed',
          summary: deps.redaction.redactText(result.summary) || 'claude reported failure',
          acceptanceEvidence: deps.redaction.redactStructured(result.acceptanceEvidence),
          finalCheckpoint: null,
          intermediateCheckpoint: null,
          checkpointReason: 'error: no checkpoint created (decision failed)',
          error: toErrorRecord(reported, now(), deps.redaction),
        },
        specAfter.sha256,
      );
      next = markTaskFailed(next, taskId, 'reported_failure', reported);
      return failTerminal(next, reported);
    }

    if (result.decision === 'replan_required') {
      // §13 步骤 1–4：保存 Record 与原因、§12.3 中间 Checkpoint、Task 回
      // pending、Run 转 planning（新 Revision 由驱动器触发）。
      deps.logger.log('debug', 'execution.replan_requested', {
        taskId: readyTaskId,
        sessionId: handle.sessionId,
        reason: result.replanReason ?? null,
      });
      let checkpoint;
      try {
        checkpoint = await deps.git.createIntermediateCheckpoint(root, {
          facts: sessionGitFacts(run),
          sessionStartHead: startFact.head,
          runId: run.runId,
          planRevision: run.planRevision,
          sessionId: handle.sessionId,
          source: { kind: 'task', taskId: readyTaskId },
        });
      } catch (error) {
        return failWithSession(handle, error as ApexError, 'checkpoint_failed');
      }
      try {
        await publishCheckpoint(deps, run, checkpoint, 'task-intermediate');
      } catch (error) {
        return failAfterCheckpoint(handle, error as ApexError, checkpoint, specAfter.sha256);
      }
      let next = closeEpisode(
        handle.run,
        readyTaskId,
        handle.sessionId,
        {
          outcome: 'replan_required',
          summary: deps.redaction.redactText(result.summary) || 'replan required',
          acceptanceEvidence: deps.redaction.redactStructured(result.acceptanceEvidence),
          finalCheckpoint: null,
          intermediateCheckpoint: checkpoint.noChanges ? null : checkpoint.finalOid,
          checkpointReason: checkpoint.reason,
          error: null,
        },
        specAfter.sha256,
      );
      const task = next.tasks[readyTaskId]!;
      assertTaskTransition(task.status, 'pending', 'replan_required');
      next = {
        ...next,
        status: applyRunEvent(next.status, 'REPLAN_REQUESTED'),
        currentTaskId: null,
        activeSession: null,
        tasks: { ...next.tasks, [readyTaskId]: { ...task, status: 'pending' } },
        // §12.3 第 5 步：中间 Checkpoint 追加到 run.json（无变更则不追加）。
        intermediateCheckpoints: checkpoint.noChanges
          ? next.intermediateCheckpoints
          : [
              ...next.intermediateCheckpoints,
              {
                oid: checkpoint.finalOid,
                role: 'task-intermediate' as const,
                sourceSessionId: handle.sessionId,
                taskId: readyTaskId,
                planRevision: run.planRevision,
                summary: `replan required by ${readyTaskId}: ${deps.redaction.redactText(result.replanReason ?? '')}`,
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
          type: 'execution_replan',
          reason: result.replanReason!,
          sourceSessionId: handle.sessionId,
        },
      };
    }

    /**
     * decision == completed 只形成候选交付物，不再直接完成 Task。
     *
     * 候选结果与 Checkpoint 持久化后，Task 保持 running；后续全新
     * task_review Session 必须独立批准，才能提交 completed 状态。
     */
    let checkpoint;
    try {
      await deps.git.assertSessionEnd(root, sessionGitFacts(run), startFact);
      checkpoint = await deps.git.createTaskCheckpoint(root, {
        facts: sessionGitFacts(run),
        sessionStartHead: startFact.head,
        runId: run.runId,
        taskId: readyTaskId,
        taskTitle: taskDef.title,
        planRevision: run.planRevision,
        sessionId: handle.sessionId,
      });
    } catch (error) {
      return failWithSession(handle, error as ApexError, 'checkpoint_failed');
    }
    try {
      await publishCheckpoint(deps, run, checkpoint, 'task-candidate');
    } catch (error) {
      return failAfterCheckpoint(handle, error as ApexError, checkpoint, specAfter.sha256);
    }
    deps.logger.log('debug', 'execution.task.checkpointed', {
      taskId: readyTaskId,
      sessionId: handle.sessionId,
      checkpoint: checkpoint.finalOid,
    });
    let next = closeEpisode(
      handle.run,
      readyTaskId,
      handle.sessionId,
      {
        outcome: 'awaiting_review',
        summary: deps.redaction.redactText(result.summary) || 'completed',
        acceptanceEvidence: deps.redaction.redactStructured(result.acceptanceEvidence),
        finalCheckpoint: checkpoint.finalOid,
        intermediateCheckpoint: null,
        checkpointReason: checkpoint.reason,
        error: null,
      },
      specAfter.sha256,
    );
    const task = next.tasks[readyTaskId]!;
    next = {
      ...next,
      activeSession: null,
      tasks: {
        ...next.tasks,
        [readyTaskId]: {
          ...task,
          candidateResult: deps.redaction.redactStructured(result),
          candidateCheckpoint: checkpoint.finalOid,
        },
      },
      repository: { ...next.repository, expectedHead: checkpoint.finalOid },
      stateRevision: next.stateRevision + 1,
      updatedAt: now(),
    };
    await deps.stateStore.writeRun(next);
    return { kind: 'review-needed', run: next, taskId: readyTaskId };
  }

  return { execute };
}
