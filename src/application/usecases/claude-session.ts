/**
 * Claude Session 生命周期原语（SPEC §6.3 七步持久化生命周期 + §2.4 中断竞速）。
 *
 * 顺序铁律（§6.3）：
 * 1. Coordinator 分配 Session ID；
 * 2. 先在 run.json.activeSession 保存 Session 事实（Execution 同时置 Task
 *    running 并追加未结束 Episode，Final Review 追加未结束 FR Episode）；
 * 3. 保存成功后才能启动 Claude 进程；
 * 4. Claude 结束后先写最终 Session Record，再提交业务结果；
 * 5. 业务结果提交后清除 activeSession；
 * 6. 启动失败也尽可能写失败 Session Record；写不进时只输出诊断。
 *
 * 中断竞速（§2.4）：invoke 与"中断请求 + 有界等待"竞速；被 abort 杀掉的
 * 子进程以 CLAUDE_EXIT_NONZERO 失败，requested=true 时映射为 RUN_INTERRUPTED；
 * 只有真挂死才走 interruptWaitMs 超时分支，超时照常收尾。
 */
import {
  appendExecutionEpisode,
  appendFinalReviewEpisode,
  appendTaskReviewEpisode,
  createExecutionEpisode,
  createFinalReviewEpisode,
  createTaskReviewEpisode,
} from '../../domain/episodes.js';
import { ApexError, isApexError } from '../../domain/errors.js';
import { formatRfc3339InSystemTimeZone } from '../../domain/time.js';
import { assertTaskTransition } from '../../domain/task-state.js';
import type { ActiveSession, SessionType } from '../../domain/schemas/active-session.js';
import type { RunJson } from '../../domain/schemas/run-json.js';
import type { SessionRecord } from '../../domain/schemas/session-record.js';
import { ClaudeInvocationError, type ClaudeInvocationFact, type ClaudePermissionModeFor, type ClaudeStreamActivity } from '../ports/ClaudeRuntimePort.js';
import type { SessionGitFacts } from '../ports/GitPort.js';
import {
  renderSessionActivity,
  renderSessionFailed,
  renderSessionFinished,
  renderSessionHeartbeat,
  renderSessionModel,
  renderSessionStarted,
} from '../presentation/progress.js';
import type { UseCaseDeps } from '../usecase-deps.js';
import { toErrorRecord } from './error-record.js';

export interface BeginSessionInput<T extends SessionType> {
  readonly type: T;
  /** execution/task_review 必填；planning/plan_review/final_review 为 null。 */
  readonly taskId: string | null;
  /** planning 传"将生成的 Revision 号"；其他传当前 Revision。 */
  readonly planRevision: number;
  /** 会话启动前刚重算的 SPEC SHA。 */
  readonly specSha256: string;
  readonly prompt: string;
  readonly permissionMode: ClaudePermissionModeFor<T>;
  readonly repositoryRoot: string;
  /** 仅 Execution 从 TaskBudget 注入，运行时通过 --max-turns 强制执行。 */
  readonly maxTurns?: number | null;
  /**
   * 可选的会话续接来源（SPEC §17 resume）：非空时 Claude 以
   * `--resume --fork-session` 续接该被中断会话；五类 Session 的首次
   * 恢复调用都通过统一续接协调器传入。
   */
  readonly resumeFromSessionId?: string | null;
}

export interface ActiveSessionHandle<T extends SessionType = SessionType> {
  readonly sessionId: string;
  readonly type: T;
  readonly taskId: string | null;
  readonly planRevision: number;
  readonly specSha256: string;
  readonly startedAt: string;
  /** 已持久化（activeSession 已写入）的 run。 */
  readonly run: RunJson;
}

/** 从 run 组 SessionGitFacts（§8.3 会话前后不变量与 Checkpoint 输入）。 */
export function sessionGitFacts(run: RunJson): SessionGitFacts {
  return {
    runBranch: run.repository.runBranch,
    baseBranchRef: run.repository.baseBranchRef,
    baseCommit: run.repository.baseCommit,
    expectedHead: run.repository.expectedHead,
    completedCheckpoints: Object.values(run.tasks)
      .filter((task) => task.status === 'completed' && task.finalCheckpoint !== null)
      .map((task) => task.finalCheckpoint!),
    specGitPath: run.spec.path,
  };
}

