/**
 * 适配器内部的统一进程执行契约。
 *
 * 该契约只描述 Git 与 Claude 共同需要的进程事实，不向 Application
 * 暴露 Execa 类型，也不解释任何业务退出码。调用方仍然负责把底层事实
 * 映射为各自稳定的错误模型。
 */

export interface ActiveProcess {
  /**
   * 请求终止当前直接子进程。
   *
   * 返回值仅表示终止请求是否成功送达；业务层不得据此推断最终退出结果，
   * 最终事实始终以 execute 返回的 ProcessExecutionOutcome 为准。
   */
  terminate(): boolean;
}

export interface ProcessExecutionRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
  /**
   * 需要完整写入子进程标准输入的文本。
   *
   * 未提供时关闭标准输入，避免子进程意外继承终端并等待交互；
   * 提供时由执行器负责写入全部内容并关闭输入流。
   */
  readonly stdinText?: string;
  readonly collectOutput: boolean;
  readonly onStart?: (process: ActiveProcess) => void;
  readonly onStdoutChunk?: (chunk: Uint8Array) => void | Promise<void>;
  readonly onStderrChunk?: (chunk: Uint8Array) => void | Promise<void>;
}

export type ProcessExecutionOutcome =
  | {
      readonly kind: 'spawn-failed';
      readonly error: Error;
    }
  | {
      readonly kind: 'timeout';
      readonly stdout: string;
      readonly stderr: string;
    }
  | {
      readonly kind: 'exited';
      readonly code: number | null;
      readonly stdout: string;
      readonly stderr: string;
      readonly streamFailed: boolean;
    };

export interface ProcessExecutor {
  /**
   * 使用参数数组执行单个进程，并等待其到达终态。
   *
   * 实现不得启用 Shell；collectOutput=false 时必须仅通过 chunk 回调消费
   * 输出，避免长会话被无界缓存在内存中。
   */
  execute(request: ProcessExecutionRequest): Promise<ProcessExecutionOutcome>;
}
