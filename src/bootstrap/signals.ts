/**
 * 前台中断信号的两次语义（SPEC §2.4）：
 *
 * - 第一次 SIGINT：调用 `onFirstInterrupt`（CLI 把它转发给 G5 驱动器的
 *   中断控制器：停新 Session → 杀直接子进程 → ≤10s → 保存事实 →
 *   Task/Run failed），进程随后以退出码 130 正常结束；
 * - 第二次 SIGINT：立即结束进程（默认 `exit(130)`），不再等待收尾。
 *
 * 这只是前台进程的有界退出语义：不构成后台 Stop 协议、不管理进程树、
 * 不承诺崩溃恢复。目标对象可注入以便测试（默认 `process`）。
 */

/** 可安装信号监听的最小目标（`process` 或其测试替身）。 */
export interface SignalTarget {
  on(event: 'SIGINT', listener: () => void): unknown;
  removeListener(event: 'SIGINT', listener: () => void): unknown;
}

export interface InstallInterruptSignalsOptions {
  /** 第一次信号：有界收尾入口（幂等）。 */
  readonly onFirstInterrupt: () => void;
  /** 第二次信号：默认立即 exit(130)；测试可替换。 */
  readonly onSecondInterrupt?: () => void;
  /** 默认 process.exit；仅测试注入。 */
  readonly exit?: (code: number) => void;
  readonly target?: SignalTarget;
}

/** 安装处理器并返回解除函数；同一时刻只应有一个前台 start 安装。 */
export function installInterruptSignals(
  options: InstallInterruptSignalsOptions,
): () => void {
  const target: SignalTarget = options.target ?? process;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const onSecond = options.onSecondInterrupt ?? (() => exit(130));
  let count = 0;
  const listener = (): void => {
    count += 1;
    if (count === 1) options.onFirstInterrupt();
    else onSecond();
  };
  target.on('SIGINT', listener);
  return () => {
    target.removeListener('SIGINT', listener);
  };
}
