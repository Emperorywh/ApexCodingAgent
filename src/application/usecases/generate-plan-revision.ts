/**
 * GeneratePlanRevision 用例（SPEC §7.1 Planning Session、§8.2 步骤 6–8、
 * §13 步骤 5–9 的 Planning 段、§3.2 SPEC 变化边界）。
 *
 * 流程：重算 SPEC SHA（§3.2 启动前边界）→ Planning 前置 Git 不变量
 * （§8.3，含 Planning 快照）→ §6.3 会话生命周期（先写 activeSession 再启动
 * 进程）→ 写 completed Session Record → Planning 副作用检测 → SPEC 结束后
 * 重算（变化则丢弃草稿、保持 planning 由驱动器重跑）→ ApplyPlanRevision
 * 提交 Revision → Run 转 running。
 *
 * 失败语义：会话未启动的启动期失败直接终态 failed；会话启动后的失败先
 * 尽力写失败 Session Record（已完成 Record 不可变、不补写），再清槽并把
 * Run 转 failed；不自动重试、不降级。
 */
import { ApexError } from '../../domain/errors.js';
import { formatRfc3339Utc } from '../../domain/time.js';
import type { PlanRevisionTrigger } from '../../domain/schemas/plan-revision-snapshot.js';
import type { RunJson } from '../../domain/schemas/run-json.js';
import type { PlannedTask } from '../../domain/schemas/task-plan-draft.js';
import type { TasksJson } from '../../domain/schemas/tasks-json.js';
import {
  buildPlanningPrompt,
  buildPlanningResumePrompt,
  type CompletedTaskSummary,
  type SkippedTaskSummary,
} from '../prompts/planning.js';
import type { UseCaseDeps } from '../usecase-deps.js';
import { applyPlanRevision } from './apply-plan-revision.js';
import {
  ensureFailedSessionRecord,
  sessionGitFacts,
  writeCompletedSessionRecord,
  type ActiveSessionHandle,
} from './claude-session.js';
import { invokeResumableSession } from './resumable-session.js';
import { persistRunBestEffort, toTerminalFailedRun } from './run-transitions.js';
import { sanitizePlanRevisionTrigger } from './plan-revision-trigger.js';

export type GeneratePlanRevisionResult =
  /** Revision 已提交，Run 转 running。 */
  | { readonly kind: 'committed'; readonly run: RunJson }
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

export function createGeneratePlanRevision(deps: UseCaseDeps): {
  execute(
    trigger: PlanRevisionTrigger,
    options?: GeneratePlanRevisionOptions,
  ): Promise<GeneratePlanRevisionResult>;
} {
  const now = (): string => formatRfc3339Utc(deps.clock.now());

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

    // §8.3：Planning 前置 Git 不变量 + Planning 快照。
    let startFact;
    try {
      startFact = await deps.git.assertSessionStart(root, sessionGitFacts(run), { planning: true });
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
    });

    const sessionBase = {
      type: 'planning',
      taskId: null,
      planRevision: run.planRevision + 1,
      specSha256: specBefore.sha256,
      permissionMode: 'plan',
      repositoryRoot: root,
    } as const;
    const invocation = await invokeResumableSession(deps, {
      run,
      session: sessionBase,
      freshPrompt: prompt,
      resume:
        options?.resumeFromSessionId === undefined
          ? null
          : {
              sessionId: options.resumeFromSessionId,
              prompt: buildPlanningResumePrompt(),
            },
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
      await deps.git.assertSessionEnd(root, sessionGitFacts(run), startFact);
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

    try {
      const committed = await applyPlanRevision(deps, handle.run, tasks, {
        draft: deps.redaction.redactStructured(fact.structuredResult),
        trigger: safeTrigger,
        plannerSessionId: handle.sessionId,
        specSha256: specBefore.sha256,
        repositoryRoot: root,
      });
      deps.logger.log('debug', 'planning.committed', {
        sessionId: handle.sessionId,
        planRevision: committed.planRevision,
        taskCount: Object.keys(committed.tasks).length,
      });
      return { kind: 'committed', run: committed };
    } catch (error) {
      return failWithSession(handle, error as ApexError);
    }
  }

  return { execute };
}
