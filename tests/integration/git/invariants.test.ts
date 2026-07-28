/**
 * Git session invariants and startup checks (SPEC §8.1 items 6–11, §8.3;
 * test matrix §22.2: switched Run Branch, moved Base Branch ref, rewritten
 * history, protected paths in Claude commits, Planning side effects).
 * All checks run against real temporary repositories.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGitAdapter } from '../../../src/adapters/git/adapter.js';
import type { GitPort, SessionStartFact } from '../../../src/application/ports/GitPort.js';
import {
  RUN_BRANCH,
  RUN_ID,
  createTempRepo,
  expectApexErrorAsync,
  mkFacts,
  seedRepo,
  type TempRepo,
} from './helpers.js';

let repo: TempRepo;
let port: GitPort;

beforeEach(async () => {
  repo = await createTempRepo();
  port = createGitAdapter();
});

afterEach(async () => {
  await repo.cleanup();
});

/** Seeds the repo, creates the Run Branch and returns the session facts. */
async function seedWithRunBranch(): Promise<ReturnType<typeof mkFacts>> {
  const baseCommit = await seedRepo(repo);
  await port.createRunBranch(repo.root, RUN_ID);
  const head = await repo.head();
  return mkFacts({ baseCommit, expectedHead: head });
}

describe('startup repository checks', () => {
  it('confirms git availability and reads HEAD facts', async () => {
    const baseCommit = await seedRepo(repo);
    await port.assertAvailable();
    const head = await port.readHead(repo.root);
    expect(head).toEqual({ oid: baseCommit, branch: 'main' });
  });

  it('resolves the repository root from a nested directory', async () => {
    await seedRepo(repo);
    await mkdir(join(repo.root, 'src', 'deep'), { recursive: true });
    expect(await port.resolveRepositoryRoot(join(repo.root, 'src', 'deep'))).toBe(
      await repo.git('rev-parse', '--show-toplevel'),
    );
  });

  it('fails with GIT_WORKTREE_REQUIRED outside a worktree', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'apex-g3-plain-'));
    try {
      await expectApexErrorAsync(
        () => port.resolveRepositoryRoot(plain),
        'GIT_WORKTREE_REQUIRED',
      );
    } finally {
      await rm(plain, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  it('fails with GIT_WORKTREE_REQUIRED for a bare repository', async () => {
    await seedRepo(repo);
    const bare = await mkdtemp(join(tmpdir(), 'apex-g3-bare-'));
    try {
      await repo.git('init', '--bare', bare);
      await expectApexErrorAsync(
        () => port.resolveRepositoryRoot(bare),
        'GIT_WORKTREE_REQUIRED',
      );
    } finally {
      await rm(bare, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  it('fails with GIT_HEAD_REQUIRED when the repository has no commits', async () => {
    await expectApexErrorAsync(() => port.readHead(repo.root), 'GIT_HEAD_REQUIRED');
  });

  it('fails with BASE_BRANCH_REQUIRED when HEAD is detached', async () => {
    await seedRepo(repo);
    await repo.git('checkout', '--detach', 'HEAD');
    await expectApexErrorAsync(() => port.readHead(repo.root), 'BASE_BRANCH_REQUIRED');
  });

  it('fails with STATE_DIRECTORY_TRACKED when state paths are tracked', async () => {
    await seedRepo(repo);
    await repo.writeFile('.apex-coding-agent/run.json', '{}\n');
    await repo.git('add', '.apex-coding-agent/run.json');
    await expectApexErrorAsync(
      () => port.assertStateDirectoryUntracked(repo.root),
      'STATE_DIRECTORY_TRACKED',
    );
  });
});

describe('working tree cleanliness (startup)', () => {
  beforeEach(() => seedRepo(repo));

  it('accepts a clean tree with only SPEC untracked or modified', async () => {
    await port.assertWorkingTreeClean(repo.root, 'SPEC.md');
    await repo.writeFile('SPEC.md', '# Modified\n');
    await port.assertWorkingTreeClean(repo.root, 'SPEC.md');
    await repo.git('checkout', '--', 'SPEC.md');
    await repo.git('rm', '--cached', 'SPEC.md', '--quiet');
    await port.assertWorkingTreeClean(repo.root, 'SPEC.md');
  });

  it('rejects untracked, modified or staged changes elsewhere', async () => {
    await repo.writeFile('notes.txt', 'hello\n');
    await expectApexErrorAsync(
      () => port.assertWorkingTreeClean(repo.root, 'SPEC.md'),
      'WORKING_TREE_DIRTY',
    );
    await repo.git('add', 'notes.txt');
    await expectApexErrorAsync(
      () => port.assertWorkingTreeClean(repo.root, 'SPEC.md'),
      'WORKING_TREE_DIRTY',
    );
    await repo.git('commit', '--message', 'track notes');
    await repo.writeFile('notes.txt', 'changed\n');
    await expectApexErrorAsync(
      () => port.assertWorkingTreeClean(repo.root, 'SPEC.md'),
      'WORKING_TREE_DIRTY',
    );
  });
});

describe('session start/end invariants', () => {
  it('passes a clean session round trip', async () => {
    const facts = await seedWithRunBranch();
    const start = await port.assertSessionStart(repo.root, facts);
    expect(start.head).toBe(facts.expectedHead);
    expect(start.planningSnapshot).toBeNull();
    await port.assertSessionEnd(repo.root, facts, start);
  });

  it('fails with GIT_FACT_CONFLICT when the Run Branch was switched away', async () => {
    const facts = await seedWithRunBranch();
    await repo.git('switch', 'main');
    await expectApexErrorAsync(
      () => port.assertSessionStart(repo.root, facts),
      'GIT_FACT_CONFLICT',
    );
  });

  it('fails with GIT_FACT_CONFLICT when HEAD no longer equals expectedHead', async () => {
    const facts = await seedWithRunBranch();
    await repo.writeFile('src/other.ts', 'export const other = 2;\n');
    await repo.commitAll('external commit');
    await expectApexErrorAsync(
      () => port.assertSessionStart(repo.root, facts),
      'GIT_FACT_CONFLICT',
    );
  });

  it('fails with GIT_HISTORY_DIVERGED when the Base Branch ref moved or vanished', async () => {
    const facts = await seedWithRunBranch();
    await repo.writeFile('src/other.ts', 'export const other = 2;\n');
    const moved = await repo.commitAll('advance base');
    await repo.git('update-ref', 'refs/heads/main', moved);
    // HEAD moved along, so use the fresh HEAD as expectedHead to isolate the Base check.
    const isolated = mkFacts(
      { baseCommit: facts.baseCommit, expectedHead: moved },
      { runBranch: facts.runBranch },
    );
    await expectApexErrorAsync(
      () => port.assertSessionStart(repo.root, isolated),
      'GIT_HISTORY_DIVERGED',
    );
    await repo.git('update-ref', '-d', 'refs/heads/main');
    await expectApexErrorAsync(
      () => port.assertSessionStart(repo.root, isolated),
      'GIT_HISTORY_DIVERGED',
    );
  });

  it('fails with GIT_HISTORY_DIVERGED when a completed checkpoint is unreachable', async () => {
    const facts = await seedWithRunBranch();
    // A commit on a divergent line of history stands in for a lost checkpoint.
    await repo.git('switch', '--detach', facts.expectedHead);
    await repo.writeFile('src/lost.ts', 'export const lost = true;\n');
    const lost = await repo.commitAll('lost checkpoint');
    await repo.git('switch', RUN_BRANCH);
    const factsWithCheckpoint = mkFacts(
      { baseCommit: facts.baseCommit, expectedHead: facts.expectedHead },
      { completedCheckpoints: [lost] },
    );
    await expectApexErrorAsync(
      () => port.assertSessionStart(repo.root, factsWithCheckpoint),
      'GIT_HISTORY_DIVERGED',
    );
  });

  it('fails with GIT_FACT_CONFLICT when rewritten history invalidated expectedHead', async () => {
    const facts = await seedWithRunBranch();
    await repo.writeFile('src/work.ts', 'export const work = 1;\n');
    const checkpoint = await repo.commitAll('checkpoint that will be dropped');
    // run.json would now record expectedHead = checkpoint; an external actor
    // rewrites the Run Branch back to the previous HEAD.
    await repo.git('reset', '--hard', facts.expectedHead);
    const stale = mkFacts({ baseCommit: facts.baseCommit, expectedHead: checkpoint });
    await expectApexErrorAsync(
      () => port.assertSessionStart(repo.root, stale),
      'GIT_FACT_CONFLICT',
    );
  });

  it('fails with GIT_HISTORY_DIVERGED when HEAD rewinds during a session', async () => {
    const initialFacts = await seedWithRunBranch();
    await repo.writeFile('src/session-base.ts', 'export const sessionBase = true;\n');
    const sessionHead = await repo.commitAll('session start checkpoint');
    const facts = mkFacts({
      baseCommit: initialFacts.baseCommit,
      expectedHead: sessionHead,
    });
    const start = await port.assertSessionStart(repo.root, facts);

    /**
     * HEAD 回退后 `start..HEAD` 会是空集合，但这不是“会话没有新增提交”。
     * 会话结束检查必须先证明 start 仍为 HEAD 的祖先。
     */
    await repo.git('reset', '--hard', `${sessionHead}^`);
    await expectApexErrorAsync(
      () => port.assertSessionEnd(repo.root, facts, start),
      'GIT_HISTORY_DIVERGED',
    );
  });

  it('fails with PROTECTED_PATH_CHANGED when SPEC becomes staged mid-run', async () => {
    const facts = await seedWithRunBranch();
    const start = await port.assertSessionStart(repo.root, facts);
    await repo.writeFile('SPEC.md', '# Staged by someone\n');
    await repo.git('add', 'SPEC.md');
    await expectApexErrorAsync(
      () => port.assertSessionEnd(repo.root, facts, start),
      'PROTECTED_PATH_CHANGED',
    );
  });

  it('fails with PROTECTED_PATH_CHANGED when the state directory becomes tracked', async () => {
    const facts = await seedWithRunBranch();
    const start = await port.assertSessionStart(repo.root, facts);
    await repo.writeFile('.apex-coding-agent/run.json', '{}\n');
    await repo.git('add', '--force', '.apex-coding-agent/run.json');
    await expectApexErrorAsync(
      () => port.assertSessionEnd(repo.root, facts, start),
      'PROTECTED_PATH_CHANGED',
    );
  });

  it('fails with PROTECTED_PATH_CHANGED when a session commit contains SPEC', async () => {
    const facts = await seedWithRunBranch();
    const start = await port.assertSessionStart(repo.root, facts);
    await repo.writeFile('SPEC.md', '# Committed by claude\n');
    await repo.git('add', 'SPEC.md');
    await repo.git('commit', '--message', 'claude touches SPEC');
    await expectApexErrorAsync(
      () => port.assertSessionEnd(repo.root, facts, start),
      'PROTECTED_PATH_CHANGED',
    );
  });

  it('fails with PROTECTED_PATH_CHANGED when a session commit contains the state directory', async () => {
    const facts = await seedWithRunBranch();
    const start = await port.assertSessionStart(repo.root, facts);
    await repo.writeFile('.apex-coding-agent/run.json', '{}\n');
    await repo.git('add', '--force', '.apex-coding-agent/run.json');
    await repo.git('commit', '--message', 'claude touches state dir');
    await expectApexErrorAsync(
      () => port.assertSessionEnd(repo.root, facts, start),
      'PROTECTED_PATH_CHANGED',
    );
  });

  it('allows session commits that only touch project files', async () => {
    const facts = await seedWithRunBranch();
    const start = await port.assertSessionStart(repo.root, facts);
    await repo.writeFile('src/feature.ts', 'export const feature = 1;\n');
    await repo.commitAll('claude: add feature');
    await port.assertSessionEnd(repo.root, facts, start);
  });
});

describe('planning side-effect detection', () => {
  let facts: ReturnType<typeof mkFacts>;
  let start: SessionStartFact;

  beforeEach(async () => {
    facts = await seedWithRunBranch();
    start = await port.assertSessionStart(repo.root, facts, { planning: true });
    expect(start.planningSnapshot).not.toBeNull();
  });

  it('passes when nothing changed', async () => {
    await port.assertSessionEnd(repo.root, facts, start);
  });

  it('allows SPEC modification and state-directory writes', async () => {
    await repo.writeFile('SPEC.md', '# User refined the spec\n');
    await repo.writeFile('.apex-coding-agent/run.json', '{}\n');
    await port.assertSessionEnd(repo.root, facts, start);
  });

  it('detects a modified tracked file', async () => {
    await repo.writeFile('src/index.ts', 'export const value = 2;\n');
    await expectApexErrorAsync(
      () => port.assertSessionEnd(repo.root, facts, start),
      'PLANNING_SIDE_EFFECT_DETECTED',
    );
  });

  it('detects a staged (index) change', async () => {
    await repo.writeFile('src/index.ts', 'export const value = 2;\n');
    await repo.git('add', 'src/index.ts');
    await expectApexErrorAsync(
      () => port.assertSessionEnd(repo.root, facts, start),
      'PLANNING_SIDE_EFFECT_DETECTED',
    );
  });

  it('detects a new untracked file', async () => {
    await writeFile(join(repo.root, 'stray.txt'), 'oops\n');
    await expectApexErrorAsync(
      () => port.assertSessionEnd(repo.root, facts, start),
      'PLANNING_SIDE_EFFECT_DETECTED',
    );
  });

  it('detects a moved HEAD (commit during planning)', async () => {
    await repo.writeFile('src/index.ts', 'export const value = 2;\n');
    await repo.commitAll('planning commit');
    await expectApexErrorAsync(
      () => port.assertSessionEnd(repo.root, facts, start),
      'PLANNING_SIDE_EFFECT_DETECTED',
    );
  });
});
