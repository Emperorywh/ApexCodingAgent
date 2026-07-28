/**
 * Git CLI process wrapper behavior: spawn failures map to
 * `GIT_COMMAND_FAILED` (and to `GIT_UNAVAILABLE` at the availability gate),
 * stderr is captured through the redaction hook, and argument-array spawning
 * never involves a shell.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGitAdapter } from '../../../src/adapters/git/adapter.js';
import { createGitRunner } from '../../../src/adapters/git/cli.js';
import {
  createTempRepo,
  expectApexErrorAsync,
  seedRepo,
  type TempRepo,
} from './helpers.js';

let repo: TempRepo;

beforeEach(async () => {
  repo = await createTempRepo();
  await seedRepo(repo);
});

afterEach(async () => {
  await repo.cleanup();
});

describe('spawn failures', () => {
  it('maps a missing git executable to GIT_COMMAND_FAILED', async () => {
    const runner = createGitRunner({ gitPath: 'git-apex-g3-does-not-exist' });
    const error = await expectApexErrorAsync(
      () => runner.run(['--version'], repo.root),
      'GIT_COMMAND_FAILED',
    );
    expect(error.message).toContain('git-apex-g3-does-not-exist');
  });

  it('maps a missing git executable to GIT_UNAVAILABLE at the startup gate', async () => {
    const port = createGitAdapter({ gitPath: 'git-apex-g3-does-not-exist' });
    await expectApexErrorAsync(() => port.assertAvailable(), 'GIT_UNAVAILABLE');
  });
});

describe('stderr capture and redaction', () => {
  it('carries redacted stderr in the error tool summary', async () => {
    const runner = createGitRunner({ redact: () => 'MASKED' });
    const error = await expectApexErrorAsync(
      () => runner.run(['rev-parse', '--verify', 'refs/heads/does-not-exist'], repo.root),
      'GIT_COMMAND_FAILED',
    );
    expect(error.toolSummary).toBe('MASKED');
  });

  it('reports raw stderr when no redaction hook is configured', async () => {
    const runner = createGitRunner();
    const error = await expectApexErrorAsync(
      () => runner.run(['rev-parse', '--verify', 'refs/heads/does-not-exist'], repo.root),
      'GIT_COMMAND_FAILED',
    );
    // The wording is git-version dependent; stderr must arrive unredacted.
    expect(error.toolSummary).toMatch(/^fatal:/);
  });
});

describe('runAllowFailure', () => {
  it('resolves with the exit code instead of throwing', async () => {
    const runner = createGitRunner();
    const result = await runner.runAllowFailure(
      ['merge-base', '--is-ancestor', 'HEAD', 'HEAD'],
      repo.root,
    );
    expect(result.code).toBe(0);
    const failed = await runner.runAllowFailure(
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      repo.root,
    );
    expect(failed.code).toBe(0); // attached to main
    await repo.git('checkout', '--detach', 'HEAD');
    const detached = await runner.runAllowFailure(
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      repo.root,
    );
    expect(detached.code).toBe(1);
  });
});
