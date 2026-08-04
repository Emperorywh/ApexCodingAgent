/**
 * toTerminalFailedRun 的 resumePoint 附着规则（SPEC §2.4/§17 resume）：
 * 前台中断、Claude 回合预算耗尽与已启动进程的非零退出会在清槽前记录
 * 恢复点（失败前状态、对应 Task 与 Claude Session ID）；非会话型错误不
 * 得伪造恢复点。
 */
import { describe, expect, it } from 'vitest';
import { createRedactor } from '../../src/adapters/redaction/redactor.js';
import { toTerminalFailedRun } from '../../src/application/usecases/run-transitions.js';
import { ApexError } from '../../src/domain/errors.js';
import type { ActiveSession } from '../../src/domain/schemas/active-session.js';
import { mkErrorRecord, mkResult, mkRun, mkTaskState, OID_B, SHA256_A, T0, T1, UUID_1, UUID_2 } from '../domain/fixtures.js';

const redaction = createRedactor();

function interrupted(): ApexError {
  return new ApexError({
    code: 'RUN_INTERRUPTED',
    stage: 'execution',
    message: 'foreground interrupt requested',
  });
}

function turnLimitReached(): ApexError {
  return new ApexError({
    code: 'CLAUDE_TURN_LIMIT_REACHED',
    stage: 'execution',
    message: 'claude reached the configured turn limit before completing the session',
  });
}

const activeSession: ActiveSession = {
  sessionId: UUID_1,
  type: 'execution',
  taskId: 'TASK-001',
  planRevision: 1,
  specSha256: SHA256_A,
  startedAt: T0,
};

function runningRunWithSession() {
  return mkRun({
    status: 'running',
    planRevision: 1,
    tasksSha256: SHA256_A,
    currentTaskId: 'TASK-001',
    activeSession,
    tasks: { 'TASK-001': mkTaskState('TASK-001', 'running') },
  });
}

