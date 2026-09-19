import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CommercePortalAuthAccountLookupService } from '../../api/portal-auth/provider/account-lookup-service.ts';
import type { CommercePortalAuthAccountLookup } from '../../api/portal-auth/provider/account-lookup-service.ts';
import { CommercePortalAuthAccountCreationUnavailable } from '../../api/portal-auth/provider/account-creation-unavailable.ts';
import {
  EnrollmentActionInvocationIdSchema,
  EnrollmentAttemptIdSchema,
  EnrollmentModuleKeySchema,
  EnrollmentPrincipalIdSchema,
  EnrollmentTenantIdSchema,
  EnrollmentTransitionKeySchema,
} from '../../shared/enrollment-contracts.ts';
import {
  CommerceEnrollmentAttemptNotFound,
  CommerceEnrollmentAttemptUnavailable,
} from '../../src/enrollment/attempts/errors.ts';
import type { CommerceEnrollmentAttemptError } from '../../src/enrollment/attempts/errors.ts';
import { makeCommerceEnrollmentPortalAuthOwnerPreparationPort } from '../../src/enrollment/orchestration/owner-transition-composition.ts';
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
  existsByProviderSubjectAndEmail: () =>
    Effect.fail(new CommercePortalAuthAccountCreationUnavailable({ reason: 'not part of this preparation' })),
};

const portFor = (attemptFailure: CommerceEnrollmentAttemptError) =>
  makeCommerceEnrollmentPortalAuthOwnerPreparationPort().pipe(
    Effect.provideService(CommerceEnrollmentOwnerTransactionRunner, {
      run: () => Effect.fail(attemptFailure),
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
      }),
      Effect.provideService(CommercePortalAuthAccountLookupService, accountLookupNeverRead),
    );
    yield* port.prepare(claimBinding);
    expect(transactions).toBe(1);
  }),
);
