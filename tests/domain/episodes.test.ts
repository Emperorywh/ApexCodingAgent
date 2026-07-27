/**
 * Episode lifecycle (SPEC §6.4/§11.3): append-only, un-ended shape, closing
 * fills still-null end fields exactly once, committed facts never overwritten,
 * and the outcome/decision conditional rules.
 */
import { describe, expect, it } from 'vitest';
import {
  appendExecutionEpisode,
  appendFinalReviewEpisode,
  closeExecutionEpisode,
  closeFinalReviewEpisode,
  createExecutionEpisode,
  createFinalReviewEpisode,
  type ExecutionEpisodeEnding,
  type FinalReviewEpisodeEnding,
} from '../../src/domain/episodes.js';
import type { TaskExecutionEpisode } from '../../src/domain/schemas/task-execution-episode.js';
import {
  expectApexError,
  mkErrorRecord,
  OID_B,
  OID_C,
  SHA256_A,
  SHA256_C,
  T0,
  T1,
  UUID_1,
  UUID_2,
  UUID_3,
} from './fixtures.js';

function mkUnendedExecution(sessionId = UUID_1): TaskExecutionEpisode {
  return createExecutionEpisode({
    sessionId,
    taskId: 'TASK-001',
    planRevision: 1,
    specSha256Before: SHA256_A,
    startedAt: T0,
  });
}

function mkExecutionEnding(overrides: Partial<ExecutionEpisodeEnding> = {}): ExecutionEpisodeEnding {
  return {
    specSha256After: SHA256_A,
    endedAt: T1,
    outcome: 'completed',
    summary: 'task completed',
    acceptanceEvidence: [
      { criterionIndex: 0, status: 'satisfied', evidence: 'evidence' },
      { criterionIndex: 1, status: 'satisfied', evidence: 'evidence' },
    ],
    finalCheckpoint: OID_B,
    intermediateCheckpoint: null,
    checkpointReason: 'Task Checkpoint 已创建',
    error: null,
    ...overrides,
  };
}

