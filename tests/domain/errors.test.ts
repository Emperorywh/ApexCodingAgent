/**
 * Error model (SPEC §15.2/§15.3): stable errorCode → errorClass mapping and
 * the ApexError shape.
 */
import { describe, expect, it } from 'vitest';
import {
  ApexError,
  ERROR_CLASSES,
  ERROR_CODE_TO_CLASS,
  ERROR_CODES,
  errorClassForCode,
  isApexError,
  isResumableErrorCode,
  isResultContractErrorCode,
  isTurnBudgetExhaustedErrorCode,
  type ErrorClass,
  type ErrorCode,
} from '../../src/domain/errors.js';

const EXPECTED_TABLE: Record<ErrorClass, readonly ErrorCode[]> = {
  startup_validation: [
    'ENVIRONMENT_UNSUPPORTED',
    'SPEC_NOT_FOUND',
    'SPEC_AMBIGUOUS',
    'SPEC_EMPTY',
    'SPEC_NOT_REGULAR_FILE',
    'SPEC_NOT_READABLE',
    'SPEC_INVALID_UTF8',
    'SPEC_OUTSIDE_REPOSITORY',
    'SPEC_STAGED',
    'WORKING_TREE_DIRTY',
    'STATE_DIRECTORY_TRACKED',
    'STATE_DIRECTORY_UNWRITABLE',
    'GIT_UNAVAILABLE',
    'GIT_WORKTREE_REQUIRED',
    'GIT_HEAD_REQUIRED',
    'BASE_BRANCH_REQUIRED',
    'GIT_REMOTE_INVALID',
    'CLAUDE_CAPABILITY_MISSING',
    'CLAUDE_INSTALLATION_UNHEALTHY',
    'SETTINGS_INVALID',
    'RUN_ALREADY_ACTIVE_OR_INTERRUPTED',
    'STATE_INVALID',
    'ARCHIVE_FAILED',
    'ARCHIVE_CONFLICT',
  ],
  run_error: ['RUN_INTERRUPTED'],
  run_control: ['RUN_ABANDONED_BY_USER'],
  claude_error: [
    'CLAUDE_START_FAILED',
    'CLAUDE_EXIT_NONZERO',
    'CLAUDE_TURN_LIMIT_REACHED',
    'CLAUDE_STREAM_FAILED',
    'CLAUDE_RESUME_UNAVAILABLE',
    'CLAUDE_RESULT_INVALID',
    'CLAUDE_REPORTED_FAILURE',
    'PLAN_REVIEW_RESULT_INVALID',
    'TASK_REVIEW_RESULT_INVALID',
    'FINAL_REVIEW_RESULT_INVALID',
  ],
  plan_error: [
    'PLAN_INVALID',
    'PLAN_REVISION_CONFLICT',
    'PLAN_REVISION_LIMIT_EXCEEDED',
    'PLAN_REVIEW_REWORK_LIMIT_EXCEEDED',
    'TASK_REVIEW_REWORK_LIMIT_EXCEEDED',
  ],
  git_error: [
    'GIT_COMMAND_FAILED',
    'GIT_FACT_CONFLICT',
    'GIT_HISTORY_DIVERGED',
    'PLANNING_SIDE_EFFECT_DETECTED',
    'PLAN_REVIEW_SIDE_EFFECT_DETECTED',
    'TASK_REVIEW_SIDE_EFFECT_DETECTED',
    'PROTECTED_PATH_CHANGED',
    'GIT_PUSH_FAILED',
  ],
  state_error: ['STATE_WRITE_FAILED', 'STATE_VALIDATION_FAILED'],
  report_error: ['FINAL_REPORT_GENERATION_FAILED'],
  command_error: [
    'CLI_USAGE_INVALID',
    'RUN_NOT_FOUND',
    'COMMAND_STATE_INVALID',
    'REPORT_NOT_AVAILABLE',
    'REPORT_COMMAND_FAILED',
    'STATE_SNAPSHOT_BUSY',
    'RUN_NOT_ABANDONABLE',
    'ABANDON_REQUIRES_FORCE',
    'RUN_NOT_RESUMABLE',
    'RESUME_REQUIRES_FORCE',
  ],
};

