/**
 * Repository-level startup facts and Run Branch creation (SPEC §8.1 items
 * 6–8, §8.3). All failures here use `startup_validation` codes: the git
 * executable missing → `GIT_UNAVAILABLE`; outside a non-bare worktree →
 * `GIT_WORKTREE_REQUIRED`; no HEAD commit → `GIT_HEAD_REQUIRED`; detached
 * HEAD (no local branch to serve as Base Branch) → `BASE_BRANCH_REQUIRED`.
 * Run Branch creation after a Run exists maps to `GIT_COMMAND_FAILED`
 * (SPEC §8.2: failures from step 5 onward fail the Run).
 */
import { ApexError } from '../../domain/errors.js';
import type { GitHeadFact } from '../../application/ports/GitPort.js';
import { RUN_BRANCH_PREFIX } from '../../domain/ids.js';
import type { GitRunner } from './cli.js';

const GIT_STAGE = 'git';

/** SPEC §8.1 item 6: `git --version` must succeed. */
export async function assertGitAvailable(git: GitRunner, cwd: string): Promise<void> {
  try {
    await git.run(['--version'], cwd);
  } catch (error) {
    throw new ApexError({
      code: 'GIT_UNAVAILABLE',
      stage: GIT_STAGE,
      message: 'git executable is not available (git --version failed)',
      cause: error,
    });
  }
}

/** SPEC §8.1 item 7: absolute top level of the (non-bare) worktree of `cwd`. */
export async function resolveRepositoryRoot(git: GitRunner, cwd: string): Promise<string> {
  const result = await git.runAllowFailure(['rev-parse', '--show-toplevel'], cwd);
  if (result.code !== 0) {
    throw new ApexError({
      code: 'GIT_WORKTREE_REQUIRED',
      stage: GIT_STAGE,
      message: 'current directory is not inside a non-bare Git worktree',
      toolSummary: git.redact(result.stderr.trim()).slice(0, 500),
    });
  }
  return result.stdout.trim();
}

/** SPEC §8.1 items 7–8: HEAD must exist and be attached to a local branch. */
export async function readHeadFact(git: GitRunner, root: string): Promise<GitHeadFact> {
  const head = await git.runAllowFailure(['rev-parse', '--verify', 'HEAD'], root);
  if (head.code !== 0) {
    throw new ApexError({
      code: 'GIT_HEAD_REQUIRED',
      stage: GIT_STAGE,
      message: 'git HEAD does not exist (the repository has no commits)',
    });
  }
  const branch = await git.runAllowFailure(['symbolic-ref', '--quiet', '--short', 'HEAD'], root);
  if (branch.code !== 0) {
    throw new ApexError({
      code: 'BASE_BRANCH_REQUIRED',
      stage: GIT_STAGE,
      message: 'HEAD is detached; attach it to a local branch that serves as the Base Branch',
    });
  }
  return { oid: head.stdout.trim(), branch: branch.stdout.trim() };
}

/** SPEC §8.3: create `apex-coding-agent/<runId>` from current HEAD and switch to it. */
export async function createRunBranch(
  git: GitRunner,
  root: string,
  runId: string,
): Promise<string> {
  const branch = `${RUN_BRANCH_PREFIX}${runId}`;
  await git.run(['switch', '--create', branch], root);
  return branch;
}
