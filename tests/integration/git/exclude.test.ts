/**
 * State-directory exclude management (SPEC §3.1; test matrix §22.2 plain
 * repo + linked worktree). The exclude file is located through
 * `git rev-parse --git-path info/exclude`, updated idempotently, and the
 * project `.gitignore` is never touched.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGitAdapter } from '../../../src/adapters/git/adapter.js';
import type { GitPort } from '../../../src/application/ports/GitPort.js';
import { createTempRepo, redactGitText, seedRepo, type TempRepo } from './helpers.js';
import { createTestProcessExecutor } from '../../process-executor.js';

let repo: TempRepo;
let port: GitPort;

beforeEach(async () => {
  repo = await createTempRepo();
  await seedRepo(repo);
  port = createGitAdapter({
    processExecutor: createTestProcessExecutor(),
    redact: redactGitText,
  });
});

afterEach(async () => {
  await repo.cleanup();
});

/** The exclude path git itself reports for `cwd` (relative output resolved). */
async function excludeFilePath(cwd: string): Promise<string> {
  const reported = await repo.git('-C', cwd, 'rev-parse', '--git-path', 'info/exclude');
  return resolve(cwd, reported);
}

describe('plain repository', () => {
  it('adds .apex-coding-agent/ to info/exclude idempotently', async () => {
    await port.ensureStateDirectoryExcluded(repo.root);
    await port.ensureStateDirectoryExcluded(repo.root);

    const content = await readFile(await excludeFilePath(repo.root), 'utf8');
    const occurrences = content
      .split('\n')
      .filter((line) => line === '.apex-coding-agent/').length;
    expect(occurrences).toBe(1);
    expect(content.endsWith('\n')).toBe(true);

    // The state directory is now ignored by git status.
    await repo.writeFile('.apex-coding-agent/run.json', '{}\n');
    expect(await repo.git('status', '--porcelain')).toBe('');
  });

  it('appends after an existing file that lacks a trailing newline', async () => {
    const excludePath = await excludeFilePath(repo.root);
    await mkdir(join(excludePath, '..'), { recursive: true });
    await writeFile(excludePath, '# custom\n*.log');
    await port.ensureStateDirectoryExcluded(repo.root);
    expect(await readFile(excludePath, 'utf8')).toBe('# custom\n*.log\n.apex-coding-agent/\n');
  });

  it('never modifies .gitignore', async () => {
    await repo.writeFile('.gitignore', 'node_modules/\n');
    await repo.git('add', '.gitignore');
    await repo.git('commit', '--message', 'add gitignore');
    await port.ensureStateDirectoryExcluded(repo.root);
    expect(await readFile(join(repo.root, '.gitignore'), 'utf8')).toBe('node_modules/\n');
    expect(await repo.git('status', '--porcelain')).toBe('');
  });
});

describe('linked worktree', () => {
  let worktreeRoot: string | null = null;

  afterEach(async () => {
    if (worktreeRoot !== null) {
      await repo.git('worktree', 'remove', '--force', worktreeRoot);
      worktreeRoot = null;
    }
  });

  it('resolves the shared exclude file without assuming .git is a directory', async () => {
    worktreeRoot = join(repo.root, '..', `${basename(repo.root)}-wt`);
    await repo.git('worktree', 'add', '-b', 'wt-branch', worktreeRoot);

    // `.git` in a linked worktree is a file, not a directory.
    const dotGit = await readFile(join(worktreeRoot, '.git'), 'utf8');
    expect(dotGit.startsWith('gitdir:')).toBe(true);

    await port.ensureStateDirectoryExcluded(worktreeRoot);
    await port.ensureStateDirectoryExcluded(worktreeRoot);

    // The exclude entry lands in the shared (main repo) exclude file, once.
    const sharedExclude = await excludeFilePath(worktreeRoot);
    expect(sharedExclude).toBe(await excludeFilePath(repo.root));
    const content = await readFile(sharedExclude, 'utf8');
    expect(content.split('\n').filter((line) => line === '.apex-coding-agent/').length).toBe(1);

    // The state directory is ignored inside the worktree as well.
    await mkdir(join(worktreeRoot, '.apex-coding-agent'), { recursive: true });
    await writeFile(join(worktreeRoot, '.apex-coding-agent', 'run.json'), '{}\n');
    expect(await repo.git('-C', worktreeRoot, 'status', '--porcelain')).toBe('');
  });
});