export interface BeginSessionOptions {
  /**
   * Execution 接力：Task 已因上一个会话处于 running，不再执行
   * pending->running 迁移，只追加新的未结束 Episode 并接管 activeSession。
   * 结果修复与 resume 不可用后的全新会话共用这一显式事实。
   */
  readonly keepTaskRunning?: boolean;
}

/**
 * §6.3 第 1–4 步：分配 Session ID、写入 activeSession（及 Episode /
 * Task 运行态）、持久化成功后返回句柄。进程只能在之后启动。
 */
export async function beginSession<T extends SessionType>(
  deps: UseCaseDeps,
  run: RunJson,
  input: BeginSessionInput<T>,
  options?: BeginSessionOptions,
): Promise<ActiveSessionHandle<T>> {
  /**
   * 驱动器循环顶部的检查只能覆盖当时的状态；会话用例在读取仓库事实、
   * 构造提示词期间都可能收到中断。这里是所有 Session 共用的真正启动边界：
   * 已请求中断时不得分配 ID、追加 Episode 或写入 activeSession。
   */
  if (deps.interrupt.requested) {
    throw new ApexError({
      code: 'RUN_INTERRUPTED',
      stage: input.type,
      message: 'foreground interrupt requested before Session start',
      taskId: input.taskId,
    });
  }

  const startedAt = formatRfc3339InSystemTimeZone(deps.clock.now());
  const sessionId = globalThis.crypto.randomUUID();
  const activeSession: ActiveSession = {
    sessionId,
    type: input.type,
    taskId: input.taskId,
    planRevision: input.planRevision,
    specSha256: input.specSha256,
    startedAt,
  };
  let next: RunJson = {
    ...run,
    activeSession,
    stateRevision: run.stateRevision + 1,
    updatedAt: startedAt,
  };

  if (input.type === 'execution') {
    const taskId = input.taskId;
    const task = taskId === null ? undefined : run.tasks[taskId];
    if (taskId === null || task === undefined) {
      throw new ApexError({
        code: 'STATE_VALIDATION_FAILED',
        stage: 'execution',
        message: `execution session requires an existing task, got ${taskId ?? 'null'}`,
      });
    }
    if (options?.keepTaskRunning === true) {
      // 结果修复接力：Task 必须正是当前 running Task，状态保持 running。
      if (task.status !== 'running' || run.currentTaskId !== taskId) {
        throw new ApexError({
          code: 'STATE_VALIDATION_FAILED',
          stage: 'execution',
          message:
            `relay session requires task ${taskId} to be the running task, ` +
            `got status ${task.status} and currentTaskId ${run.currentTaskId ?? 'null'}`,
        });
      }
    } else {
      assertTaskTransition(task.status, 'running', 'orchestrator_selected');
    }
    const episode = createExecutionEpisode({
      sessionId,
      taskId,
      planRevision: input.planRevision,
      specSha256Before: input.specSha256,
      startedAt,
    });
    next = {
      ...next,
      currentTaskId: taskId,
      tasks: {
        ...next.tasks,
        [taskId]: {
          ...task,
          status: 'running',
          executionEpisodes: appendExecutionEpisode(task.executionEpisodes, episode),
        },
      },
    };
  }

  if (input.type === 'task_review') {
    const taskId = input.taskId;
    const task = taskId === null ? undefined : run.tasks[taskId];
    const executionEpisode = task?.executionEpisodes.at(-1);
    if (
      taskId === null ||
      task === undefined ||
      task.status !== 'running' ||
      run.currentTaskId !== taskId ||
      task.candidateResult === null ||
      task.candidateCheckpoint === null ||
      executionEpisode === undefined ||
      executionEpisode.outcome !== 'awaiting_review' ||
      executionEpisode.finalCheckpoint !== task.candidateCheckpoint
    ) {
      throw new ApexError({
        code: 'STATE_VALIDATION_FAILED',
        stage: 'task_review',
        message: `task review session requires a persisted candidate for running task ${taskId ?? 'null'}`,
      });
    }
    /**
     * 复核 Episode 在启动 Claude 之前固定候选 Execution Session 和 Checkpoint。
     * 新生成的 sessionId 与 executionSessionId 由领域不变式强制不同。
     */
    const episode = createTaskReviewEpisode({
      sessionId,
      taskId,
      executionSessionId: executionEpisode.sessionId,
      candidateCheckpoint: task.candidateCheckpoint,
      planRevision: input.planRevision,
      specSha256Before: input.specSha256,
      startedAt,
    });
    next = {
      ...next,
      currentTaskId: taskId,
      tasks: {
        ...next.tasks,
        [taskId]: {
          ...task,
          taskReviewEpisodes: appendTaskReviewEpisode(task.taskReviewEpisodes, episode),
        },
      },
    };
  }

  if (input.type === 'final_review') {
    const episode = createFinalReviewEpisode({
      sessionId,
      planRevision: input.planRevision,
      specSha256Before: input.specSha256,
      startedAt,
    });
    next = {
      ...next,
      finalReviewEpisodes: appendFinalReviewEpisode(next.finalReviewEpisodes, episode),
    };
  }

  // §6.3 第 4 步：保存成功后才能启动 Claude 进程。
  await deps.stateStore.writeRun(next);
  deps.logger.log('debug', 'session.begin.persisted', {
    sessionId,
    type: input.type,
    taskId: input.taskId,
    planRevision: input.planRevision,
  });
  return {
    sessionId,
    type: input.type,
    taskId: input.taskId,
    planRevision: input.planRevision,
    specSha256: input.specSha256,
    startedAt,
    run: next,
  };
}

