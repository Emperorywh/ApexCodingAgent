/**
 * toTerminalFailedRun 的 resumePoint 附着规则（SPEC §2.4/§17 resume）：
 * 仅 RUN_INTERRUPTED 的终态失败在清槽前记录恢复点（中断前状态、被中断
 * Task 与 Claude Session ID），其余错误一律 resumePoint=null。
 */
import { describe, expect, it } from 'vitest';
import { createRedactor } from '../../src/adapters/redaction/redactor.js';
import { toTerminalFailedRun } from '../../src/application/usecases/run-transitions.js';
import { ApexError } from '../../src/domain/errors.js';
import type { ActiveSession } from '../../src/domain/schemas/active-session.js';
import { mkRun, mkTaskState, SHA256_A, T0, T1, UUID_1 } from '../domain/fixtures.js';

const redaction = createRedactor();

function interrupted(): ApexError {
  return new ApexError({
    code: 'RUN_INTERRUPTED',
    stage: 'execution',
    message: 'foreground interrupt requested',
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
    });
  });

  it('RUN_INTERRUPTED between sessions records a session-less resume point', () => {
    const planning = mkRun({ status: 'planning' });
    const terminal = toTerminalFailedRun(planning, interrupted(), T1, redaction);
    expect(terminal.resumePoint).toEqual({
      fromStatus: 'planning',
      taskId: null,
      sessionId: null,
    });
  });

  it('RUN_INTERRUPTED in final review keeps final_review as the resume target', () => {
    const reviewing = mkRun({ status: 'final_review', planRevision: 1, tasksSha256: SHA256_A });
    const terminal = toTerminalFailedRun(reviewing, interrupted(), T1, redaction);
    expect(terminal.resumePoint).toEqual({
      fromStatus: 'final_review',
      taskId: null,
      sessionId: null,
    });
  });

  it('non-interrupt failures never carry a resume point', () => {
    const claudeFailure = new ApexError({
      code: 'CLAUDE_EXIT_NONZERO',
      stage: 'execution',
      message: 'claude exited 1',
    });
    const terminal = toTerminalFailedRun(runningRunWithSession(), claudeFailure, T1, redaction);
    expect(terminal.resumePoint).toBeNull();
  });
});
