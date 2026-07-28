/**
 * Application 用例的共享依赖集合（SPEC §5.2 Application Ports）。
 *
 * 用例只依赖端口与纯函数依赖（时钟、等待、中断控制器），不接触
 * node:* 与适配器实现；具体适配器由 bootstrap 层组装注入。
 */
import type { ClaudeCapabilityReport, ClaudeRuntimePort } from './ports/ClaudeRuntimePort.js';
import type { ClockPort } from './ports/clock.js';
import type { FileSystemPort } from './ports/file-system.js';
import type { GitPort } from './ports/GitPort.js';
import type { InterruptController } from './interrupt.js';
import type { OutputPort } from './ports/output.js';
import type { RedactionPort } from './ports/redaction.js';
import type { ReporterPort } from './ports/ReporterPort.js';
import type { RunArchivePort } from './ports/run-archive-port.js';
import type { StateStorePort } from './ports/state-store.js';

export interface UseCaseDeps {
  /** `<repoRoot>/.apex-coding-agent`，`/` 分隔。 */
  readonly stateDir: string;
  readonly stateStore: StateStorePort;
  readonly git: GitPort;
  readonly claude: ClaudeRuntimePort;
  readonly clock: ClockPort;
  readonly fileSystem: FileSystemPort;
  readonly redaction: RedactionPort;
  readonly reporter: ReporterPort;
  readonly archiver: RunArchivePort;
  readonly output: OutputPort;
  readonly interrupt: InterruptController;
  /** 可注入的有界等待（默认基于定时器），便于测试与确定性竞速。 */
  readonly wait: (ms: number) => Promise<void>;
  /** 前台中断的有界等待时长，默认 10_000（§2.4 第 3 步）。 */
  readonly interruptWaitMs: number;
  /** 启动检查得到的显式能力事实；invoke 不再做第二次探测。 */
  readonly capabilityReport: ClaudeCapabilityReport;
}
