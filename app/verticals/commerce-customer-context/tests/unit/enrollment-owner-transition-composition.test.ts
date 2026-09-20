import { DateTime, Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CommercePortalAuthAccountLookupService } from '../../api/portal-auth/provider/account-lookup-service.ts';
import type { CommercePortalAuthAccountLookup } from '../../api/portal-auth/provider/account-lookup-service.ts';
import { CommercePortalAuthAccountCreationUnavailable } from '../../api/portal-auth/provider/account-creation-unavailable.ts';
import {
  CommercePortalAccountSubjectSchema,
  EnrollmentActionInvocationIdSchema,
  EnrollmentAttemptIdSchema,
  EnrollmentKeySchema,
  EnrollmentModuleKeySchema,
  EnrollmentPrincipalIdSchema,
  EnrollmentTenantIdSchema,
  EnrollmentTransitionKeySchema,
} from '../../shared/enrollment-contracts.ts';
import type { EnrollmentAttemptSnapshot } from '../../shared/enrollment-contracts.ts';
import {
  CommerceEnrollmentAttemptNotFound,
  CommerceEnrollmentAttemptUnavailable,
} from '../../src/enrollment/attempts/errors.ts';
import type { CommerceEnrollmentAttemptError } from '../../src/enrollment/attempts/errors.ts';
import {
  makeCommerceEnrollmentPortalAuthOwnerPreparationPort,
  providerObservationFor,
} from '../../src/enrollment/orchestration/owner-transition-composition.ts';
import { CommerceEnrollmentOwnerEffectIndeterminate } from '../../src/enrollment/orchestration/owner-transition-errors.ts';
import { CommerceEnrollmentOwnerTransactionRunner } from '../../src/enrollment/orchestration/owner-transition-production.ts';
import {
  CLAIM_PORTAL_ENROLLMENT_TRANSITION_ACTION_KEY,
  PORTAL_ACCOUNT_CREATION_TRANSITION_KEY,
  PORTAL_AUTH_OWNER_MODULE_KEY,
  RECORD_PORTAL_ENROLLMENT_OUTCOME_ACTION_KEY,
} from '../../src/enrollment/orchestration/prepared-owner-authority.ts';
import type { CommerceEnrollmentPreparedOwnerBinding } from '../../src/enrollment/orchestration/prepared-owner-authority.ts';

const tenantId = Schema.decodeSync(EnrollmentTenantIdSchema)('10000000-0000-4000-8000-0000000000a1');
const actorPrincipalId = Schema.decodeSync(EnrollmentPrincipalIdSchema)('20000000-0000-4000-8000-0000000000a1');
const actionInvocationId = Schema.decodeSync(EnrollmentActionInvocationIdSchema)(
  '30000000-0000-4000-8000-0000000000a1',
);
const ownerInvocationId = Schema.decodeSync(EnrollmentActionInvocationIdSchema)('40000000-0000-4000-8000-0000000000a1');
const attemptId = Schema.decodeSync(EnrollmentAttemptIdSchema)('50000000-0000-4000-8000-0000000000a1');
const ownerModuleKey = Schema.decodeSync(EnrollmentModuleKeySchema)(PORTAL_AUTH_OWNER_MODULE_KEY);
const transitionKey = Schema.decodeSync(EnrollmentTransitionKeySchema)(PORTAL_ACCOUNT_CREATION_TRANSITION_KEY);

const claimBinding: CommerceEnrollmentPreparedOwnerBinding = {
  actionInvocationId,
  actionKey: CLAIM_PORTAL_ENROLLMENT_TRANSITION_ACTION_KEY,
  actorPrincipalId,
  expectedRevision: 1,
  ownerInvocationId,
  ownerModuleKey,
  portalEnrollmentAttemptId: attemptId,
  tenantId,
  transitionKey,
};

const recordBinding: CommerceEnrollmentPreparedOwnerBinding = {
  ...claimBinding,
  actionKey: RECORD_PORTAL_ENROLLMENT_OUTCOME_ACTION_KEY,
};

