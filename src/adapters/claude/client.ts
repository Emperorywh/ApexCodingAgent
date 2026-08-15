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
import {
  getSchemaJson,
  getTaskPlanDraftSchemaJson,
} from '../../domain/schemas/index.js';
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
import { createClaudeSessionLog } from './session-log.js';

const DEFAULT_CLAUDE_PATH = 'claude';
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
const STDERR_REDACTED_LIMIT = 4_000;
const STDERR_DIAGNOSTIC_TAIL_LIMIT = 256;
/**
 * StructuredOutput 是每趟 Session 的强制提交边界，不能依赖模型先通过
 * tool_reference 动态发现。命令级 settings 的优先级高于用户/项目设置，
 * 只关闭本次 Claude 子进程的工具延迟加载；代理地址、模型和凭据等其他
 * 用户配置仍由 Claude Code 按原层级继承与合并。
 */
const SESSION_SETTINGS_JSON = JSON.stringify({
  env: { ENABLE_TOOL_SEARCH: 'false' },
});
const RESUME_UNAVAILABLE_PATTERNS = [
  /no conversation found(?: (?:with|for))? session id/i,
  /failed to resume the conversation/i,
] as const;
const RESULT_SCHEMA_BY_SESSION_TYPE = {
  planning: 'TaskPlanDraft',
  plan_review: 'PlanReviewResult',
  execution: 'TaskExecutionResult',
  task_review: 'TaskReviewResult',
  final_review: 'FinalReviewResult',
} as const;
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
  /**
   * 版本、帮助和无副作用参数校验共用的能力探测超时；正式 Session 不设置
   * 自动超时，避免任务规模增长后被基础设施提前终止。
   */
  readonly probeTimeoutMs?: number;
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
  const chunkRedactor = redaction.createChunkRedactor('all');
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

  const probe: CapabilityProbe = createCapabilityProbe(
    runProbe,
    (text) => redaction.redactText(text),
  );

  async function invoke<T extends SessionType>(
    request: ClaudeInvocationRequest<T>,
  ): Promise<ClaudeInvocationFact<T>> {
    /**
     * Reviewer 的权限不能随 --full-access 升级；它是只读完成门禁，不属于
     * 实现阶段。Git 会话快照仍作为第二道、与模型权限无关的副作用检测。
     */
    const permissionIsValid =
      request.type === 'planning' || request.type === 'plan_review'
        ? request.permissionMode === 'plan'
        : request.type === 'task_review'
          ? request.permissionMode === 'auto'
          : request.permissionMode === 'auto' || request.permissionMode === 'bypassPermissions';
    if (!permissionIsValid) {
      throw new TypeError(
        `unsupported claude permission mode ${String(request.permissionMode)} for ${request.type}`,
      );
    }
    if (
      request.maxTurns !== null &&
      request.maxTurns !== undefined &&
      (!Number.isInteger(request.maxTurns) || request.maxTurns <= 0)
    ) {
      throw new TypeError(`maxTurns must be a positive integer, got ${String(request.maxTurns)}`);
    }

    /*
     * 调用请求通常来自本 Adapter 的能力探测，但端口也可被测试或其他组合根
     * 直接调用；版本事实仍在当前边界重新清洗，错误路径和成功路径共用它。
     */
    const claudeVersion = redaction.redactText(request.capabilityReport.version);
    /**
     * 初始 Planning 的输出契约必须在 Claude 工具层先收紧。
     * 其他会话禁止携带该字段，避免调用方传入一个与 Session 类型不一致的 Schema。
     */
    if (request.type === 'planning' && request.planningDraftSchemaMode === undefined) {
      throw new TypeError('planning invoke requires planningDraftSchemaMode');
    }
    if (request.type !== 'planning' && request.planningDraftSchemaMode !== undefined) {
      throw new TypeError(
        `planningDraftSchemaMode is not allowed for ${request.type}`,
      );
    }
    const resultSchemaJson =
      request.type === 'planning'
        ? getTaskPlanDraftSchemaJson(request.planningDraftSchemaMode!)
        : getSchemaJson(RESULT_SCHEMA_BY_SESSION_TYPE[request.type]);
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
    const budgetArgs =
      request.maxTurns === null || request.maxTurns === undefined
        ? []
        : ['--max-turns', String(request.maxTurns)];
    const args = [
      '-p',
      ...sessionArgs,
      ...budgetArgs,
      '--settings',
      SESSION_SETTINGS_JSON,
      '--permission-mode',
      request.permissionMode,
      '--output-format',
      'stream-json',
      '--verbose',
      '--json-schema',
      JSON.stringify(resultSchemaJson),
    ];

    const streamCollector = createClaudeStreamCollector({
      sessionId: request.sessionId,
      /**
       * 即使受管策略覆盖命令级设置，模型也不得在同一结构化提交搜索上
       * 无限打转。解析器确认退化循环后立即终止唯一直接子进程；最终错误
       * 仍由完整流事实统一映射，回调本身不猜测退出码。
       */
      onProtocolViolation: () => {
        activeProcess?.terminate();
      },
      ...(request.onStreamActivity === undefined
        ? {}
        : {
            onActivity: (activity) => {
              /*
               * 流式活动同样是 Adapter 对外事实，不能依赖 Application 在每个
               * 展示点自行补脱敏；所有动态标签、详情和元数据在回调前统一清洗。
               */
              request.onStreamActivity?.({
                ...activity,
                model:
                  activity.model === null ? null : redaction.redactText(activity.model),
                provider:
                  activity.provider === null
                    ? null
                    : redaction.redactText(activity.provider),
                displayEvent:
                  activity.displayEvent === null
                    ? null
                    : {
                        ...activity.displayEvent,
                        label: redaction.redactText(activity.displayEvent.label),
                        detail:
                          activity.displayEvent.detail === null
                            ? null
                            : redaction.redactText(activity.displayEvent.detail),
                      },
              });
            },
          }),
    });
    const stderrCollector = createStderrCollector(redaction);
    const sessionLog = createClaudeSessionLog({
      repositoryRoot: request.cwd,
      sessionId: request.sessionId,
      fileSystem,
      redaction,
    });

    try {
      const outcome = await processExecutor.execute({
        command: claudePath,
        args,
        cwd: request.cwd,
        /*
         * 正式 Session 的上下文规模随计划和验收证据增长，不能进入 argv。
         *
         * Claude print 模式支持从管道读取文本；统一走 stdin 后，Planning、
         * Execution、Task Review、Final Review 和续接会话均不受命令行长度限制。
         */
        stdinText: request.prompt,
        collectOutput: false,
        onStart: (process) => {
          activeProcess = process;
        },
        onStdoutChunk: async (chunk) => {
          const logRecords = streamCollector.push(chunk);
          await sessionLog.push(logRecords);
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

      const finalizedStream = streamCollector.finish();
      const stream = finalizedStream.stream;
      const stderr = stderrCollector.finish();
      const stderrSummary = summarizeStderr(stderr.redacted, (text) => text);
      await sessionLog.push(finalizedStream.trailingRecords);
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
        /*
         * 成功事实离开 Claude Adapter 前整体脱敏。Application 后续可以直接
         * 用于决策和持久化，replanReason 等新增字段不会再绕过单独调用点。
         */
        structuredResult: redaction.redactStructured(evaluation.structuredResult),
        claudeVersion,
        model:
          evaluation.model === null ? null : redaction.redactText(evaluation.model),
        provider:
          evaluation.provider === null ? null : redaction.redactText(evaluation.provider),
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
