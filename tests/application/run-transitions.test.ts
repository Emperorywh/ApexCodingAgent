/**
 * toTerminalFailedRun 的 resumePoint 附着规则（SPEC §2.4/§17 resume）：
 * 前台中断、Claude 回合预算耗尽、已启动进程的非零退出与结果契约失败会
 * 在清槽前记录恢复点（失败前状态、对应 Task 与 Claude Session ID）；
 * 非会话型错误不得伪造恢复点。
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

  it('PLAN_REVISION_CONFLICT keeps the completed Planner Session resumable with feedback facts', () => {
    /**
     * 草稿确定性校验修正回路耗尽：Planner 会话进程正常结束（Record 已
     * 完成）、Run 状态未被草稿触碰。恢复点保留该会话身份，显式 resume
     * 续接它并携精确校验结论继续定向修正；上一轮独立复核反馈也必须
     * 保留，供重开的 Planning 重新消费。
     */
    const conflict = new ApexError({
      code: 'PLAN_REVISION_CONFLICT',
      stage: 'planning',
      message: 'unabsorbed intermediate checkpoint abc has no disposition',
    });
    const planning = mkRun({
      status: 'planning',
      planRevision: 1,
      tasksSha256: SHA256_A,
      activeSession: { ...activeSession, type: 'planning', taskId: null },
      planReviewFeedback: {
        planRevision: 2,
        plannerSessionId: UUID_1,
        reviewerSessionId: UUID_2,
        reviewAttempt: 1,
      },
    });
    const terminal = toTerminalFailedRun(planning, conflict, T1, redaction);
    expect(terminal.status).toBe('failed');
    expect(terminal.resumePoint).toEqual({
      fromStatus: 'planning',
      taskId: null,
      sessionId: UUID_1,
      sessionType: 'planning',
    });
    expect(terminal.planReviewFeedback).not.toBeNull();
  });

  it('PLAN_INVALID without a started session records a session-less planning resume point', () => {
    const invalid = new ApexError({
      code: 'PLAN_INVALID',
      stage: 'planning',
      message: 'task TASK-001 acceptance criterion 1 has no verification step',
    });
    const terminal = toTerminalFailedRun(mkRun({ status: 'planning' }), invalid, T1, redaction);
    expect(terminal.resumePoint).toEqual({
      fromStatus: 'planning',
      taskId: null,
      sessionId: null,
      sessionType: null,
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

  it('GIT_PUSH_FAILED keeps the delivered Execution Session resumable for a push retry', () => {
    /**
     * 远程发布失败时本地 Checkpoint 已记录为中间 Checkpoint、Session
     * Record 与 transcript 完好；恢复点保留已交付会话的身份，显式
     * resume 续接该会话重新交付并重试推送。
     */
    const pushFailure = new ApexError({
      code: 'GIT_PUSH_FAILED',
      stage: 'git-push',
      message: 'failed to push Run Branch to remote origin',
    });
    const failure = mkErrorRecord({
      errorCode: 'GIT_PUSH_FAILED',
      errorClass: 'git_error',
      message: 'failed to push Run Branch to remote origin',
    });
    const run = runningRunWithSession();
    const terminal = toTerminalFailedRun(
      {
        ...run,
        tasks: {
          'TASK-001': mkTaskState('TASK-001', 'failed', { failure }),
        },
      },
      pushFailure,
      T1,
      redaction,
    );
    expect(terminal.status).toBe('failed');
    expect(terminal.resumePoint).toEqual({
      fromStatus: 'running',
      taskId: 'TASK-001',
      sessionId: UUID_1,
      sessionType: 'execution',
    });
  });

  it('GIT_PUSH_FAILED in final review stays explicitly non-resumable', () => {
    /**
     * Final Review 的未推送提交由 FR 会话自己产生，没有可诚实归属的 Task；
     * final_review 不变式要求所有中间 Checkpoint 由 completed Task 吸收，
     * 恢复点会让 resume 的重开写入必然被拒。保持不可恢复而不是持久化一个
     * 注定失败的恢复点。
     */
    const pushFailure = new ApexError({
      code: 'GIT_PUSH_FAILED',
      stage: 'git-push',
      message: 'failed to push Run Branch to remote origin',
    });
    const reviewing = mkRun({
      status: 'final_review',
      planRevision: 1,
      tasksSha256: SHA256_A,
      activeSession: { ...activeSession, type: 'final_review', taskId: null },
    });
    const terminal = toTerminalFailedRun(reviewing, pushFailure, T1, redaction);
    expect(terminal.status).toBe('failed');
    expect(terminal.lastError?.errorCode).toBe('GIT_PUSH_FAILED');
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

  it('PLAN_REVIEW_RESULT_INVALID keeps the plan candidate and reviewer session resumable', () => {
    /**
     * 结果修复接力耗尽后的真实失败形状（2026-08 真实 Run 复盘）：进程正常
     * 结束、transcript 与候选草稿引用完好，只有结果未过语义门禁。恢复点
     * 续接复核会话，候选引用必须保留，否则 resume 无草稿可审。
     */
    const contractFailure = new ApexError({
      code: 'PLAN_REVIEW_RESULT_INVALID',
      stage: 'plan_review',
      message: 'approved task assessment TASK-001 requires an empty issues list',
    });
    const candidate = {
      planRevision: 1,
      plannerSessionId: UUID_1,
      specSha256: SHA256_A,
      trigger: { type: 'initial' as const, reason: '初始计划', sourceSessionId: null },
      reviewAttempt: 1,
    };
    const reviewing = mkRun({
      status: 'planning',
      planCandidate: candidate,
      activeSession: { ...activeSession, sessionId: UUID_2, type: 'plan_review', taskId: null },
    });
    const terminal = toTerminalFailedRun(reviewing, contractFailure, T1, redaction);
    expect(terminal.resumePoint).toEqual({
      fromStatus: 'planning',
      taskId: null,
      sessionId: UUID_2,
      sessionType: 'plan_review',
    });
    expect(terminal.planCandidate).toEqual(candidate);
  });

  it('TASK_REVIEW_RESULT_INVALID keeps the failed task candidate for the resumed reviewer', () => {
    /**
     * review-task.failWithSession 已把 Task 转 failed 并保留候选；本函数
     * 不得再清候选，resumePoint 续接返回非法结果的 Reviewer 会话。
     */
    const contractFailure = new ApexError({
      code: 'TASK_REVIEW_RESULT_INVALID',
      stage: 'task_review',
      message: 'approved requires an empty issues list',
    });
    const reviewing = mkRun({
      status: 'running',
      planRevision: 1,
      tasksSha256: SHA256_A,
      currentTaskId: 'TASK-001',
      activeSession: { ...activeSession, sessionId: UUID_2, type: 'task_review' },
      tasks: {
        'TASK-001': mkTaskState('TASK-001', 'failed', {
          failure: mkErrorRecord({
            errorCode: 'TASK_REVIEW_RESULT_INVALID',
            message: 'approved requires an empty issues list',
          }),
          candidateResult: mkResult(),
          candidateCheckpoint: OID_B,
        }),
      },
    });
    const terminal = toTerminalFailedRun(reviewing, contractFailure, T1, redaction);
    expect(terminal.resumePoint).toEqual({
      fromStatus: 'running',
      taskId: 'TASK-001',
      sessionId: UUID_2,
      sessionType: 'task_review',
    });
    const task = terminal.tasks['TASK-001']!;
    expect(task.status).toBe('failed');
    expect(task.candidateResult).not.toBeNull();
    expect(task.candidateCheckpoint).toBe(OID_B);
  });

  it('CLAUDE_RESULT_INVALID keeps the failed execution session resumable', () => {
    const contractFailure = new ApexError({
      code: 'CLAUDE_RESULT_INVALID',
      stage: 'execution',
      message: 'acceptanceEvidence missing criterionIndex 1',
    });
    const run = runningRunWithSession();
    const terminal = toTerminalFailedRun(
      {
        ...run,
        tasks: {
          'TASK-001': mkTaskState('TASK-001', 'failed', {
            failure: mkErrorRecord({ errorCode: 'CLAUDE_RESULT_INVALID' }),
          }),
        },
      },
      contractFailure,
      T1,
      redaction,
    );
    expect(terminal.resumePoint).toEqual({
      fromStatus: 'running',
      taskId: 'TASK-001',
      sessionId: UUID_1,
      sessionType: 'execution',
    });
  });

  it('FINAL_REVIEW_RESULT_INVALID keeps the final review session resumable', () => {
    const contractFailure = new ApexError({
      code: 'FINAL_REVIEW_RESULT_INVALID',
      stage: 'final_review',
      message: 'decision completed requires replanReason to be null',
    });
    const reviewing = mkRun({
      status: 'final_review',
      planRevision: 1,
      tasksSha256: SHA256_A,
      activeSession: { ...activeSession, sessionId: UUID_2, type: 'final_review', taskId: null },
    });
    const terminal = toTerminalFailedRun(reviewing, contractFailure, T1, redaction);
    expect(terminal.resumePoint).toEqual({
      fromStatus: 'final_review',
      taskId: null,
      sessionId: UUID_2,
      sessionType: 'final_review',
    });
  });
});
