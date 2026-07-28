/**
 * ExecuteNextTask 用例（SPEC §9 Task 执行全章、§12.2/§12.3 Checkpoint、
 * §13 Replan 步骤 1–4、§3.2 Execution 期间 SPEC 变化六步、§2.4 中断收尾）。
 *
 * 单趟执行：选择 Ready Task → §6.3 会话生命周期 → 按 decision 提交业务结果。
 * 所有失败路径都先把可获得的事实（Session Record、Episode、Git 事实）落盘，
 * 再把 Task 与 Run 转 failed；不自动重试、不恢复旧 Session。
 *
 * SPEC SHA-256 边界（§3.2）：Task 启动前（变化则转 planning 触发新 Revision）、
 * Session 正常结束后提交结果前（变化走六步变化流程）。
 */
import { ApexError } from '../../domain/errors.js';
import {
  closeExecutionEpisode,
  type ExecutionEpisodeEnding,
} from '../../domain/episodes.js';
import { validateExecutionResultSemantics } from '../../domain/results.js';
import { applyRunEvent } from '../../domain/run-state.js';
import {
  assertTaskTransition,
  selectReadyTask,
  type TaskTransitionReason,
} from '../../domain/task-state.js';
import { formatRfc3339Utc } from '../../domain/time.js';
import type { PlanRevisionTrigger } from '../../domain/schemas/plan-revision-snapshot.js';
import type { RunJson } from '../../domain/schemas/run-json.js';
import type { TaskExecutionResult } from '../../domain/schemas/task-execution-result.js';
import type { PlannedTask } from '../../domain/schemas/task-plan-draft.js';
import { buildExecutionPrompt } from '../prompts/execution.js';
import type { UseCaseDeps } from '../usecase-deps.js';
import {
  beginSession,
  ensureFailedSessionRecord,
  invokeSession,
  sessionGitFacts,
  writeCompletedSessionRecord,
  type ActiveSessionHandle,
} from './claude-session.js';
import { toErrorRecord } from './error-record.js';
import { persistRunBestEffort, toTerminalFailedRun } from './run-transitions.js';

export type ExecuteNextTaskResult =
  /** Task completed 且 Checkpoint 成功。 */
  | { readonly kind: 'task-completed'; readonly run: RunJson; readonly taskId: string }
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

export function createExecuteNextTask(deps: UseCaseDeps): {
  execute(): Promise<ExecuteNextTaskResult>;
} {
  const now = (): string => formatRfc3339Utc(deps.clock.now());

  /** 终态失败收尾：清槽、lastError、terminalAt，尽力持久化（§15 state_error）。 */
  async function failTerminal(run: RunJson, error: ApexError): Promise<ExecuteNextTaskResult> {
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

  async function execute(): Promise<ExecuteNextTaskResult> {
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

    // §3.2：Session 启动前重算 SPEC SHA-256。
    const specBefore = await deps.git.readSpecFact(root, run.spec.path);
    if (specBefore.sha256 !== run.spec.sha256) {
      // SPEC 在 Session 外变化：尚未启动任何会话，直接转 planning 触发新 Revision。
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
    let startFact;
    try {
      startFact = await deps.git.assertSessionStart(root, sessionGitFacts(run));
    } catch (error) {
      return failTerminal(run, error as ApexError);
    }

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
    });

    // §6.3 第 1–4 步：写 activeSession + Task running + 未结束 Episode，保存后启动。
    const sessionInput = {
      type: 'execution' as const,
      taskId: readyTaskId,
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
      const apex = error as ApexError;
      return failWithSession(
        handle,
        apex,
        apex.errorCode === 'RUN_INTERRUPTED' ? 'run_interrupted' : 'claude_call_failed',
      );
    }

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
      return failWithSession(handle, error as ApexError, 'claude_call_failed');
    }
    const result: TaskExecutionResult = fact.structuredResult;

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
        return failWithSession(handle, error as ApexError, 'checkpoint_failed');
      }
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
        kind: 'replan-needed',
        run: next,
        trigger: {
          type: 'spec_changed',
          reason: `SPEC changed during execution of ${readyTaskId}`,
          sourceSessionId: handle.sessionId,
        },
      };
    }

    // §9.4 字段规则语义校验（结构 Schema 已由适配器校验）。
    try {
      validateExecutionResultSemantics(result, taskDef);
    } catch (error) {
      return failWithSession(handle, error as ApexError, 'result_invalid');
    }

    if (result.decision === 'failed') {
      // §9.6：decision == failed 是合法结果，映射 CLAUDE_REPORTED_FAILURE。
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

    // decision == completed：§9.5 完成判定（Git 不变量 + §12.2 Checkpoint）。
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
    let next = closeEpisode(
      handle.run,
      readyTaskId,
      handle.sessionId,
      {
        outcome: 'completed',
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
    assertTaskTransition(task.status, 'completed', 'completed_and_checkpointed');
    next = {
      ...next,
      currentTaskId: null,
      activeSession: null,
      tasks: {
        ...next.tasks,
        [readyTaskId]: {
          ...task,
          status: 'completed',
          completedResult: deps.redaction.redactStructured(result),
          finalCheckpoint: checkpoint.finalOid,
        },
      },
      repository: { ...next.repository, expectedHead: checkpoint.finalOid },
      stateRevision: next.stateRevision + 1,
      updatedAt: now(),
    };
    await deps.stateStore.writeRun(next);
    return { kind: 'task-completed', run: next, taskId: readyTaskId };
  }

  return { execute };
}
