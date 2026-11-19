import { APIError } from 'better-auth';
import { ActionPermissionDenied, ActionPolicyDenied } from '@app/core-runtime';
import { attemptUnavailable } from '../../src/enrollment/attempts/errors.ts';
import { Effect, Logger, Redacted } from 'effect';
import { expect, it } from 'effect-rstest';

import { failureLogSummary } from '../../api/portal-auth/problems-support.ts';
import {
  answerEnrollmentActionFailure,
  commercePortalAuthEnrollmentInvalidProblem,
  commercePortalAuthEnrollmentUnavailableProblem,
} from '../../api/portal-auth/enrollment/problems.ts';

it('keeps only the allow-listed failure fields for the operator log', () => {
  const providerFailure = new APIError('INTERNAL_SERVER_ERROR', {
    code: 'COMMERCE_AUTH_PROVIDER_FAILURE',
    message: 'The Commerce portal authentication provider call failed',
  });
  Object.assign(providerFailure, { headers: new Headers({ 'set-cookie': 'session=secret' }) });

  const summary = failureLogSummary(providerFailure);

  expect(summary).toEqual({ failure: 'untagged', status: 'INTERNAL_SERVER_ERROR' });
  expect(JSON.stringify(summary)).not.toContain('secret');
  const ownerFailure = { _tag: 'OwnerUnavailable', operation: 'read', reason: 'owner timeout' } as const;
  expect(failureLogSummary(ownerFailure)).toEqual({
    failure: 'OwnerUnavailable',
    operation: 'read',
    reason: 'owner timeout',
  });
  expect(failureLogSummary('not an object')).toEqual({ failure: 'unrecognized' });
});

it.effect('logs a governed enrollment refusal without publishing its internal reason or logging private fields', () =>
  Effect.gen(function* logsGovernedRefusal() {
    const logs: string[] = [];
    const failure = Object.assign(
      new ActionPermissionDenied({
        code: 'action_permission_denied',
        reason: 'private-provider-detail',
        reasons: ['deny.workload_unbound', 'private-address@example.test'],
      }),
      {
        authorization: 'private-assertion',
        cause: new Error('private-cause'),
        password: Redacted.make('private-credential'),
      },
    );
    const problem = yield* answerEnrollmentActionFailure('commerce.customer-context.start-portal-enrollment')(
      failure,
    ).pipe(
      Effect.flip,
      Effect.provide(
        Logger.layer([
          Logger.make((options) => {
            logs.push(JSON.stringify(Logger.formatStructured.log(options)));
          }),
        ]),
      ),
    );
    expect(problem).toMatchObject({ code: 'enrollment_rejected', status: 403 });
    expect(new Set(Object.keys(problem))).toEqual(new Set(['_tag', 'code', 'detail', 'status', 'title', 'type']));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('ActionPermissionDenied');
    expect(logs[0]).toContain('deny.workload_unbound');
    expect(logs[0]).toContain('commerce.customer-context.start-portal-enrollment');
    expect(logs[0]).not.toContain('private-');
    expect(JSON.stringify(problem)).not.toContain('ActionPermissionDenied');
    expect(JSON.stringify(problem)).not.toContain('deny.workload_unbound');
  }),
);

it.effect('distinguishes an unavailable permission check while retaining the existing closed response', () =>
  Effect.gen(function* logsUnavailablePermissionCheck() {
    const logs: string[] = [];
    const problem = yield* answerEnrollmentActionFailure('commerce.customer-context.start-portal-enrollment')({
      _tag: 'ActionPermissionCheckError',
      reason: 'private-storage-diagnostic',
    }).pipe(
      Effect.flip,
      Effect.provide(
        Logger.layer([
          Logger.make((options) => {
            logs.push(JSON.stringify(Logger.formatStructured.log(options)));
          }),
        ]),
      ),
    );
    expect(problem).toMatchObject({ code: 'enrollment_rejected', status: 403 });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('ActionPermissionCheckError');
    expect(logs[0]).not.toContain('private-storage-diagnostic');
  }),
);

it.effect('preserves transport invalid and unavailable problems without reclassifying them as a refusal', () =>
  Effect.gen(function* preservesTransportFailures() {
    const logs: string[] = [];
    for (const original of [
      commercePortalAuthEnrollmentInvalidProblem(),
      commercePortalAuthEnrollmentUnavailableProblem(),
    ]) {
      const problem = yield* answerEnrollmentActionFailure('commerce.customer-context.start-portal-enrollment')(
        original,
      ).pipe(
        Effect.flip,
        Effect.provide(
          Logger.layer([
            Logger.make((options) => {
              logs.push(JSON.stringify(Logger.formatStructured.log(options)));
            }),
          ]),
        ),
      );
      expect(problem).toBe(original);
    }
    expect(logs).toEqual([]);
  }),
);

it.effect('retains retryable Attempt outages and keeps Policy explanations private', () =>
  Effect.gen(function* logsClosedActionOutcomes() {
    const logs: string[] = [];
    const capture = Logger.layer([
      Logger.make((options) => {
        logs.push(JSON.stringify(Logger.formatStructured.log(options)));
      }),
    ]);
    const unavailable = yield* answerEnrollmentActionFailure('commerce.customer-context.start-portal-enrollment')(
      attemptUnavailable('private-database-detail'),
    ).pipe(Effect.flip, Effect.provide(capture));
    expect(unavailable).toMatchObject({ code: 'enrollment_unavailable', retryable: true, status: 503 });
    const denied = yield* answerEnrollmentActionFailure('commerce.customer-context.start-portal-enrollment')(
      new ActionPolicyDenied({
        code: 'action_policy_denied',
        policyReasonCode: 'private-policy-detail',
        reason: 'private-reason',
      }),
    ).pipe(Effect.flip, Effect.provide(capture));
    expect(denied).toMatchObject({ code: 'enrollment_rejected', status: 403 });
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain('CommerceEnrollmentAttemptUnavailable');
    expect(logs[1]).toContain('ActionPolicyDenied');
    expect(logs.join('')).not.toContain('private-');
  }),
);

it.effect('logs only closed permission codes when the refusal is not a workload binding failure', () =>
  Effect.gen(function* logsClosedPermissionCodes() {
    const logs: string[] = [];
    for (const code of ['action_permission_denied', 'action_approval_required'] as const) {
      const problem = yield* answerEnrollmentActionFailure('commerce.customer-context.start-portal-enrollment')(
        new ActionPermissionDenied({ code, reason: 'private-reason', reasons: ['private-denial-code'] }),
      ).pipe(
        Effect.flip,
        Effect.provide(
          Logger.layer([
            Logger.make((options) => {
              logs.push(JSON.stringify(Logger.formatStructured.log(options)));
            }),
          ]),
        ),
      );
      expect(problem).toMatchObject({ code: 'enrollment_rejected', status: 403 });
      expect(logs.at(-1)).toContain(code);
    }
    expect(logs).toHaveLength(2);
    expect(logs.join('')).not.toContain('private-');
  }),
);

it.effect('never logs a caller-controlled failure tag', () =>
  Effect.gen(function* masksUnknownFailureTag() {
    const logs: string[] = [];
    yield* answerEnrollmentActionFailure('commerce.customer-context.claim-portal-enrollment-transition')({
      _tag: 'private-address@example.test',
    }).pipe(
      Effect.flip,
      Effect.provide(
        Logger.layer([
          Logger.make((options) => {
            logs.push(JSON.stringify(Logger.formatStructured.log(options)));
          }),
        ]),
      ),
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('owner_domain_failure');
    expect(logs[0]).not.toContain('private-address');
  }),
);
