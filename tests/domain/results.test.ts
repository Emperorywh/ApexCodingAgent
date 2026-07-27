/**
 * Semantic gates for Claude results: TaskExecutionResult (§9.4) and
 * FinalReviewResult (§14.1).
 */
import { describe, expect, it } from 'vitest';
import {
  validateExecutionResultSemantics,
  validateFinalReviewResultSemantics,
} from '../../src/domain/results.js';
import type { FinalReviewResult } from '../../src/domain/schemas/final-review-result.js';
import { expectApexError, mkResult, mkTask } from './fixtures.js';

const TASK = mkTask('TASK-001'); // two acceptance criteria: indexes 0 and 1

function mkFinalReview(overrides: Partial<FinalReviewResult> = {}): FinalReviewResult {
  return {
    decision: 'completed',
    summary: '整体复核通过',
    reviewedTaskIds: ['TASK-001', 'TASK-002'],
    tests: [{ command: 'npm test', result: 'passed' }],
    changedAreas: [],
    remainingRisks: [],
    replanReason: null,
    ...overrides,
  };
}

describe('TaskExecutionResult semantics (§9.4)', () => {
  it('accepts a fully satisfied completed result', () => {
    expect(() => validateExecutionResultSemantics(mkResult(), TASK)).not.toThrow();
  });

  it('rejects missing, out-of-range and duplicated criterionIndex entries', () => {
    const missing = mkResult({
      acceptanceEvidence: [{ criterionIndex: 0, status: 'satisfied', evidence: 'e' }],
    });
    expectApexError(
      () => validateExecutionResultSemantics(missing, TASK),
      'CLAUDE_RESULT_INVALID',
    );

    const outOfRange = mkResult({
      acceptanceEvidence: [
        { criterionIndex: 0, status: 'satisfied', evidence: 'e' },
        { criterionIndex: 1, status: 'satisfied', evidence: 'e' },
        { criterionIndex: 2, status: 'satisfied', evidence: 'e' },
      ],
    });
    expectApexError(
      () => validateExecutionResultSemantics(outOfRange, TASK),
      'CLAUDE_RESULT_INVALID',
    );

    const duplicated = mkResult({
      acceptanceEvidence: [
        { criterionIndex: 0, status: 'satisfied', evidence: 'e' },
        { criterionIndex: 0, status: 'satisfied', evidence: 'e' },
        { criterionIndex: 1, status: 'satisfied', evidence: 'e' },
      ],
    });
    expectApexError(
      () => validateExecutionResultSemantics(duplicated, TASK),
      'CLAUDE_RESULT_INVALID',
    );
  });

  it('completed requires every criterion satisfied and no failed test', () => {
    const notSatisfied = mkResult({
      acceptanceEvidence: [
        { criterionIndex: 0, status: 'satisfied', evidence: 'e' },
        { criterionIndex: 1, status: 'not_satisfied', evidence: 'e' },
      ],
    });
    expectApexError(
      () => validateExecutionResultSemantics(notSatisfied, TASK),
      'CLAUDE_RESULT_INVALID',
    );

    const failedTest = mkResult({ tests: [{ command: 'npm test', result: 'failed' }] });
    expectApexError(
      () => validateExecutionResultSemantics(failedTest, TASK),
      'CLAUDE_RESULT_INVALID',
    );
  });

  it('replan_required needs a reason but allows not_satisfied evidence', () => {
    const legal = mkResult({
      decision: 'replan_required',
      replanReason: 'architecture changed',
      acceptanceEvidence: [
        { criterionIndex: 0, status: 'satisfied', evidence: 'e' },
        { criterionIndex: 1, status: 'not_satisfied', evidence: 'e' },
      ],
    });
    expect(() => validateExecutionResultSemantics(legal, TASK)).not.toThrow();

    const noReason = mkResult({ decision: 'replan_required' });
    expectApexError(
      () => validateExecutionResultSemantics(noReason, TASK),
      'CLAUDE_RESULT_INVALID',
    );

    const stillIncomplete = mkResult({
      decision: 'replan_required',
      replanReason: 'r',
      acceptanceEvidence: [{ criterionIndex: 0, status: 'satisfied', evidence: 'e' }],
    });
    expectApexError(
      () => validateExecutionResultSemantics(stillIncomplete, TASK),
      'CLAUDE_RESULT_INVALID',
    );
  });

  it('failed decision keeps full coverage and a null replanReason', () => {
    const legal = mkResult({
      decision: 'failed',
      acceptanceEvidence: [
        { criterionIndex: 0, status: 'satisfied', evidence: 'e' },
        { criterionIndex: 1, status: 'not_satisfied', evidence: 'e' },
      ],
    });
    expect(() => validateExecutionResultSemantics(legal, TASK)).not.toThrow();

    const withReason = mkResult({ decision: 'failed', replanReason: 'r' });
    expectApexError(
      () => validateExecutionResultSemantics(withReason, TASK),
      'CLAUDE_RESULT_INVALID',
    );
  });

  it('completed must not carry a replanReason', () => {
    const withReason = mkResult({ replanReason: 'r' });
    expectApexError(
      () => validateExecutionResultSemantics(withReason, TASK),
      'CLAUDE_RESULT_INVALID',
    );
  });
});

