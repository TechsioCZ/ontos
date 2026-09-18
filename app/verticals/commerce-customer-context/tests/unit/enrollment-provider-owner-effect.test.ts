import { Effect, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CommercePortalAccountCreateInputSchema } from '../../api/portal-auth/provider/account-create.ts';
import type {
  CommercePortalAccountCreateInputBoundary,
  CommercePortalAccountCreateResult,
  CommercePortalAuthAccountCreationFailure,
  CommercePortalAuthAccountCreationService,
} from '../../api/portal-auth/provider/account-create.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import { CommercePortalAuthAccountCreationRejected } from '../../api/portal-auth/provider/account-creation-rejected.ts';
import { CommercePortalAuthAccountCreationUnavailable } from '../../api/portal-auth/provider/account-creation-unavailable.ts';
import type {
  CommerceEnrollmentOwnerEffect,
  CommerceEnrollmentOwnerTransition,
} from '../../src/enrollment/orchestration/owner-transition-driver.ts';
import { CommerceEnrollmentOwnerTransitionSchema } from '../../src/enrollment/orchestration/owner-transition-driver.ts';
import {
  CommerceEnrollmentProviderOwnerReconciliationObservationSchema,
  makeCommerceEnrollmentPortalAuthOwnerEffect,
} from '../../src/enrollment/orchestration/provider-owner-effect.ts';
import {
  CommerceEnrollmentOwnerEffectIndeterminate,
  CommerceEnrollmentOwnerEffectRejected,
  CommerceEnrollmentOwnerEffectUnavailable,
} from '../../src/enrollment/orchestration/owner-transition-errors.ts';
import {
  EnrollmentActionInvocationIdSchema,
  EnrollmentAttemptIdSchema,
  EnrollmentEvidenceReferenceSchema,
  EnrollmentPrincipalIdSchema,
  EnrollmentTenantIdSchema,
} from '../../shared/enrollment-contracts.ts';

const tenantId = Schema.decodeSync(EnrollmentTenantIdSchema)('10000000-0000-4000-8000-000000000001');
const attemptId = Schema.decodeSync(EnrollmentAttemptIdSchema)('20000000-0000-4000-8000-000000000001');
const ownerInvocationId = Schema.decodeSync(EnrollmentActionInvocationIdSchema)('30000000-0000-4000-8000-000000000001');
const actorPrincipalId = Schema.decodeSync(EnrollmentPrincipalIdSchema)('40000000-0000-4000-8000-000000000001');
const evidenceRef = Schema.decodeSync(EnrollmentEvidenceReferenceSchema)('50000000-0000-4000-8000-000000000001');

const transition: CommerceEnrollmentOwnerTransition = Schema.decodeSync(CommerceEnrollmentOwnerTransitionSchema)({
  actorPrincipalId,
  correlationId: 'provider-owner-unit',
  expectedRevision: 1,
  ownerInvocationId,
  ownerModuleKey: 'commerce.portal-auth',
  portalEnrollmentAttemptId: attemptId,
  requestDigest: 'a'.repeat(64),
  tenantId,
  transitionKey: 'provider.account.create',
});

const accountInput: CommercePortalAccountCreateInputBoundary = Schema.decodeUnknownSync(
  CommercePortalAccountCreateInputSchema,
)({
  email: 'new-user@example.com',
  enrollmentAttemptId: attemptId,
  name: 'New User',
  ownerInvocationId,
  password: Redacted.make('P'.repeat(24)),
  tenantId,
});

const accountResult = (
  overrides: Partial<CommercePortalAccountCreateResult> = {},
): CommercePortalAccountCreateResult => ({
  enrollmentAttemptId: attemptId,
  evidenceRef,
  outcome: 'CREATED',
  providerSubjectId: 'provider-user-1',
  revision: 2,
  ...overrides,
});

const accountCreation = (
  result: Effect.Effect<CommercePortalAccountCreateResult, CommercePortalAuthAccountCreationFailure> = Effect.succeed(
    accountResult(),
  ),
): CommercePortalAuthAccountCreationService['Service'] => ({
  createAccount: () => result,
});

const reconciliationFound = Schema.decodeUnknownSync(CommerceEnrollmentProviderOwnerReconciliationObservationSchema)({
  evidenceRef,
  outcome: 'FOUND',
  providerSubjectId: 'provider-user-2',
});

const reconciliationNotFound = Schema.decodeUnknownSync(CommerceEnrollmentProviderOwnerReconciliationObservationSchema)(
  {
    evidenceRef,
    outcome: 'NOT_FOUND',
  },
);

const malformedObservation = Schema.decodeUnknownSync(CommerceEnrollmentProviderOwnerReconciliationObservationSchema)({
  evidenceRef,
  outcome: 'FOUND',
  providerSubjectId: 'user',
});
Object.defineProperty(malformedObservation, 'evidenceRef', {
  configurable: true,
  value: 'not-a-uuid',
});

const makeOwner = (
  accountService: CommercePortalAuthAccountCreationService['Service'] = accountCreation(),
  observation = reconciliationFound,
): CommerceEnrollmentOwnerEffect =>
  makeCommerceEnrollmentPortalAuthOwnerEffect({
    accountCreation: accountService,
    makeAccountInput: () => Effect.succeed(accountInput),
    reconcileAccount: () => Effect.succeed(observation),
  });

