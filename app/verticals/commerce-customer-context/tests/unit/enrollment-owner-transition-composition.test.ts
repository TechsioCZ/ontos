import { DateTime, Effect, Option, Schema, Struct } from 'effect';
import { expect, it } from 'effect-rstest';

import { CommercePortalAuthAccountLookupService } from '../../api/portal-auth/provider/account-lookup-service.ts';
import type { CommercePortalAuthAccountLookup } from '../../api/portal-auth/provider/account-lookup-service.ts';
import { CommercePortalAuthAccountCreationReconciliationService } from '../../api/portal-auth/provider/account-creation-reconciliation-service.ts';
import { CommercePortalAuthAccountCreationUnavailable } from '../../api/portal-auth/provider/account-creation-unavailable.ts';
import {
  CommercePortalAccountSubjectSchema,
  EnrollmentOwnerOperationSnapshotSchema,
  EnrollmentActionInvocationIdSchema,
  EnrollmentAttemptIdSchema,
  EnrollmentKeySchema,
  EnrollmentLegalEntityIdSchema,
  EnrollmentModuleKeySchema,
  EnrollmentPrincipalIdSchema,
  EnrollmentTenantIdSchema,
  EnrollmentTransitionKeySchema,
} from '../../shared/enrollment-contracts.ts';
import { RetailEnrollmentEvidenceSchema } from '@app/party-registry/api';
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
import { CommerceEnrollmentOwnerTransactionRunner } from '../../src/enrollment/orchestration/owner-transition-production.ts';
import {
  CLAIM_PORTAL_ENROLLMENT_TRANSITION_ACTION_KEY,
  PORTAL_ACCOUNT_CREATION_TRANSITION_KEY,
  PORTAL_AUTH_OWNER_MODULE_KEY,
  RECORD_PORTAL_ENROLLMENT_OUTCOME_ACTION_KEY,
} from '../../src/enrollment/orchestration/prepared-owner-authority.ts';
import type { CommerceEnrollmentPreparedOwnerBinding } from '../../src/enrollment/orchestration/prepared-owner-authority.ts';

import {
  retailEnrollmentVerificationRequired,
  verifiedRetailEnrollmentEvidence,
} from '../../src/enrollment/orchestration/owner-effect-registry.ts';

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
  verifiedEmailForOwnerInvocation: () => Effect.succeed(false),
};

const portFor = (attemptFailure: CommerceEnrollmentAttemptError) =>
  makeCommerceEnrollmentPortalAuthOwnerPreparationPort().pipe(
    Effect.provideService(CommerceEnrollmentOwnerTransactionRunner, {
      run: () => Effect.fail(attemptFailure),
      runWorker: () => Effect.fail(attemptFailure),
    }),
    Effect.provideService(CommercePortalAuthAccountLookupService, accountLookupNeverRead),
    Effect.provideService(CommercePortalAuthAccountCreationReconciliationService, {
      reissueVerificationEmail: () => Effect.succeedNone,
    }),
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
      Effect.provideService(CommercePortalAuthAccountCreationReconciliationService, {
        reissueVerificationEmail: () => Effect.succeedNone,
      }),
    );
    yield* port.prepare(claimBinding);
    expect(transactions).toBe(1);
  }),
);

