/**
 * Read-only repository status for reporting (SPEC §14.4): the HEAD fact plus
 * the raw `git status --porcelain` line set. No invariant assertions are
 * made — a detached HEAD is reported as `branch: null` instead of throwing
 * the startup-era BASE_BRANCH_REQUIRED.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGitAdapter } from '../../../src/adapters/git/adapter.js';
import type { GitPort } from '../../../src/application/ports/GitPort.js';
import { createTempRepo, seedRepo, type TempRepo } from './helpers.js';

let repo: TempRepo;
let port: GitPort;
let baseCommit: string;

beforeEach(async () => {
  repo = await createTempRepo();
  baseCommit = await seedRepo(repo);
  port = createGitAdapter();
});

afterEach(async () => {
  await repo.cleanup();
});

describe('readRepositoryStatus', () => {
  it('reports HEAD oid and attached branch of a clean repository', async () => {
    const status = await port.readRepositoryStatus(repo.root);
    expect(status.head.oid).toBe(baseCommit);
    expect(status.head.branch).toBe('main');
    expect(status.statusEntries).toEqual([]);
  });

  it('returns the raw porcelain lines once the worktree changes', async () => {
    await repo.writeFile('notes.txt', 'scratch\n');
    await repo.writeFile('src/index.ts', 'export const value = 2;\n');

    const status = await port.readRepositoryStatus(repo.root);
    expect(status.statusEntries).toContain('?? notes.txt');
    expect(status.statusEntries).toContain(' M src/index.ts');
    // HEAD itself is untouched by worktree changes.
    expect(status.head.oid).toBe(baseCommit);
    expect(status.head.branch).toBe('main');
  });

  it('reports a detached HEAD as branch null without throwing', async () => {
    await repo.git('switch', '--detach', 'HEAD');

    const status = await port.readRepositoryStatus(repo.root);
    expect(status.head.oid).toBe(baseCommit);
    expect(status.head.branch).toBeNull();
    expect(status.statusEntries).toEqual([]);
  });
});