it.effect('binds private Portal Auth creation to the claimed Attempt and emits a proven subject', () =>
  Effect.gen(function* dispatchesAccountCreation() {
    let calls = 0;
    const owner = makeCommerceEnrollmentPortalAuthOwnerEffect({
      accountCreation: {
        createAccount: (input) =>
          Effect.sync(() => {
            calls += 1;
            expect(input.enrollmentAttemptId).toBe(attemptId);
            return accountResult();
          }),
      },
      makeAccountInput: () => Effect.succeed(accountInput),
      reconcileAccount: () => Effect.succeed(reconciliationFound),
    });
    const result = yield* owner.dispatch(transition);
    expect(result.status).toBe('SUCCEEDED');
    expect(result.accountSubject?.authenticationNamespaceId).toBe(COMMERCE_AUTHENTICATION_NAMESPACE_ID);
    expect(result.accountSubject?.providerSubjectId).toBe('provider-user-1');
    expect(result.nextState).toBeUndefined();
    expect(calls).toBe(1);
  }),
);

it.effect('keeps a mismatched post-effect Attempt result recoverable', () =>
  Effect.gen(function* keepsMismatchedResultIndeterminate() {
    const otherAttemptId = Schema.decodeSync(EnrollmentAttemptIdSchema)('70000000-0000-4000-8000-000000000001');
    const owner = makeCommerceEnrollmentPortalAuthOwnerEffect({
      accountCreation: accountCreation(Effect.succeed(accountResult({ enrollmentAttemptId: otherAttemptId }))),
      makeAccountInput: () => Effect.succeed(accountInput),
      reconcileAccount: () => Effect.succeed(reconciliationFound),
    });
    const failure = yield* owner.dispatch(transition).pipe(Effect.flip);
    expect(failure).toBeInstanceOf(CommerceEnrollmentOwnerEffectIndeterminate);
  }),
);

it.effect('rejects an owner input identity mismatch before provider invocation', () =>
  Effect.gen(function* rejectsMismatchedInput() {
    let calls = 0;
    const owner = makeCommerceEnrollmentPortalAuthOwnerEffect({
      accountCreation: {
        createAccount: () =>
          Effect.sync(() => {
            calls += 1;
            return accountResult();
          }),
      },
      makeAccountInput: () =>
        Effect.succeed({
          ...accountInput,
          ownerInvocationId: Schema.decodeSync(EnrollmentActionInvocationIdSchema)(
            '60000000-0000-4000-8000-000000000001',
          ),
        }),
      reconcileAccount: () => Effect.succeed(reconciliationFound),
    });
    const failure = yield* owner.dispatch(transition).pipe(Effect.flip);
    expect(failure).toBeInstanceOf(CommerceEnrollmentOwnerEffectRejected);
    expect(calls).toBe(0);
  }),
);

it.effect('maps provider rejection and unavailability without pretending a final outcome', () =>
  Effect.gen(function* mapsProviderFailures() {
    const rejectedOwner = makeOwner(
      accountCreation(
        Effect.fail(
          new CommercePortalAuthAccountCreationRejected({
            reason: 'duplicate account',
          }),
        ),
      ),
    );
    const rejectedFailure = yield* rejectedOwner.dispatch(transition).pipe(Effect.flip);
    expect(rejectedFailure).toBeInstanceOf(CommerceEnrollmentOwnerEffectRejected);

    const unavailableOwner = makeOwner(
      accountCreation(
        Effect.fail(
          new CommercePortalAuthAccountCreationUnavailable({
            reason: 'provider timeout',
          }),
        ),
      ),
    );
    const unavailableFailure = yield* unavailableOwner.dispatch(transition).pipe(Effect.flip);
    expect(unavailableFailure).toBeInstanceOf(CommerceEnrollmentOwnerEffectUnavailable);
  }),
);

it.effect('reconciles only exact owner lookup observations and records a definitive absence as FAILED', () =>
  Effect.gen(function* reconcilesProviderOutcome() {
    const foundOwner = makeOwner();
    const found = yield* foundOwner.reconcile({
      ...transition,
      observedRevision: 2,
      ownerOperationRevision: 1,
    });
    expect(found.status).toBe('SUCCEEDED');
    expect(found.accountSubject?.providerSubjectId).toBe('provider-user-2');
    expect(found.nextState).toBeUndefined();

    const absentOwner = makeOwner(accountCreation(), reconciliationNotFound);
    const absent = yield* absentOwner.reconcile({
      ...transition,
      observedRevision: 2,
      ownerOperationRevision: 1,
    });
    expect(absent.status).toBe('FAILED');
    expect(absent.failureCode).toBe('provider_account_not_found');
  }),
);

it.effect('fails closed on malformed or self-referential provider reconciliation evidence', () =>
  Effect.gen(function* rejectsUnsafeReconciliation() {
    const malformedOwner = makeCommerceEnrollmentPortalAuthOwnerEffect({
      accountCreation: accountCreation(),
      makeAccountInput: () => Effect.succeed(accountInput),
      reconcileAccount: () => Effect.succeed(malformedObservation),
    });
    const malformed = yield* malformedOwner
      .reconcile({
        ...transition,
        observedRevision: 2,
        ownerOperationRevision: 1,
      })
      .pipe(Effect.flip);
    expect(malformed).toBeInstanceOf(CommerceEnrollmentOwnerEffectIndeterminate);

    const selfReference = Schema.decodeSync(EnrollmentEvidenceReferenceSchema)(ownerInvocationId);
    const selfReferentialOwner = makeOwner(
      accountCreation(),
      Schema.decodeUnknownSync(CommerceEnrollmentProviderOwnerReconciliationObservationSchema)({
        evidenceRef: selfReference,
        outcome: 'NOT_FOUND',
      }),
    );
    const selfReferential = yield* selfReferentialOwner
      .reconcile({
        ...transition,
        observedRevision: 2,
        ownerOperationRevision: 1,
      })
      .pipe(Effect.flip);
    expect(selfReferential).toBeInstanceOf(CommerceEnrollmentOwnerEffectUnavailable);
  }),
);
