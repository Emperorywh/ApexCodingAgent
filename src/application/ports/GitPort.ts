/**
 * GitPort (SPEC §5.2 Application Ports). Every Git fact the Coordinator reads
 * and every Git mutation it performs goes through this port. The
 * implementation lives in `src/adapters/git/` and shells out to the `git`
 * executable with argument arrays (SPEC §7.2). Checkpoint publication is the
 * only remote mutation; it never merges, resets, rebases, stashes, cleans or
 * deletes branches (SPEC §12.6).
 *
 * Error mapping (SPEC §15.3): implementations throw `ApexError` with stable
 * codes. Startup-time checks use the `startup_validation` codes
 * (`GIT_UNAVAILABLE`, `GIT_WORKTREE_REQUIRED`, `GIT_HEAD_REQUIRED`,
 * `BASE_BRANCH_REQUIRED`, `WORKING_TREE_DIRTY`, `STATE_DIRECTORY_TRACKED`,
 * `SPEC_*`); any Git failure after a Run exists uses the `git_error` codes
 * (`GIT_COMMAND_FAILED`, `GIT_FACT_CONFLICT`, `GIT_HISTORY_DIVERGED`,
 * `PROTECTED_PATH_CHANGED`, `PLANNING_SIDE_EFFECT_DETECTED`).
 *
 * All paths crossing this boundary are absolute host paths (`root`, `cwd`) or
 * `/`-separated Git-relative paths (`specGitPath`), per SPEC §11.5.
 */

/** HEAD fact: the commit OID plus the attached branch short name. */
export interface GitHeadFact {
  readonly oid: string;
  /** Short branch name when HEAD is attached; `null` when detached. */
  readonly branch: string | null;
}

/**
 * 只读仓库状态（报告用，SPEC §14.4）：HEAD 事实与
 * `git status --porcelain` 原始行集合，不做任何解释或过滤。
 */
export interface RepositoryStatusFact {
  readonly head: GitHeadFact;
  /** `git status --porcelain` 原始行集合（仅过滤空行）。 */
  readonly statusEntries: readonly string[];
}

/**
 * SPEC resolution result (SPEC §3.2). `gitPath` is the authoritative
 * `/`-separated path relative to the repository root; `sha256` is computed
 * over the raw file bytes (BOM included).
 */
export interface SpecFact {
  readonly gitPath: string;
  readonly absolutePath: string;
  readonly sha256: string;
}

/** Run-scoped Git facts copied from `run.json.repository` plus SPEC identity. */
export interface SessionGitFacts {
  readonly runBranch: string;
  readonly baseBranchRef: string;
  readonly baseCommit: string;
  /** `run.json.repository.expectedHead` — the recorded session-start HEAD. */
  readonly expectedHead: string;
  /** Final checkpoint OIDs of all completed tasks (must stay reachable). */
  readonly completedCheckpoints: readonly string[];
  readonly specGitPath: string;
}

/** Planning side-effect snapshot (SPEC §8.3): HEAD plus the filtered
 * `git status --porcelain` entry set (SPEC and `.apex-coding-agent/` exempted). */
export interface PlanningSnapshot {
  readonly head: string;
  readonly statusEntries: readonly string[];
}

/** Facts captured at session start; threaded into {@link GitPort.assertSessionEnd}. */
export interface SessionStartFact {
  readonly head: string;
  /** Non-null only for Planning Sessions. */
  readonly planningSnapshot: PlanningSnapshot | null;
}

/**
 * 恢复前只读校验得到的仓库断点。
 *
 * 当中断发生在可修改仓库的 Session 内时，HEAD 可以是 expectedHead 的
 * 安全后继；调用方必须把 currentHead 写回新的运行断点后才能启动会话。
 */
export interface ResumePositionFact {
  readonly currentHead: string;
  readonly advancedFromExpectedHead: boolean;
}

/** Checkpoint outcome facts; the Application layer persists them (episodes, run.json). */
export interface CheckpointOutcome {
  /** HEAD after the checkpoint flow — the OID recorded as the checkpoint. */
  finalOid: string;
  /** Commits Claude created during the session, oldest first (preserved). */
  readonly claudeCommits: readonly string[];
  /** OID of the Coordinator-created commit, or `null` when none was needed. */
  readonly coordinatorCommit: string | null;
  /** `true` when neither Claude nor the Coordinator changed the repository. */
  readonly noChanges: boolean;
  /**
   * Reason token for the episode `checkpointReason` field:
   * `committed_remaining_changes` / `claude_commits_only` / `no_changes` for
   * final checkpoints; `committed_remaining_changes` / `claude_commits_only`
   * / `no_intermediate_changes` for intermediate ones.
   */
  readonly reason: string;
}

