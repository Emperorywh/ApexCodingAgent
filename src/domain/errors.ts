/**
 * Stable error model (SPEC §15.2/§15.3).
 *
 * Every failure surfaced by the system carries a stable `errorCode`; the code
 * deterministically maps to an `errorClass` which drives run-level behavior.
 * Domain code throws {@link ApexError} with these codes instead of ad-hoc
 * strings.
 */

export const ERROR_CLASSES = [
  'startup_validation',
  'run_error',
  'run_control',
  'claude_error',
  'plan_error',
  'git_error',
  'state_error',
  'report_error',
  'command_error',
] as const;

export type ErrorClass = (typeof ERROR_CLASSES)[number];

/** errorCode -> errorClass, mirroring SPEC §15.3 exactly. */
export const ERROR_CODE_TO_CLASS = {
  // startup_validation
  ENVIRONMENT_UNSUPPORTED: 'startup_validation',
  SPEC_NOT_FOUND: 'startup_validation',
  SPEC_AMBIGUOUS: 'startup_validation',
  SPEC_EMPTY: 'startup_validation',
  SPEC_NOT_REGULAR_FILE: 'startup_validation',
  SPEC_NOT_READABLE: 'startup_validation',
  SPEC_INVALID_UTF8: 'startup_validation',
  SPEC_OUTSIDE_REPOSITORY: 'startup_validation',
  SPEC_STAGED: 'startup_validation',
  WORKING_TREE_DIRTY: 'startup_validation',
  STATE_DIRECTORY_TRACKED: 'startup_validation',
  STATE_DIRECTORY_UNWRITABLE: 'startup_validation',
  GIT_UNAVAILABLE: 'startup_validation',
  GIT_WORKTREE_REQUIRED: 'startup_validation',
  GIT_HEAD_REQUIRED: 'startup_validation',
  BASE_BRANCH_REQUIRED: 'startup_validation',
  /*
   * 自动推送在 Run 创建前要求远程目标可解析；该错误不会产生或修改
   * Run，避免工作完成后才发现目标远程根本不存在。
   */
  GIT_REMOTE_INVALID: 'startup_validation',
  CLAUDE_CAPABILITY_MISSING: 'startup_validation',
  CLAUDE_INSTALLATION_UNHEALTHY: 'startup_validation',
  SETTINGS_INVALID: 'startup_validation',
  RUN_ALREADY_ACTIVE_OR_INTERRUPTED: 'startup_validation',
  STATE_INVALID: 'startup_validation',
  ARCHIVE_FAILED: 'startup_validation',
  ARCHIVE_CONFLICT: 'startup_validation',
  // run_error
  RUN_INTERRUPTED: 'run_error',
  // run_control
  RUN_ABANDONED_BY_USER: 'run_control',
  // claude_error
  CLAUDE_START_FAILED: 'claude_error',
  CLAUDE_EXIT_NONZERO: 'claude_error',
  CLAUDE_TURN_LIMIT_REACHED: 'claude_error',
  CLAUDE_STREAM_FAILED: 'claude_error',
  CLAUDE_RESUME_UNAVAILABLE: 'claude_error',
  CLAUDE_RESULT_INVALID: 'claude_error',
  CLAUDE_REPORTED_FAILURE: 'claude_error',
  PLAN_REVIEW_RESULT_INVALID: 'claude_error',
  TASK_REVIEW_RESULT_INVALID: 'claude_error',
  FINAL_REVIEW_RESULT_INVALID: 'claude_error',
  // plan_error
  PLAN_INVALID: 'plan_error',
  PLAN_REVISION_CONFLICT: 'plan_error',
  PLAN_REVISION_LIMIT_EXCEEDED: 'plan_error',
  /*
   * 同一未提交 Revision 的独立计划复核连续打回达到上限时终止，避免
   * Planner 与 Reviewer 在没有新增事实的情况下形成无界反馈循环。
   */
  PLAN_REVIEW_REWORK_LIMIT_EXCEEDED: 'plan_error',
  /*
   * 历史错误码：独立复核连续打回同一 Task 达到上限。现行为是升级为
   * Replan（当前计划边界内无法收敛时由 Planner 重新划分），Run 不再因此
   * 终止；此码保留在注册表中以兼容历史 Run 状态与报告。
   */
  TASK_REVIEW_REWORK_LIMIT_EXCEEDED: 'plan_error',
  // git_error
  GIT_COMMAND_FAILED: 'git_error',
  GIT_FACT_CONFLICT: 'git_error',
  GIT_HISTORY_DIVERGED: 'git_error',
  PLANNING_SIDE_EFFECT_DETECTED: 'git_error',
  PLAN_REVIEW_SIDE_EFFECT_DETECTED: 'git_error',
  TASK_REVIEW_SIDE_EFFECT_DETECTED: 'git_error',
  PROTECTED_PATH_CHANGED: 'git_error',
  /*
   * 本地 Checkpoint 已形成、但发布到远程失败时使用独立错误码，调用方
   * 可以明确区分“提交失败”和“远程交付失败”。
   */
  GIT_PUSH_FAILED: 'git_error',
  // state_error
  STATE_WRITE_FAILED: 'state_error',
  STATE_VALIDATION_FAILED: 'state_error',
  // report_error
  FINAL_REPORT_GENERATION_FAILED: 'report_error',
  // command_error
  CLI_USAGE_INVALID: 'command_error',
  RUN_NOT_FOUND: 'command_error',
  COMMAND_STATE_INVALID: 'command_error',
  REPORT_NOT_AVAILABLE: 'command_error',
  REPORT_COMMAND_FAILED: 'command_error',
  STATE_SNAPSHOT_BUSY: 'command_error',
  RUN_NOT_ABANDONABLE: 'command_error',
  ABANDON_REQUIRES_FORCE: 'command_error',
  RUN_NOT_RESUMABLE: 'command_error',
  RESUME_REQUIRES_FORCE: 'command_error',
} as const satisfies Record<string, ErrorClass>;

