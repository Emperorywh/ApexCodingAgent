/**
 * Claude CLI 进程客户端。所有调用都使用 `child_process.spawn` 参数数组，
 * 不拼接 Shell；stdout/stderr 经过脱敏后由 FileSystemPort 持久化，并把
 * stream-json 契约委托给纯解析器。
 *
 * 子进程原样继承当前用户环境，不读取或缓存凭据，不调用 CC Switch 私有
 * API，也不创建隔离配置目录。本模块不记录 PID、不接管旧 Session、
 * 不恢复 Session，也不自动重启失败进程。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { FileSystemPort } from '../../application/ports/file-system.js';
import type { RedactionPort } from '../../application/ports/redaction.js';
import type {
  ClaudeCapabilityReport,
  ClaudeInvocationFact,
  ClaudeInvocationRequest,
  ClaudeRuntimePort,
} from '../../application/ports/ClaudeRuntimePort.js';
import type { SessionType } from '../../domain/schemas/active-session.js';
import { getSchemaJson } from '../../domain/schemas/index.js';
import { createCapabilityProbe, type CapabilityProbe, type ProbeRunResult } from './capability.js';
import {
  claudeLogWriteFailed,
  claudeStartFailed,
  claudeStreamFailed,
  summarizeStderr,
} from './errors.js';
import { evaluateStreamOutcome } from './stream-parser.js';

const DEFAULT_CLAUDE_PATH = 'claude';
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
const RESULT_SCHEMA_BY_SESSION_TYPE = {
  planning: 'TaskPlanDraft',
  execution: 'TaskExecutionResult',
  final_review: 'FinalReviewResult',
} as const;
const STDERR_LOG_HEADER = '[apex stderr diagnostic]';

export interface ClaudeRuntimeOptions {
  /**
   * Claude 可执行入口；默认使用 PATH 中的 claude。以 js、mjs 或 cjs
   * 结尾的脚本通过当前 Node 运行时启动，仍然只使用参数数组。
   */
  readonly claudePath?: string;
  readonly fileSystem: FileSystemPort;
  readonly redaction: RedactionPort;
  /** version/help 探测超时；正式 Session 不设置自动超时。 */
  readonly probeTimeoutMs?: number;
}

type SpawnOutcome =
  | { readonly kind: 'spawn-failed'; readonly error: Error }
  | { readonly kind: 'timeout' }
  | {
      readonly kind: 'exited';
      readonly code: number | null;
      readonly stdout: string;
      readonly stderr: string;
      /** stdout 或 stderr 管道在流式读取期间发生错误。 */
      readonly pipeFailed: boolean;
    };

interface SpawnCollectOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly onChild?: (child: ChildProcess) => void;
}

/** 脚本形式入口转换为 `node <script>`，原生可执行路径保持不变。 */
function resolveCommand(
  claudePath: string,
  args: readonly string[],
): { readonly command: string; readonly argv: readonly string[] } {
  if (/\.(?:cjs|js|mjs)$/i.test(claudePath)) {
    return { command: process.execPath, argv: [claudePath, ...args] };
  }
  return { command: claudePath, argv: args };
}

/** 能力探测和 Session 共用的单一 spawn/采集原语。 */
function spawnCollect(
  claudePath: string,
  args: readonly string[],
  options: SpawnCollectOptions,
): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function finish(outcome: SpawnOutcome): void {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(outcome);
    }

    const { command, argv } = resolveCommand(claudePath, args);
    let child: ChildProcess;
    try {
      child = spawn(command, [...argv], {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({
        kind: 'spawn-failed',
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }
    options.onChild?.(child);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let pipeFailed = false;

    timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            child.kill();
            finish({ kind: 'timeout' });
          }, options.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.stdout?.on('error', () => {
      pipeFailed = true;
    });
    child.stderr?.on('error', () => {
      pipeFailed = true;
    });
    child.on('error', (error: Error) => finish({ kind: 'spawn-failed', error }));
    child.on('close', (code: number | null) =>
      finish({
        kind: 'exited',
        code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        pipeFailed,
      }),
    );
  });
}

/** Session Record 保存的 Git 相对日志路径。 */
export function sessionLogPath(sessionId: string): string {
  return `logs/${sessionId}.log`;
}

