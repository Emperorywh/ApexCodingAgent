/**
 * Checkpoint creation (SPEC §12). One shared flow backs all three kinds:
 *
 * 1. Validate the session Git facts — Run Branch attachment, pinned Base
 *    Branch ref, reachable completed checkpoints, untracked state directory,
 *    unstaged SPEC (§12.2 steps 3–5, §12.3 step 1, §12.4 step 3);
 * 2. record the commits Claude created during the session (they are kept,
 *    never rewritten) and reject any that touch protected paths;
 * 3. stage every remaining tracked/untracked change while explicitly
 *    excluding SPEC and `.apex-coding-agent/` via `:(exclude)` pathspecs;
 * 4. commit with `--no-verify --no-gpg-sign` when anything was staged, or
 *    record the no-change reason otherwise.
 *
 * Commit messages and trailers follow SPEC §12.2–§12.4 and use only the four
 * trailer names `ApexCodingAgent-Run` / `-Task` / `-Plan-Revision` /
 * `-Session`; valueless lines (Task for final-review commits) are omitted.
 */
import type {
  CheckpointOutcome,
  FinalReviewCheckpointInput,
  IntermediateCheckpointInput,
  SessionGitFacts,
  TaskCheckpointInput,
} from '../../application/ports/GitPort.js';
import { gitCommandFailed, type GitRunner } from './cli.js';
import {
  assertBaseRefPinned,
  assertCheckpointsAreAncestors,
  assertHeadOnRunBranch,
  assertSessionCommitsClean,
  assertSpecNotStagedInRun,
  assertStateDirectoryUntrackedInRun,
  listSessionCommits,
} from './invariants.js';

type Trailer = readonly [name: string, value: string];

function buildMessage(subject: string, trailers: readonly Trailer[]): string {
  const lines = trailers.map(([name, value]) => `${name}: ${value}`);
  return `${subject}\n\n${lines.join('\n')}\n`;
}

function baseTrailers(runId: string, planRevision: number, sessionId: string): Trailer[] {
  return [
    ['ApexCodingAgent-Run', runId],
    ['ApexCodingAgent-Plan-Revision', String(planRevision)],
    ['ApexCodingAgent-Session', sessionId],
  ];
}

interface CheckpointFlowOptions {
  readonly facts: SessionGitFacts;
  readonly sessionStartHead: string;
  readonly subject: string;
  readonly trailers: readonly Trailer[];
  /** Reason token used when neither Claude nor the Coordinator changed anything. */
  readonly noChangesReason: 'no_changes' | 'no_intermediate_changes';
}

/**
 * §12.2：显式排除 SPEC 与状态目录的 pathspec。
 *
 * 必须规避 Git 的一个陷阱：被 ignore 规则命中的路径若以纯字面名出现在
 * 任何 pathspec（包括 `:(exclude)`）中，`git add` 会按"显式指定已忽略
 * 路径"报错退出（ SPEC 只可能位于 ignored 位置时通过显式路径指定；
 * `.apex-coding-agent/` 总是被 info/exclude 忽略）。把最后一个字面字符
 * 改写为单字符类可保持精确匹配，同时不再触发该检查。
 */
function escapeGlobLiteralCharacter(character: string): string {
  switch (character) {
    case '[':
      return '[[]';
    case ']':
      return '[]]';
    case '*':
      return '[*]';
    case '?':
      return '[?]';
    case '\\':
      return '[\\\\]';
    default:
      return character;
  }
}

/** 把最后一个字符编码为单字符类，使整个 pathspec 保持非字面模式。 */
function literalCharacterClass(character: string): string {
  switch (character) {
    case '[':
      return '[[]';
    case ']':
      return '[]]';
    case '-':
      return '[-]';
    case '^':
    case '!':
    case '\\':
      return `[\\${character}]`;
    default:
      return `[${character}]`;
  }
}

function exclusionPathspec(gitRelativePath: string): string {
  const characters = [...gitRelativePath];
  const last = characters.pop()!;
  const escapedPrefix = characters.map(escapeGlobLiteralCharacter).join('');
  return `:(exclude)${escapedPrefix}${literalCharacterClass(last)}`;
}

/** 状态目录的内容排除（目录自身不入库，glob 匹配其全部内容）。 */
const STATE_DIR_EXCLUSION = exclusionPathspec('.apex-coding-agent') + '/**';

