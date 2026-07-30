/**
 * SPEC discovery and path validation (SPEC §3.2; test matrix §22.1 path
 * normalization / discovery / ignored / symlink-junction boundaries, §22.2
 * SPEC tracked-modified-staged states). Runs against real temporary repos.
 */
import { createHash } from 'node:crypto';
import { realpath, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGitAdapter } from '../../../src/adapters/git/adapter.js';
import {
  discoverSpecCandidates,
  isPathInside,
  toGitRelativePath,
} from '../../../src/adapters/git/spec-discovery.js';
import { createGitRunner } from '../../../src/adapters/git/cli.js';
import type { GitPort } from '../../../src/application/ports/GitPort.js';
import {
  createTempRepo,
  expectApexErrorAsync,
  redactGitText,
  seedRepo,
  type TempRepo,
} from './helpers.js';
import { createTestProcessExecutor } from '../../process-executor.js';

const IS_WINDOWS = process.platform === 'win32';
const sha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');

let repo: TempRepo;
let port: GitPort;

beforeEach(async () => {
  repo = await createTempRepo();
  port = createGitAdapter({
    processExecutor: createTestProcessExecutor(),
    redact: redactGitText,
  });
});

afterEach(async () => {
  await repo.cleanup();
});

describe('path normalization helpers', () => {
  it('contains child paths with a strict segment boundary', () => {
    expect(isPathInside('/repo/docs/SPEC.md', '/repo')).toBe(true);
    expect(isPathInside('/repo2/SPEC.md', '/repo')).toBe(false);
    expect(isPathInside('/repo', '/repo')).toBe(true);
  });

  it('folds case only on Windows', () => {
    expect(isPathInside('C:/REPO/docs', 'C:/repo')).toBe(IS_WINDOWS);
  });

  it('normalizes mixed separators to `/`-joined relative paths', () => {
    const gitPath = toGitRelativePath('C:/repo', 'C:/repo/docs\\SPEC.md');
    expect(gitPath).toBe('docs/SPEC.md');
  });
});

describe('default discovery', () => {
  it('resolves a unique untracked SPEC.md at the repository root', async () => {
    await repo.writeFile('SPEC.md', '# Spec\n');
    const fact = await port.resolveSpec(repo.root, repo.root, null);
    expect(fact.gitPath).toBe('SPEC.md');
    expect(fact.sha256).toBe(sha256('# Spec\n'));
  });

  it('resolves a tracked SPEC.md in a subdirectory', async () => {
    await seedRepo(repo);
    await repo.writeFile('docs/SPEC.md', '# Docs Spec\n');
    await repo.git('rm', '--quiet', 'SPEC.md');
    await repo.git('add', 'docs/SPEC.md');
    await repo.git('commit', '--message', 'move spec');
    const fact = await port.resolveSpec(repo.root, repo.root, null);
    expect(fact.gitPath).toBe('docs/SPEC.md');
  });

  it('fails with SPEC_NOT_FOUND when no candidate exists', async () => {
    await seedRepo(repo);
    await repo.git('rm', 'SPEC.md', '--quiet');
    await repo.git('commit', '--message', 'drop spec');
    await expectApexErrorAsync(() => port.resolveSpec(repo.root, repo.root, null), 'SPEC_NOT_FOUND');
  });

  it('fails with SPEC_AMBIGUOUS when several candidates exist', async () => {
    await seedRepo(repo);
    await repo.writeFile('docs/SPEC.md', '# Other\n');
    const error = await expectApexErrorAsync(
      () => port.resolveSpec(repo.root, repo.root, null),
      'SPEC_AMBIGUOUS',
    );
    expect(error.message).toContain('SPEC.md');
    expect(error.message).toContain('docs/SPEC.md');
  });

  it('ignores candidates inside .apex-coding-agent/', async () => {
    await repo.writeFile('.apex-coding-agent/SPEC.md', '# State\n');
    await expectApexErrorAsync(() => port.resolveSpec(repo.root, repo.root, null), 'SPEC_NOT_FOUND');
  });

  it('does not traverse Git-ignored directories (explicit path still works)', async () => {
    await repo.writeFile('.gitignore', 'vendor/\n');
    await repo.writeFile('vendor/SPEC.md', '# Vendor\n');
    await repo.git('add', '.gitignore');
    await repo.git('commit', '--message', 'ignore vendor');

    expect(
      await discoverSpecCandidates(
        createGitRunner({
          processExecutor: createTestProcessExecutor(),
          redact: redactGitText,
        }),
        repo.root,
        repo.root,
      ),
    ).toEqual([]);
    await expectApexErrorAsync(() => port.resolveSpec(repo.root, repo.root, null), 'SPEC_NOT_FOUND');

    const fact = await port.resolveSpec(repo.root, repo.root, 'vendor/SPEC.md');
    expect(fact.gitPath).toBe('vendor/SPEC.md');
  });
});

