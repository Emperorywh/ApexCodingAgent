/**
 * 前台中断控制器（SPEC §2.4 明确的运行边界）。
 *
 * 第一次中断信号的语义：停止启动新 Session、请求终止当前直接 Claude
 * 子进程（通过绑定的 `ClaudeRuntimePort.abort`）、有界等待后照常收尾。
 * 控制器只保存"是否已请求"这一事实并转发 abort；不保存 PID、不管理
 * 进程树、不构成后台 Stop 协议。
 */
export interface InterruptController {
  readonly requested: boolean;
  /** 幂等：置位并调用已绑定的 abort（§2.4 第 1–2 步）。 */
  request(): void;
  /** 首次 request 时解决；用于和有界等待做竞速。 */
  waitForRequest(): Promise<void>;
  /** 绑定实际生效 ClaudeRuntimePort 的 abort；后绑定生效。 */
  bindAbort(abort: () => void): void;
}

/** 创建运行期中断控制器；初始未请求，abort 未绑定。 */
export function createInterruptController(): InterruptController {
  let requested = false;
  let boundAbort: (() => void) | null = null;
  let resolveWait: (() => void) | null = null;
  const waitPromise = new Promise<void>((resolve) => {
    resolveWait = resolve;
  });

  return {
    get requested() {
      return requested;
    },
    request() {
      if (requested) return;
      requested = true;
      // 先解决等待者，让竞速方立即进入有界等待（§2.4 第 3 步）。
      resolveWait?.();
      boundAbort?.();
    },
    waitForRequest() {
      return waitPromise;
    },
    bindAbort(abort) {
      boundAbort = abort;
    },
  };
}
