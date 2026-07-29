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
 * - 不记录 PID、不自动重启，并原样继承用户环境；
 * - Session 续接仅服务于 resume 命令：`resumeFromSessionId` 非空时用
 *   `--resume <旧ID> --fork-session --session-id <新ID>` 续接被中断的
 *   对话，一次调用仍只对应一个（新的）Session ID。
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
  /**
   * 可选的流活跃回调：stdout 每产生一个 chunk 同步回调一次，供调用方
   * 驱动用户心跳行与逐事件进度行。事件类型与事件摘要是对 stream-json
   * 逐行 JSON.parse 的尽力提取（可能为 null），绝不改变 §7.2 的进程
   * 与结果语义。
   */
  readonly onStreamActivity?: (activity: ClaudeStreamActivity) => void;
  /**
   * 可选的会话续接来源（SPEC §17 resume）：非空时本调用以
   * `--resume <该ID> --fork-session --session-id <sessionId>` 启动，
   * 续接被中断会话的对话上下文，同时保持一次调用一个新 Session ID 的
   * §6.3 顺序铁律。resume 命令重开的三类 Session 均可使用。
   */
  readonly resumeFromSessionId?: string | null;
}

/**
 * 单个 stream-json 事件的终端展示事实。
 *
 * Adapter 负责解释 Claude 的原始字段并给事件编号；Application 只按 kind
 * 决定默认终端是否展示，不再解析 `tool:` 等魔法字符串。
 */
export interface ClaudeStreamDisplayEvent {
  readonly sequence: number;
  readonly kind:
    | 'thinking'
    | 'message'
    | 'tool'
    | 'tool_result'
    | 'tool_error'
    | 'system'
    | 'result';
  /** 工具名、系统子类型或稳定的人类标签。 */
  readonly label: string;
  /** 已压成单行且有长度上限的动态详情；无详情时为 null。 */
  readonly detail: string | null;
}

/** 一次 invoke 期间的流活跃事实（心跳行与事件行的数据来源）。 */
export interface ClaudeStreamActivity {
  /** 已累计接收的 stdout 字节数（UTF-8 解码前）。 */
  readonly receivedStdoutBytes: number;
  /** 最近一个完整 stream-json 事件行的 `type`；未解析到时为 null。 */
  readonly lastEventType: string | null;
  /**
   * 最近一个可展示事件。收集器对同一 stdout chunk 内的每个完整事件分别
   * 回调，因此不会再因操作系统合并 chunk 而只留下最后一条摘要。
   */
  readonly displayEvent: ClaudeStreamDisplayEvent | null;
  /**
   * 从 system/init 事件尽力提取的模型标识（首个非空值）；尚未见到时
   * 为 null。只做进度展示，持久化事实仍以 §7.2 结果评估为准。
   */
  readonly model: string | null;
  /** 同 model 一并提取的 Provider 标识；缺失时为 null。 */
  readonly provider: string | null;
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
