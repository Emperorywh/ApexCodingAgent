/**
 * Git invariants (SPEC §8.1 items 9/11, §8.3 session facts, §12.5).
 *
 * Every check is read-only. Failure mapping (SPEC §15.3 git_error row):
 * - HEAD not attached to the Run Branch / session-start HEAD mismatch →
 *   `GIT_FACT_CONFLICT`;
 * - Base Branch ref moved or deleted, completed checkpoints unreachable →
 *   `GIT_HISTORY_DIVERGED`;
 * - session commits containing SPEC or `.apex-coding-agent/`, staged SPEC or
 *   newly tracked state paths mid-run → `PROTECTED_PATH_CHANGED`;
 * - Planning Session side effects (HEAD, index, tracked worktree or
 *   untracked file set) → `PLANNING_SIDE_EFFECT_DETECTED`.
 *
 * On any failure the Run goes to `failed`; nothing here resets, rebases,
 * stashes, merges, cleans or switches branches (SPEC §12.5/§12.6).
 */
import { ApexError } from '../../domain/errors.js';
import type {
  PlanningSnapshot,
  ResumePositionFact,
  SessionGitFacts,
  SessionStartFact,
} from '../../application/ports/GitPort.js';
import { gitCommandFailed, type GitRunner } from './cli.js';
import { isSpecStaged } from './spec-discovery.js';

const GIT_STAGE = 'git';
const STATE_DIR_PREFIX = '.apex-coding-agent/';
const MESSAGE_SAMPLE_LIMIT = 5;

function gitFactConflict(message: string): ApexError {
  return new ApexError({ code: 'GIT_FACT_CONFLICT', stage: GIT_STAGE, message });
}

function gitHistoryDiverged(message: string): ApexError {
  return new ApexError({ code: 'GIT_HISTORY_DIVERGED', stage: GIT_STAGE, message });
}

function protectedPathChanged(message: string): ApexError {
  return new ApexError({ code: 'PROTECTED_PATH_CHANGED', stage: GIT_STAGE, message });
}

// ---------------------------------------------------------------------------
// Working-tree status (porcelain v1, NUL-separated)

export interface StatusEntry {
  /** Raw entry as emitted by porcelain (`XY path`, rename pair joined by NUL). */
  readonly raw: string;
  /** All paths the entry touches (rename/copy carries source and target). */
  readonly paths: readonly string[];
}

function parsePorcelain(raw: string): StatusEntry[] {
  const fields = raw.split('\0');
  const entries: StatusEntry[] = [];
  let index = 0;
  while (index < fields.length) {
    const field = fields[index]!;
    index += 1;
    if (field.length === 0) continue;
    const xy = field.slice(0, 2);
    const paths: string[] = [field.slice(3)];
    let rawEntry = field;
    if (xy.includes('R') || xy.includes('C')) {
      const origin = fields[index];
      if (origin !== undefined && origin.length > 0) {
        paths.push(origin);
        rawEntry = `${field}\0${origin}`;
        index += 1;
      }
    }
    entries.push({ raw: rawEntry, paths });
  }
  return entries;
}

export async function readStatusEntries(git: GitRunner, root: string): Promise<StatusEntry[]> {
  const { stdout } = await git.run(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    root,
  );
  return parsePorcelain(stdout);
}

/** SPEC and the state directory are never Coordinator commit targets. */
function isProtectedEntry(entry: StatusEntry, specGitPath: string): boolean {
  return entry.paths.some(
    (path) => path === specGitPath || path.startsWith(STATE_DIR_PREFIX),
  );
}

/**
 * SPEC §8.1 item 11 (startup): the worktree must be clean except the SPEC
 * file itself (untracked or worktree-modified). Never commits, stashes,
 * resets or deletes user changes — it only reports.
 */
