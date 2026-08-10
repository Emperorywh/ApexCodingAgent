/**
 * Episode lifecycle (SPEC §6.3/§6.4/§11.3): episodes are append-only facts.
 * An episode is appended un-ended (all end fields null) when its session
 * starts, and exactly once closed by filling the still-null end fields —
 * already committed non-null facts are never overwritten, deleted or
 * reordered.
 */
import { ApexError } from './errors.js';
import {
  assertExecutionEpisodeRules,
  assertFinalReviewEpisodeRules,
  assertTaskReviewEpisodeRules,
} from './invariants.js';
import type { ErrorRecord } from './schemas/error-record.js';
import type {
  FinalReviewCheckpointRole,
  FinalReviewEpisode,
  FinalReviewEpisodeDecision,
} from './schemas/final-review-episode.js';
import type {
  ExecutionEpisodeOutcome,
  TaskExecutionEpisode,
} from './schemas/task-execution-episode.js';
import type { AcceptanceEvidence } from './schemas/task-execution-result.js';
import type { TestReport } from './schemas/task-execution-result.js';
import type {
  ReviewIssue,
  VerificationEvidence,
} from './schemas/review-evidence.js';
import type {
  TaskReviewEpisode,
  TaskReviewEpisodeOutcome,
} from './schemas/task-review-episode.js';

const STATE_STAGE = 'state';

function episodeError(message: string): ApexError {
  return new ApexError({ code: 'STATE_VALIDATION_FAILED', stage: STATE_STAGE, message });
}

export interface CreateExecutionEpisodeInput {
  readonly sessionId: string;
  readonly taskId: string;
  readonly planRevision: number;
  readonly specSha256Before: string;
  readonly startedAt: string;
}

/** Un-ended episode as appended at Execution Session start (§6.3 step 3). */
export function createExecutionEpisode(input: CreateExecutionEpisodeInput): TaskExecutionEpisode {
  return {
    sessionId: input.sessionId,
    taskId: input.taskId,
    planRevision: input.planRevision,
    specSha256Before: input.specSha256Before,
    specSha256After: null,
    startedAt: input.startedAt,
    endedAt: null,
    outcome: null,
    summary: null,
    acceptanceEvidence: [],
    finalCheckpoint: null,
    intermediateCheckpoint: null,
    checkpointReason: null,
    error: null,
  };
}

/** Facts filled in when an Execution Episode ends. */
export interface ExecutionEpisodeEnding {
  readonly specSha256After: string;
  readonly endedAt: string;
  readonly outcome: ExecutionEpisodeOutcome;
  readonly summary: string;
  readonly acceptanceEvidence: AcceptanceEvidence[];
  readonly finalCheckpoint: string | null;
  readonly intermediateCheckpoint: string | null;
  readonly checkpointReason: string;
  readonly error: ErrorRecord | null;
}

/**
 * Appends an episode, enforcing append-only semantics: the session ID must be
 * new and the episode itself must satisfy the episode rules.
 */
export function appendExecutionEpisode(
  episodes: readonly TaskExecutionEpisode[],
  episode: TaskExecutionEpisode,
): TaskExecutionEpisode[] {
  if (episodes.some((existing) => existing.sessionId === episode.sessionId)) {
    throw episodeError(`execution episode for session ${episode.sessionId} already exists`);
  }
  assertExecutionEpisodeRules(episode);
  return [...episodes, episode];
}

/**
 * Closes an un-ended episode by filling its still-null end fields. Throws if
 * the episode is unknown, already closed, or any end field was already
 * committed (no-overwrite rule), or the ending violates the outcome rules.
 */
