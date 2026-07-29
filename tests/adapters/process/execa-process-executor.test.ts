/**
 * Execa 进程执行器的适配器级契约测试。
 *
 * 使用当前 Node 可执行文件覆盖参数数组、stdout/stderr 流、非零退出和
 * 超时，不依赖 Shell，也不访问网络或用户安装的外部工具。
 */

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createExecaProcessExecutor } from '../../../src/adapters/process/execa-process-executor.js';

describe('createExecaProcessExecutor', () => {
  it('collects output and forwards the same bytes to chunk consumers', async () => {
    const stdoutChunks: Uint8Array[] = [];
    const stderrChunks: Uint8Array[] = [];
    const outcome = await createExecaProcessExecutor().execute({
      command: process.execPath,
      args: [
        '-e',
        'process.stdout.write("stdout-value\\n"); process.stderr.write("stderr-value\\n");',
      ],
      collectOutput: true,
      onStdoutChunk: (chunk) => {
        stdoutChunks.push(chunk);
      },
      onStderrChunk: (chunk) => {
        stderrChunks.push(chunk);
      },
    });

    expect(outcome).toEqual({
      kind: 'exited',
      code: 0,
      stdout: 'stdout-value\n',
      stderr: 'stderr-value\n',
      streamFailed: false,
    });
    expect(Buffer.concat(stdoutChunks).toString('utf8')).toBe('stdout-value\n');
    expect(Buffer.concat(stderrChunks).toString('utf8')).toBe('stderr-value\n');
  });

  it('returns non-zero exit codes without converting them to spawn failures', async () => {
    const outcome = await createExecaProcessExecutor().execute({
      command: process.execPath,
      args: ['-e', 'process.exit(7)'],
      collectOutput: true,
    });

    expect(outcome).toMatchObject({ kind: 'exited', code: 7 });
  });

  it('streams long output without returning a second collected copy', async () => {
    let receivedBytes = 0;
    const outputSize = 1024 * 1024;
    const outcome = await createExecaProcessExecutor().execute({
      command: process.execPath,
      args: ['-e', `process.stdout.write(Buffer.alloc(${outputSize}, 65))`],
      collectOutput: false,
      onStdoutChunk: (chunk) => {
        receivedBytes += chunk.byteLength;
      },
    });

    /**
     * 长会话模式下，字节只交给增量消费者；结果对象不再保留第二份完整输出。
     *
     * 这条契约防止后续调整 Execa 选项时无意恢复无界内存收集。
     */
    expect(outcome).toMatchObject({
      kind: 'exited',
      code: 0,
      stdout: '',
      stderr: '',
      streamFailed: false,
    });
    expect(receivedBytes).toBe(outputSize);
  });

  it('runs a shebang script directly and preserves shell-hostile arguments', async () => {
    const script = fileURLToPath(
      new URL('../../fixtures/process/echo.mjs', import.meta.url),
    );
    const value = 'value & echo SHOULD_NOT_RUN';
    const outcome = await createExecaProcessExecutor().execute({
      command: script,
      args: [value],
      collectOutput: true,
    });

    expect(outcome).toMatchObject({
      kind: 'exited',
      code: 0,
      stdout: `${value}\n`,
    });
  });

  it('returns a distinct timeout outcome', async () => {
    const outcome = await createExecaProcessExecutor().execute({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60_000)'],
      timeoutMs: 50,
      collectOutput: true,
    });

    expect(outcome.kind).toBe('timeout');
  });
});