export function createClaudeRuntime(options: ClaudeRuntimeOptions): ClaudeRuntimePort {
  const claudePath = options.claudePath ?? DEFAULT_CLAUDE_PATH;
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const fileSystem = options.fileSystem;
  const redaction = options.redaction;

  /** 当前 invoke 的直接 Session 子进程；不存在活动调用时为 null。 */
  let activeChild: ChildProcess | null = null;

  const runProbe = async (args: readonly string[]): Promise<ProbeRunResult> => {
    const outcome = await spawnCollect(claudePath, args, { timeoutMs: probeTimeoutMs });
    if (outcome.kind === 'spawn-failed') throw outcome.error;
    if (outcome.kind === 'timeout') {
      return { code: -1, stdout: '', stderr: `probe timed out after ${probeTimeoutMs}ms` };
    }
    return { code: outcome.code ?? -1, stdout: outcome.stdout, stderr: outcome.stderr };
  };

  const probe: CapabilityProbe = createCapabilityProbe(runProbe);

  function absoluteLogPath(cwd: string, sessionId: string): string {
    const root = cwd.replace(/[\\/]+$/, '');
    return `${root}/.apex-coding-agent/logs/${sessionId}.log`;
  }

  /**
   * 在判断调用结果前持久化日志。stdout 保留原始事件行形态，stderr 只以
   * 脱敏且有长度上限的诊断段写入，避免成功或结构化失败时静默丢失。
   */
  async function writeSessionLog(
    request: ClaudeInvocationRequest,
    stdout: string,
    stderr: string,
    processExitCode: number | null,
    claudeVersion: string | null,
  ): Promise<void> {
    const absolute = absoluteLogPath(request.cwd, request.sessionId);
    const redactedStdout = redaction.redactText(stdout);
    const stderrSummary = summarizeStderr(stderr, (text) => redaction.redactText(text));
    const separator =
      redactedStdout === '' || redactedStdout.endsWith('\n') ? '' : '\n';
    const redactedLog =
      stderrSummary === null
        ? redactedStdout
        : `${redactedStdout}${separator}${STDERR_LOG_HEADER}\n${stderrSummary}\n`;
    try {
      await fileSystem.mkdir(`${absolute.slice(0, absolute.lastIndexOf('/'))}`, {
        recursive: true,
      });
      await fileSystem.writeFile(absolute, new TextEncoder().encode(redactedLog));
    } catch (error) {
      throw claudeLogWriteFailed(request.type, sessionLogPath(request.sessionId), error, {
        sessionId: request.sessionId,
        facts: { processExitCode, claudeVersion },
      });
    }
  }

  async function invoke<T extends SessionType>(
    request: ClaudeInvocationRequest<T>,
  ): Promise<ClaudeInvocationFact<T>> {
    const permissionIsValid =
      request.type === 'planning'
        ? request.permissionMode === 'plan'
        : request.permissionMode === 'auto' || request.permissionMode === 'bypassPermissions';
    if (!permissionIsValid) {
      throw new TypeError(
        `unsupported claude permission mode ${String(request.permissionMode)} for ${request.type}`,
      );
    }

    const claudeVersion = request.capabilityReport.version;
    const resultSchema = RESULT_SCHEMA_BY_SESSION_TYPE[request.type];
    const args = [
      '-p',
      '--session-id',
      request.sessionId,
      '--permission-mode',
      request.permissionMode,
      '--output-format',
      'stream-json',
      '--verbose',
      '--json-schema',
      JSON.stringify(getSchemaJson(resultSchema)),
      request.prompt,
    ];

    try {
      const outcome = await spawnCollect(claudePath, args, {
        cwd: request.cwd,
        onChild: (child) => {
          activeChild = child;
        },
      });
      if (outcome.kind === 'spawn-failed') {
        const redactedMessage = redaction.redactText(outcome.error.message);
        throw claudeStartFailed(
          request.type,
          `failed to spawn claude (${claudePath}): ${redactedMessage}`,
          { cause: outcome.error, sessionId: request.sessionId, claudeVersion },
        );
      }
      if (outcome.kind === 'timeout') {
        /**
         * 正式 Session 不配置超时；该分支仅用于保持 SpawnOutcome 穷尽，
         * 如果未来调用边界被错误修改，必须以稳定流错误立即暴露。
         */
        throw claudeStreamFailed(request.type, 'claude session was timed out unexpectedly', {
          sessionId: request.sessionId,
          facts: { claudeVersion },
        });
      }

      await writeSessionLog(
        request,
        outcome.stdout,
        outcome.stderr,
        outcome.code,
        claudeVersion,
      );

      if (outcome.pipeFailed) {
        throw claudeStreamFailed(
          request.type,
          'claude stdout/stderr pipe failed unrecoverably during the session',
          {
            sessionId: request.sessionId,
            facts: { processExitCode: outcome.code, claudeVersion },
            toolSummary: summarizeStderr(outcome.stderr, (text) => redaction.redactText(text)),
          },
        );
      }

      const evaluation = evaluateStreamOutcome({
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        exitCode: outcome.code,
        sessionId: request.sessionId,
        sessionType: request.type,
        claudeVersion,
        redact: (text) => redaction.redactText(text),
      });

      return {
        sessionId: request.sessionId,
        type: request.type,
        exitCode: 0,
        structuredResult: evaluation.structuredResult,
        claudeVersion,
        model: evaluation.model,
        provider: evaluation.provider,
        stderrSummary: evaluation.stderrSummary,
        logPath: sessionLogPath(request.sessionId),
      };
    } finally {
      activeChild = null;
    }
  }

  return {
    probeCapabilities: (): Promise<ClaudeCapabilityReport> => probe.probeCapabilities(),
    invoke,
    abort(): void {
      activeChild?.kill();
    },
  };
}