export async function assertWorkingTreeClean(
  git: GitRunner,
  root: string,
  specGitPath: string,
): Promise<void> {
  const dirty = (await readStatusEntries(git, root)).filter(
    (entry) => !isProtectedEntry(entry, specGitPath),
  );
  if (dirty.length === 0) return;
  const sample = dirty
    .slice(0, MESSAGE_SAMPLE_LIMIT)
    .map((entry) => entry.raw.replace('\0', ' -> '))
    .join('; ');
  throw new ApexError({
    code: 'WORKING_TREE_DIRTY',
    stage: GIT_STAGE,
    message: `working tree has changes outside SPEC (${dirty.length} entr${dirty.length === 1 ? 'y' : 'ies'}): ${sample}`,
  });
}

// ---------------------------------------------------------------------------
// State directory tracked checks

async function listTrackedStatePaths(git: GitRunner, root: string): Promise<string[]> {
  const { stdout } = await git.run(['ls-files', '-z', '--', STATE_DIR_PREFIX], root);
  return stdout.split('\0').filter((entry) => entry.length > 0);
}

/** SPEC §8.1 item 9 (startup). */
export async function assertStateDirectoryUntrackedAtStartup(
  git: GitRunner,
  root: string,
): Promise<void> {
  const tracked = await listTrackedStatePaths(git, root);
  if (tracked.length > 0) {
    throw new ApexError({
      code: 'STATE_DIRECTORY_TRACKED',
      stage: GIT_STAGE,
      message: `.apex-coding-agent/ contains Git-tracked path(s): ${tracked.slice(0, MESSAGE_SAMPLE_LIMIT).join(', ')}`,
    });
  }
}

/** Mid-run variant (SPEC §8.3 invariant 5). */
export async function assertStateDirectoryUntrackedInRun(
  git: GitRunner,
  root: string,
): Promise<void> {
  const tracked = await listTrackedStatePaths(git, root);
  if (tracked.length > 0) {
    throw protectedPathChanged(
      `.apex-coding-agent/ became Git-tracked during the run: ${tracked.slice(0, MESSAGE_SAMPLE_LIMIT).join(', ')}`,
    );
  }
}

/** Mid-run variant of the staged-SPEC check (SPEC §8.3 invariant 7). */
export async function assertSpecNotStagedInRun(
  git: GitRunner,
  root: string,
  specGitPath: string,
): Promise<void> {
  if (await isSpecStaged(git, root, specGitPath)) {
    throw protectedPathChanged(`SPEC file ${specGitPath} has staged changes`);
  }
}

// ---------------------------------------------------------------------------
// Branch / history facts

/** HEAD must be attached to the Run Branch; resolves to the HEAD OID. */
export async function assertHeadOnRunBranch(
  git: GitRunner,
  root: string,
  runBranch: string,
): Promise<string> {
  const branch = await git.runAllowFailure(['symbolic-ref', '--quiet', '--short', 'HEAD'], root);
  if (branch.code !== 0) {
    throw gitFactConflict(`HEAD is detached; expected it attached to run branch ${runBranch}`);
  }
  const attached = branch.stdout.trim();
  if (attached !== runBranch) {
    throw gitFactConflict(`HEAD is attached to ${attached}, expected run branch ${runBranch}`);
  }
  const { stdout } = await git.run(['rev-parse', 'HEAD'], root);
  return stdout.trim();
}

/** Base Branch ref must keep pointing exactly at the recorded base commit. */
export async function assertBaseRefPinned(
  git: GitRunner,
  root: string,
  baseBranchRef: string,
  baseCommit: string,
): Promise<void> {
  const resolved = await git.runAllowFailure(['rev-parse', '--verify', baseBranchRef], root);
  if (resolved.code !== 0) {
    throw gitHistoryDiverged(`base branch ref ${baseBranchRef} no longer resolves`);
  }
  if (resolved.stdout.trim() !== baseCommit) {
    throw gitHistoryDiverged(
      `base branch ref ${baseBranchRef} moved from ${baseCommit} to ${resolved.stdout.trim()}`,
    );
  }
}