export function closeExecutionEpisode(
  episodes: readonly TaskExecutionEpisode[],
  sessionId: string,
  ending: ExecutionEpisodeEnding,
): TaskExecutionEpisode[] {
  const index = episodes.findIndex((episode) => episode.sessionId === sessionId);
  if (index < 0) {
    throw episodeError(`no execution episode for session ${sessionId}`);
  }
  const episode = episodes[index]!;
  if (
    episode.endedAt !== null ||
    episode.specSha256After !== null ||
    episode.outcome !== null ||
    episode.summary !== null ||
    episode.acceptanceEvidence.length > 0 ||
    episode.finalCheckpoint !== null ||
    episode.intermediateCheckpoint !== null ||
    episode.checkpointReason !== null ||
    episode.error !== null
  ) {
    throw episodeError(
      `execution episode ${sessionId} already has committed end fields and must not be overwritten`,
    );
  }
  const closed: TaskExecutionEpisode = {
    ...episode,
    specSha256After: ending.specSha256After,
    endedAt: ending.endedAt,
    outcome: ending.outcome,
    summary: ending.summary,
    acceptanceEvidence: [...ending.acceptanceEvidence],
    finalCheckpoint: ending.finalCheckpoint,
    intermediateCheckpoint: ending.intermediateCheckpoint,
    checkpointReason: ending.checkpointReason,
    error: ending.error,
  };
  assertExecutionEpisodeRules(closed);
  return episodes.map((existing, position) => (position === index ? closed : existing));
}

export interface CreateTaskReviewEpisodeInput {
  readonly sessionId: string;
  readonly taskId: string;
  readonly executionSessionId: string;
  readonly candidateCheckpoint: string;
  readonly planRevision: number;
  readonly specSha256Before: string;
  readonly startedAt: string;
}

/**
 * 创建尚未结束的独立 Task Review Episode。
 *
 * executionSessionId 与 review sessionId 分开保存，使领域不变式可以直接
 * 证明复核者不是产生候选实现的同一个 Claude Session。
 */
export function createTaskReviewEpisode(
  input: CreateTaskReviewEpisodeInput,
): TaskReviewEpisode {
  const episode: TaskReviewEpisode = {
    sessionId: input.sessionId,
    taskId: input.taskId,
    executionSessionId: input.executionSessionId,
    candidateCheckpoint: input.candidateCheckpoint,
    planRevision: input.planRevision,
    specSha256Before: input.specSha256Before,
    specSha256After: null,
    startedAt: input.startedAt,
    endedAt: null,
    outcome: null,
    summary: null,
    tests: [],
    verificationEvidence: [],
    acceptanceEvidence: [],
    issues: [],
    error: null,
  };
  assertTaskReviewEpisodeRules(episode);
  return episode;
}

export interface TaskReviewEpisodeEnding {
  readonly specSha256After: string;
  readonly endedAt: string;
  readonly outcome: TaskReviewEpisodeOutcome;
  readonly summary: string;
  readonly tests: TestReport[];
  readonly verificationEvidence: readonly VerificationEvidence[];
  readonly acceptanceEvidence: AcceptanceEvidence[];
  readonly issues: readonly ReviewIssue[];
  readonly error: ErrorRecord | null;
}

/** 追加 Task Review Episode，并拒绝复用任何既有复核 Session ID。 */
export function appendTaskReviewEpisode(
  episodes: readonly TaskReviewEpisode[],
  episode: TaskReviewEpisode,
): TaskReviewEpisode[] {
  if (episodes.some((existing) => existing.sessionId === episode.sessionId)) {
    throw episodeError(`task review episode for session ${episode.sessionId} already exists`);
  }
  assertTaskReviewEpisodeRules(episode);
  return [...episodes, episode];
}

/**
 * 关闭一次 Task Review Episode。
 *
 * 与其他 Episode 相同，任何已经提交的结束字段都不可覆盖，确保中断恢复
 * 和失败收尾不会改写先前的审计事实。
 */