export type ErrorCode = keyof typeof ERROR_CODE_TO_CLASS;

export const ERROR_CODES = Object.keys(ERROR_CODE_TO_CLASS) as ErrorCode[];

export function errorClassForCode(code: ErrorCode): ErrorClass {
  return ERROR_CODE_TO_CLASS[code];
}

/**
 * 判断稳定错误是否表示单趟 Execution 的回合预算已经耗尽。
 *
 * Adapter 负责把外部 Claude 事实映射为 errorCode；外层只通过此领域语义
 * 分支，避免在 Prompt 或用例中重新解释外部流协议。
 */
export function isTurnBudgetExhaustedErrorCode(code: ErrorCode): boolean {
  return code === 'CLAUDE_TURN_LIMIT_REACHED';
}

/**
 * 判断稳定错误是否为结构化结果的契约校验失败。
 *
 * 四个阶段的 *_RESULT_INVALID 共享同一形态：Claude 会话进程正常结束、
 * transcript 与已持久化事实（计划草稿引用、Task 候选结果与 Checkpoint）
 * 完好，唯一缺陷是结构化结果未通过 Schema 或领域语义门禁。
 */
export function isResultContractErrorCode(code: ErrorCode): boolean {
  return (
    code === 'CLAUDE_RESULT_INVALID' ||
    code === 'PLAN_REVIEW_RESULT_INVALID' ||
    code === 'TASK_REVIEW_RESULT_INVALID' ||
    code === 'FINAL_REVIEW_RESULT_INVALID'
  );
}

