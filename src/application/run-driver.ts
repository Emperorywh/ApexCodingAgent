/**
 * Run 驱动器（SPEC §5.4 运行模型、§2.4 中断收尾的应用层部分、§17 start
 * 进度摘要）：前台串行调度循环 planning → 逐 Task → final_review → 终态。
 *
 * - 顶层 Task 串行、同一时刻最多一个 Claude Session；每次状态迁移输出一行
 *   经脱敏的进度摘要。
 * - Plan Revision 触发原因（trigger）在进程内随循环传递：Execution/Final
 *   Review 给出的 replan 原因在下一轮 Planning 中使用；提交后清零。
 * - `requestInterrupt()` 只转发给中断控制器：停止启动新 Session、经绑定的
 *   abort 杀直接子进程；有界等待与收尾在会话原语（invokeSession）内完成。
 *   中断落在会话之外时（循环顶部检查），直接把当前 Run 收尾为 failed
 *   （RUN_INTERRUPTED）。
 */
import { ApexError, isApexError } from '../domain/errors.js';
import { isTerminalRunStatus } from '../domain/run-state.js';
import { formatRfc3339Utc } from '../domain/time.js';
import type { PlanRevisionTrigger } from '../domain/schemas/plan-revision-snapshot.js';
import type { RunJson } from '../domain/schemas/run-json.js';
import type { UseCaseDeps } from './usecase-deps.js';
import { createExecuteNextTask } from './usecases/execute-next-task.js';
import { createGeneratePlanRevision } from './usecases/generate-plan-revision.js';
import { createRunFinalReview } from './usecases/run-final-review.js';
import { persistRunBestEffort, toTerminalFailedRun } from './usecases/run-transitions.js';

export interface RunDriver {
  /** 驱动当前 Run 到终态并返回终态 run.json。 */
  driveToTerminal(): Promise<RunJson>;
  /** 第一次中断信号（§2.4）：停止新 Session 并请求终止直接子进程。 */
  requestInterrupt(): void;
}

const INITIAL_TRIGGER: PlanRevisionTrigger = {
  type: 'initial',
  reason: '初始计划',
  sourceSessionId: null,
};

export function createRunDriver(deps: UseCaseDeps): RunDriver {
  const generatePlanRevision = createGeneratePlanRevision(deps);
  const executeNextTask = createExecuteNextTask(deps);
  const runFinalReview = createRunFinalReview(deps);

  function progress(line: string): void {
    deps.output.writeLine(deps.redaction.redactText(`[apex] ${line}`));
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
    const run = await deps.stateStore.readRun().catch(() => null);
    if (run === null || isTerminalRunStatus(run.status)) {
      throw apex;
    }
    const terminal = toTerminalFailedRun(
      run,
      apex,
      formatRfc3339Utc(deps.clock.now()),
      deps.redaction,
    );
    await persistRunBestEffort(deps, terminal);
    return terminal;
  }

  async function driveToTerminal(): Promise<RunJson> {
    let trigger = INITIAL_TRIGGER;
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
          formatRfc3339Utc(deps.clock.now()),
          deps.redaction,
        );
        await persistRunBestEffort(deps, terminal);
        progress(`run ${run.runId} ${run.status} -> failed (RUN_INTERRUPTED)`);
        return terminal;
      }

      try {
        switch (run.status) {
          case 'planning': {
            const result = await generatePlanRevision.execute(trigger);
            if (result.kind === 'committed') {
              progress(
                `run ${run.runId} planning -> running (plan revision ${result.run.planRevision} committed)`,
              );
              trigger = INITIAL_TRIGGER;
            } else if (result.kind === 'spec-changed') {
              progress(`run ${run.runId} SPEC changed during planning; replanning`);
            } else {
              progress(`run ${run.runId} planning -> failed (${result.run.lastError?.errorCode ?? 'unknown'})`);
              return result.run;
            }
            break;
          }
          case 'running': {
            const result = await executeNextTask.execute();
            if (result.kind === 'task-completed') {
              const checkpoint = result.run.tasks[result.taskId]?.finalCheckpoint ?? '';
              progress(`task ${result.taskId} -> completed (checkpoint ${checkpoint.slice(0, 12)})`);
            } else if (result.kind === 'replan-needed') {
              trigger = result.trigger;
              progress(`run ${run.runId} running -> planning (${result.trigger.type})`);
            } else if (result.kind === 'final-review') {
              progress(`run ${run.runId} running -> final_review (all tasks completed)`);
            } else {
              progress(`run ${run.runId} running -> failed (${result.run.lastError?.errorCode ?? 'unknown'})`);
              return result.run;
            }
            break;
          }
          case 'final_review': {
            const result = await runFinalReview.execute();
            if (result.kind === 'completed') {
              progress(`run ${run.runId} final_review -> completed (report ${result.run.reportPath ?? 'report.md'})`);
              return result.run;
            }
            if (result.kind === 'replan-needed') {
              trigger = result.trigger;
              progress(`run ${run.runId} final_review -> planning (${result.trigger.type})`);
            } else {
              progress(`run ${run.runId} final_review -> failed (${result.run.lastError?.errorCode ?? 'unknown'})`);
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