describe('invocation-directory scoping', () => {
  it('resolves the subtree SPEC despite SPECs elsewhere in the repository (monorepo)', async () => {
    await seedRepo(repo); // tracked SPEC.md at the root, like a sibling project would have
    await repo.writeFile('china-3d/docs/SPEC.md', '# China 3D\n');
    await repo.writeFile('agv-map-3d/orchestration/SPEC.md', '# AGV\n');
    const fact = await port.resolveSpec(repo.root, join(repo.root, 'china-3d'), null);
    expect(fact.gitPath).toBe('china-3d/docs/SPEC.md');
    expect(fact.sha256).toBe(sha256('# China 3D\n'));
  });

  it('scopes discoverSpecCandidates to the invocation subtree', async () => {
    await seedRepo(repo);
    await repo.writeFile('sub/a/SPEC.md', '# A\n');
    await repo.writeFile('sub/b/SPEC.md', '# B\n');
    const git = createGitRunner({
      processExecutor: createTestProcessExecutor(),
      redact: redactGitText,
    });
    const all = await discoverSpecCandidates(git, repo.root, repo.root);
    expect([...all].sort()).toEqual(['SPEC.md', 'sub/a/SPEC.md', 'sub/b/SPEC.md']);
    const scoped = await discoverSpecCandidates(git, repo.root, join(repo.root, 'sub'));
    expect([...scoped].sort()).toEqual(['sub/a/SPEC.md', 'sub/b/SPEC.md']);
  });

  it('fails with SPEC_AMBIGUOUS listing only the subtree candidates', async () => {
    await seedRepo(repo);
    await repo.writeFile('sub/a/SPEC.md', '# A\n');
    await repo.writeFile('sub/b/SPEC.md', '# B\n');
    const error = await expectApexErrorAsync(
      () => port.resolveSpec(repo.root, join(repo.root, 'sub'), null),
      'SPEC_AMBIGUOUS',
    );
    expect(error.message).toContain('sub/a/SPEC.md');
    expect(error.message).toContain('sub/b/SPEC.md');
  });

  it('fails with SPEC_NOT_FOUND when the SPEC exists only outside the subtree', async () => {
    await seedRepo(repo); // SPEC.md at the root only
    await repo.writeFile('sub/src/index.ts', 'export {};\n');
    await expectApexErrorAsync(
      () => port.resolveSpec(repo.root, join(repo.root, 'sub'), null),
      'SPEC_NOT_FOUND',
    );
  });

  it('does not look into sibling or parent directories', async () => {
    await seedRepo(repo);
    await repo.git('rm', '--quiet', 'SPEC.md');
    await repo.git('commit', '--message', 'drop spec');
    await repo.writeFile('sub/SPEC.md', '# Sub\n');
    await expectApexErrorAsync(
      () => port.resolveSpec(repo.root, join(repo.root, 'sub', 'deeper'), null),
      'SPEC_NOT_FOUND',
    );
  });
});

