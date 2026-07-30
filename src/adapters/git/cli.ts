/**
 * Git CLI process wrapper (SPEC §7.2): delegates the argument-array execution
 * boundary to the shared ProcessExecutor and never constructs a shell string.
 * It collects the bounded output of short Git commands, enforces a per-command
 * timeout, and maps every non-zero exit / spawn failure / timeout to
 * `GIT_COMMAND_FAILED` (SPEC §15.3 git_error row). Expected-non-zero probes
 * (`merge-base --is-ancestor`, `diff --cached --quiet`, detached-HEAD
 * `symbolic-ref`) go through {@link GitRunner.runAllowFailure} and map their
 * own exit codes.
 */
import { ApexError } from '../../domain/errors.js';
import type { ProcessExecutor } from '../process/process-executor.js';

const GIT_STAGE = 'git';
const DEFAULT_TIMEOUT_MS = 30_000;
const SUMMARY_LIMIT = 2_000;

export interface GitRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitRunner {
  /** Runs git and rejects with `GIT_COMMAND_FAILED` unless the exit code is 0. */
  run(args: readonly string[], cwd: string): Promise<GitRunResult>;
  /** Runs git and resolves with whatever exit code the process produced. */
  runAllowFailure(args: readonly string[], cwd: string): Promise<GitRunResult>;
  /** 调用方错误映射复用的必选脱敏函数，不允许 identity 回退。 */
  readonly redact: (text: string) => string;
}

export interface GitRunnerOptions {
  readonly processExecutor: ProcessExecutor;
  /** git executable (SPEC §17 `--git-cli-path`); defaults to `git` on PATH. */
  readonly gitPath?: string;
  readonly timeoutMs?: number;
  /** Redaction hook (SPEC §18.4) applied before dynamic text enters diagnostics. */
  readonly redact: (text: string) => string;
}

export function gitCommandFailed(
  message: string,
  options: {
    readonly redact: (text: string) => string;
    readonly stderr?: string;
    readonly cause?: unknown;
  },
): ApexError {
  /*
   * stderr、可执行路径和 Git 参数都可能含仓库路径或凭据。错误在 Adapter
   * 内构造时就统一清洗，不能把 Redaction 留给某个下游展示点补救。
   */
  const trimmed = options.stderr?.trim() ?? '';
  const redacted = trimmed.length > 0 ? options.redact(trimmed) : '';
  return new ApexError({
    code: 'GIT_COMMAND_FAILED',
    stage: GIT_STAGE,
    message: options.redact(message),
    ...(redacted.length > 0 ? { toolSummary: redacted.slice(0, SUMMARY_LIMIT) } : {}),
    ...(options.cause === undefined ? {} : { cause: options.cause }),
  });
}

export function createGitRunner(options: GitRunnerOptions): GitRunner {
  const gitPath = options.gitPath ?? 'git';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /**
   * Git 命令输出规模受具体协议约束，可以在统一执行器内完整收集。
   *
   * 这里仅解释进程终态并映射稳定 Git 错误；底层执行器不会知道哪些非零
   * 退出属于探测语义，因此 runAllowFailure 仍能保留原有行为。
   */
  async function executeGit(args: readonly string[], cwd: string): Promise<GitRunResult> {
    const outcome = await options.processExecutor.execute({
      command: gitPath,
      args,
      cwd,
      timeoutMs,
      collectOutput: true,
    });
    if (outcome.kind === 'spawn-failed') {
      throw gitCommandFailed(`failed to spawn git (${gitPath}): ${outcome.error.message}`, {
        redact: options.redact,
        cause: outcome.error,
      });
    }
    if (outcome.kind === 'timeout') {
      throw gitCommandFailed(`git ${args.join(' ')} timed out after ${timeoutMs}ms`, {
        redact: options.redact,
      });
    }
    if (outcome.streamFailed) {
      throw gitCommandFailed(`git ${args.join(' ')} stdout/stderr stream failed`, {
        stderr: outcome.stderr,
        redact: options.redact,
      });
    }
    return {
      code: outcome.code ?? -1,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
    };
  }

  return {
    redact: options.redact,
    async run(args, cwd) {
      const result = await executeGit(args, cwd);
      if (result.code !== 0) {
        throw gitCommandFailed(`git (${gitPath}) ${args.join(' ')} exited with code ${result.code}`, {
          stderr: result.stderr,
          redact: options.redact,
        });
      }
      return result;
    },
    runAllowFailure: executeGit,
  };
}