export function closeTaskReviewEpisode(
  episodes: readonly TaskReviewEpisode[],
  sessionId: string,
  ending: TaskReviewEpisodeEnding,
): TaskReviewEpisode[] {
  const index = episodes.findIndex((episode) => episode.sessionId === sessionId);
  if (index < 0) {
    throw episodeError(`no task review episode for session ${sessionId}`);
  }
  const episode = episodes[index]!;
  if (
    episode.endedAt !== null ||
    episode.specSha256After !== null ||
    episode.outcome !== null ||
    episode.summary !== null ||
    episode.tests.length > 0 ||
    episode.verificationEvidence.length > 0 ||
    episode.acceptanceEvidence.length > 0 ||
    episode.issues.length > 0 ||
    episode.error !== null
  ) {
    throw episodeError(
      `task review episode ${sessionId} already has committed end fields and must not be overwritten`,
    );
  }
  const closed: TaskReviewEpisode = {
    ...episode,
    specSha256After: ending.specSha256After,
    endedAt: ending.endedAt,
    outcome: ending.outcome,
    summary: ending.summary,
    tests: [...ending.tests],
    verificationEvidence: [...ending.verificationEvidence],
    acceptanceEvidence: [...ending.acceptanceEvidence],
    issues: [...ending.issues],
    error: ending.error,
  };
  assertTaskReviewEpisodeRules(closed);
  return episodes.map((existing, position) => (position === index ? closed : existing));
}

export interface CreateFinalReviewEpisodeInput {
  readonly sessionId: string;
  readonly planRevision: number;
  readonly specSha256Before: string;
  readonly startedAt: string;
}

/** Un-ended Final Review Episode as appended at session start. */
export function createFinalReviewEpisode(input: CreateFinalReviewEpisodeInput): FinalReviewEpisode {
  return {
    sessionId: input.sessionId,
    planRevision: input.planRevision,
    specSha256Before: input.specSha256Before,
    specSha256After: null,
    startedAt: input.startedAt,
    endedAt: null,
    decision: null,
    summary: null,
    reviewedTaskIds: [],
    changedAreas: [],
    checkpointRole: null,
    checkpoint: null,
    checkpointReason: null,
    error: null,
  };
}

/** Facts filled in when a Final Review Episode ends. */
export interface FinalReviewEpisodeEnding {
  readonly specSha256After: string;
  readonly endedAt: string;
  readonly decision: FinalReviewEpisodeDecision;
  readonly summary: string;
  readonly reviewedTaskIds: string[];
  readonly changedAreas: string[];
  readonly checkpointRole: FinalReviewCheckpointRole | null;
  readonly checkpoint: string | null;
  readonly checkpointReason: string;
  readonly error: ErrorRecord | null;
}

export function appendFinalReviewEpisode(
  episodes: readonly FinalReviewEpisode[],
  episode: FinalReviewEpisode,
): FinalReviewEpisode[] {
  if (episodes.some((existing) => existing.sessionId === episode.sessionId)) {
    throw episodeError(`final review episode for session ${episode.sessionId} already exists`);
  }
  assertFinalReviewEpisodeRules(episode);
  return [...episodes, episode];
}

export function closeFinalReviewEpisode(
  episodes: readonly FinalReviewEpisode[],
  sessionId: string,
  ending: FinalReviewEpisodeEnding,
): FinalReviewEpisode[] {
  const index = episodes.findIndex((episode) => episode.sessionId === sessionId);
  if (index < 0) {
    throw episodeError(`no final review episode for session ${sessionId}`);
  }
  const episode = episodes[index]!;
  if (
    episode.endedAt !== null ||
    episode.specSha256After !== null ||
    episode.decision !== null ||
    episode.summary !== null ||
    episode.reviewedTaskIds.length > 0 ||
    episode.changedAreas.length > 0 ||
    episode.checkpointRole !== null ||
    episode.checkpoint !== null ||
    episode.checkpointReason !== null ||
    episode.error !== null
  ) {
    throw episodeError(
      `final review episode ${sessionId} already has committed end fields and must not be overwritten`,
    );
  }
  const closed: FinalReviewEpisode = {
    ...episode,
    specSha256After: ending.specSha256After,
    endedAt: ending.endedAt,
    decision: ending.decision,
    summary: ending.summary,
    reviewedTaskIds: [...ending.reviewedTaskIds],
    changedAreas: [...ending.changedAreas],
    checkpointRole: ending.checkpointRole,
    checkpoint: ending.checkpoint,
    checkpointReason: ending.checkpointReason,
    error: ending.error,
  };
  assertFinalReviewEpisodeRules(closed);
  return episodes.map((existing, position) => (position === index ? closed : existing));
}