describe('toTerminalFailedRun resumePoint (§2.4/§17)', () => {
  it('RUN_INTERRUPTED captures the pre-interrupt status, task and session before clearing slots', () => {
    const terminal = toTerminalFailedRun(runningRunWithSession(), interrupted(), T1, redaction);
    expect(terminal.status).toBe('failed');
    expect(terminal.activeSession).toBeNull();
    expect(terminal.currentTaskId).toBeNull();
    expect(terminal.terminalAt).toBe(T1);
    expect(terminal.resumePoint).toEqual({
      fromStatus: 'running',
      taskId: 'TASK-001',
      sessionId: UUID_1,
      sessionType: 'execution',
    });
  });

  it('RUN_INTERRUPTED between sessions records a session-less resume point', () => {
    const planning = mkRun({ status: 'planning' });
    const terminal = toTerminalFailedRun(planning, interrupted(), T1, redaction);
    expect(terminal.resumePoint).toEqual({
      fromStatus: 'planning',
      taskId: null,
      sessionId: null,
      sessionType: null,
    });
  });

  it('RUN_INTERRUPTED in final review keeps final_review as the resume target', () => {
    const reviewing = mkRun({ status: 'final_review', planRevision: 1, tasksSha256: SHA256_A });
    const terminal = toTerminalFailedRun(reviewing, interrupted(), T1, redaction);
    expect(terminal.resumePoint).toEqual({
      fromStatus: 'final_review',
      taskId: null,
      sessionId: null,
      sessionType: null,
    });
  });

  it('CLAUDE_TURN_LIMIT_REACHED keeps the failed Execution Session resumable', () => {
    const failure = mkErrorRecord({
      errorCode: 'CLAUDE_TURN_LIMIT_REACHED',
      errorClass: 'claude_error',
      message: 'claude reached the configured turn limit before completing the session',
    });
    const run = runningRunWithSession();
    const terminal = toTerminalFailedRun(
      {
        ...run,
        tasks: {
          'TASK-001': mkTaskState('TASK-001', 'failed', { failure }),
        },
      },
      turnLimitReached(),
      T1,
      redaction,
    );

    /**
     * 硬预算仍让 Run 结束为 failed，但必须保留原 Session ID；后续只有用户
     * 显式执行 resume 才会获得一份新的回合预算。
     */
    expect(terminal.status).toBe('failed');
    expect(terminal.lastError?.errorCode).toBe('CLAUDE_TURN_LIMIT_REACHED');
    expect(terminal.resumePoint).toEqual({
      fromStatus: 'running',
      taskId: 'TASK-001',
      sessionId: UUID_1,
      sessionType: 'execution',
    });
  });

  it('CLAUDE_EXIT_NONZERO keeps the started Execution Session for explicit resume', () => {
    const claudeFailure = new ApexError({
      code: 'CLAUDE_EXIT_NONZERO',
      stage: 'execution',
      message: 'claude exited 1',
    });
    const terminal = toTerminalFailedRun(runningRunWithSession(), claudeFailure, T1, redaction);
    /**
     * 非零退出仍立即结束 Run，但不能抹掉已经持久化的 Session 身份；是否
     * 真有 transcript 由后续显式 resume 的标准续接/全新会话协议判定。
     */
    expect(terminal.resumePoint).toEqual({
      fromStatus: 'running',
      taskId: 'TASK-001',
      sessionId: UUID_1,
      sessionType: 'execution',
    });
  });

  it('non-session failures never carry a resume point', () => {
    const gitFailure = new ApexError({
      code: 'GIT_COMMAND_FAILED',
      stage: 'checkpoint',
      message: 'git failed',
    });
    const terminal = toTerminalFailedRun(runningRunWithSession(), gitFailure, T1, redaction);
    /**
     * Git 等非 Session 错误没有可续接的 Claude 上下文；即使清槽前恰好还
     * 有 activeSession 事实，也不能越过错误策略生成恢复点。
     */
    expect(terminal.resumePoint).toBeNull();
  });

  it('RUN_INTERRUPTED in the pre-review window fails the task but keeps its candidate', () => {
    /**
     * 候选已持久化、Reviewer 尚未启动（无 activeSession）的窗口：没有可
     * 续接的会话，resumePoint 记 task_review + sessionId null；被中断
     * Task 转 failed 且保留候选，resume 后由全新 Reviewer 复核。
     */
    const windowRun = mkRun({
      status: 'running',
      planRevision: 1,
      tasksSha256: SHA256_A,
      currentTaskId: 'TASK-001',
      activeSession: null,
      tasks: {
        'TASK-001': mkTaskState('TASK-001', 'running', {
          candidateResult: mkResult(),
          candidateCheckpoint: OID_B,
        }),
      },
    });
    const terminal = toTerminalFailedRun(windowRun, interrupted(), T1, redaction);
    expect(terminal.status).toBe('failed');
    expect(terminal.resumePoint).toEqual({
      fromStatus: 'running',
      taskId: 'TASK-001',
      sessionId: null,
      sessionType: 'task_review',
    });
    const task = terminal.tasks['TASK-001']!;
    expect(task.status).toBe('failed');
    expect(task.failure?.errorCode).toBe('RUN_INTERRUPTED');
    expect(task.candidateResult).not.toBeNull();
    expect(task.candidateCheckpoint).toBe(OID_B);
  });

  it('RUN_INTERRUPTED with an active review session keeps the resumable session id', () => {
    // 非窗口形状：Reviewer 已启动，本函数不把 Task 转 failed，
    // resumePoint 续接的是被中断的 Reviewer 会话本身。
    const reviewing = mkRun({
      status: 'running',
      planRevision: 1,
      tasksSha256: SHA256_A,
      currentTaskId: 'TASK-001',
      activeSession: { ...activeSession, sessionId: UUID_2, type: 'task_review' },
      tasks: {
        'TASK-001': mkTaskState('TASK-001', 'running', {
          candidateResult: mkResult(),
          candidateCheckpoint: OID_B,
        }),
      },
    });
    const terminal = toTerminalFailedRun(reviewing, interrupted(), T1, redaction);
    expect(terminal.resumePoint).toEqual({
      fromStatus: 'running',
      taskId: 'TASK-001',
      sessionId: UUID_2,
      sessionType: 'task_review',
    });
    expect(terminal.tasks['TASK-001']!.status).toBe('running');
  });
});
