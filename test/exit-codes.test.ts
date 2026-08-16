import { describe, expect, it } from 'vitest';
import {
  OUTCOMES,
  outcomeFor,
  foldPartialUpload,
  foldState,
  type FileOutcome,
  type NextAction,
  type Reason,
} from '../src/exit-codes.js';
import { EasyCastError, toEasyCastError } from '../src/errors.js';

/**
 * The table as written in the plan. Kept here spelled out rather than imported
 * so the test fails if the implementation table drifts, instead of agreeing with
 * itself.
 */
const EXPECTED: ReadonlyArray<[number, Reason, boolean, string, boolean, NextAction]> = [
  [0, 'ok', true, 'known', false, 'done'],
  [0, 'dry_run', true, 'known', false, 'request-plan'],
  [0, 'recover_report', true, 'known', false, 'done'],
  [1, 'network_unreachable', false, 'known', true, 'retry'],
  [1, 'no_access_or_not_found', false, 'known', false, 'ask-user'],
  [1, 'rejected_by_endpoint', false, 'known', false, 'fix-args'],
  [1, 'internal_error', false, 'unknown', false, 'report-to-human'],
  [2, 'bad_args', false, 'known', false, 'fix-args'],
  [2, 'bad_key', false, 'known', false, 'fix-args'],
  [2, 'unsupported_extension', false, 'known', false, 'fix-args'],
  [2, 'body_budget_exceeded', false, 'known', false, 'fix-args'],
  [2, 'ledger_capacity_exceeded', false, 'known', false, 'fix-args'],
  [2, 'repo_not_inferable', false, 'known', false, 'fix-args'],
  [2, 'repo_ambiguous', false, 'known', false, 'fix-args'],
  [2, 'journal_not_writable', false, 'known', false, 'fix-environment'],
  [2, 'identity_mismatch', false, 'known', false, 'fix-environment'],
  [2, 'token_not_found', false, 'known', false, 'fix-environment'],
  [3, 'target_not_found', false, 'known', false, 'ask-user'],
  [4, 'partial_upload_retryable', false, 'mixed', true, 'retry'],
  [4, 'partial_upload_blocked', false, 'mixed', false, 'report-to-human'],
  [4, 'unresolved_backlog', false, 'known', false, 'report-to-human'],
  [5, 'endpoint_unavailable', false, 'unknown', false, 'report-to-human'],
  [6, 'refused_public', false, 'known', false, 'ask-user'],
  [7, 'plan_mismatch', false, 'known', false, 'request-plan'],
  [7, 'plan_missing', false, 'known', false, 'request-plan'],
];

describe('(exitCode, reason) contract', () => {
  it.each(EXPECTED)(
    'code %i / %s resolves to a single unambiguous action',
    (exitCode, reason, ok, state, retryable, nextAction) => {
      const spec = outcomeFor(reason);
      expect(spec.exitCode).toBe(exitCode);
      expect(spec.ok).toBe(ok);
      expect(spec.state).toBe(state);
      expect(spec.retryable).toBe(retryable);
      expect(spec.nextAction).toBe(nextAction);
    },
  );

  it('registers exactly the reasons in the plan and no others', () => {
    expect(OUTCOMES.map((spec) => spec.reason).sort()).toEqual(EXPECTED.map(([, r]) => r).sort());
  });

  it('never maps one reason to two outcomes', () => {
    expect(new Set(OUTCOMES.map((spec) => spec.reason)).size).toBe(OUTCOMES.length);
  });

  it('only ever reports success on exit code 0', () => {
    for (const spec of OUTCOMES) expect(spec.ok).toBe(spec.exitCode === 0);
  });

  it('never invites a retry when the remote state is unknown', () => {
    for (const spec of OUTCOMES) {
      if (spec.state === 'unknown') expect(spec.retryable).toBe(false);
    }
  });

  it('tells a dry run to ask for the plan rather than declaring the job done', () => {
    expect(outcomeFor('dry_run').nextAction).toBe('request-plan');
    expect(outcomeFor('dry_run').exitCode).toBe(0);
  });
});

const file = (over: Partial<FileOutcome>): FileOutcome => ({
  succeeded: false,
  state: 'known',
  retryable: false,
  ...over,
});

describe('partial upload fold', () => {
  it('is retryable when every failure was a transport error that never sent bytes', () => {
    const files = [
      file({ succeeded: true }),
      file({ state: 'known', retryable: true }),
      file({ state: 'known', retryable: true }),
    ];
    expect(foldPartialUpload(files)).toBe('partial_upload_retryable');
  });

  it('is blocked as soon as one outcome is unknown', () => {
    const files = [file({ succeeded: true }), file({ state: 'unknown', retryable: false })];
    expect(foldPartialUpload(files)).toBe('partial_upload_blocked');
  });

  it('is blocked when a failure is permanent even though its state is known', () => {
    const files = [file({ succeeded: true }), file({ state: 'known', retryable: false })];
    expect(foldPartialUpload(files)).toBe('partial_upload_blocked');
  });
});

describe('state fold', () => {
  it('is mixed when some files landed and some did not', () => {
    expect(foldState([file({ succeeded: true }), file({})])).toBe('mixed');
  });

  it('is unknown when nothing landed and an outcome is unknown', () => {
    expect(foldState([file({ state: 'unknown' })])).toBe('unknown');
  });

  it('is known when everything landed', () => {
    expect(foldState([file({ succeeded: true }), file({ succeeded: true })])).toBe('known');
  });
});

describe('error model', () => {
  it('carries the reason through to its outcome', () => {
    const error = new EasyCastError('target_not_found', 'no such pull request');
    expect(error.outcome.exitCode).toBe(3);
    expect(error.outcome.nextAction).toBe('ask-user');
  });

  it('reports an unexpected throw as an internal error with unknown state', () => {
    const error = toEasyCastError(new TypeError('boom'));
    expect(error.reason).toBe('internal_error');
    expect(error.outcome.state).toBe('unknown');
    expect(error.outcome.exitCode).toBe(1);
  });

  it('passes an EasyCastError through unchanged', () => {
    const original = new EasyCastError('refused_public', 'public repository');
    expect(toEasyCastError(original)).toBe(original);
  });
});
