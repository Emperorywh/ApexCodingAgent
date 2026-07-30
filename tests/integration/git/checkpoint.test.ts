/**
 * Checkpoint creation (SPEC §12.2–§12.4; test matrix §22.2: preserved Claude
 * commits, Coordinator commits unaffected by repository hooks or signing
 * config, protected-path exclusion, no-change bookkeeping). Real temporary
 * repositories with a created Run Branch.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGitAdapter } from '../../../src/adapters/git/adapter.js';
import type {
  GitPort,
  SessionGitFacts,
  SessionStartFact,
} from '../../../src/application/ports/GitPort.js';
import {
  RUN_BRANCH,
  RUN_ID,
  SESSION_ID,
  createTempRepo,
  mkFacts,
  redactGitText,
  seedRepo,
  type TempRepo,
} from './helpers.js';
import { createTestProcessExecutor } from '../../process-executor.js';

let repo: TempRepo;
let port: GitPort;
let facts: SessionGitFacts;
let start: SessionStartFact;

beforeEach(async () => {
  repo = await createTempRepo();
  port = createGitAdapter({
    processExecutor: createTestProcessExecutor(),
    redact: redactGitText,
  });
  const baseCommit = await seedRepo(repo);
  await port.createRunBranch(repo.root, RUN_ID);
  facts = mkFacts({ baseCommit, expectedHead: await repo.head() });
  start = await port.assertSessionStart(repo.root, facts);
});

afterEach(async () => {
  await repo.cleanup();
});

const logMessage = (): Promise<string> => repo.git('log', '-1', '--format=%B');
const committedPaths = (): Promise<string> =>
  repo.git('show', '--name-only', '--format=', 'HEAD');

const taskInput = () => ({
  facts,
  sessionStartHead: start.head,
  runId: RUN_ID,
  taskId: 'TASK-001',
  taskTitle: 'Implement feature',
  planRevision: 1,
  sessionId: SESSION_ID,
});

describe('task checkpoint (§12.2)', () => {
  /**
   * 该用例连续执行真实 Git 提交、祖先校验和 Trailer 读取。
   *
   * Windows 全量并发套件会与其他临时仓库测试竞争进程和文件系统资源，
   * 因此使用集成测试级预算，避免 Vitest 默认 5 秒制造假失败。
   */
  it('preserves Claude commits and commits only the remaining changes', async () => {
    // Claude's own commit during the session.
    await repo.writeFile('src/feature.ts', 'export const feature = 1;\n');
    await repo.git('add', 'src/feature.ts');
    await repo.git('commit', '--message', 'claude: add feature');
    const claudeOid = await repo.head();
    // Remaining uncommitted work (tracked modification + untracked file).
    await repo.writeFile('src/index.ts', 'export const value = 2;\n');
    await repo.writeFile('notes.txt', 'scratch\n');

    const outcome = await port.createTaskCheckpoint(repo.root, taskInput());

    expect(outcome.claudeCommits).toEqual([claudeOid]);
    expect(outcome.coordinatorCommit).not.toBeNull();
    expect(outcome.finalOid).toBe(outcome.coordinatorCommit);
    expect(outcome.finalOid).toBe(await repo.head());
    expect(outcome.noChanges).toBe(false);
    expect(outcome.reason).toBe('committed_remaining_changes');

    // Claude's commit stays reachable; the Coordinator commit holds the rest.
    expect((await repo.gitRaw('merge-base', '--is-ancestor', claudeOid, 'HEAD')).code).toBe(0);
    const paths = await committedPaths();
    expect(paths).toContain('src/index.ts');
    expect(paths).toContain('notes.txt');
    expect(paths).not.toContain('src/feature.ts');

    const message = await logMessage();
    expect(message).toContain('apex-coding-agent(TASK-001): Implement feature');
    expect(message).toContain(`ApexCodingAgent-Run: ${RUN_ID}`);
    expect(message).toContain('ApexCodingAgent-Task: TASK-001');
    expect(message).toContain('ApexCodingAgent-Plan-Revision: 1');
    expect(message).toContain(`ApexCodingAgent-Session: ${SESSION_ID}`);
  }, 30_000);

  it('succeeds despite failing repository hooks and enforced GPG signing', async () => {
    const hooksDir = join(repo.root, 'hooks');
    await mkdir(hooksDir, { recursive: true });
    await writeFile(join(hooksDir, 'pre-commit'), '#!/bin/sh\nexit 1\n');
    await writeFile(join(hooksDir, 'commit-msg'), '#!/bin/sh\nexit 1\n');
    await repo.git('config', 'core.hooksPath', hooksDir);
    await repo.git('config', 'commit.gpgsign', 'true');

    // Sanity: a plain commit is blocked by the hook (and would require GPG).
    await repo.writeFile('src/index.ts', 'export const value = 2;\n');
    expect((await repo.gitRaw('commit', '--all', '--message', 'blocked')).code).not.toBe(0);

    const outcome = await port.createTaskCheckpoint(repo.root, taskInput());
    expect(outcome.coordinatorCommit).not.toBeNull();
    expect(await repo.head()).toBe(outcome.coordinatorCommit);
  });

  it('never commits SPEC or the state directory', async () => {
    // No info/exclude entry on purpose: the pathspec exclusion alone must hold.
    await repo.writeFile('SPEC.md', '# Changed during execution\n');
    await repo.writeFile('.apex-coding-agent/run.json', '{}\n');
    await repo.writeFile('src/index.ts', 'export const value = 2;\n');

    const outcome = await port.createTaskCheckpoint(repo.root, taskInput());
    expect(outcome.coordinatorCommit).not.toBeNull();

    expect((await committedPaths()).trim()).toBe('src/index.ts');
    const status = (
      await repo.gitRaw('status', '--porcelain', '--untracked-files=all')
    ).stdout;
    expect(status).toContain(' M SPEC.md');
    expect(status).toContain('?? .apex-coding-agent/');
  });

  it('精确排除路径段含方括号的 SPEC', async () => {
    /**
     * Windows 允许目录名包含 `[`/`]`，但 Git pathspec 会把它们解释为
     * 字符类。本用例保证适配器转义完整路径，而不是把权威 SPEC 意外加入
     * Coordinator Checkpoint。
     */
    const specialFacts = { ...facts, specGitPath: 'docs/[x]/SPEC.md' };
    const specialStart = await port.assertSessionStart(repo.root, specialFacts);
    await repo.writeFile('docs/[x]/SPEC.md', '# Changed during execution\n');
    await repo.writeFile('src/index.ts', 'export const value = 2;\n');

    const outcome = await port.createTaskCheckpoint(repo.root, {
      ...taskInput(),
      facts: specialFacts,
      sessionStartHead: specialStart.head,
    });

    expect(outcome.coordinatorCommit).not.toBeNull();
    expect((await committedPaths()).trim()).toBe('src/index.ts');
    const status = (
      await repo.gitRaw('status', '--porcelain', '--untracked-files=all')
    ).stdout;
    expect(status).toContain('?? docs/[x]/SPEC.md');
  });

  it('records the reason instead of creating an empty commit when nothing changed', async () => {
    const outcome = await port.createTaskCheckpoint(repo.root, taskInput());
    expect(outcome.noChanges).toBe(true);
    expect(outcome.reason).toBe('no_changes');
    expect(outcome.coordinatorCommit).toBeNull();
    expect(outcome.claudeCommits).toEqual([]);
    expect(outcome.finalOid).toBe(start.head);
    expect(await repo.head()).toBe(start.head);
  });

  it('keeps Claude commits as the final checkpoint when nothing remains', async () => {
    await repo.writeFile('src/feature.ts', 'export const feature = 1;\n');
    await repo.git('add', 'src/feature.ts');
    await repo.git('commit', '--message', 'claude: complete feature');
    const claudeOid = await repo.head();

    const outcome = await port.createTaskCheckpoint(repo.root, taskInput());
    expect(outcome.reason).toBe('claude_commits_only');
    expect(outcome.coordinatorCommit).toBeNull();
    expect(outcome.finalOid).toBe(claudeOid);
    expect(outcome.noChanges).toBe(false);
  });
});

