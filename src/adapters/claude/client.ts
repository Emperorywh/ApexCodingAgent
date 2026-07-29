/**
 * Claude CLI 进程客户端。
 *
 * 命令执行委托给 Adapter 内部的 ProcessExecutor，始终使用参数数组且不
 * 启用 Shell。正式 Session 的 stdout 会同步进入增量事件收集器和流式
 * 脱敏日志，不再把完整 transcript 缓存在内存；stderr 只保留有界诊断。
 *
 * 子进程原样继承当前用户环境，不读取或缓存凭据，不调用任何私有 API，
 * 也不创建隔离配置目录。续接请求仍以 `--resume <旧ID>
 * --fork-session --session-id <新ID>` 启动，保持一次调用一个新 Session
 * ID 的事实模型。
 */

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
import type {
  ActiveProcess,
  ProcessExecutor,
} from '../process/process-executor.js';
import { createCapabilityProbe, type CapabilityProbe, type ProbeRunResult } from './capability.js';
import {
  claudeLogWriteFailed,
  claudeResumeUnavailable,
  claudeStartFailed,
  claudeStreamFailed,
  summarizeStderr,
} from './errors.js';
import {
  createClaudeStreamCollector,
  evaluateCollectedStreamOutcome,
} from './stream-parser.js';

const DEFAULT_CLAUDE_PATH = 'claude';
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
const STDERR_REDACTED_LIMIT = 4_000;
const STDERR_DIAGNOSTIC_TAIL_LIMIT = 256;
const RESUME_UNAVAILABLE_PATTERNS = [
  /no conversation found(?: (?:with|for))? session id/i,
  /failed to resume the conversation/i,
] as const;
const RESULT_SCHEMA_BY_SESSION_TYPE = {
  planning: 'TaskPlanDraft',
  execution: 'TaskExecutionResult',
  final_review: 'FinalReviewResult',
} as const;
const STDERR_LOG_HEADER = '[apex stderr diagnostic]';

export interface ClaudeRuntimeOptions {
  /**
   * Claude 可执行入口；默认使用 PATH 中的 claude。
   *
   * Windows 的 PATHEXT、npm shim、空格路径和脚本 shebang 统一由
   * ProcessExecutor 解析，本适配器不再维护第二套命令发现规则。
   */
  readonly claudePath?: string;
  readonly processExecutor: ProcessExecutor;
  readonly fileSystem: FileSystemPort;
  readonly redaction: RedactionPort;
  /** version/help 探测超时；正式 Session 不设置自动超时。 */
  readonly probeTimeoutMs?: number;
}

interface IncrementalSessionLog {
  readonly pushStdout: (
    chunk: Uint8Array,
    safeRecordBoundaryOffsets: readonly number[],
  ) => Promise<void>;
  readonly finish: (stderrSummary: string | null) => Promise<void>;
  readonly failure: () => unknown | null;
}

interface CollectedStderr {
  readonly redacted: string;
  readonly resumeTranscriptUnavailable: boolean;
}

interface StderrCollector {
  readonly push: (chunk: Uint8Array) => void;
  readonly finish: () => CollectedStderr;
}

/** Session Record 保存的 Git 相对日志路径。 */
export function sessionLogPath(sessionId: string): string {
  return `logs/${sessionId}.log`;
}

function appendBounded(current: string, addition: string, limit: number): string {
  if (current.length >= limit || addition === '') return current;
  return `${current}${addition.slice(0, limit - current.length)}`;
}

/**
 * 创建 stderr 的有界增量收集器。
 *
 * 脱敏文本只保留固定长度的错误摘要；续接诊断用滚动尾部跨 chunk 匹配，
 * 因此即使关键提示出现在很长 stderr 的末尾也不会退化，同时不保存完整原文。
 */
function createStderrCollector(redaction: RedactionPort): StderrCollector {
  const decoder = new TextDecoder();
  const chunkRedactor = redaction.createChunkRedactor();
  let redacted = '';
  let diagnosticTail = '';
  let resumeTranscriptUnavailable = false;
  let finished = false;

  function consume(text: string): void {
    const diagnosticWindow = `${diagnosticTail}${text}`;
    if (
      !resumeTranscriptUnavailable &&
      RESUME_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(diagnosticWindow))
    ) {
      resumeTranscriptUnavailable = true;
    }
    diagnosticTail = diagnosticWindow.slice(-STDERR_DIAGNOSTIC_TAIL_LIMIT);
    redacted = appendBounded(
      redacted,
      chunkRedactor.push(text),
      STDERR_REDACTED_LIMIT,
    );
  }

  return {
    push(chunk): void {
      if (finished) throw new Error('cannot push to a finished stderr collector');
      consume(decoder.decode(chunk, { stream: true }));
    },
    finish(): CollectedStderr {
      if (finished) throw new Error('stderr collector finish called more than once');
      finished = true;
      consume(decoder.decode());
      redacted = appendBounded(
        redacted,
        chunkRedactor.flush(),
        STDERR_REDACTED_LIMIT,
      );
      return { redacted, resumeTranscriptUnavailable };
    },
  };
}