async function runCheckpointFlow(
  git: GitRunner,
  root: string,
  flow: CheckpointFlowOptions,
): Promise<CheckpointOutcome> {
  const { facts } = flow;
  await assertHeadOnRunBranch(git, root, facts.runBranch);
  await assertBaseRefPinned(git, root, facts.baseBranchRef, facts.baseCommit);
  await assertCheckpointsAreAncestors(git, root, facts.completedCheckpoints);
  await assertStateDirectoryUntrackedInRun(git, root);
  await assertSpecNotStagedInRun(git, root, facts.specGitPath);

  const claudeCommits = await listSessionCommits(git, root, flow.sessionStartHead);
  await assertSessionCommitsClean(git, root, claudeCommits, facts.specGitPath);

  await git.run(
    [
      'add',
      '--all',
      '--',
      '.',
      exclusionPathspec(facts.specGitPath),
      STATE_DIR_EXCLUSION,
    ],
    root,
  );
  const staged = await git.runAllowFailure(['diff', '--cached', '--quiet'], root);
  if (staged.code !== 0 && staged.code !== 1) {
    throw gitCommandFailed('git diff --cached --quiet failed during checkpoint', {
      stderr: staged.stderr,
      redact: git.redact,
    });
  }

  let coordinatorCommit: string | null = null;
  if (staged.code === 1) {
    await git.run(
      ['commit', '--no-verify', '--no-gpg-sign', '--message', buildMessage(flow.subject, flow.trailers)],
      root,
    );
    coordinatorCommit = (await git.run(['rev-parse', 'HEAD'], root)).stdout.trim();
  }
  const finalOid = coordinatorCommit ?? (await git.run(['rev-parse', 'HEAD'], root)).stdout.trim();
  const noChanges = claudeCommits.length === 0 && coordinatorCommit === null;
  const reason =
    coordinatorCommit !== null
      ? 'committed_remaining_changes'
      : claudeCommits.length > 0
        ? 'claude_commits_only'
        : flow.noChangesReason;
  return { finalOid, claudeCommits, coordinatorCommit, noChanges, reason };
}

/** SPEC §12.2 Task Checkpoint (steps 3–9 of the 11-step flow). */
export async function createTaskCheckpoint(
  git: GitRunner,
  root: string,
  input: TaskCheckpointInput,
): Promise<CheckpointOutcome> {
  return runCheckpointFlow(git, root, {
    facts: input.facts,
    sessionStartHead: input.sessionStartHead,
    subject: `apex-coding-agent(${input.taskId}): ${input.taskTitle}`,
    trailers: [
      ['ApexCodingAgent-Run', input.runId],
      ['ApexCodingAgent-Task', input.taskId],
      ['ApexCodingAgent-Plan-Revision', String(input.planRevision)],
      ['ApexCodingAgent-Session', input.sessionId],
    ],
    noChangesReason: 'no_changes',
  });
}

/** SPEC §12.3 intermediate Checkpoint (replan / spec-change preservation). */
export async function createIntermediateCheckpoint(
  git: GitRunner,
  root: string,
  input: IntermediateCheckpointInput,
): Promise<CheckpointOutcome> {
  const isTask = input.source.kind === 'task';
  const subject = isTask
    ? `apex-coding-agent(${input.source.taskId}): preserve intermediate work`
    : 'apex-coding-agent(final-review): preserve intermediate work';
  const trailers: Trailer[] = isTask
    ? [
        ['ApexCodingAgent-Run', input.runId],
        ['ApexCodingAgent-Task', input.source.taskId],
        ['ApexCodingAgent-Plan-Revision', String(input.planRevision)],
        ['ApexCodingAgent-Session', input.sessionId],
      ]
    : baseTrailers(input.runId, input.planRevision, input.sessionId);
  return runCheckpointFlow(git, root, {
    facts: input.facts,
    sessionStartHead: input.sessionStartHead,
    subject,
    trailers,
    noChangesReason: 'no_intermediate_changes',
  });
}

/** SPEC §12.4 Final Review Checkpoint for `decision == completed`. */
export async function createFinalReviewCheckpoint(
  git: GitRunner,
  root: string,
  input: FinalReviewCheckpointInput,
): Promise<CheckpointOutcome> {
  return runCheckpointFlow(git, root, {
    facts: input.facts,
    sessionStartHead: input.sessionStartHead,
    subject: `apex-coding-agent(final-review): finalize ${input.runId}`,
    trailers: baseTrailers(input.runId, input.planRevision, input.sessionId),
    noChangesReason: 'no_changes',
  });
}
