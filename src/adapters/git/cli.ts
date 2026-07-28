/**
 * Git CLI process wrapper (SPEC §7.2): `child_process.spawn` with an argument
 * array — never a shell string. Collects stdout/stderr, enforces a per-command
 * timeout, and maps every non-zero exit / spawn failure / timeout to
 * `GIT_COMMAND_FAILED` (SPEC §15.3 git_error row). Expected-non-zero probes
 * (`merge-base --is-ancestor`, `diff --cached --quiet`, detached-HEAD
 * `symbolic-ref`) go through {@link GitRunner.runAllowFailure} and map their
 * own exit codes.
 */
import { spawn } from 'node:child_process';
import { ApexError } from '../../domain/errors.js';

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
  /** Redaction hook (identity when none was configured), for caller-side error mapping. */
  readonly redact: (text: string) => string;
}

export interface GitRunnerOptions {
  /** git executable (SPEC §17 `--git-cli-path`); defaults to `git` on PATH. */
  readonly gitPath?: string;
  readonly timeoutMs?: number;
  /** Redaction hook (SPEC §18.4) applied to stderr before it enters diagnostics. */
  readonly redact?: (text: string) => string;
}

export function gitCommandFailed(
  message: string,
  options?: { readonly stderr?: string; readonly redact?: (text: string) => string; readonly cause?: unknown },
): ApexError {
  const trimmed = options?.stderr?.trim() ?? '';
  const redacted = options?.redact !== undefined && trimmed.length > 0 ? options.redact(trimmed) : trimmed;
  return new ApexError({
    code: 'GIT_COMMAND_FAILED',
    stage: GIT_STAGE,
    message,
    ...(redacted.length > 0 ? { toolSummary: redacted.slice(0, SUMMARY_LIMIT) } : {}),
    ...(options?.cause === undefined ? {} : { cause: options.cause }),
  });
}

export function createGitRunner(options: GitRunnerOptions = {}): GitRunner {
  const gitPath = options.gitPath ?? 'git';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  function spawnGit(args: readonly string[], cwd: string): Promise<GitRunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(gitPath, [...args], {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(
          gitCommandFailed(`git ${args.join(' ')} timed out after ${timeoutMs}ms`),
        );
      }, timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(
          gitCommandFailed(`failed to spawn git (${gitPath}): ${error.message}`, {
            cause: error,
          }),
        );
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          code: code ?? -1,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
        });
      });
    });
  }

  return {
    redact: options.redact ?? ((text: string) => text),
    async run(args, cwd) {
      const result = await spawnGit(args, cwd);
      if (result.code !== 0) {
        throw gitCommandFailed(`git ${args.join(' ')} exited with code ${result.code}`, {
          stderr: result.stderr,
          ...(options.redact === undefined ? {} : { redact: options.redact }),
        });
      }
      return result;
    },
    runAllowFailure: spawnGit,
  };
}