describe('FinalReviewResult semantics (§14.1)', () => {
  const COMPLETED_IDS = ['TASK-001', 'TASK-002'];

  it('accepts completed with the exact completed-task set, order-insensitive', () => {
    expect(() =>
      validateFinalReviewResultSemantics(mkFinalReview(), COMPLETED_IDS),
    ).not.toThrow();
    expect(() =>
      validateFinalReviewResultSemantics(
        mkFinalReview({ reviewedTaskIds: ['TASK-002', 'TASK-001'] }),
        COMPLETED_IDS,
      ),
    ).not.toThrow();
  });

  it('rejects incomplete, excessive or duplicated reviewedTaskIds', () => {
    expectApexError(
      () =>
        validateFinalReviewResultSemantics(
          mkFinalReview({ reviewedTaskIds: ['TASK-001'] }),
          COMPLETED_IDS,
        ),
      'FINAL_REVIEW_RESULT_INVALID',
    );
    expectApexError(
      () =>
        validateFinalReviewResultSemantics(
          mkFinalReview({ reviewedTaskIds: ['TASK-001', 'TASK-002', 'TASK-003'] }),
          COMPLETED_IDS,
        ),
      'FINAL_REVIEW_RESULT_INVALID',
    );
    expectApexError(
      () =>
        validateFinalReviewResultSemantics(
          mkFinalReview({ reviewedTaskIds: ['TASK-001', 'TASK-001', 'TASK-002'] }),
          COMPLETED_IDS,
        ),
      'FINAL_REVIEW_RESULT_INVALID',
    );
  });

  it('rejects duplicates even for replan_required', () => {
    expectApexError(
      () =>
        validateFinalReviewResultSemantics(
          mkFinalReview({
            decision: 'replan_required',
            replanReason: 'gap found',
            reviewedTaskIds: ['TASK-001', 'TASK-001'],
          }),
          COMPLETED_IDS,
        ),
      'FINAL_REVIEW_RESULT_INVALID',
    );
  });

  it('rejects completed with a failed test or a replanReason', () => {
    expectApexError(
      () =>
        validateFinalReviewResultSemantics(
          mkFinalReview({ tests: [{ command: 'npm test', result: 'failed' }] }),
          COMPLETED_IDS,
        ),
      'FINAL_REVIEW_RESULT_INVALID',
    );
    expectApexError(
      () =>
        validateFinalReviewResultSemantics(
          mkFinalReview({ replanReason: 'r' }),
          COMPLETED_IDS,
        ),
      'FINAL_REVIEW_RESULT_INVALID',
    );
  });

  it('rejects replan_required without a reason and accepts it with one', () => {
    expectApexError(
      () =>
        validateFinalReviewResultSemantics(
          mkFinalReview({ decision: 'replan_required', reviewedTaskIds: [] }),
          COMPLETED_IDS,
        ),
      'FINAL_REVIEW_RESULT_INVALID',
    );
    expect(() =>
      validateFinalReviewResultSemantics(
        mkFinalReview({
          decision: 'replan_required',
          replanReason: 'missing integration tests',
          reviewedTaskIds: ['TASK-001'],
        }),
        COMPLETED_IDS,
      ),
    ).not.toThrow();
  });
});