type InvokeRaceOutcome<T extends SessionType> =
  | { readonly kind: 'fact'; readonly fact: ClaudeInvocationFact<T> }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'interrupt-timeout' };

/** 会话耗时的人类可读格式（`83s` / `3m12s`），只用于进度行。 */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes === 0 ? `${seconds}s` : `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

/**
 * §6.3 第 4–5 步的进程调用段：绑定 abort 后启动唯一一次 invoke，并与
 * 前台中断做有界竞速（§2.4 第 1–3 步）。
 *
 * - 正常结束：返回事实或原样抛出 ClaudeInvocationError；
 * - 中断期间的调用失败：映射为 RUN_INTERRUPTED（保留原进程退出事实）；
 * - 中断后子进程真挂死：最多等 interruptWaitMs，超时抛 RUN_INTERRUPTED
 *   （processExitCode null），照常进入后续收尾。
 */
export async function invokeSession<T extends SessionType>(
  deps: UseCaseDeps,
  handle: ActiveSessionHandle<T>,
  input: BeginSessionInput<T>,
): Promise<ClaudeInvocationFact<T>> {
  // §2.4 第 2 步：中断时请求终止当前直接子进程（后绑定生效）。
  deps.interrupt.bindAbort(() => deps.claude.abort());

  /**
   * 中断可能发生在驱动器的循环顶部检查之后、Session 事实持久化之前。
   * bindAbort 与 invoke 之间没有 await，因此先同步检查再调用 invoke，
   * 可以保证已发生的中断不会启动新子进程，同时后续中断仍由绑定回调终止
   * 已启动的直接子进程。
   */
  if (deps.interrupt.requested) {
    throw new ClaudeInvocationError({
      code: 'RUN_INTERRUPTED',
      stage: input.type,
      message: 'foreground interrupt requested before Claude process start',
      sessionId: handle.sessionId,
      taskId: handle.taskId,
      processExitCode: null,
      claudeVersion: null,
    });
  }

  /*
   * Session 切换是长任务中的一级里程碑：标题和元数据必须逐行写入，保证
   * TTY 与重定向输出拥有相同层级，也避免多行文本绕过单行脱敏边界。
   */
  for (const line of renderSessionStarted({
    sessionId: handle.sessionId,
    type: handle.type,
    taskId: handle.taskId,
    planRevision: handle.planRevision,
  })) {
    deps.output.writeLine(deps.redaction.redactText(line));
  }
  const startedMs = deps.clock.now().getTime();
  const elapsedMs = (): number => deps.clock.now().getTime() - startedMs;
  let activity: ClaudeStreamActivity = {
    relevantEventCount: 0,
    lastEventType: null,
    displayEvent: null,
    model: null,
    provider: null,
  };
  deps.logger.log('debug', 'session.invoke.start', {
    sessionId: handle.sessionId,
    type: handle.type,
    taskId: handle.taskId,
    planRevision: handle.planRevision,
  });

  /** 已消费的结构化展示事件序号；同一快照因分块活跃上报时不会重复打印。 */
  let printedEventSequence = 0;
  /** init 元数据行每次 Session 只输出一次（model 首次非空时）。 */
  let modelLinePrinted = false;
  /**
   * 最近一次真正写入用户终端的活动时间。
   *
   * 心跳只在一个完整间隔内没有模型/工具活动时输出，避免用户刚看到动作行
   * 紧接着又收到“仍在工作”的重复事实。
   */
  let lastVisibleActivityMs = startedMs;

  const invokePromise = deps.claude.invoke<T>({
    prompt: input.prompt,
    sessionId: handle.sessionId,
    cwd: input.repositoryRoot,
    capabilityReport: deps.capabilityReport,
    type: input.type,
    permissionMode: input.permissionMode,
    maxTurns: input.maxTurns ?? null,
    resumeFromSessionId: input.resumeFromSessionId ?? null,
    onStreamActivity: (next) => {
      activity = next;
      // init 事件一到就告知本次 Session 实际使用的模型与 Provider。
      if (!modelLinePrinted && next.model != null) {
        modelLinePrinted = true;
        deps.output.writeLine(
          deps.redaction.redactText(renderSessionModel(next.model, next.provider)),
        );
        lastVisibleActivityMs = deps.clock.now().getTime();
      }
      /*
       * 默认终端只展示工具动作与工具错误。thinking、system、普通文本和
       * 成功工具结果仍完整进入 Session 日志；--verbose 另有结构化调试流，
       * 因此这里的降噪不会损失排错事实。
       */
      if (
        next.displayEvent !== null &&
        next.displayEvent.sequence > printedEventSequence
      ) {
        printedEventSequence = next.displayEvent.sequence;
        const line = renderSessionActivity(next.displayEvent, input.repositoryRoot);
        if (line !== null) {
          deps.output.writeLine(deps.redaction.redactText(line));
          lastVisibleActivityMs = deps.clock.now().getTime();
        }
      }
    },
  });
  /*
   * 交互终端把该状态作为底部唯一活动区域原位刷新；非 TTY 实现则写成
   * 普通纯文本行。工具动作仍是可回看的持久事实，不会被状态替换覆盖。
   */
  deps.output.updateStatus(
    deps.redaction.redactText(renderSessionHeartbeat(formatElapsed(elapsedMs()), 0)),
  );
  const settled: Promise<InvokeRaceOutcome<T>> = invokePromise.then(
    (fact): InvokeRaceOutcome<T> => ({ kind: 'fact', fact }),
    (error: unknown): InvokeRaceOutcome<T> => ({ kind: 'error', error }),
  );
  const interruptTimeout: Promise<InvokeRaceOutcome<T>> = deps.interrupt
    .waitForRequest()
    .then(() => deps.wait(deps.interruptWaitMs))
    .then((): InvokeRaceOutcome<T> => ({ kind: 'interrupt-timeout' }));

  /**
   * 心跳行：Session 未 settle 时每个间隔输出一次（已耗时 + 流活跃事实），
   * settle 后由 finally 清除标志位让循环自然退出；循环自身的异常不得
   * 影响 §2.4 竞速，因此挂空 catch（组合根的 wait 定时器已 unref，残留
   * 一次等待不会拖延进程退出）。
   */
  let heartbeatActive = true;
  const heartbeat = (async (): Promise<void> => {
    while (heartbeatActive) {
      await deps.wait(deps.sessionHeartbeatMs);
      if (!heartbeatActive) return;
      if (deps.clock.now().getTime() - lastVisibleActivityMs < deps.sessionHeartbeatMs) {
        continue;
      }
      deps.output.updateStatus(
        deps.redaction.redactText(
          renderSessionHeartbeat(
            formatElapsed(elapsedMs()),
            activity.relevantEventCount,
          ),
        ),
      );
      lastVisibleActivityMs = deps.clock.now().getTime();
    }
  })();
  void heartbeat.catch(() => undefined);

  function progressFailed(errorCode: string): void {
    deps.output.clearStatus();
    deps.output.writeLine(
      deps.redaction.redactText(
        renderSessionFailed(handle.type, formatElapsed(elapsedMs()), errorCode),
      ),
    );
  }

  try {
    const outcome = await Promise.race([settled, interruptTimeout]);

    if (outcome.kind === 'fact') {
      deps.output.clearStatus();
      deps.output.writeLine(
        deps.redaction.redactText(
          renderSessionFinished(
            handle.type,
            formatElapsed(elapsedMs()),
            outcome.fact.model,
          ),
        ),
      );
      deps.logger.log('debug', 'session.invoke.end', {
        sessionId: handle.sessionId,
        type: handle.type,
        elapsedMs: elapsedMs(),
        exitCode: 0,
        model: outcome.fact.model,
        provider: outcome.fact.provider,
      });
      return outcome.fact;
    }

    if (outcome.kind === 'error') {
      if (!deps.interrupt.requested) {
        const errorCode = isApexError(outcome.error) ? outcome.error.errorCode : 'unknown';
        progressFailed(errorCode);
        deps.logger.log('error', 'session.invoke.error', {
          sessionId: handle.sessionId,
          type: handle.type,
          elapsedMs: elapsedMs(),
          errorCode,
          message: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
        });
        throw outcome.error;
      }
      // abort 杀掉的子进程以 CLAUDE_EXIT_NONZERO（exitCode 可能为 null）失败；
      // 已请求中断时统一映射为 RUN_INTERRUPTED，保留可观察的进程事实。
      const original = outcome.error;
      progressFailed('RUN_INTERRUPTED');
      deps.logger.log('warn', 'session.invoke.interrupted', {
        sessionId: handle.sessionId,
        type: handle.type,
        elapsedMs: elapsedMs(),
        processExitCode: original instanceof ClaudeInvocationError ? original.processExitCode : null,
      });
      throw new ClaudeInvocationError({
        code: 'RUN_INTERRUPTED',
        stage: input.type,
        message: 'foreground interrupt requested',
        sessionId: handle.sessionId,
        taskId: handle.taskId,
        processExitCode: original instanceof ClaudeInvocationError ? original.processExitCode : null,
        claudeVersion: original instanceof ClaudeInvocationError ? original.claudeVersion : null,
        cause: original,
      });
    }

    // §2.4 第 3 步：有界等待超时，无论子进程是否退出都继续后续收尾。
    // 给 invokePromise 挂空 catch，防止后续 settle 时产生 unhandled rejection。
    void invokePromise.catch(() => undefined);
    progressFailed('RUN_INTERRUPTED');
    deps.logger.log('warn', 'session.invoke.interrupt_timeout', {
      sessionId: handle.sessionId,
      type: handle.type,
      elapsedMs: elapsedMs(),
      interruptWaitMs: deps.interruptWaitMs,
    });
    throw new ClaudeInvocationError({
      code: 'RUN_INTERRUPTED',
      stage: input.type,
      message: 'foreground interrupt requested',
      sessionId: handle.sessionId,
      taskId: handle.taskId,
      processExitCode: null,
      claudeVersion: null,
    });
  } finally {
    heartbeatActive = false;
    /*
     * 所有异常分支共享最后一道呈现清理边界。
     * clearStatus 必须幂等，确保日志/状态写入异常也不会留下悬空活动行。
     */
    deps.output.clearStatus();
  }
}

/**
 * §6.3 第 5 步前半：Session 正常结束后先写 completed Session Record
 * （不可变）；结构化结果持久化前必须 redactStructured（§18.4）。
 */
export async function writeCompletedSessionRecord<T extends SessionType>(
  deps: UseCaseDeps,
  handle: ActiveSessionHandle<T>,
  fact: ClaudeInvocationFact<T>,
): Promise<void> {
  /*
   * State Store 会执行最终安全断言，但 Session Record 组装层仍负责把端口事实
   * 转成安全领域事实；测试替身或未来 Adapter 也不能把未清洗元数据带入状态。
   */
  const redactOptional = (value: string | null): string | null =>
    value === null ? null : deps.redaction.redactText(value);
  const record: SessionRecord = {
    schemaVersion: 1,
    sessionId: handle.sessionId,
    type: handle.type,
    status: 'completed',
    runId: handle.run.runId,
    taskId: handle.taskId,
    planRevision: handle.planRevision,
    specSha256: handle.specSha256,
    startedAt: handle.startedAt,
    endedAt: formatRfc3339InSystemTimeZone(deps.clock.now()),
    claude: {
      version: deps.redaction.redactText(fact.claudeVersion),
      model: redactOptional(fact.model),
      provider: redactOptional(fact.provider),
    },
    exitCode: 0,
    structuredResult: deps.redaction.redactStructured(fact.structuredResult),
    logPath: fact.logPath,
    error: null,
  };
  await deps.stateStore.writeSessionRecord(record);
  deps.logger.log('debug', 'session.record.completed', {
    sessionId: handle.sessionId,
    type: handle.type,
  });
}

/**
 * §6.3 第 7 步：启动失败也尽可能写失败 Session Record；无法写入时只
 * 输出一行脱敏诊断，不伪造成功状态。
 */
export async function writeFailedSessionRecord(
  deps: UseCaseDeps,
  handle: ActiveSessionHandle,
  error: ApexError,
  facts: { processExitCode: number | null; claudeVersion: string | null },
): Promise<void> {
  const endedAt = formatRfc3339InSystemTimeZone(deps.clock.now());
  /*
   * 失败事实可能来自测试替身或非 Claude 异常，版本字符串仍按外部元数据处理；
   * unknown 是程序生成常量，不需要保留任何未经脱敏的备用副本。
   */
  const claudeVersion =
    facts.claudeVersion === null
      ? 'unknown'
      : deps.redaction.redactText(facts.claudeVersion);
  const record: SessionRecord = {
    schemaVersion: 1,
    sessionId: handle.sessionId,
    type: handle.type,
    status: 'failed',
    runId: handle.run.runId,
    taskId: handle.taskId,
    planRevision: handle.planRevision,
    specSha256: handle.specSha256,
    startedAt: handle.startedAt,
    endedAt,
    claude: { version: claudeVersion, model: null, provider: null },
    exitCode: facts.processExitCode,
    structuredResult: null,
    logPath: `logs/${handle.sessionId}.log`,
    error: toErrorRecord(error, endedAt, deps.redaction),
  };
  try {
    await deps.stateStore.writeSessionRecord(record);
    deps.logger.log('debug', 'session.record.failed_written', {
      sessionId: handle.sessionId,
      type: handle.type,
      errorCode: error.errorCode,
    });
  } catch (writeError) {
    const detail = writeError instanceof Error ? writeError.message : String(writeError);
    deps.logger.log('error', 'session.record.write_failed', {
      sessionId: handle.sessionId,
      type: handle.type,
      message: detail,
    });
    deps.output.writeLine(
      deps.redaction.redactText(
        `! 状态写入失败 · Session ${handle.sessionId} 的失败记录 · ${detail}`,
      ),
    );
  }
}

/**
 * 幂等补写失败 Session Record 的统一入口。
 *
 * Session Record 一旦存在便不可覆盖；读取本身失败时也不能猜测文件是否
 * 已经发布，因此只输出诊断并继续业务失败收尾。这样 Planning、Execution
 * 与 Final Review 共用同一套进程事实映射，不会因复制逻辑而产生分歧。
 */
export async function ensureFailedSessionRecord(
  deps: UseCaseDeps,
  handle: ActiveSessionHandle,
  error: ApexError,
): Promise<void> {
  let alreadyRecorded: boolean;
  try {
    alreadyRecorded = (await deps.stateStore.readSessionRecord(handle.sessionId)) !== null;
  } catch (readError) {
    const detail = readError instanceof Error ? readError.message : String(readError);
    deps.logger.log('error', 'session.record.read_failed', {
      sessionId: handle.sessionId,
      type: handle.type,
      message: detail,
    });
    deps.output.writeLine(
      deps.redaction.redactText(
        `! 状态读取失败 · 无法确认 Session ${handle.sessionId} 的记录是否存在 · ` +
          `为避免覆盖不可变记录，不再补写 · ${detail}`,
      ),
    );
    return;
  }
  if (alreadyRecorded) return;

  const processFacts =
    error instanceof ClaudeInvocationError
      ? { processExitCode: error.processExitCode, claudeVersion: error.claudeVersion }
      : { processExitCode: null, claudeVersion: null };
  await writeFailedSessionRecord(deps, handle, error, processFacts);
}