/**
 * 判断终态失败是否携带可由 `resume` 消费的确定性恢复点。
 *
 * 前台中断与已启动进程的非零退出，都可能已经在 transcript 中留下可继续
 * 的工作。Claude 回合预算耗尽先由 Execution 用例在驱动循环内有界自动
 * 续接（fork 原会话并追加一趟等额预算），追加次数用尽后才按可续接失败
 * 终结当前 Run；除此之外，恢复资格只表示允许用户显式执行 `resume`，
 * 当前 Run 仍立即失败，绝不在原驱动循环中自动重试外部调用。
 *
 * 结果契约失败同样必须可续接：会话进程正常结束，transcript 与候选事实
 * 完好，进程内的结果修复接力耗尽只说明结果通道与当前模型系统性失配；
 * 持久化恢复点（并保留计划候选）让用户可以显式 resume——例如先升级
 * CLI 或修正提示词——续接同一会话重新交付合法结果，而不是把已完成
 * 的规划与执行成果整体报废。
 *
 * 远程发布失败（GIT_PUSH_FAILED）在 Execution 阶段也属于同一形态：本地
 * Checkpoint 已形成并记录为中间 Checkpoint、expectedHead 已同步、Session
 * Record 与 transcript 完好，唯一缺口是远程交付。推送失败多由网络、鉴权
 * 或远程配置引起，驱动循环内自动重试毫无意义；持久化恢复点让用户修复
 * 外部条件后显式 resume，续接已交付会话重新收敛并重试推送，已完成的
 * 全部工作随之到达远程。Final Review 阶段的推送失败是例外：未推送提交
 * 由 Final Review 会话自己产生，没有可诚实归属的 Task，重开写入必然被
 * final_review 不变式拒绝，因此由 toTerminalFailedRun 显式排除、不持久化
 * 恢复点。仓库事实冲突（GIT_FACT_CONFLICT 等）则意味着并发改动或事实
 * 漂移，不存在可续接的安全断点，保持不可恢复。
 *
 * 通用非零退出可能发生在 transcript 尚未建立之前。此时恢复协调器会让
 * Claude 明确判定续接不可用，再按既有协议创建一次全新 Session；这比按
 * 易变的退出码猜测“鉴权失败”或“进程中断”更稳定，也不会丢失已完成工作。
 *
 * 草稿确定性校验失败（PLAN_INVALID / PLAN_REVISION_CONFLICT）同样必须
 * 可续接：进程内的定向修正回路耗尽只说明当前模型多轮仍未能给出合法
 * 草稿，而 Run 状态未被草稿触碰、刚完成的 Planner transcript 完好。
 * 持久化恢复点（sessionType=planning）让用户可以显式 resume——例如先
 * 升级 CLI 或切换模型——续接该会话并携精确校验结论继续修正，而不是
 * 把已完成的全部 Task 连同 Run 一起报废。Revision 上限
 * （PLAN_REVISION_LIMIT_EXCEEDED）与状态损坏不属于模型可修正事实，
 * 保持不可恢复。
 */
export function isResumableErrorCode(code: ErrorCode): boolean {
  return (
    code === 'RUN_INTERRUPTED' ||
    isTurnBudgetExhaustedErrorCode(code) ||
    code === 'CLAUDE_EXIT_NONZERO' ||
    isResultContractErrorCode(code) ||
    code === 'GIT_PUSH_FAILED' ||
    code === 'PLAN_INVALID' ||
    code === 'PLAN_REVISION_CONFLICT'
  );
}

export interface ApexErrorInit {
  readonly code: ErrorCode;
  /** Stage where the failure occurred, e.g. "startup", "planning", "execution". */
  readonly stage: string;
  readonly message: string;
  /** Redacted, semantics-preserving tool output summary, when available. */
  readonly toolSummary?: string | null;
  readonly sessionId?: string | null;
  readonly taskId?: string | null;
  readonly cause?: unknown;
}

/**
 * The single error type thrown across the system. Carries the stable error
 * code and its derived class; timestamps are supplied by callers when the
 * error is persisted as an Error Record (time is program-generated upstream).
 */
export class ApexError extends Error {
  readonly errorCode: ErrorCode;
  readonly errorClass: ErrorClass;
  readonly stage: string;
  readonly toolSummary: string | null;
  readonly sessionId: string | null;
  readonly taskId: string | null;

  constructor(init: ApexErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'ApexError';
    this.errorCode = init.code;
    this.errorClass = errorClassForCode(init.code);
    this.stage = init.stage;
    this.toolSummary = init.toolSummary ?? null;
    this.sessionId = init.sessionId ?? null;
    this.taskId = init.taskId ?? null;
  }
}

export function isApexError(value: unknown): value is ApexError {
  return value instanceof ApexError;
}
