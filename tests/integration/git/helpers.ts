/**
 * Shared helpers for the real-temporary-repo Git integration tests (SPEC
 * §22.2). Each repo is initialized with `main` as the default branch, a local
 * test identity and no GPG signing; the Git adapter under test talks to the
 * same `git` executable as a user would.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { expect } from 'vitest';
import type { SessionGitFacts } from '../../../src/application/ports/GitPort.js';
import { ApexError, type ErrorCode } from '../../../src/domain/errors.js';

const execFileAsync = promisify(execFile);

export const RUN_ID = 'RUN-123e4567-e89b-42d3-a456-426614174000';
export const RUN_BRANCH = `apex-coding-agent/${RUN_ID}`;
export const SESSION_ID = 'abcdefab-1234-5678-9abc-def012345678';

export interface GitCallResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface TempRepo {
  readonly root: string;
  /** Runs git; resolves to trimmed stdout, rejects on non-zero exit. */
  git(...args: string[]): Promise<string>;
  /** Runs git; resolves with the raw outcome regardless of exit code. */
  gitRaw(...args: string[]): Promise<GitCallResult>;
  writeFile(relPath: string, content: string | Uint8Array): Promise<void>;
  /** `git add -A` + commit; resolves to the new commit OID. */
  commitAll(message: string): Promise<string>;
  head(): Promise<string>;
  cleanup(): Promise<void>;
}

export async function createTempRepo(): Promise<TempRepo> {
  const root = await mkdtemp(join(tmpdir(), 'apex-g3-'));
  const gitRaw = async (...args: string[]): Promise<GitCallResult> => {
    try {
      const { stdout, stderr } = await execFileAsync('git', args, {
        cwd: root,
        // 防止 git 子进程悬挂：超时会 kill 进程并使 promise 拒绝，
        // 避免测试被中止后仍有进程占用临时目录（Windows EBUSY）。
        timeout: 30_000,
      });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failed = error as {
        readonly code?: number;
        readonly stdout?: string;
        readonly stderr?: string;
      };
      return {
        code: typeof failed.code === 'number' ? failed.code : 1,
        stdout: failed.stdout ?? '',
        stderr: failed.stderr ?? String(error),
      };
    }
  };
  const git = async (...args: string[]): Promise<string> => {
    const result = await gitRaw(...args);
    if (result.code !== 0) {
      throw new Error(`git ${args.join(' ')} failed in ${root}: ${result.stderr}`);
    }
    return result.stdout.trim();
  };
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Apex Test');
  await git('config', 'user.email', 'apex-test@example.invalid');
  await git('config', 'commit.gpgsign', 'false');

  return {
    root,
    git,
    gitRaw,
    async writeFile(relPath, content) {
      const absolute = join(root, relPath);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, content);
    },
    async commitAll(message) {
      await git('add', '-A');
      await git('commit', '--message', message);
      return git('rev-parse', 'HEAD');
    },
    head: () => git('rev-parse', 'HEAD'),
    /**
     * Windows 不允许删除仍作为子进程 cwd 的目录；git 进程退出略滞后于
     * 测试结束时 rmdir 会报 EBUSY，用重试吸收这个竞争窗口。
     */
    cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
  };
}

/** Seeds a repo with a tracked SPEC.md and one source file; returns the base commit. */
export async function seedRepo(repo: TempRepo): Promise<string> {
  await repo.writeFile('SPEC.md', '# Spec\n');
  await repo.writeFile('src/index.ts', 'export const value = 1;\n');
  return repo.commitAll('initial commit');
}

/** Session facts matching the seeded repo + created run branch. */
export function mkFacts(
  base: { readonly baseCommit: string; readonly expectedHead: string },
  overrides: Partial<SessionGitFacts> = {},
): SessionGitFacts {
  return {
    runBranch: RUN_BRANCH,
    baseBranchRef: 'refs/heads/main',
    completedCheckpoints: [],
    specGitPath: 'SPEC.md',
    ...base,
    ...overrides,
  };
}

export async function expectApexErrorAsync(
  fn: () => Promise<unknown>,
  code: ErrorCode,
): Promise<ApexError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApexError);
    expect((error as ApexError).errorCode).toBe(code);
    return error as ApexError;
  }
  throw new Error(`expected ApexError with code ${code}, but nothing was thrown`);
}