const accountLookupNeverRead: CommercePortalAuthAccountLookup = {
  existsByEmail: () =>
    Effect.fail(new CommercePortalAuthAccountCreationUnavailable({ reason: 'not part of this preparation' })),
  existsByProviderSubject: () =>
    Effect.fail(new CommercePortalAuthAccountCreationUnavailable({ reason: 'not part of this preparation' })),
  subjectForOwnerInvocation: () => Effect.succeedNone,
};

const portFor = (attemptFailure: CommerceEnrollmentAttemptError) =>
  makeCommerceEnrollmentPortalAuthOwnerPreparationPort().pipe(
    Effect.provideService(CommerceEnrollmentOwnerTransactionRunner, {
      run: () => Effect.fail(attemptFailure),
      runWorker: () => Effect.fail(attemptFailure),
    }),
    Effect.provideService(CommercePortalAuthAccountLookupService, accountLookupNeverRead),
  );

const retryableAttemptFailure = new CommerceEnrollmentAttemptUnavailable({
  attemptId,
  code: 'attempt_unavailable',
  reason: 'The durable Enrollment Attempt transaction could not be completed',
  retryable: true,
});

const definitiveAttemptFailure = new CommerceEnrollmentAttemptNotFound({
  attemptId,
  code: 'attempt_not_found',
  reason: 'The Enrollment Attempt was not found in the verified Tenant',
  retryable: false,
});

it.effect('binds the installed owner port to the Commerce portal account-creation transition', () =>
  Effect.gen(function* advertisesTheOwnerTransition() {
    const port = yield* portFor(retryableAttemptFailure);
    expect(port.ownerModuleKey).toBe(PORTAL_AUTH_OWNER_MODULE_KEY);
    expect(port.transitionKey).toBe(PORTAL_ACCOUNT_CREATION_TRANSITION_KEY);
  }),
);

it.effect('reports a retryable owner read as unavailable rather than denying the claim', () =>
  Effect.gen(function* keepsRetryableFailuresUnavailable() {
    const port = yield* portFor(retryableAttemptFailure);
    expect(yield* port.prepare(claimBinding)).toStrictEqual({ outcome: 'unavailable' });
    expect(yield* port.prepare(recordBinding)).toStrictEqual({ outcome: 'unavailable' });
  }),
);

it.effect('denies both owner phases when the durable Attempt answer is definitive', () =>
  Effect.gen(function* deniesDefinitiveFailures() {
    const port = yield* portFor(definitiveAttemptFailure);
    expect(yield* port.prepare(claimBinding)).toStrictEqual({ outcome: 'denied' });
    expect(yield* port.prepare(recordBinding)).toStrictEqual({ outcome: 'denied' });
  }),
);

it.effect('opens exactly one owner transaction for the claim phase and never reads the provider', () =>
  Effect.gen(function* opensOneTransactionPerPhase() {
    let transactions = 0;
    const port = yield* makeCommerceEnrollmentPortalAuthOwnerPreparationPort().pipe(
      Effect.provideService(CommerceEnrollmentOwnerTransactionRunner, {
        run: () => {
          transactions += 1;
          return Effect.fail(retryableAttemptFailure);
        },
        runWorker: () => Effect.fail(retryableAttemptFailure),
      }),
      Effect.provideService(CommercePortalAuthAccountLookupService, accountLookupNeverRead),
    );
    yield* port.prepare(claimBinding);
    expect(transactions).toBe(1);
  }),
);

const observedAttempt = (overrides: Partial<EnrollmentAttemptSnapshot> = {}): EnrollmentAttemptSnapshot => ({
  createdAt: DateTime.makeUnsafe('2026-09-16T10:00:00.000Z'),
  createdByPrincipalId: actorPrincipalId,
  intentDigest: 'a'.repeat(64),
  intentKey: Schema.decodeSync(EnrollmentKeySchema)('portal.enrollment.start'),
  journey: 'RETAIL_SELF_ENROLLMENT',
  portalEnrollmentAttemptId: attemptId,
  revision: 1,
  state: 'RECONCILIATION_REQUIRED',
  tenantId,
  updatedAt: DateTime.makeUnsafe('2026-09-16T10:00:00.000Z'),
  ...overrides,
});