describe('error model (§15)', () => {
  it('defines exactly 62 stable error codes and 9 error classes', () => {
    expect(ERROR_CODES).toHaveLength(62);
    expect(ERROR_CLASSES).toHaveLength(9);
  });

  it('maps every errorCode to its §15.3 errorClass', () => {
    for (const [errorClass, codes] of Object.entries(EXPECTED_TABLE)) {
      for (const code of codes) {
        expect(errorClassForCode(code)).toBe(errorClass);
        expect(ERROR_CODE_TO_CLASS[code]).toBe(errorClass);
      }
    }
  });

  it('covers every expected code exactly once', () => {
    const allExpected = Object.values(EXPECTED_TABLE).flat();
    expect(allExpected).toHaveLength(62);
    expect([...ERROR_CODES].sort()).toEqual([...allExpected].sort());
  });

  it('keeps started-session exits eligible only for explicit resume', () => {
    /**
     * 这组策略值决定终态是否持久化 resumePoint。通用非零退出必须保留
     * Session 身份，而启动前失败和非 Session 错误不能伪造续接上下文。
     */
    expect(isResumableErrorCode('RUN_INTERRUPTED')).toBe(true);
    expect(isResumableErrorCode('CLAUDE_TURN_LIMIT_REACHED')).toBe(true);
    expect(isResumableErrorCode('CLAUDE_EXIT_NONZERO')).toBe(true);
    expect(isResumableErrorCode('CLAUDE_START_FAILED')).toBe(false);
    expect(isResumableErrorCode('GIT_COMMAND_FAILED')).toBe(false);
  });

  it('keeps result-contract failures resumable across all four stages', () => {
    /**
     * 结果契约失败时进程正常结束、transcript 与候选事实完好；修复接力
     * 耗尽后持久化恢复点，显式 resume 续接同一会话重新交付合法结果，
     * 而不是报废整个 Run。
     */
    expect(isResumableErrorCode('CLAUDE_RESULT_INVALID')).toBe(true);
    expect(isResumableErrorCode('PLAN_REVIEW_RESULT_INVALID')).toBe(true);
    expect(isResumableErrorCode('TASK_REVIEW_RESULT_INVALID')).toBe(true);
    expect(isResumableErrorCode('FINAL_REVIEW_RESULT_INVALID')).toBe(true);
    expect(isResultContractErrorCode('CLAUDE_RESULT_INVALID')).toBe(true);
    expect(isResultContractErrorCode('FINAL_REVIEW_RESULT_INVALID')).toBe(true);
    expect(isResultContractErrorCode('CLAUDE_EXIT_NONZERO')).toBe(false);
    expect(isResultContractErrorCode('RUN_INTERRUPTED')).toBe(false);
  });

  it('keeps plan draft validation failures resumable for explicit resume', () => {
    /**
     * 进程内修正回路耗尽只说明当前模型多轮仍未给出合法草稿；Run 状态未被
     * 草稿触碰、刚完成的 Planner transcript 完好。持久化恢复点让用户可以
     * 显式 resume（例如先升级 CLI 或切换模型），续接同一会话携精确校验
     * 结论继续修正，而不是报废已完成的全部 Task。Revision 上限与状态损坏
     * 不是模型可修正事实，保持不可恢复。
     */
    expect(isResumableErrorCode('PLAN_INVALID')).toBe(true);
    expect(isResumableErrorCode('PLAN_REVISION_CONFLICT')).toBe(true);
    expect(isResumableErrorCode('PLAN_REVISION_LIMIT_EXCEEDED')).toBe(false);
    expect(isResumableErrorCode('STATE_VALIDATION_FAILED')).toBe(false);
  });

  it('keeps remote publication failure resumable while repository conflicts stay terminal', () => {
    /**
     * GIT_PUSH_FAILED 时本地 Checkpoint、Session Record 与 transcript 全部
     * 完好，唯一缺口是远程交付；持久化恢复点让用户修复网络/鉴权/远程配置
     * 后显式 resume 重试推送，而不是把已完成工作整体报废。仓库事实冲突
     * （并发改动）不存在可续接的安全断点，必须保持不可恢复。
     */
    expect(isResumableErrorCode('GIT_PUSH_FAILED')).toBe(true);
    expect(isResumableErrorCode('GIT_FACT_CONFLICT')).toBe(false);
    expect(isResumableErrorCode('GIT_COMMAND_FAILED')).toBe(false);
  });

  it('classifies only the stable Execution turn-budget error as exhausted', () => {
    /**
     * 外层恢复策略只能消费领域分类，不能自行解释 Claude 原始流；这里锁定
     * 分类边界，防止普通退出或人工中断误触发预算耗尽的收敛提示。
     */
    expect(isTurnBudgetExhaustedErrorCode('CLAUDE_TURN_LIMIT_REACHED')).toBe(true);
    expect(isTurnBudgetExhaustedErrorCode('CLAUDE_EXIT_NONZERO')).toBe(false);
    expect(isTurnBudgetExhaustedErrorCode('RUN_INTERRUPTED')).toBe(false);
  });

  it('ApexError carries code, derived class, stage and optional facts', () => {
    const error = new ApexError({
      code: 'CLAUDE_EXIT_NONZERO',
      stage: 'execution',
      message: 'claude exited 1',
      toolSummary: 'exit 1',
      sessionId: '123e4567-e89b-42d3-a456-426614174000',
      taskId: 'TASK-001',
    });
    expect(error.errorCode).toBe('CLAUDE_EXIT_NONZERO');
    expect(error.errorClass).toBe('claude_error');
    expect(error.stage).toBe('execution');
    expect(error.message).toBe('claude exited 1');
    expect(error.toolSummary).toBe('exit 1');
    expect(error.sessionId).toBe('123e4567-e89b-42d3-a456-426614174000');
    expect(error.taskId).toBe('TASK-001');
    expect(isApexError(error)).toBe(true);
  });

  it('ApexError defaults optional facts to null', () => {
    const error = new ApexError({ code: 'PLAN_INVALID', stage: 'planning', message: 'bad plan' });
    expect(error.toolSummary).toBeNull();
    expect(error.sessionId).toBeNull();
    expect(error.taskId).toBeNull();
    expect(isApexError(new Error('nope'))).toBe(false);
  });
});
