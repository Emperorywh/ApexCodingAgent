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
import type { SessionRecord } from '../../domain/schemas/session-record.js';
import type { ClockPort } from '../ports/clock.js';
import type { OutputPort } from '../ports/output.js';
import type { RedactionPort } from '../ports/redaction.js';
import type { StateStorePort } from '../ports/state-store.js';
import { toErrorRecord } from './error-record.js';
import {
  closeExecutionEpisodeAsSessionError,
  closeFinalReviewEpisodeAsSessionError,
} from './run-transitions.js';

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

    // §17 第 3 步：风险提示（系统无法判断旧进程是否仍然存在）。
    deps.output.writeLine(
      deps.redaction.redactText(
        `警告：系统无法判断 run ${run.runId} 的旧 Apex/Claude 进程是否仍然存在；` +
          '请确认旧进程不再写入仓库后再继续。本命令不终止任何进程、不修改 Git。',
      ),
    );

    const abandoned = new ApexError({
      code: 'RUN_ABANDONED_BY_USER',
      stage: 'abandon',
      message: `run ${run.runId} abandoned by user via --force`,
      sessionId: run.activeSession?.sessionId ?? null,
      taskId: run.currentTaskId,
    });
    let next: RunJson = run;

    // §17 第 5 步：未结束 activeSession 且 Session Record 尚未写入时，补写
    // exitCode=null 的失败 Record（只表示 Coordinator 放弃接力）；已写入的
    // Record 保持不可修改。
    if (run.activeSession !== null) {
      const active = run.activeSession;
      const existing = await deps.stateStore.readSessionRecord(active.sessionId);
      if (existing === null) {
        const endedAt = now();
        const record: SessionRecord = {
          schemaVersion: 1,
          sessionId: active.sessionId,
          type: active.type,
          status: 'failed',
          runId: run.runId,
          taskId: active.taskId,
          planRevision: active.planRevision,
          specSha256: active.specSha256,
          startedAt: active.startedAt,
          endedAt,
          claude: { version: 'unknown', model: null, provider: null },
          exitCode: null,
          structuredResult: null,
          logPath: `logs/${active.sessionId}.log`,
          error: toErrorRecord(abandoned, endedAt, deps.redaction),
        };
        try {
          await deps.stateStore.writeSessionRecord(record);
        } catch (error) {
          // §11.4：该尝试失败不触发额外恢复协议，只输出诊断。
          const detail = error instanceof Error ? error.message : String(error);
          deps.output.writeLine(
            deps.redaction.redactText(
              `state_error: 失败 Session Record 无法写入（session ${active.sessionId}），仅输出诊断: ${detail}`,
            ),
          );
        }
      }
    }

    // §17 第 6 步：未结束 Episode 结束为 session_error（已结束的不改动）。
    // abandon 不读取 Git/SPEC，结束 SHA 沿用 Episode 启动前最后确认值。
    for (const task of Object.values(run.tasks)) {
      for (const episode of task.executionEpisodes) {
        if (episode.endedAt === null) {
          next = closeExecutionEpisodeAsSessionError(
            next,
            task.taskId,
            episode.sessionId,
            abandoned,
            now(),
            episode.specSha256Before,
            deps.redaction,
          );
        }
      }
    }
    for (const episode of run.finalReviewEpisodes) {
      if (episode.endedAt === null) {
        next = closeFinalReviewEpisodeAsSessionError(
          next,
          episode.sessionId,
          abandoned,
          now(),
          episode.specSha256Before,
          deps.redaction,
        );
      }
    }

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
