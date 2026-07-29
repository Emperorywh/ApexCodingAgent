/**
 * start / resume 前台命令共用的运行时工厂边界。
 *
 * 两个命令都需要先解析配置与状态，再按最终 CLI 路径绑定 Git、Claude 和
 * 状态端口。把工厂契约放在独立 Application 模块，可避免 ResumeRun 反向
 * 依赖 StartRun 用例，也让 Composition Root 只维护一份装配协议。
 */
import type { InterruptController } from './interrupt.js';
import type {
  ClaudeCapabilityReport,
  ClaudeRuntimePort,
} from './ports/ClaudeRuntimePort.js';
import type { ClockPort } from './ports/clock.js';
import type { FileSystemPort } from './ports/file-system.js';
import type { GitPort } from './ports/GitPort.js';
import type { LoggerPort } from './ports/logger.js';
import type { OutputPort } from './ports/output.js';
import type { RedactionPort } from './ports/redaction.js';
import type { StateStorePort } from './ports/state-store.js';
import type { UseCaseDeps } from './usecase-deps.js';

export interface RunCommandDeps {
  readonly fileSystem: FileSystemPort;
  readonly clock: ClockPort;
  readonly redaction: RedactionPort;
  readonly output: OutputPort;
  readonly interrupt: InterruptController;
  readonly wait: (ms: number) => Promise<void>;
  readonly interruptWaitMs: number;
  /**
   * 周期调度器（组合根用 unref 的 setInterval 实现），返回解除函数。
   * 目前唯一消费者是前台属主存活信号（usecases/run-heartbeat）。
   */
  readonly scheduleInterval: (callback: () => void, intervalMs: number) => () => void;
  /** 按最终生效路径构造 Git 适配器。 */
  readonly makeGitPort: (gitCliPath: string | null) => GitPort;
  /** 按最终生效路径构造 Claude 适配器。 */
  readonly makeClaudePort: (claudeCliPath: string | null) => ClaudeRuntimePort;
  /**
   * 构造调试日志口（stateDir 确定后调用）。
   *
   * 实现须保证写失败不影响 Run；上一终态 Run 的日志会在新 Run 启动前
   * 随归档转移，不能在此工厂中隐藏额外状态。
   */
  readonly makeLogger: (input: {
    readonly stateDir: string;
    readonly verbose: boolean;
  }) => LoggerPort;
  /** 仅依赖状态目录构造严格 State Store，供绑定外部 CLI 前读取 Run。 */
  readonly makeStateStore: (stateDir: string) => StateStorePort;
  /** 绑定最终端口与状态目录，组装驱动业务用例所需的完整依赖。 */
  readonly makeBoundDeps: (input: {
    readonly stateDir: string;
    readonly git: GitPort;
    readonly claude: ClaudeRuntimePort;
    readonly capabilityReport: ClaudeCapabilityReport;
    readonly logger: LoggerPort;
  }) => UseCaseDeps;
}
