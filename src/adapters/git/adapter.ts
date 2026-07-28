/**
 * Git CLI adapter: binds the low-level `git` runner and the focused modules
 * (`repository`, `spec-discovery`, `exclude`, `invariants`, `checkpoint`)
 * into the Application-owned {@link GitPort}.
 */
import type { GitPort } from '../../application/ports/GitPort.js';
import { createGitRunner, type GitRunnerOptions } from './cli.js';
import {
  assertGitAvailable,
  createRunBranch,
  readHeadFact,
  resolveRepositoryRoot,
} from './repository.js';
import { readSpecFact, resolveSpecFact, isSpecStaged } from './spec-discovery.js';
import { ensureStateDirectoryExcluded } from './exclude.js';
import {
  assertSessionEndFacts,
  assertSessionStartFacts,
  assertStateDirectoryUntrackedAtStartup,
  assertWorkingTreeClean,
} from './invariants.js';
import {
  createFinalReviewCheckpoint,
  createIntermediateCheckpoint,
  createTaskCheckpoint,
} from './checkpoint.js';
import { ApexError } from '../../domain/errors.js';

export type GitAdapterOptions = GitRunnerOptions;

export function createGitAdapter(options: GitAdapterOptions = {}): GitPort {
  const git = createGitRunner(options);
  return {
    assertAvailable: () => assertGitAvailable(git, process.cwd()),
    resolveRepositoryRoot: (cwd) => resolveRepositoryRoot(git, cwd),
    readHead: (root) => readHeadFact(git, root),
    assertStateDirectoryUntracked: (root) =>
      assertStateDirectoryUntrackedAtStartup(git, root),
    assertWorkingTreeClean: (root, specGitPath) =>
      assertWorkingTreeClean(git, root, specGitPath),
    resolveSpec: (root, cwd, explicitPath) => resolveSpecFact(git, root, cwd, explicitPath),
    readSpecFact: (root, gitPath) => readSpecFact(git, root, gitPath),
    assertSpecNotStaged: async (root, specGitPath) => {
      if (await isSpecStaged(git, root, specGitPath)) {
        throw new ApexError({
          code: 'SPEC_STAGED',
          stage: 'spec-discovery',
          message: `SPEC file has staged changes: ${specGitPath}`,
        });
      }
    },
    ensureStateDirectoryExcluded: (root) => ensureStateDirectoryExcluded(git, root),
    createRunBranch: (root, runId) => createRunBranch(git, root, runId),
    assertSessionStart: (root, facts, options) =>
      assertSessionStartFacts(git, root, facts, options?.planning === true),
    assertSessionEnd: (root, facts, start) => assertSessionEndFacts(git, root, facts, start),
    createTaskCheckpoint: (root, input) => createTaskCheckpoint(git, root, input),
    createIntermediateCheckpoint: (root, input) => createIntermediateCheckpoint(git, root, input),
    createFinalReviewCheckpoint: (root, input) => createFinalReviewCheckpoint(git, root, input),
  };
}