describe('Task Execution Episode (§11.3)', () => {
  it('creates an un-ended episode with every end field null', () => {
    const episode = mkUnendedExecution();
    expect(episode).toMatchObject({
      sessionId: UUID_1,
      taskId: 'TASK-001',
      specSha256After: null,
      endedAt: null,
      outcome: null,
      summary: null,
      acceptanceEvidence: [],
      finalCheckpoint: null,
      intermediateCheckpoint: null,
      checkpointReason: null,
      error: null,
    });
  });

  it('appends episodes and rejects duplicate session IDs', () => {
    const first = appendExecutionEpisode([], mkUnendedExecution());
    expect(first).toHaveLength(1);
    expectApexError(
      () => appendExecutionEpisode(first, mkUnendedExecution()),
      'STATE_VALIDATION_FAILED',
    );
  });

  it('rejects appending a malformed episode (endedAt set, outcome null)', () => {
    const broken = { ...mkUnendedExecution(), endedAt: T1 };
    expectApexError(() => appendExecutionEpisode([], broken), 'STATE_VALIDATION_FAILED');
  });

  it('closes an episode by filling its end fields, without mutating the input array', () => {
    const episodes = appendExecutionEpisode([], mkUnendedExecution());
    const closed = closeExecutionEpisode(episodes, UUID_1, mkExecutionEnding());
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({
      outcome: 'completed',
      endedAt: T1,
      finalCheckpoint: OID_B,
      checkpointReason: 'Task Checkpoint 已创建',
    });
    // Input array and episode object stay untouched (append-only semantics).
    expect(episodes[0]!.endedAt).toBeNull();
  });

  it('failed/session_error outcomes require a matching Error Record', () => {
    const episodes = appendExecutionEpisode([], mkUnendedExecution());
    expectApexError(
      () => closeExecutionEpisode(episodes, UUID_1, mkExecutionEnding({ outcome: 'failed' })),
      'STATE_VALIDATION_FAILED',
    );
    const withError = closeExecutionEpisode(
      episodes,
      UUID_1,
      mkExecutionEnding({ outcome: 'failed', error: mkErrorRecord() }),
    );
    expect(withError[0]!.outcome).toBe('failed');

    expectApexError(
      () =>
        closeExecutionEpisode(
          appendExecutionEpisode([], mkUnendedExecution()),
          UUID_1,
          mkExecutionEnding({ outcome: 'session_error', error: mkErrorRecord({ errorClass: 'plan_error' }) }),
        ),
      'STATE_VALIDATION_FAILED',
    );
  });

  it('non-error outcomes must keep error null', () => {
    const episodes = appendExecutionEpisode([], mkUnendedExecution());
    for (const outcome of ['completed', 'replan_required', 'spec_changed'] as const) {
      expectApexError(
        () =>
          closeExecutionEpisode(
            episodes,
            UUID_1,
            mkExecutionEnding({ outcome, error: mkErrorRecord() }),
          ),
        'STATE_VALIDATION_FAILED',
      );
    }
  });

  it('requires summary and checkpointReason once ended', () => {
    const episodes = appendExecutionEpisode([], mkUnendedExecution());
    expectApexError(
      () => closeExecutionEpisode(episodes, UUID_1, mkExecutionEnding({ summary: null as never })),
      'STATE_VALIDATION_FAILED',
    );
    expectApexError(
      () =>
        closeExecutionEpisode(episodes, UUID_1, mkExecutionEnding({ checkpointReason: null as never })),
      'STATE_VALIDATION_FAILED',
    );
  });

  it('never overwrites a closed episode and rejects unknown sessions', () => {
    const closed = closeExecutionEpisode(
      appendExecutionEpisode([], mkUnendedExecution()),
      UUID_1,
      mkExecutionEnding(),
    );
    expectApexError(
      () => closeExecutionEpisode(closed, UUID_1, mkExecutionEnding()),
      'STATE_VALIDATION_FAILED',
    );
    expectApexError(
      () => closeExecutionEpisode(closed, UUID_2, mkExecutionEnding()),
      'STATE_VALIDATION_FAILED',
    );
  });

  it('keeps every episode of a task across replan cycles (append-only history)', () => {
    let episodes = appendExecutionEpisode([], mkUnendedExecution(UUID_1));
    episodes = closeExecutionEpisode(
      episodes,
      UUID_1,
      mkExecutionEnding({
        outcome: 'replan_required',
        finalCheckpoint: null,
        intermediateCheckpoint: OID_C,
        checkpointReason: '已创建中间 Checkpoint',
      }),
    );
    episodes = appendExecutionEpisode(episodes, mkUnendedExecution(UUID_2));
    episodes = closeExecutionEpisode(episodes, UUID_2, mkExecutionEnding({ finalCheckpoint: OID_B }));
    expect(episodes.map((episode) => episode.sessionId)).toEqual([UUID_1, UUID_2]);
    expect(episodes[0]!.outcome).toBe('replan_required');
    expect(episodes[0]!.intermediateCheckpoint).toBe(OID_C);
    expect(episodes[1]!.outcome).toBe('completed');
    expect(episodes[1]!.finalCheckpoint).toBe(OID_B);
  });
});