const observedAttempt = (overrides: Partial<EnrollmentAttemptSnapshot> = {}): EnrollmentAttemptSnapshot => ({
  compositionRevision: 'c'.repeat(64),
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

it.effect(
  'reports a creation the provider never correlated as absent, so the same invocation is dispatched again',
  () =>
    Effect.gen(function* absentWithoutASubject() {
      const observation = yield* providerObservationFor(observedAttempt(), accountLookupNeverRead, ownerInvocationId);
      expect(observation.outcome).toBe('NOT_FOUND');
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
      verifiedEmailForOwnerInvocation: () => Effect.succeed(false),
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
      verifiedEmailForOwnerInvocation: () => Effect.succeed(false),
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
      verifiedEmailForOwnerInvocation: () => Effect.succeed(false),
    };
    const observation = yield* providerObservationFor(observedAttempt(), lookup, ownerInvocationId);
    expect(observation).toStrictEqual({ evidenceRef: String(attemptId), outcome: 'NOT_FOUND' });
  }),
);

const sellingLegalEntityId = '70000000-0000-4000-8000-0000000000a1';
const verifiedAttempt = () =>
  observedAttempt({
    accountSubject: Schema.decodeSync(CommercePortalAccountSubjectSchema)({
      authenticationNamespaceId: 'ontos.commerce.portal.better-auth.v1',
      providerSubjectId: 'provider-user-a1',
      subjectType: 'user',
    }),
    targetLegalEntityId: Schema.decodeSync(EnrollmentLegalEntityIdSchema)(sellingLegalEntityId),
  });
const providerOperation = Schema.decodeUnknownSync(EnrollmentOwnerOperationSnapshotSchema)({
  ...claimBinding,
  createdAt: '2026-09-16T10:00:00.000Z',
  portalEnrollmentOwnerOperationId: '80000000-0000-4000-8000-0000000000a1',
  requestDigest: 'd'.repeat(64),
  required: true,
  revision: 2,
  status: 'SUCCEEDED',
  updatedAt: '2026-09-16T10:01:00.000Z',
});
it.effect('retail continuation gates on the exact creation invocation before preparing any owner claim', () =>
  Effect.gen(function* verificationBeforeOwnerClaim() {
    let verified = false;
    const lookups: { ownerInvocationId: string; providerSubjectId: string }[] = [];
    const lookup: CommercePortalAuthAccountLookup = {
      ...accountLookupNeverRead,
      verifiedEmailForOwnerInvocation: (input) =>
        Effect.sync(() => {
          lookups.push(input);
          return verified;
        }),
    };
    const context = { attempt: verifiedAttempt(), operations: [providerOperation] };
    expect(yield* retailEnrollmentVerificationRequired(context, lookup)).toBe(true);
    verified = true;
    expect(yield* retailEnrollmentVerificationRequired(context, lookup)).toBe(false);
    expect(lookups).toEqual([
      { ownerInvocationId, providerSubjectId: 'provider-user-a1' },
      { ownerInvocationId, providerSubjectId: 'provider-user-a1' },
    ]);
    expect(
      yield* retailEnrollmentVerificationRequired({ ...context, operations: [] }, lookup).pipe(Effect.isFailure),
    ).toBe(true);
    expect(lookups).toHaveLength(2);
  }),
);

const evidenceCandidate = {
  evidenceRefs: ['90000000-0000-4000-8000-0000000000a1'],
  officialIdentifiers: [],
  partyType: 'PERSON' as const,
  provenance: { method: 'commerce.portal-enrollment.self-enrollment', source: 'commerce.customer-context' },
  validFrom: DateTime.makeUnsafe('2026-09-16T10:00:00.000Z'),
};
it.effect(
  'retail attestation rechecks current provider ownership against the exact durable creation operation and subject',
  () =>
    Effect.gen(function* currentProof() {
      let verified = true;
      const lookups: { ownerInvocationId: string; providerSubjectId: string }[] = [];
      const lookup: CommercePortalAuthAccountLookup = {
        ...accountLookupNeverRead,
        verifiedEmailForOwnerInvocation: (input) =>
          Effect.sync(() => {
            lookups.push(input);
            return verified;
          }),
      };
      const input = { attempt: verifiedAttempt(), operations: [providerOperation], sellingLegalEntityId };
      const operation = verifiedRetailEnrollmentEvidence(input, evidenceCandidate, lookup);
      const proof = yield* operation;
      expect(Schema.is(RetailEnrollmentEvidenceSchema)(proof)).toBe(true);
      expect(proof.providerSubjectId).toBe('provider-user-a1');
      expect(proof.providerOwnerInvocationId).toBe(ownerInvocationId);
      expect(lookups).toEqual([{ ownerInvocationId, providerSubjectId: 'provider-user-a1' }]);
      verified = false;
      expect(yield* operation.pipe(Effect.isFailure)).toBe(true);
      expect(lookups).toHaveLength(2);
    }),
);
for (const scenario of [
  'unverified',
  'wrong-journey',
  'wrong-company',
  'wrong-operation-attempt',
  'wrong-operation-tenant',
  'unfinished-operation',
  'missing-subject',
] as const) {
  it.effect(`retail attestation refuses ${scenario} without accepting browser verification flags`, () =>
    Effect.gen(function* denyUnproven() {
      let attempt = verifiedAttempt();
      const operation = { ...providerOperation };
      if (scenario === 'wrong-journey') {
        attempt = { ...attempt, journey: 'COUNTERPARTY_INVITATION' };
      }
      if (scenario === 'wrong-company') {
        attempt = Struct.omit(attempt, ['targetLegalEntityId']);
      }
      if (scenario === 'missing-subject') {
        attempt = Struct.omit(attempt, ['accountSubject']);
      }
      if (scenario === 'wrong-operation-attempt') {
        operation.portalEnrollmentAttemptId = Schema.decodeSync(EnrollmentAttemptIdSchema)(sellingLegalEntityId);
      }
      if (scenario === 'wrong-operation-tenant') {
        operation.tenantId = Schema.decodeSync(EnrollmentTenantIdSchema)(sellingLegalEntityId);
      }
      if (scenario === 'unfinished-operation') {
        operation.status = 'IN_PROGRESS';
      }
      let checks = 0;
      const lookup: CommercePortalAuthAccountLookup = {
        ...accountLookupNeverRead,
        verifiedEmailForOwnerInvocation: () =>
          Effect.sync(() => {
            checks += 1;
            return scenario !== 'unverified';
          }),
      };
      expect(
        yield* verifiedRetailEnrollmentEvidence(
          { attempt, operations: [operation], sellingLegalEntityId },
          evidenceCandidate,
          lookup,
        ).pipe(Effect.isFailure),
      ).toBe(true);
      expect(checks).toBe(scenario === 'unverified' ? 1 : 0);
    }),
  );
}