describe('explicit path resolution', () => {
  beforeEach(() => seedRepo(repo));

  it('resolves a relative path against the invocation directory', async () => {
    await repo.writeFile('docs/SPEC.md', '# Docs\n');
    const fact = await port.resolveSpec(repo.root, join(repo.root, 'docs'), 'SPEC.md');
    expect(fact.gitPath).toBe('docs/SPEC.md');
  });

  it('normalizes backslashes and wrong casing on Windows', async () => {
    await repo.writeFile('docs/SPEC.md', '# Docs\n');
    if (!IS_WINDOWS) return; // POSIX treats `\\` and case literally; covered by the win32 run.
    const fact = await port.resolveSpec(repo.root, repo.root, 'docs\\spec.md');
    expect(fact.gitPath).toBe('docs/SPEC.md');
  });

  it('rejects a path escaping the root with SPEC_OUTSIDE_REPOSITORY', async () => {
    await expectApexErrorAsync(
      () => port.resolveSpec(repo.root, repo.root, '../SPEC.md'),
      'SPEC_OUTSIDE_REPOSITORY',
    );
    await expectApexErrorAsync(
      () => port.resolveSpec(repo.root, repo.root, resolve(repo.root, '..', 'SPEC.md')),
      'SPEC_OUTSIDE_REPOSITORY',
    );
  });

  it('rejects a missing explicit file with SPEC_NOT_FOUND', async () => {
    await expectApexErrorAsync(
      () => port.resolveSpec(repo.root, repo.root, 'docs/SPEC.md'),
      'SPEC_NOT_FOUND',
    );
  });

  it('rejects a directory with SPEC_NOT_REGULAR_FILE', async () => {
    await expectApexErrorAsync(
      () => port.resolveSpec(repo.root, repo.root, 'src'),
      'SPEC_NOT_REGULAR_FILE',
    );
  });
});

describe('symlink and junction boundaries', () => {
  let outside: TempRepo;
  let canSymlink = false;
  let canJunction = false;

  beforeEach(async () => {
    await seedRepo(repo);
    outside = await createTempRepo();
    await outside.writeFile('SPEC.md', '# Outside\n');
    const link = join(repo.root, 'linked-spec.md');
    const junction = join(repo.root, 'junction-dir');
    try {
      await symlink(join(outside.root, 'SPEC.md'), link, 'file');
      canSymlink = true;
    } catch (error) {
      console.info(
        `[g3] file-symlink creation unavailable (${(error as NodeJS.ErrnoException).code}); boundary test skipped`,
      );
    }
    try {
      await symlink(outside.root, junction, 'junction');
      canJunction = true;
    } catch (error) {
      console.info(
        `[g3] junction creation unavailable (${(error as NodeJS.ErrnoException).code}); boundary test skipped`,
      );
    }
  });

  afterEach(() => outside.cleanup());

  it('rejects a file symlink escaping the root', async () => {
    if (!canSymlink) return; // annotated in beforeEach when creation is not permitted
    await expectApexErrorAsync(
      () => port.resolveSpec(repo.root, repo.root, 'linked-spec.md'),
      'SPEC_OUTSIDE_REPOSITORY',
    );
  });

  it('rejects a directory junction escaping the root', async () => {
    if (!canJunction) return;
    await expectApexErrorAsync(
      () => port.resolveSpec(repo.root, repo.root, 'junction-dir/SPEC.md'),
      'SPEC_OUTSIDE_REPOSITORY',
    );
  });
});

describe('file validation', () => {
  beforeEach(() => seedRepo(repo));

  it('rejects empty content with SPEC_EMPTY (BOM-only counts as empty)', async () => {
    await repo.writeFile('SPEC.md', '');
    await expectApexErrorAsync(
      () => port.resolveSpec(repo.root, repo.root, 'SPEC.md'),
      'SPEC_EMPTY',
    );
    await repo.writeFile('SPEC.md', Uint8Array.from([0xef, 0xbb, 0xbf]));
    await expectApexErrorAsync(
      () => port.resolveSpec(repo.root, repo.root, 'SPEC.md'),
      'SPEC_EMPTY',
    );
  });

  it('rejects invalid UTF-8 with SPEC_INVALID_UTF8', async () => {
    await repo.writeFile('SPEC.md', Uint8Array.from([0xff, 0xfe, 0x41, 0x00]));
    await expectApexErrorAsync(
      () => port.resolveSpec(repo.root, repo.root, 'SPEC.md'),
      'SPEC_INVALID_UTF8',
    );
  });

  it('accepts a UTF-8 BOM and hashes the raw bytes including it', async () => {
    const raw = Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('# Spec\n')]);
    await repo.writeFile('SPEC.md', raw);
    const fact = await port.resolveSpec(repo.root, repo.root, 'SPEC.md');
    expect(fact.sha256).toBe(sha256(raw));
  });
});