it.effect('keeps a creation the provider never correlated indeterminate instead of calling it absent', () =>
  Effect.gen(function* staysIndeterminateWithoutASubject() {
    const failure = yield* Effect.flip(
      providerObservationFor(observedAttempt(), accountLookupNeverRead, ownerInvocationId),
    );
    expect(Schema.is(CommerceEnrollmentOwnerEffectIndeterminate)(failure)).toBe(true);
    expect(failure.code).toBe('provider_account_reconciliation_indeterminate');
  }),
);

it.effect('resolves a recorded subject through the exact provider directory lookup', () =>
  Effect.gen(function* readsTheProviderDirectory() {
    const accountSubject = Schema.decodeSync(CommercePortalAccountSubjectSchema)({
      authenticationNamespaceId: 'ontos.commerce.portal.better-auth.v1',
      providerSubjectId: 'provider-user-a1',
      subjectType: 'user',
    });
    let lookedUp: string | undefined;
    const lookup: CommercePortalAuthAccountLookup = {
      ...accountLookupNeverRead,
      existsByProviderSubject: ({ providerSubjectId }) =>
        Effect.sync(() => {
          lookedUp = providerSubjectId;
          return true;
        }),
      subjectForOwnerInvocation: () =>
        Effect.fail(
          new CommercePortalAuthAccountCreationUnavailable({
            reason: 'the recorded subject must be preferred over the correlation',
          }),
        ),
    };
    const observation = yield* providerObservationFor(observedAttempt({ accountSubject }), lookup, ownerInvocationId);
    expect(lookedUp).toBe('provider-user-a1');
    expect(observation.outcome).toBe('FOUND');
  }),
);

/**
 * The lost-answer case the correlation exists for: Better Auth committed the account and the start
 * route never journalled its subject, so the Attempt carries none. Without the correlation lookup
 * this reconciliation fails `provider_account_reconciliation_indeterminate` forever.
 */
it.effect('recovers a lost creation answer through the provider-side owner-invocation correlation', () =>
  Effect.gen(function* recoversThroughTheCorrelation() {
    let correlatedInvocation: string | undefined;
    let lookedUp: string | undefined;
    const lookup: CommercePortalAuthAccountLookup = {
      ...accountLookupNeverRead,
      existsByProviderSubject: ({ providerSubjectId }) =>
        Effect.sync(() => {
          lookedUp = providerSubjectId;
          return true;
        }),
      subjectForOwnerInvocation: ({ ownerInvocationId: invocation }) =>
        Effect.sync(() => {
          correlatedInvocation = invocation;
          return Option.some('provider-user-lost-answer');
        }),
    };
    const observation = yield* providerObservationFor(observedAttempt(), lookup, ownerInvocationId);
    expect(correlatedInvocation).toBe(String(ownerInvocationId));
    expect(lookedUp).toBe('provider-user-lost-answer');
    expect(observation).toStrictEqual({
      evidenceRef: String(attemptId),
      outcome: 'FOUND',
      providerSubjectId: 'provider-user-lost-answer',
    });
  }),
);

/**
 * A correlation the provider wrote for an account it no longer holds is a definitive absence, not
 * an unknown: reporting FOUND here would journal a subject no session could ever authenticate.
 */
it.effect('reports a correlated subject the provider no longer holds as absent', () =>
  Effect.gen(function* reportsAbsentCorrelatedSubject() {
    const lookup: CommercePortalAuthAccountLookup = {
      ...accountLookupNeverRead,
      existsByProviderSubject: () => Effect.succeed(false),
      subjectForOwnerInvocation: () => Effect.succeedSome('provider-user-vanished'),
    };
    const observation = yield* providerObservationFor(observedAttempt(), lookup, ownerInvocationId);
    expect(observation).toStrictEqual({ evidenceRef: String(attemptId), outcome: 'NOT_FOUND' });
  }),
);
