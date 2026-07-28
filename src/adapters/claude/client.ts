/**
 * Claude CLI 进程客户端。所有调用都使用 `child_process.spawn` 参数数组，
 * 不拼接 Shell；stdout/stderr 经过脱敏后由 FileSystemPort 持久化，并把
 * stream-json 契约委托给纯解析器。Windows 上 PATH 中的 `claude` 通常只是
 * npm shim，入口先经 windows-command 解析为真实可执行文件再启动。
 *
 * 子进程原样继承当前用户环境，不读取或缓存凭据，不调用 CC Switch 私有
 * API，也不创建隔离配置目录。本模块不记录 PID、不接管旧 Session、
 * 不恢复 Session，也不自动重启失败进程。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import type { FileSystemPort } from '../../application/ports/file-system.js';
import type { RedactionPort } from '../../application/ports/redaction.js';
import type {
  ClaudeCapabilityReport,
  ClaudeInvocationFact,
  ClaudeInvocationRequest,
  ClaudeRuntimePort,
  ClaudeStreamActivity,
} from '../../application/ports/ClaudeRuntimePort.js';
import type { SessionType } from '../../domain/schemas/active-session.js';
import { getSchemaJson } from '../../domain/schemas/index.js';
import { createCapabilityProbe, type CapabilityProbe, type ProbeRunResult } from './capability.js';
import { resolveWindowsCommand, type WindowsCommandEnvironment } from './windows-command.js';
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
   * 结尾的脚本通过当前 Node 运行时启动，仍然只使用参数数组。Windows
   * 上的裸命令名先经 PATH/PATHEXT 定位并对 npm shim 解引用，得到可
   * 无 Shell 启动的真实入口。
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
  /** stdout 每个 chunk 的同步回调（心跳数据来源）；probe 不使用。 */
  readonly onStdoutChunk?: (chunk: Buffer) => void;
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

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      options.onStdoutChunk?.(chunk);
    });
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

/** 事件摘要的单行长度上限（超出截断并加省略号）。 */
const EVENT_SUMMARY_LIMIT = 200;

/** 折叠为单行并截断到上限，只用于进度展示。 */
function toSummaryLine(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= EVENT_SUMMARY_LIMIT
    ? oneLine
    : `${oneLine.slice(0, EVENT_SUMMARY_LIMIT)}…`;
}

/** assistant/user 事件的 message.content 块（尽力读取，字段缺失则跳过）。 */
type StreamContentBlock = Record<string, unknown>;

function readContentBlocks(event: Record<string, unknown>): StreamContentBlock[] {
  const message = event['message'];
  if (typeof message !== 'object' || message === null) return [];
  const content = (message as Record<string, unknown>)['content'];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter(
    (block): block is StreamContentBlock => typeof block === 'object' && block !== null,
  );
}

/** 工具调用的一行摘要：工具名 + 最具辨识度的输入字段。 */
function summarizeToolUse(block: StreamContentBlock): string {
  const name = typeof block['name'] === 'string' ? block['name'] : 'unknown';
  const input = block['input'];
  if (typeof input !== 'object' || input === null) return `tool: ${name}`;
  const record = input as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return `tool: ${name} — ${toSummaryLine(value)}`;
    }
  }
  return `tool: ${name}`;
}

/** 工具结果的一行摘要；错误结果显式标注。 */
function summarizeToolResult(block: StreamContentBlock): string {
  const prefix = block['is_error'] === true ? 'tool result (error)' : 'tool result';
  const content = block['content'];
  if (typeof content === 'string') return `${prefix}: ${toSummaryLine(content)}`;
  if (Array.isArray(content)) {
    const text = content
      .map((part: unknown) => {
        if (typeof part !== 'object' || part === null) return '';
        const record = part as Record<string, unknown>;
        return typeof record['text'] === 'string' ? record['text'] : '';
      })
      .filter((part: string) => part !== '')
      .join(' ');
    if (text !== '') return `${prefix}: ${toSummaryLine(text)}`;
  }
  return `${prefix} received`;
}

/**
 * 从单个 stream-json 事件提取单行人类可读摘要（思考、文本、工具调用、
 * 工具结果、系统事件、终止结果）。只用于前台进度展示：无法摘要的事件
 * 返回 null，且任何字段缺失都不会抛错。
 */
export function summarizeStreamEvent(event: Record<string, unknown>): string | null {
  const type = event['type'];
  if (type === 'assistant' || type === 'user') {
    const parts: string[] = [];
    for (const block of readContentBlocks(event)) {
      switch (block['type']) {
        case 'thinking':
          if (typeof block['thinking'] === 'string' && block['thinking'].trim() !== '') {
            parts.push(`thinking: ${toSummaryLine(block['thinking'])}`);
          }
          break;
        case 'text':
          if (typeof block['text'] === 'string' && block['text'].trim() !== '') {
            parts.push(toSummaryLine(block['text']));
          }
          break;
        case 'tool_use':
          parts.push(summarizeToolUse(block));
          break;
        case 'tool_result':
          parts.push(summarizeToolResult(block));
          break;
        default:
          break;
      }
    }
    return parts.length === 0 ? null : toSummaryLine(parts.join(' | '));
  }
  if (type === 'system') {
    const subtype = typeof event['subtype'] === 'string' ? event['subtype'] : 'unknown';
    return `system: ${subtype}`;
  }
  if (type === 'result') {
    return 'result event received';
  }
  return null;
}

/**
 * 逐 chunk 累计 stdout 字节数，并按行缓冲尽力提取最近一个 stream-json
 * 事件的 `type` 与单行摘要（JSON.parse 失败的行保持上一已知值）。
 * 只用于心跳行与事件行展示，不参与 §7.2 的结果判定。
 */
function createStreamActivityTracker(
  report: (activity: ClaudeStreamActivity) => void,
): (chunk: Buffer) => void {
  const decoder = new TextDecoder();
  let receivedStdoutBytes = 0;
  let lastEventType: string | null = null;
  let lastEventSummary: string | null = null;
  let lineBuffer = '';
  return (chunk: Buffer): void => {
    receivedStdoutBytes += chunk.length;
    lineBuffer += decoder.decode(chunk, { stream: true });
    let newlineIndex = lineBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = lineBuffer.slice(0, newlineIndex).trim();
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      if (line !== '') {
        try {
          const parsed: unknown = JSON.parse(line);
          if (
            typeof parsed === 'object' &&
            parsed !== null &&
            typeof (parsed as { type?: unknown }).type === 'string'
          ) {
            lastEventType = (parsed as { type: string }).type;
            const summary = summarizeStreamEvent(parsed as Record<string, unknown>);
            if (summary !== null) lastEventSummary = summary;
          }
        } catch {
          // 非 JSON 事件行：忽略，保持上一已知事件类型与摘要。
        }
      }
      newlineIndex = lineBuffer.indexOf('\n');
    }
    report({ receivedStdoutBytes, lastEventType, lastEventSummary });
  };
}

/** 从进程环境读取 Windows 命令解析事实；PATH/PATHEXT 键名大小写不敏感。 */
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

export function createClaudeRuntime(options: ClaudeRuntimeOptions): ClaudeRuntimePort {
  const claudePath = resolveWindowsCommand(
    options.claudePath ?? DEFAULT_CLAUDE_PATH,
    systemWindowsCommandEnvironment(),
  );
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
        ...(request.onStreamActivity === undefined
          ? {}
          : { onStdoutChunk: createStreamActivityTracker(request.onStreamActivity) }),
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
