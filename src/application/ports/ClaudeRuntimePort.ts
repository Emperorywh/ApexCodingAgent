/**
 * ClaudeRuntimePort 是 Application 层访问 Claude Code CLI 的唯一边界
 * （SPEC §5.2、§7.2）。能力探测、stream-json 调用、原始事件解析以及
 * 外部失败到稳定错误码的映射都集中在 `src/adapters/claude/`。
 *
 * 核心契约：
 * - 所有参数都通过 `child_process.spawn` 参数数组传递，不拼接 Shell；
 * - 一次 invoke 只启动一个 Claude Session 子进程；
 * - 成功要求退出码为 0，且恰好存在一个通过对应内置 Schema 的 result；
 * - decision 为 failed 仍是合法结果，由后续 Application 用例解释；
 * - 不记录 PID、不恢复 Session、不自动重启，并原样继承用户环境。
 */
import { ApexError, type ApexErrorInit } from '../../domain/errors.js';
import type { SessionType } from '../../domain/schemas/active-session.js';
import type { FinalReviewResult } from '../../domain/schemas/final-review-result.js';
import type { TaskExecutionResult } from '../../domain/schemas/task-execution-result.js';
import type { TaskPlanDraft } from '../../domain/schemas/task-plan-draft.js';

/**
 * Claude CLI 可接收的权限模式。调用方显式选择策略，适配器只执行已经
 * 确定的策略；Planning 固定为 plan，其他 Session 不允许使用 plan。
 */
export type ClaudePermissionMode = 'plan' | 'auto' | 'bypassPermissions';

interface ClaudeInvocationRequestBase {
  /** 内置提示词，由 G5 组装并作为最后一个位置参数传入。 */
  readonly prompt: string;
  /** 程序分配的规范小写 UUID，原样传给 `--session-id`。 */
  readonly sessionId: string;
  /** Session 工作目录，即仓库根目录。 */
  readonly cwd: string;
  /**
   * 启动检查得到的显式能力事实。invoke 不再暗中执行第二次版本探测，
   * 从而保证一次调用只对应一个 Session 子进程，并保持数据流可推导。
   */
  readonly capabilityReport: ClaudeCapabilityReport;
}

/**
 * 调用请求使用判别联合表达合法状态：Session 类型同时决定权限范围和
 * 结果 Schema，调用方无法再构造类型与 Schema 相互矛盾的请求。
 */
export type ClaudePermissionModeFor<T extends SessionType> = T extends 'planning'
  ? Extract<ClaudePermissionMode, 'plan'>
  : Exclude<ClaudePermissionMode, 'plan'>;

export type ClaudeInvocationRequest<T extends SessionType = SessionType> =
  ClaudeInvocationRequestBase & {
    readonly type: T;
    readonly permissionMode: ClaudePermissionModeFor<T>;
  };

interface ClaudeInvocationFactBase {
  readonly sessionId: string;
  /** 成功事实的退出码恒为 0。 */
  readonly exitCode: 0;
  /** 来自显式能力探测报告的 Claude CLI 版本。 */
  readonly claudeVersion: string;
  /**
   * 只从允许的稳定 init 事件字段提取的元数据。缺失时为 null，绝不从
   * 环境变量、端点、Header 或完整配置对象推导。
   */
  readonly model: string | null;
  readonly provider: string | null;
  /** 脱敏且有长度上限的 stderr 诊断；没有内容时为 null。 */
  readonly stderrSummary: string | null;
  /** 脱敏 Session 日志的 Git 相对路径。 */
  readonly logPath: string;
}

export interface ClaudeStructuredResultBySessionType {
  readonly planning: TaskPlanDraft;
  readonly execution: TaskExecutionResult;
  readonly final_review: FinalReviewResult;
}

export type ClaudeStructuredResult<T extends SessionType> =
  ClaudeStructuredResultBySessionType[T];

/**
 * 成功调用事实使用 Session 类型参数约束结构化结果，后续持久化可以直接
 * 推导结果类型，无需由调用方编写类型断言。
 */
export interface ClaudeInvocationFact<T extends SessionType = SessionType>
  extends ClaudeInvocationFactBase {
  readonly type: T;
  readonly structuredResult: ClaudeStructuredResult<T>;
}

/** SPEC §8.1 第 5 项定义的能力探测结果。 */
export interface ClaudeCapabilityReport {
  /** 去除首尾空白后的 `claude --version` 输出。 */
  readonly version: string;
  /** 已明确确认的全部必需能力稳定标识。 */
  readonly capabilities: readonly string[];
}

/**
 * invoke 的失败类型：在稳定 ApexError 之外携带 Session Record 所需的
 * 进程事实。进程未启动或由信号结束、因而不存在数字退出码时保存 null。
 */
export class ClaudeInvocationError extends ApexError {
  /** 数字退出码；进程未启动或由信号结束时为 null。 */
  readonly processExitCode: number | null;
  /** 已完成能力探测时的 CLI 版本，否则为 null。 */
  readonly claudeVersion: string | null;

  constructor(
    init: ApexErrorInit & {
      readonly processExitCode?: number | null;
      readonly claudeVersion?: string | null;
    },
  ) {
    super(init);
    this.name = 'ClaudeInvocationError';
    this.processExitCode = init.processExitCode ?? null;
    this.claudeVersion = init.claudeVersion ?? null;
  }
}

export interface ClaudeRuntimePort {
  /**
   * 通过参数数组执行 `claude --version` 和 `claude --help`，并确认必需
   * 选项及枚举值明确存在。缺失时直接失败并列出实际版本与缺失能力，
   * 不提供兼容或降级路径。
   */
  probeCapabilities(): Promise<ClaudeCapabilityReport>;

  /**
   * 按 §7.2 启动一个且仅一个 Claude Session。成功时返回事实，失败时
   * 抛出携带唯一稳定错误码的 ClaudeInvocationError；日志落盘失败统一
   * 使用 STATE_WRITE_FAILED。
   */
  invoke<T extends SessionType>(
    request: ClaudeInvocationRequest<T>,
  ): Promise<ClaudeInvocationFact<T>>;

  /**
   * 请求终止当前 invoke 的直接子进程。没有活动子进程时为空操作，且
   * 永不递归处理该子进程创建的其他进程。
   */
  abort(): void;
}