/** 已形成的本地 Checkpoint 发布到固定 Run 远程分支时的完整输入。 */
export interface PublishRunBranchInput {
  readonly remote: string;
  readonly runBranch: string;
  readonly checkpointOid: string;
}

/** SPEC §12.2 input. `facts.expectedHead` equals `sessionStartHead`. */
export interface TaskCheckpointInput {
  readonly facts: SessionGitFacts;
  readonly sessionStartHead: string;
  readonly runId: string;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly planRevision: number;
  readonly sessionId: string;
}

/** SPEC §12.3 input; `source` selects the commit message and the Task trailer. */
export interface IntermediateCheckpointInput {
  readonly facts: SessionGitFacts;
  readonly sessionStartHead: string;
  readonly runId: string;
  readonly planRevision: number;
  readonly sessionId: string;
  readonly source:
    | { readonly kind: 'task'; readonly taskId: string }
    | { readonly kind: 'final-review' };
}

/** SPEC §12.4 input (`decision == completed`; replan goes through §12.3). */
export interface FinalReviewCheckpointInput {
  readonly facts: SessionGitFacts;
  readonly sessionStartHead: string;
  readonly runId: string;
  readonly planRevision: number;
  readonly sessionId: string;
}

export interface GitPort {
  /** SPEC §8.1 item 6: the git executable runs. Throws `GIT_UNAVAILABLE`. */
  assertAvailable(): Promise<void>;

  /**
   * 自动推送启动门禁：远程名必须安全且存在非空 URL。
   * 该检查只读取本地 Git 配置，不访问网络、不修改远程。
   */
  assertPushRemote(root: string, remote: string): Promise<void>;

  /**
   * SPEC §8.1 item 7: resolves `cwd` to the absolute top level of its
   * (non-bare) worktree. Throws `GIT_WORKTREE_REQUIRED` outside a worktree.
   */
  resolveRepositoryRoot(cwd: string): Promise<string>;

  /**
   * SPEC §8.1 items 7–8: reads HEAD. Throws `GIT_HEAD_REQUIRED` when HEAD
   * does not exist and `BASE_BRANCH_REQUIRED` when HEAD is detached (no
   * attached local branch to serve as Base Branch).
   */
  readHead(root: string): Promise<GitHeadFact>;

  /**
   * SPEC §8.1 item 9 (startup): throws `STATE_DIRECTORY_TRACKED` when
   * `.apex-coding-agent/` contains Git-tracked paths.
   */
  assertStateDirectoryUntracked(root: string): Promise<void>;

  /**
   * SPEC §8.1 item 11 (startup): throws `WORKING_TREE_DIRTY` for any
   * index/tracked/untracked change except the SPEC file itself (untracked or
   * worktree-modified is allowed; staged SPEC is rejected separately).
   */
  assertWorkingTreeClean(root: string, specGitPath: string): Promise<void>;

  /**
   * SPEC §3.2: default discovery (`explicitPath === null`) or explicit path
   * validation. Default discovery lists
   * `git ls-files --cached --others --exclude-standard`, keeps entries whose
   * file name is strictly `SPEC.md` outside `.git/` and
   * `.apex-coding-agent/`; zero candidates → `SPEC_NOT_FOUND`, several →
   * `SPEC_AMBIGUOUS`. An explicit path resolves against `cwd`; both its
   * lexical and its real path must stay inside the repository root
   * (`SPEC_OUTSIDE_REPOSITORY`). The file must be a readable regular UTF-8
   * file (BOM allowed) with non-empty content (`SPEC_NOT_REGULAR_FILE`,
   * `SPEC_NOT_READABLE`, `SPEC_INVALID_UTF8`, `SPEC_EMPTY`), must not be
   * staged (`SPEC_STAGED`), and is hashed over raw bytes.
   */
  resolveSpec(root: string, cwd: string, explicitPath: string | null): Promise<SpecFact>;

  /**
   * SPEC §3.2 recompute boundary: re-reads the authoritative SPEC path and
   * recomputes its raw-byte SHA-256 (same file validations as
   * {@link GitPort.resolveSpec}, without the staged check — mid-run staged
   * SPEC is caught by the session invariants).
   */
  readSpecFact(root: string, gitPath: string): Promise<SpecFact>;

  /**
   * SPEC §8.1 item 10 (startup): throws `SPEC_STAGED` when the SPEC file has
   * staged changes. Never unstages automatically.
   */
  assertSpecNotStaged(root: string, specGitPath: string): Promise<void>;

