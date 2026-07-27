/**
 * Run state machine (SPEC §6.1): every legal transition, every domain event,
 * illegal transitions and terminal-state immutability.
 */
import { describe, expect, it } from 'vitest';
import {
  applyRunEvent,
  canRunTransition,
  isTerminalRunStatus,
  RUN_TRANSITIONS,
  TERMINAL_RUN_STATUSES,
  type RunEvent,
  type RunStatus,
} from '../../src/domain/run-state.js';
import { RUN_STATUSES } from '../../src/domain/schemas/run-json.js';
import { expectApexError } from './fixtures.js';

const ALL_STATUSES: RunStatus[] = [...RUN_STATUSES];
const ALL_EVENTS: RunEvent[] = [
  'PLAN_ACCEPTED',
  'REPLAN_REQUESTED',
  'SPEC_CHANGED',
  'ALL_TASKS_COMPLETED',
  'FINAL_REVIEW_COMPLETED',
  'RUN_ERROR',
  'RUN_ABANDONED',
];

const LEGAL_TRANSITIONS: ReadonlyArray<readonly [RunStatus, RunStatus]> = [
  ['planning', 'running'],
  ['planning', 'failed'],
  ['planning', 'abandoned'],
  ['running', 'planning'],
  ['running', 'final_review'],
  ['running', 'failed'],
  ['running', 'abandoned'],
  ['final_review', 'planning'],
  ['final_review', 'completed'],
  ['final_review', 'failed'],
  ['final_review', 'abandoned'],
];

const EVENT_CASES: ReadonlyArray<readonly [RunEvent, RunStatus, RunStatus]> = [
  ['PLAN_ACCEPTED', 'planning', 'running'],
  ['REPLAN_REQUESTED', 'running', 'planning'],
  ['REPLAN_REQUESTED', 'final_review', 'planning'],
  ['SPEC_CHANGED', 'planning', 'planning'],
  ['SPEC_CHANGED', 'running', 'planning'],
  ['SPEC_CHANGED', 'final_review', 'planning'],
  ['ALL_TASKS_COMPLETED', 'running', 'final_review'],
  ['FINAL_REVIEW_COMPLETED', 'final_review', 'completed'],
  ['RUN_ERROR', 'planning', 'failed'],
  ['RUN_ERROR', 'running', 'failed'],
  ['RUN_ERROR', 'final_review', 'failed'],
  ['RUN_ABANDONED', 'planning', 'abandoned'],
  ['RUN_ABANDONED', 'running', 'abandoned'],
  ['RUN_ABANDONED', 'final_review', 'abandoned'],
];

describe('Run state machine (§6.1)', () => {
  it('has exactly six statuses and three terminal statuses', () => {
    expect(ALL_STATUSES).toHaveLength(6);
    expect(TERMINAL_RUN_STATUSES).toEqual(['completed', 'failed', 'abandoned']);
    for (const status of ALL_STATUSES) {
      expect(isTerminalRunStatus(status)).toBe(TERMINAL_RUN_STATUSES.includes(status));
    }
  });

  it.each(LEGAL_TRANSITIONS)('allows %s -> %s', (from, to) => {
    expect(canRunTransition(from, to)).toBe(true);
    expect(RUN_TRANSITIONS[from]).toContain(to);
  });

  it('rejects every non-listed pairwise transition', () => {
    const legal = new Set(LEGAL_TRANSITIONS.map(([from, to]) => `${from}->${to}`));
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        if (legal.has(`${from}->${to}`)) continue;
        expect(canRunTransition(from, to)).toBe(false);
      }
    }
  });

  it.each(EVENT_CASES)('applies %s: %s -> %s', (event, from, to) => {
    expect(applyRunEvent(from, event)).toBe(to);
  });

  it('rejects events from illegal source statuses', () => {
    const allowedSources: Record<RunEvent, readonly RunStatus[]> = {
      PLAN_ACCEPTED: ['planning'],
      REPLAN_REQUESTED: ['running', 'final_review'],
      SPEC_CHANGED: ['planning', 'running', 'final_review'],
      ALL_TASKS_COMPLETED: ['running'],
      FINAL_REVIEW_COMPLETED: ['final_review'],
      RUN_ERROR: ['planning', 'running', 'final_review'],
      RUN_ABANDONED: ['planning', 'running', 'final_review'],
    };
    for (const event of ALL_EVENTS) {
      for (const status of ALL_STATUSES) {
        if (allowedSources[event].includes(status)) continue;
        expectApexError(() => applyRunEvent(status, event), 'STATE_VALIDATION_FAILED');
      }
    }
  });

  it('terminal statuses accept no event at all (including RUN_ERROR/RUN_ABANDONED)', () => {
    for (const terminal of TERMINAL_RUN_STATUSES) {
      expect(RUN_TRANSITIONS[terminal]).toEqual([]);
      for (const event of ALL_EVENTS) {
        expectApexError(() => applyRunEvent(terminal, event), 'STATE_VALIDATION_FAILED');
      }
    }
  });
});