/** Every completed-task checkpoint must stay an ancestor of HEAD. */
export async function assertCheckpointsAreAncestors(
  git: GitRunner,
  root: string,
  checkpointOids: readonly string[],
): Promise<void> {
  for (const oid of checkpointOids) {
    const result = await git.runAllowFailure(['merge-base', '--is-ancestor', oid, 'HEAD'], root);
    if (result.code === 0) continue;
    if (result.code === 1) {
      throw gitHistoryDiverged(`completed checkpoint ${oid} is no longer an ancestor of HEAD`);
    }
    throw gitCommandFailed(`git merge-base --is-ancestor ${oid} HEAD failed`, {
      stderr: result.stderr,
      redact: git.redact,
    });
  }
}

// ---------------------------------------------------------------------------
// Session commits and protected paths

/** OIDs of commits added on top of the session-start HEAD, oldest first. */
export async function listSessionCommits(
  git: GitRunner,
  root: string,
  sessionStartHead: string,
): Promise<string[]> {
  const head = (await git.run(['rev-parse', 'HEAD'], root)).stdout.trim();
  if (head === sessionStartHead) return [];
  /**
   * `start..HEAD` 在 HEAD 被 reset 到会话起点之前时会返回空集合，
   * 因而不能单独证明会话历史只向前增长。先验证起点仍是 HEAD 的祖先，
   * 再枚举新增提交，才能把 rewind 与正常的无提交会话区分开。
   */
  const ancestry = await git.runAllowFailure(
    ['merge-base', '--is-ancestor', sessionStartHead, 'HEAD'],
    root,
  );
  if (ancestry.code === 1) {
    throw gitHistoryDiverged(
      `session start HEAD ${sessionStartHead} is no longer an ancestor of HEAD ${head}`,
    );
  }
  if (ancestry.code !== 0) {
    throw gitCommandFailed(
      `git merge-base --is-ancestor ${sessionStartHead} HEAD failed`,
      {
        stderr: ancestry.stderr,
        redact: git.redact,
      },
    );
  }
  const { stdout } = await git.run(['rev-list', '--reverse', `${sessionStartHead}..HEAD`], root);
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Session-added commits must not touch SPEC or `.apex-coding-agent/`. */
export async function assertSessionCommitsClean(
  git: GitRunner,
  root: string,
  commitOids: readonly string[],
  specGitPath: string,
): Promise<void> {
  for (const oid of commitOids) {
    const { stdout } = await git.run(
      ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', oid],
      root,
    );
    const offending = stdout
      .split('\0')
      .filter((entry) => entry.length > 0)
      .filter((path) => path === specGitPath || path.startsWith(STATE_DIR_PREFIX));
    if (offending.length > 0) {
      throw protectedPathChanged(
        `session commit ${oid} contains protected path(s): ${offending.join(', ')}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Planning side-effect detection

/** Snapshot of HEAD plus the filtered status entry set (SPEC §8.3). */
export async function capturePlanningSnapshot(
  git: GitRunner,
  root: string,
  specGitPath: string,
): Promise<PlanningSnapshot> {
  const head = (await git.run(['rev-parse', 'HEAD'], root)).stdout.trim();
  const statusEntries = (await readStatusEntries(git, root))
    .filter((entry) => !isProtectedEntry(entry, specGitPath))
    .map((entry) => entry.raw)
    .sort();
  return { head, statusEntries };
}

/** HEAD, index, tracked worktree and untracked file set must be identical. */
export async function assertPlanningSnapshotUnchanged(
  git: GitRunner,
  root: string,
  snapshot: PlanningSnapshot,
  specGitPath: string,
): Promise<void> {
  const current = await capturePlanningSnapshot(git, root, specGitPath);
  if (current.head !== snapshot.head) {
    throw new ApexError({
      code: 'PLANNING_SIDE_EFFECT_DETECTED',
      stage: GIT_STAGE,
      message: `planning session moved HEAD from ${snapshot.head} to ${current.head}`,
    });
  }
  const before = snapshot.statusEntries;
  const after = current.statusEntries;
  const changed =
    before.length !== after.length || before.some((entry, index) => entry !== after[index]);
  if (changed) {
    const format = (entries: readonly string[]) =>
      entries
        .slice(0, MESSAGE_SAMPLE_LIMIT)
        .map((entry) => entry.replace('\0', ' -> '))
        .join('; ');
    throw new ApexError({
      code: 'PLANNING_SIDE_EFFECT_DETECTED',
      stage: GIT_STAGE,
      message: `planning session changed the worktree/index (before: [${format(before)}]; after: [${format(after)}])`,
    });
  }
}

// ---------------------------------------------------------------------------
// Composed session facts (SPEC §8.3)

/** Pre-session invariants; captures the Planning snapshot when requested. */
export async function assertSessionStartFacts(
  git: GitRunner,
  root: string,
  facts: SessionGitFacts,
  planning: boolean,
): Promise<SessionStartFact> {
  const head = await assertHeadOnRunBranch(git, root, facts.runBranch);
  if (head !== facts.expectedHead) {
    throw gitFactConflict(
      `session start HEAD ${head} does not equal run.json expectedHead ${facts.expectedHead}`,
    );
  }
  await assertBaseRefPinned(git, root, facts.baseBranchRef, facts.baseCommit);
  await assertCheckpointsAreAncestors(git, root, facts.completedCheckpoints);
  await assertStateDirectoryUntrackedInRun(git, root);
  await assertSpecNotStagedInRun(git, root, facts.specGitPath);
  const planningSnapshot = planning
    ? await capturePlanningSnapshot(git, root, facts.specGitPath)
    : null;
  return { head, planningSnapshot };
}

/**
 * 恢复命令的完整 Git 预检。
 *
 * 与普通 Session 启动不同，被中断的可写会话可能已经创建安全提交；该
 * 路径允许 expectedHead..HEAD 的单向后继，同时复用受保护提交检查。
 * 所有校验均为只读，调用方可以在失败时保留原恢复点供用户修复后重试。
 */
export async function assertResumePositionFacts(
  git: GitRunner,
  root: string,
  facts: SessionGitFacts,
  allowAdvancedHead: boolean,
): Promise<ResumePositionFact> {
  const currentHead = await assertHeadOnRunBranch(git, root, facts.runBranch);
  await assertBaseRefPinned(git, root, facts.baseBranchRef, facts.baseCommit);
  await assertCheckpointsAreAncestors(git, root, facts.completedCheckpoints);
  await assertStateDirectoryUntrackedInRun(git, root);
  await assertSpecNotStagedInRun(git, root, facts.specGitPath);

  if (currentHead === facts.expectedHead) {
    return { currentHead, advancedFromExpectedHead: false };
  }
  if (!allowAdvancedHead) {
    throw gitFactConflict(
      `resume HEAD ${currentHead} does not equal run.json expectedHead ${facts.expectedHead}`,
    );
  }

  const inFlightCommits = await listSessionCommits(git, root, facts.expectedHead);
  await assertSessionCommitsClean(git, root, inFlightCommits, facts.specGitPath);
  return { currentHead, advancedFromExpectedHead: true };
}

/** Post-session invariants, including protected paths and Planning side effects. */
export async function assertSessionEndFacts(
  git: GitRunner,
  root: string,
  facts: SessionGitFacts,
  start: SessionStartFact,
): Promise<void> {
  await assertHeadOnRunBranch(git, root, facts.runBranch);
  await assertBaseRefPinned(git, root, facts.baseBranchRef, facts.baseCommit);
  await assertCheckpointsAreAncestors(git, root, facts.completedCheckpoints);
  await assertStateDirectoryUntrackedInRun(git, root);
  await assertSpecNotStagedInRun(git, root, facts.specGitPath);
  const sessionCommits = await listSessionCommits(git, root, start.head);
  await assertSessionCommitsClean(git, root, sessionCommits, facts.specGitPath);
  if (start.planningSnapshot !== null) {
    await assertPlanningSnapshotUnchanged(git, root, start.planningSnapshot, facts.specGitPath);
  }
}