/**
 * 创建单次 Session 的增量日志写入器。
 *
 * UTF-8 解码和脱敏状态跨 chunk 保持；每次 appendFile 都在进程输出回压
 * 链中等待完成。写入失败只记录首个原因并停止后续文件操作，让进程继续
 * 到达可持久化的真实退出码，再统一映射 STATE_WRITE_FAILED。
 */
function createIncrementalSessionLog(
  request: ClaudeInvocationRequest,
  fileSystem: FileSystemPort,
  redaction: RedactionPort,
): IncrementalSessionLog {
  const root = request.cwd.replace(/[\\/]+$/, '');
  const absolute = `${root}/.apex-coding-agent/logs/${request.sessionId}.log`;
  const parent = absolute.slice(0, absolute.lastIndexOf('/'));
  const decoder = new TextDecoder();
  const chunkRedactor = redaction.createChunkRedactor();
  const encoder = new TextEncoder();
  let initialized = false;
  let writeFailure: unknown | null = null;
  let hasContent = false;
  let endsWithNewline = true;
  let finished = false;

  async function record(operation: () => Promise<void>): Promise<void> {
    if (writeFailure !== null) return;
    try {
      await operation();
    } catch (error) {
      writeFailure = error;
    }
  }

  async function ensureInitialized(): Promise<void> {
    if (initialized || writeFailure !== null) return;
    initialized = true;
    await record(async () => {
      await fileSystem.mkdir(parent, { recursive: true });
      await fileSystem.writeFile(absolute, new Uint8Array(0));
    });
  }

  async function append(text: string): Promise<void> {
    if (text === '') return;
    await ensureInitialized();
    await record(() => fileSystem.appendFile(absolute, encoder.encode(text)));
    hasContent = true;
    endsWithNewline = text.endsWith('\n');
  }

  return {
    async pushStdout(chunk, safeRecordBoundaryOffsets): Promise<void> {
      if (finished) throw new Error('cannot write to a finished session log');
      const text = decoder.decode(chunk, { stream: true });
      /**
       * stream-json 解析器只为已验证的 JSON 对象行提供边界。每段先进入通用
       * 流式脱敏器，再尝试按记录排出；若存在尚未闭合的多行私钥，脱敏器会
       * 跨记录继续保留，不能因日志低延迟需求而牺牲安全性。
       */
      let segmentStart = 0;
      for (const boundaryOffset of safeRecordBoundaryOffsets) {
        await append(chunkRedactor.push(text.slice(segmentStart, boundaryOffset)));
        await append(chunkRedactor.flushRecordBoundary());
        segmentStart = boundaryOffset;
      }
      await append(chunkRedactor.push(text.slice(segmentStart)));
    },
    async finish(stderrSummary): Promise<void> {
      if (finished) throw new Error('session log finish called more than once');
      finished = true;
      const decodedTail = decoder.decode();
      await append(`${chunkRedactor.push(decodedTail)}${chunkRedactor.flush()}`);
      await ensureInitialized();
      if (stderrSummary !== null) {
        const separator = !hasContent || endsWithNewline ? '' : '\n';
        await append(`${separator}${STDERR_LOG_HEADER}\n${stderrSummary}\n`);
      }
    },
    failure: () => writeFailure,
  };
}

/**
 * 判断 Claude 是否在实际执行任何事件前报告 transcript 不可用。
 *
 * 只有续接调用、空 stdout、数字非零退出和明确官方诊断同时成立时才允许
 * Application 走安全回退，避免把运行中失败误判为可重新执行。
 */
function isResumeTranscriptUnavailable(
  request: ClaudeInvocationRequest,
  hasStdoutContent: boolean,
  resumeDiagnosticFound: boolean,
  exitCode: number | null,
): exitCode is number {
  if (
    request.resumeFromSessionId === null ||
    request.resumeFromSessionId === undefined ||
    typeof exitCode !== 'number' ||
    exitCode === 0 ||
    hasStdoutContent
  ) {
    return false;
  }
  return resumeDiagnosticFound;
}

