/**
 * 基于 Execa 的统一进程执行实现。
 *
 * Execa 只负责跨平台命令解析、参数转义、超时和进程生命周期；输出仍由
 * 本模块以字节流交给调用方，从而保留 Claude 脱敏与 Git 错误映射的完整
 * 控制权。整个执行路径固定 shell=false，不接受命令字符串协议。
 */

import { execa } from 'execa';
import { existsSync, readFileSync } from 'node:fs';
import type {
  ActiveProcess,
  ProcessExecutionOutcome,
  ProcessExecutionRequest,
  ProcessExecutor,
} from './process-executor.js';
import {
  resolveWindowsCommand,
  type WindowsCommandEnvironment,
} from './windows-command.js';

interface ChunkSink {
  readonly consume: (chunk: Uint8Array) => Promise<void>;
  readonly chunks: Buffer[];
  readonly failure: () => Error | null;
  readonly transform: {
    readonly binary: true;
    transform(chunk: Uint8Array): AsyncGenerator<never, void, void>;
  };
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * 把 Execa 的可写输出边界转换为顺序、可回压的异步 chunk 回调。
 *
 * collectOutput 只用于短命令；正式 Claude Session 会关闭收集并直接把
 * 每个字节块送入增量日志和事件消费者，避免在两个层级重复缓存。
 */
function createChunkSink(
  collectOutput: boolean,
  consume: ((chunk: Uint8Array) => void | Promise<void>) | undefined,
): ChunkSink {
  const chunks: Buffer[] = [];
  let failure: Error | null = null;
  const sink: ChunkSink = {
    chunks,
    async consume(chunk): Promise<void> {
      if (failure !== null) return;
      const bytes = Buffer.from(chunk);
      if (collectOutput) chunks.push(bytes);
      try {
        await consume?.(bytes);
      } catch (error) {
        failure = asError(error);
      }
    },
    failure: () => failure,
    transform: {
      binary: true,
      async *transform(chunk: Uint8Array): AsyncGenerator<never, void, void> {
        await sink.consume(chunk);
      },
    },
  };
  return sink;
}

function collectedText(sink: ChunkSink): string {
  return Buffer.concat(sink.chunks).toString('utf8');
}

function processError(result: {
  readonly shortMessage?: string | undefined;
  readonly originalMessage?: string | undefined;
  readonly cause?: unknown;
}): Error {
  if (result.cause instanceof Error) return result.cause;
  return new Error(
    result.originalMessage ?? result.shortMessage ?? 'subprocess could not be started',
  );
}

/**
 * 显式 Node 脚本入口使用当前运行时启动。
 *
 * Windows 对 .js/.mjs 文件关联的 CreateProcess 行为并不稳定，且不能保证
 * 标准流仍连接到父进程；转为 `node <script>` 后仍是参数数组和无 Shell
 * 执行，同时与 CLI 的 `--claude-cli-path` 脚本契约保持一致。
 */
function normalizeCommand(
  command: string,
  args: readonly string[],
): { readonly command: string; readonly args: readonly string[] } {
  if (/\.(?:cjs|js|mjs)$/i.test(command)) {
    return { command: process.execPath, args: [command, ...args] };
  }
  return { command, args };
}

/**
 * 每次执行时读取当前 PATH/PATHEXT，支持 CLI 启动后的显式环境调整。
 *
 * 文件读取只用于解析用户选择的 shim，不枚举或缓存凭据，也不会把 shim
 * 文本写入日志。
 */
function systemWindowsCommandEnvironment(): WindowsCommandEnvironment {
  const readVariable = (name: string): string | undefined => {
    const key = Object.keys(process.env).find((candidate) => candidate.toUpperCase() === name);
    return key === undefined ? undefined : process.env[key];
  };
  return {
    platform: process.platform,
    pathVariable: readVariable('PATH'),
    pathExtVariable: readVariable('PATHEXT'),
    fileExists: (absolutePath) => existsSync(absolutePath),
    readShimText: (absolutePath) => {
      try {
        return readFileSync(absolutePath, 'utf8');
      } catch {
        return null;
      }
    },
  };
}

function resolveCommand(
  command: string,
  args: readonly string[],
): { readonly command: string; readonly args: readonly string[] } | null {
  const initial = normalizeCommand(command, args);
  const resolved = resolveWindowsCommand(
    initial.command,
    systemWindowsCommandEnvironment(),
  );
  if (resolved === null) return null;
  return normalizeCommand(resolved, initial.args);
}

export function createExecaProcessExecutor(): ProcessExecutor {
  return {
    async execute(request: ProcessExecutionRequest): Promise<ProcessExecutionOutcome> {
      const stdout = createChunkSink(request.collectOutput, request.onStdoutChunk);
      const stderr = createChunkSink(request.collectOutput, request.onStderrChunk);
      try {
        const normalized = resolveCommand(request.command, request.args);
        if (normalized === null) {
          return {
            kind: 'spawn-failed',
            error: new Error(`command could not be resolved without a shell: ${request.command}`),
          };
        }
        const subprocess = execa(normalized.command, [...normalized.args], {
          ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
          ...(request.timeoutMs === undefined ? {} : { timeout: request.timeoutMs }),
          /*
           * 长文本通过标准输入传输，不参与 Windows CreateProcess 命令行组装。
           *
           * 未提供输入的 Git 与能力探测命令继续显式关闭 stdin；提供输入时
           * 交给 Execa 写入并关闭管道，保持一次请求对应一次完整输入。
           */
          ...(request.stdinText === undefined
            ? { stdin: 'ignore' as const }
            : { input: request.stdinText }),
          shell: false,
          windowsHide: true,
          /**
           * 生成器只消费而不产出数据，Execa 因此不会再次缓存完整输出。
           *
           * 每个字节块会在生成器继续读取前完成调用方处理，既保留异步回压，
           * 又让长 Claude 会话的常驻内存只由增量解析器和有界诊断缓冲决定。
           */
          stdout: stdout.transform,
          stderr: stderr.transform,
          reject: false,
          stripFinalNewline: false,
        });
        const active: ActiveProcess = {
          terminate: () => {
            try {
              return subprocess.kill();
            } catch {
              return false;
            }
          },
        };
        request.onStart?.(active);

        const result = await subprocess;
        const stdoutText = collectedText(stdout);
        const stderrText = collectedText(stderr);
        if (result.timedOut) {
          return { kind: 'timeout', stdout: stdoutText, stderr: stderrText };
        }

        const streamFailed = stdout.failure() !== null || stderr.failure() !== null;
        if (
          result.exitCode === undefined &&
          result.signal === undefined &&
          !result.isTerminated &&
          !streamFailed
        ) {
          return { kind: 'spawn-failed', error: processError(result) };
        }
        return {
          kind: 'exited',
          code: result.exitCode ?? null,
          stdout: stdoutText,
          stderr: stderrText,
          streamFailed,
        };
      } catch (error) {
        return { kind: 'spawn-failed', error: asError(error) };
      }
    },
  };
}
