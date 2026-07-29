/**
 * CLI 运行时契约：`runCli` 只依赖本接口，真实实现由 bootstrap 的
 * Composition Root 组装（适配器、信号、环境事实），测试可整体替换。
 */
import type { RepositoryStatusFact } from '../../application/ports/GitPort.js';
import type { InterruptController } from '../../application/interrupt.js';
import type { RedactionPort } from '../../application/ports/redaction.js';
import type { ConsistentSnapshot } from '../../application/ports/state-store.js';
import type {
  AbandonRunInput,
  AbandonRunResult,
} from '../../application/usecases/abandon-run.js';
import type { GenerateReportResult } from '../../application/usecases/generate-report.js';
import type { StartRunInput, StartRunResult } from '../../application/usecases/start-run.js';
import type { EnvironmentFacts } from '../../application/usecases/run-runtime-preflight.js';
import type {
  ResumeRunInput,
  ResumeRunResult,
} from '../../application/usecases/resume-run.js';

/**
 * `status` 命令的已提交读取结果。
 *
 * CLI 只接收渲染所需事实，不接触 StateStore/Git 等次级端口；
 * 仓库解析、一致性读取和适配器装配全部封装在 Composition Root。
 */
export interface StatusCommandResult {
  readonly snapshot: ConsistentSnapshot;
  readonly git: RepositoryStatusFact;
}

export interface SignalHandlerSpec {
  /** 第一次中断信号：§2.4 有界收尾（转发给中断控制器）。 */
  readonly onFirstInterrupt: () => void;
}

export interface CliRuntime {
  /** 命令调用目录。 */
  readonly cwd: string;
  /** 启动环境事实（§8.1 第 1、3 项检查输入）。 */
  readonly environment: EnvironmentFacts;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly redaction: RedactionPort;
  readonly interrupt: InterruptController;
  readonly startRun: { execute(input: StartRunInput): Promise<StartRunResult> };
  readonly resume: { execute(input: ResumeRunInput): Promise<ResumeRunResult> };
  /**
   * CLI 仅依赖命令级接口。
   *
   * 具体用例及其端口依赖由 Composition Root 创建，避免接口层承担
   * 依赖注入职责或获得超出命令所需的基础设施能力。
   */
  readonly status: { execute(): Promise<StatusCommandResult | null> };
  readonly report: { execute(): Promise<GenerateReportResult> };
  readonly abandon: { execute(input: AbandonRunInput): Promise<AbandonRunResult> };
  /**
   * 安装前台中断信号处理（仅 start/resume 使用，§2.4）；返回解除函数。
   * 第二次信号的立即退出语义由安装方（bootstrap/signals）实现。
   */
  readonly installSignals: (handlers: SignalHandlerSpec) => () => void;
}