export function createClaudeRuntime(options: ClaudeRuntimeOptions): ClaudeRuntimePort {
  const claudePath = options.claudePath ?? DEFAULT_CLAUDE_PATH;
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const fileSystem = options.fileSystem;
  const redaction = options.redaction;
  const processExecutor = options.processExecutor;

  /** 当前 invoke 的直接 Session 子进程；不存在活动调用时为 null。 */
  let activeProcess: ActiveProcess | null = null;

  const runProbe = async (args: readonly string[]): Promise<ProbeRunResult> => {
    const outcome = await processExecutor.execute({
      command: claudePath,
      args,
      timeoutMs: probeTimeoutMs,
      collectOutput: true,
    });
    if (outcome.kind === 'spawn-failed') throw outcome.error;
    if (outcome.kind === 'timeout') {
      return { code: -1, stdout: '', stderr: `probe timed out after ${probeTimeoutMs}ms` };
    }
    if (outcome.streamFailed) {
      return { code: -1, stdout: outcome.stdout, stderr: 'probe output stream failed' };
    }
    return { code: outcome.code ?? -1, stdout: outcome.stdout, stderr: outcome.stderr };
  };

  const probe: CapabilityProbe = createCapabilityProbe(runProbe);

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
    /*
     * resume 续接仍由 Claude Adapter 独占构造。
     *
     * --fork-session 保证本次调用使用新的 Session ID，Application 的顺序
     * 铁律和持久化模型不需要感知底层 CLI 参数。
     */
    const sessionArgs =
      request.resumeFromSessionId !== null && request.resumeFromSessionId !== undefined
        ? [
            '--resume',
            request.resumeFromSessionId,
            '--fork-session',
            '--session-id',
            request.sessionId,
          ]
        : ['--session-id', request.sessionId];
    const args = [
      '-p',
      ...sessionArgs,
      '--permission-mode',
      request.permissionMode,
      '--output-format',
      'stream-json',
      '--verbose',
      '--json-schema',
      JSON.stringify(getSchemaJson(resultSchema)),
      request.prompt,
    ];

    const streamCollector = createClaudeStreamCollector({
      sessionId: request.sessionId,
      ...(request.onStreamActivity === undefined
        ? {}
        : { onActivity: request.onStreamActivity }),
    });
    const stderrCollector = createStderrCollector(redaction);
    const sessionLog = createIncrementalSessionLog(request, fileSystem, redaction);

    try {
      const outcome = await processExecutor.execute({
        command: claudePath,
        args,
        cwd: request.cwd,
        collectOutput: false,
        onStart: (process) => {
          activeProcess = process;
        },
        onStdoutChunk: async (chunk) => {
          const safeRecordBoundaryOffsets = streamCollector.push(chunk);
          await sessionLog.pushStdout(chunk, safeRecordBoundaryOffsets);
        },
        onStderrChunk: (chunk) => {
          stderrCollector.push(chunk);
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
         * 正式 Session 不配置超时；该分支只保持执行结果穷尽。
         *
         * 如果调用边界未来被错误修改，稳定流错误会立即暴露这一契约破坏。
         */
        throw claudeStreamFailed(request.type, 'claude session was timed out unexpectedly', {
          sessionId: request.sessionId,
          facts: { claudeVersion },
        });
      }

      const stream = streamCollector.finish();
      const stderr = stderrCollector.finish();
      const stderrSummary = summarizeStderr(stderr.redacted, (text) => text);
      await sessionLog.finish(stderrSummary);
      const logFailure = sessionLog.failure();
      if (logFailure !== null) {
        throw claudeLogWriteFailed(
          request.type,
          sessionLogPath(request.sessionId),
          logFailure,
          {
            sessionId: request.sessionId,
            facts: { processExitCode: outcome.code, claudeVersion },
          },
        );
      }
      if (outcome.streamFailed) {
        throw claudeStreamFailed(
          request.type,
          'claude stdout/stderr stream failed unrecoverably during the session',
          {
            sessionId: request.sessionId,
            facts: { processExitCode: outcome.code, claudeVersion },
            toolSummary: stderrSummary,
          },
        );
      }
      if (
        isResumeTranscriptUnavailable(
          request,
          stream.hasContent,
          stderr.resumeTranscriptUnavailable,
          outcome.code,
        )
      ) {
        throw claudeResumeUnavailable(
          request.type,
          outcome.code,
          stderr.redacted,
          (text) => text,
          { sessionId: request.sessionId, claudeVersion },
        );
      }

      const evaluation = evaluateCollectedStreamOutcome({
        stream,
        stderr: stderr.redacted,
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
      activeProcess = null;
    }
  }

  return {
    probeCapabilities: (): Promise<ClaudeCapabilityReport> => probe.probeCapabilities(),
    invoke,
    abort(): void {
      activeProcess?.terminate();
    },
  };
}