describe('intermediate checkpoint (§12.3)', () => {
  it('commits remaining changes with the task intermediate message and trailers', async () => {
    await repo.writeFile('src/index.ts', 'export const value = 2;\n');
    const outcome = await port.createIntermediateCheckpoint(repo.root, {
      facts,
      sessionStartHead: start.head,
      runId: RUN_ID,
      planRevision: 1,
      sessionId: SESSION_ID,
      source: { kind: 'task', taskId: 'TASK-001' },
    });
    expect(outcome.noChanges).toBe(false);
    expect(outcome.coordinatorCommit).not.toBeNull();
    const message = await logMessage();
    expect(message).toContain('apex-coding-agent(TASK-001): preserve intermediate work');
    expect(message).toContain('ApexCodingAgent-Task: TASK-001');
    expect(message).toContain(`ApexCodingAgent-Run: ${RUN_ID}`);
  });

  it('uses the final-review message and omits the Task trailer for review sources', async () => {
    await repo.writeFile('src/index.ts', 'export const value = 2;\n');
    const outcome = await port.createIntermediateCheckpoint(repo.root, {
      facts,
      sessionStartHead: start.head,
      runId: RUN_ID,
      planRevision: 2,
      sessionId: SESSION_ID,
      source: { kind: 'final-review' },
    });
    expect(outcome.coordinatorCommit).not.toBeNull();
    const message = await logMessage();
    expect(message).toContain('apex-coding-agent(final-review): preserve intermediate work');
    expect(message).not.toContain('ApexCodingAgent-Task');
    expect(message).toContain(`ApexCodingAgent-Run: ${RUN_ID}`);
    expect(message).toContain('ApexCodingAgent-Plan-Revision: 2');
    expect(message).toContain(`ApexCodingAgent-Session: ${SESSION_ID}`);
  });

  it('records no_intermediate_changes without creating a commit', async () => {
    const outcome = await port.createIntermediateCheckpoint(repo.root, {
      facts,
      sessionStartHead: start.head,
      runId: RUN_ID,
      planRevision: 1,
      sessionId: SESSION_ID,
      source: { kind: 'task', taskId: 'TASK-001' },
    });
    expect(outcome.noChanges).toBe(true);
    expect(outcome.reason).toBe('no_intermediate_changes');
    expect(outcome.coordinatorCommit).toBeNull();
    expect(outcome.finalOid).toBe(start.head);
    expect(await repo.head()).toBe(start.head);
  });
});