describe('Final Review Episode (§11.3)', () => {
  function mkUnendedFinalReview(sessionId = UUID_3) {
    return createFinalReviewEpisode({
      sessionId,
      planRevision: 1,
      specSha256Before: SHA256_A,
      startedAt: T0,
    });
  }

  function mkFinalReviewEnding(
    overrides: Partial<FinalReviewEpisodeEnding> = {},
  ): FinalReviewEpisodeEnding {
    return {
      specSha256After: SHA256_C,
      endedAt: T1,
      decision: 'completed',
      summary: '整体复核通过',
      reviewedTaskIds: ['TASK-001'],
      changedAreas: [],
      checkpointRole: 'final-review-final',
      checkpoint: OID_B,
      checkpointReason: 'Final Review Checkpoint 已确认',
      error: null,
      ...overrides,
    };
  }

  it('creates an un-ended episode with every end field null', () => {
    expect(mkUnendedFinalReview()).toMatchObject({
      decision: null,
      endedAt: null,
      checkpointRole: null,
      checkpoint: null,
      checkpointReason: null,
      error: null,
      reviewedTaskIds: [],
      changedAreas: [],
    });
  });

  it('completed requires role final-review-final and a checkpoint', () => {
    const episodes = appendFinalReviewEpisode([], mkUnendedFinalReview());
    const closed = closeFinalReviewEpisode(episodes, UUID_3, mkFinalReviewEnding());
    expect(closed[0]!.decision).toBe('completed');

    expectApexError(
      () =>
        closeFinalReviewEpisode(
          appendFinalReviewEpisode([], mkUnendedFinalReview()),
          UUID_3,
          mkFinalReviewEnding({ checkpointRole: 'final-review-intermediate' }),
        ),
      'STATE_VALIDATION_FAILED',
    );
    expectApexError(
      () =>
        closeFinalReviewEpisode(
          appendFinalReviewEpisode([], mkUnendedFinalReview()),
          UUID_3,
          mkFinalReviewEnding({ checkpoint: null }),
        ),
      'STATE_VALIDATION_FAILED',
    );
  });

  it('replan_required: intermediate role with changes, both null without changes', () => {
    const withChanges = closeFinalReviewEpisode(
      appendFinalReviewEpisode([], mkUnendedFinalReview()),
      UUID_3,
      mkFinalReviewEnding({
        decision: 'replan_required',
        checkpointRole: 'final-review-intermediate',
        checkpoint: OID_C,
        changedAreas: ['src/domain'],
      }),
    );
    expect(withChanges[0]!.checkpointRole).toBe('final-review-intermediate');

    const withoutChanges = closeFinalReviewEpisode(
      appendFinalReviewEpisode([], mkUnendedFinalReview()),
      UUID_3,
      mkFinalReviewEnding({ decision: 'spec_changed', checkpointRole: null, checkpoint: null }),
    );
    expect(withoutChanges[0]!.checkpointRole).toBeNull();
    expect(withoutChanges[0]!.checkpoint).toBeNull();

    // checkpointReason is always required once ended.
    expectApexError(
      () =>
        closeFinalReviewEpisode(
          appendFinalReviewEpisode([], mkUnendedFinalReview()),
          UUID_3,
          mkFinalReviewEnding({
            decision: 'replan_required',
            checkpointRole: null,
            checkpoint: null,
            checkpointReason: null as never,
          }),
        ),
      'STATE_VALIDATION_FAILED',
    );
  });

  it('session_error requires an Error Record and forbids the final role', () => {
    expectApexError(
      () =>
        closeFinalReviewEpisode(
          appendFinalReviewEpisode([], mkUnendedFinalReview()),
          UUID_3,
          mkFinalReviewEnding({
            decision: 'session_error',
            checkpointRole: null,
            checkpoint: null,
            error: null,
          }),
        ),
      'STATE_VALIDATION_FAILED',
    );
    expectApexError(
      () =>
        closeFinalReviewEpisode(
          appendFinalReviewEpisode([], mkUnendedFinalReview()),
          UUID_3,
          mkFinalReviewEnding({ decision: 'session_error', error: mkErrorRecord() }),
        ),
      'STATE_VALIDATION_FAILED',
    );
  });

  it('requires checkpointRole and checkpoint to be set together', () => {
    expectApexError(
      () =>
        closeFinalReviewEpisode(
          appendFinalReviewEpisode([], mkUnendedFinalReview()),
          UUID_3,
          mkFinalReviewEnding({
            decision: 'replan_required',
            checkpointRole: 'final-review-intermediate',
            checkpoint: null,
          }),
        ),
      'STATE_VALIDATION_FAILED',
    );
  });

  it('never overwrites committed episodes and rejects duplicate appends', () => {
    const closed = closeFinalReviewEpisode(
      appendFinalReviewEpisode([], mkUnendedFinalReview()),
      UUID_3,
      mkFinalReviewEnding(),
    );
    expectApexError(
      () => closeFinalReviewEpisode(closed, UUID_3, mkFinalReviewEnding()),
      'STATE_VALIDATION_FAILED',
    );
    expectApexError(
      () => appendFinalReviewEpisode(closed, mkUnendedFinalReview()),
      'STATE_VALIDATION_FAILED',
    );
  });
});
