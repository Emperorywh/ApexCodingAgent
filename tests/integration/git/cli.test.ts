/**
 * Git CLI process wrapper behavior: spawn failures map to
 * `GIT_COMMAND_FAILED` (and to `GIT_UNAVAILABLE` at the availability gate),
 * stderr is captured through the redaction hook, and argument-array spawning
 * never involves a shell.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGitAdapter } from '../../../src/adapters/git/adapter.js';
import { createGitRunner } from '../../../src/adapters/git/cli.js';
import type { ProcessExecutor } from '../../../src/adapters/process/process-executor.js';
import {
  createTempRepo,
  expectApexErrorAsync,
  redactGitText,
  seedRepo,
  type TempRepo,
} from './helpers.js';
import { createTestProcessExecutor } from '../../process-executor.js';

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
    const runner = createGitRunner({
      processExecutor: createTestProcessExecutor(),
      gitPath: 'git-apex-g3-does-not-exist',
      redact: redactGitText,
    });
    const error = await expectApexErrorAsync(
      () => runner.run(['--version'], repo.root),
      'GIT_COMMAND_FAILED',
    );
    expect(error.message).toContain('git-apex-g3-does-not-exist');
  });

  it('maps a missing git executable to GIT_UNAVAILABLE at the startup gate', async () => {
    const port = createGitAdapter({
      processExecutor: createTestProcessExecutor(),
      gitPath: 'git-apex-g3-does-not-exist',
      redact: redactGitText,
    });
    await expectApexErrorAsync(() => port.assertAvailable(), 'GIT_UNAVAILABLE');
  });
});

describe('stderr capture and redaction', () => {
  it('carries redacted stderr in the error tool summary', async () => {
    /*
     * 用确定性进程事实注入合成凭据，验证真实 Redactor 在 Git 错误离开
     * Adapter 前生效，而不是只证明某个测试用 MASKED 回调被调用。
     */
    const secret = 'sk-proj-abcdefghijklmnop';
    const processExecutor: ProcessExecutor = {
      execute: async () => ({
        kind: 'exited',
        code: 1,
        stdout: '',
        stderr: `fatal: authentication failed for ${secret}`,
        streamFailed: false,
      }),
    };
    const runner = createGitRunner({
      processExecutor,
      redact: redactGitText,
    });
    const error = await expectApexErrorAsync(
      () => runner.run(['rev-parse', '--verify', 'refs/heads/does-not-exist'], repo.root),
      'GIT_COMMAND_FAILED',
    );
    expect(error.toolSummary).toBe('fatal: authentication failed for [REDACTED]');
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it('preserves non-sensitive stderr after the mandatory redaction boundary', async () => {
    const runner = createGitRunner({
      processExecutor: createTestProcessExecutor(),
      redact: redactGitText,
    });
    const error = await expectApexErrorAsync(
      () => runner.run(['rev-parse', '--verify', 'refs/heads/does-not-exist'], repo.root),
      'GIT_COMMAND_FAILED',
    );
    /*
     * 真实 Redactor 对普通 fatal 诊断保持可分析性；接口本身不再允许省略
     * 脱敏函数，因此不存在生产 identity 回退分支。
     */
    expect(error.toolSummary).toMatch(/^fatal:/);
  });
});

describe('runAllowFailure', () => {
  it('resolves with the exit code instead of throwing', async () => {
    const runner = createGitRunner({
      processExecutor: createTestProcessExecutor(),
      redact: redactGitText,
    });
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