describe('SPEC tracked / modified / staged states', () => {
  beforeEach(() => seedRepo(repo));

  /** Removes the tracked SPEC so it can re-enter as a genuinely untracked file. */
  async function untrackSpec(content: string): Promise<void> {
    await repo.git('rm', '--quiet', 'SPEC.md');
    await repo.git('commit', '--message', 'untrack spec');
    await repo.writeFile('SPEC.md', content);
  }

  it('allows an untracked SPEC', async () => {
    await untrackSpec('# Untracked\n');
    const fact = await port.resolveSpec(repo.root, repo.root, null);
    expect(fact.gitPath).toBe('SPEC.md');
    expect(fact.sha256).toBe(sha256('# Untracked\n'));
  });

  it('allows a worktree-modified (unstaged) SPEC', async () => {
    await repo.writeFile('SPEC.md', '# Changed\n');
    const fact = await port.resolveSpec(repo.root, repo.root, null);
    expect(fact.sha256).toBe(sha256('# Changed\n'));
  });

  it('rejects a staged SPEC with SPEC_STAGED and never unstages', async () => {
    await repo.writeFile('SPEC.md', '# Staged\n');
    await repo.git('add', 'SPEC.md');
    await expectApexErrorAsync(
      () => port.resolveSpec(repo.root, repo.root, null),
      'SPEC_STAGED',
    );
    // The staged change is left exactly as found.
    const staged = await repo.git('diff', '--cached', '--name-only');
    expect(staged).toBe('SPEC.md');
  });

  it('rejects a staged deletion of SPEC as SPEC_STAGED', async () => {
    await repo.git('rm', '--cached', 'SPEC.md', '--quiet');
    await expectApexErrorAsync(
      () => port.resolveSpec(repo.root, repo.root, null),
      'SPEC_STAGED',
    );
  });

  it('rejects a newly staged (previously untracked) SPEC', async () => {
    await untrackSpec('# Brand new\n');
    await repo.git('add', 'SPEC.md');
    await expectApexErrorAsync(
      () => port.resolveSpec(repo.root, repo.root, null),
      'SPEC_STAGED',
    );
  });
});

describe('readSpecFact recompute boundary', () => {
  it('rejects a persisted path that is no longer a valid Git-relative path', async () => {
    /**
     * readSpecFact 接收的是持久化事实，但仍是文件访问边界。
     * 即使调用方绕过 Schema，也不能用 `..` 或绝对路径读取仓库外文件。
     */
    await expectApexErrorAsync(
      () => port.readSpecFact(repo.root, '../SPEC.md'),
      'SPEC_OUTSIDE_REPOSITORY',
    );
    await expectApexErrorAsync(
      () => port.readSpecFact(repo.root, 'C:/outside/SPEC.md'),
      'SPEC_OUTSIDE_REPOSITORY',
    );
  });

  it('re-hashes the authoritative path after a worktree change', async () => {
    await seedRepo(repo);
    const before = await port.readSpecFact(repo.root, 'SPEC.md');
    await repo.writeFile('SPEC.md', '# Updated\n');
    const after = await port.readSpecFact(repo.root, 'SPEC.md');
    expect(before.sha256).not.toBe(after.sha256);
    expect(after.sha256).toBe(sha256('# Updated\n'));
  });

  it('fails with SPEC_NOT_FOUND when the file vanished mid-run', async () => {
    await seedRepo(repo);
    await repo.git('rm', 'SPEC.md', '--quiet');
    await expectApexErrorAsync(() => port.readSpecFact(repo.root, 'SPEC.md'), 'SPEC_NOT_FOUND');
  });
});