  /**
   * SPEC §3.1 / §8.2 step 1: locates the real exclude file via
   * `git rev-parse --git-path info/exclude` (linked-worktree safe, never
   * assumes `.git` is a directory) and idempotently adds
   * `.apex-coding-agent/`. Never touches `.gitignore`.
   */
  ensureStateDirectoryExcluded(root: string): Promise<void>;

  /**
   * SPEC §8.3: creates `apex-coding-agent/<runId>` from the current HEAD and
   * switches the worktree to it. Returns the branch name.
   */
  createRunBranch(root: string, runId: string): Promise<string>;

  /**
   * SPEC §8.3 pre-session invariants: HEAD attached to the Run Branch and
   * equal to `facts.expectedHead` (`GIT_FACT_CONFLICT`), Base Branch ref still
   * pinned to `baseCommit` and completed checkpoints still ancestors of HEAD
   * (`GIT_HISTORY_DIVERGED`), `.apex-coding-agent/` untracked and SPEC not
   * staged (`PROTECTED_PATH_CHANGED`). Returns the session-start HEAD (plus a
   * Planning snapshot when `options.planning`).
   */
  assertSessionStart(
    root: string,
    facts: SessionGitFacts,
    options?: { readonly planning?: boolean },
  ): Promise<SessionStartFact>;

  /**
   * resume 首次状态写入前的完整只读校验：Run Branch、Base Branch、
   * completed Checkpoint、状态目录和 SPEC 保护规则全部成立。
   *
   * `allowAdvancedHead=true` 仅用于被中断的 Execution/Final Review
   * Session；此时 current HEAD 必须是 expectedHead 的后继，且新增提交
   * 不得包含 SPEC 或 `.apex-coding-agent/`。其余恢复点要求 HEAD 精确相等。
   */
  assertResumePosition(
    root: string,
    facts: SessionGitFacts,
    options: { readonly allowAdvancedHead: boolean },
  ): Promise<ResumePositionFact>;

  /**
   * SPEC §8.3 post-session invariants: same branch/Base/ancestor/tracked/
   * staged checks, plus session-added commits must not contain SPEC or
   * `.apex-coding-agent/` (`PROTECTED_PATH_CHANGED`). When the start fact
   * carries a Planning snapshot, HEAD and the filtered status entry set must
   * be identical to the snapshot (`PLANNING_SIDE_EFFECT_DETECTED`; no
   * automatic rollback).
   */
  assertSessionEnd(
    root: string,
    facts: SessionGitFacts,
    start: SessionStartFact,
  ): Promise<void>;

  /**
   * SPEC §12.2: validates the session Git facts (steps 3–5), records
   * Claude-created commits (step 6), commits remaining tracked/untracked
   * changes with `:(exclude)` pathspecs for SPEC and `.apex-coding-agent/`
   * (step 7), or records the no-change reason (step 8). The Coordinator
   * commit uses `--no-verify --no-gpg-sign`, message
   * `apex-coding-agent(<task-id>): <task-title>` and the four trailers.
   */
  createTaskCheckpoint(root: string, input: TaskCheckpointInput): Promise<CheckpointOutcome>;

  /**
   * SPEC §12.3: same validation and preserved-commit rules; the Coordinator
   * commit message is `...: preserve intermediate work` and the
   * `ApexCodingAgent-Task` trailer is omitted for final-review sources. A
   * no-change flow yields `noChanges === true` and
   * `reason === 'no_intermediate_changes'` — no
   * `run.json.intermediateCheckpoints` entry is appended then.
   */
  createIntermediateCheckpoint(
    root: string,
    input: IntermediateCheckpointInput,
  ): Promise<CheckpointOutcome>;

  /**
   * SPEC §12.4 (decision `completed`): preserves Claude's commits and commits
   * remaining changes with message
   * `apex-coding-agent(final-review): finalize <run-id>`; with no repository
   * changes the Final Commit is the review-start HEAD.
   */
  createFinalReviewCheckpoint(
    root: string,
    input: FinalReviewCheckpointInput,
  ): Promise<CheckpointOutcome>;

  /**
   * 发布已经形成的本地 Checkpoint；只允许同名 Run 分支的 fast-forward
   * 更新，并验证当前分支与 checkpointOid 后再接触远程。
   */
  publishRunBranch(root: string, input: PublishRunBranchInput): Promise<void>;

  /** 只读仓库状态（报告用）：HEAD 事实与 status --porcelain 行；不做任何不变量断言。 */
  readRepositoryStatus(root: string): Promise<RepositoryStatusFact>;
}