describe('final review checkpoint (§12.4)', () => {
  const reviewInput = () => ({
    facts,
    sessionStartHead: start.head,
    runId: RUN_ID,
    planRevision: 1,
    sessionId: SESSION_ID,
  });

  it('commits remaining changes with the finalize message and no Task trailer', async () => {
    await repo.writeFile('src/index.ts', 'export const value = 3;\n');
    const outcome = await port.createFinalReviewCheckpoint(repo.root, reviewInput());
    expect(outcome.coordinatorCommit).not.toBeNull();
    const message = await logMessage();
    expect(message).toContain(`apex-coding-agent(final-review): finalize ${RUN_ID}`);
    expect(message).not.toContain('ApexCodingAgent-Task');
    expect(message).toContain(`ApexCodingAgent-Run: ${RUN_ID}`);
  });

  it('falls back to the review-start HEAD when nothing changed', async () => {
    const outcome = await port.createFinalReviewCheckpoint(repo.root, reviewInput());
    expect(outcome.noChanges).toBe(true);
    expect(outcome.coordinatorCommit).toBeNull();
    expect(outcome.finalOid).toBe(start.head);
  });
});

describe('run branch', () => {
  it('creates and switches to apex-coding-agent/<run-id> from the current HEAD', async () => {
    // The beforeEach already created it; assert the observable facts.
    expect(await repo.git('symbolic-ref', '--short', 'HEAD')).toBe(RUN_BRANCH);
    expect(await repo.git('rev-parse', 'HEAD')).toBe(facts.expectedHead);
    expect(await repo.git('rev-parse', RUN_BRANCH)).toBe(facts.expectedHead);
  });
});
