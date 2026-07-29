/**
 * AbandonRun 用例（SPEC §17 abandon --force 十步、§4.4 非终态旧 Run 处理）。
 *
 * 在用户确认旧进程已停止后，把无法继续的非终态 Run 显式转为 abandoned。
 * 本用例不调用 Claude、不终止进程、不修改 Git、不生成 Checkpoint；已写入
 * 的 Session Record 与已结束 Episode 保持不可修改。
 */
import { ApexError, isApexError } from '../../domain/errors.js';
import { applyRunEvent, isTerminalRunStatus } from '../../domain/run-state.js';
import { assertTaskTransition } from '../../domain/task-state.js';
import { formatRfc3339Utc } from '../../domain/time.js';
import type { RunJson } from '../../domain/schemas/run-json.js';
import type { ClockPort } from '../ports/clock.js';
import type { OutputPort } from '../ports/output.js';
import type { RedactionPort } from '../ports/redaction.js';
import type { StateStorePort } from '../ports/state-store.js';
import { toErrorRecord } from './error-record.js';
import { reconcileOrphanedSessionFacts } from './orphaned-session-reconciler.js';
import { readOwnerLiveness, type OwnerLiveness } from './run-heartbeat.js';

export interface AbandonRunDeps {
  readonly stateStore: StateStorePort;
  readonly clock: ClockPort;
  readonly redaction: RedactionPort;
  readonly output: OutputPort;
}

export interface AbandonRunInput {
  /** §17 第 2 步：必须显式 --force。 */
  readonly force: boolean;
}

export interface AbandonRunResult {
  readonly run: RunJson;
}

/**
 * §17 第 3 步风险提示：有存活信号依据时给出精确事实，无依据时保持
 * "系统无法判断"的人工确认语义。abandon 始终要求 --force（§17 第 2 步），
 * 存活信号只改变提示内容，不改变门槛。
 */
function abandonRiskWarning(run: RunJson, liveness: OwnerLiveness): string {
  switch (liveness.kind) {
    case 'presumed_dead':
      return (
        `run ${run.runId} 的属主进程已 ${Math.round(liveness.ageMs / 1000)} 秒未发送存活信号，` +
        '判定为崩溃离场；本命令只做状态收尾，不终止任何进程、不修改 Git。'
      );
    case 'active':
      return (
        `警告：run ${run.runId} 的属主进程在 ${Math.round(liveness.ageMs / 1000)} 秒前仍有存活信号；` +
        '请确认旧进程已停止，否则 abandon 会与仍在运行的进程并发写状态。本命令不终止任何进程、不修改 Git。'
      );
    default:
      return (
        `警告：系统无法判断 run ${run.runId} 的旧 Apex/Claude 进程是否仍然存在；` +
        '请确认旧进程不再写入仓库后再继续。本命令不终止任何进程、不修改 Git。'
      );
  }
}

export function createAbandonRun(deps: AbandonRunDeps): {
  execute(input: AbandonRunInput): Promise<AbandonRunResult>;
} {
  const now = (): string => formatRfc3339Utc(deps.clock.now());

  async function execute(input: AbandonRunInput): Promise<AbandonRunResult> {
    // §17 第 1 步：要求存在严格 Schema 合法的非终态 run.json。
    let run: RunJson | null;
    try {
      run = await deps.stateStore.readRun();
    } catch (error) {
      if (isApexError(error) && error.errorCode === 'STATE_VALIDATION_FAILED') {
        throw new ApexError({
          code: 'COMMAND_STATE_INVALID',
          stage: 'abandon',
          message: `run.json is not a strictly valid state file: ${error.message}`,
          cause: error,
        });
      }
      throw error;
    }
    if (run === null) {
      throw new ApexError({
        code: 'RUN_NOT_FOUND',
        stage: 'abandon',
        message: 'no run.json exists; nothing to abandon',
      });
    }
    if (isTerminalRunStatus(run.status)) {
      throw new ApexError({
        code: 'RUN_NOT_ABANDONABLE',
        stage: 'abandon',
        message: `run ${run.runId} is already terminal (${run.status})`,
      });
    }

    // §17 第 2 步：必须显式 --force。
    if (!input.force) {
      throw new ApexError({
        code: 'ABANDON_REQUIRES_FORCE',
        stage: 'abandon',
        message: 'abandon requires the explicit --force flag',
      });
    }

    // §17 第 3 步：按属主存活性给出精确风险提示。
    const liveness = await readOwnerLiveness(deps.stateStore, deps.clock, run.runId);
    deps.output.writeLine(deps.redaction.redactText(abandonRiskWarning(run, liveness)));

    const abandoned = new ApexError({
      code: 'RUN_ABANDONED_BY_USER',
      stage: 'abandon',
      message: `run ${run.runId} abandoned by user via --force`,
      sessionId: run.activeSession?.sessionId ?? null,
      taskId: run.currentTaskId,
    });
    /**
     * §17 第 5–6 步由共享协调器完成：不可变 Session Record 补写与全部
     * 未结束 Episode 收尾只有一份实现，resume --force 复用同一协议。
     */
    let next: RunJson = await reconcileOrphanedSessionFacts(deps, run, abandoned);

    // §17 第 7 步：原 running Task 转 failed 并记录 RUN_ABANDONED_BY_USER。
    for (const task of Object.values(next.tasks)) {
      if (task.status === 'running') {
        assertTaskTransition(task.status, 'failed', 'run_abandoned');
        next = {
          ...next,
          tasks: {
            ...next.tasks,
            [task.taskId]: {
              ...task,
              status: 'failed',
              failure: toErrorRecord(abandoned, now(), deps.redaction),
            },
          },
        };
      }
    }

    // §17 第 8–9 步：清槽，Run 转 abandoned 并保存 terminalAt。
    const at = now();
    next = {
      ...next,
      status: applyRunEvent(next.status, 'RUN_ABANDONED'),
      activeSession: null,
      currentTaskId: null,
      lastError: toErrorRecord(abandoned, at, deps.redaction),
      terminalAt: at,
      updatedAt: at,
      stateRevision: next.stateRevision + 1,
    };
    // §17 第 10 步：保留其余 Task、Session、日志、工作区和分支事实（本用例
    // 只写 run.json 与必要的 Session Record，其余一概不碰）。
    await deps.stateStore.writeRun(next);
    return { run: next };
  }

  return { execute };
}
