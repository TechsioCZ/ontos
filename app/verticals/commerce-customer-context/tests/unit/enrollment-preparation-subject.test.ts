import { Effect, Option, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  ActivatePrincipalBindingResultSchema,
  ReadPrincipalBindingResultSchema,
  ReservePrincipalBindingResultSchema,
} from '@app/core-runtime/auth/external-identity-contracts';
import type {
  ActivatePrincipalBindingRequest,
  ExternalIdentityClientOptions,
  ExternalIdentityClientPort,
  ReadPrincipalBindingResult,
  ReservePrincipalBindingRequest,
} from '@app/shared-contracts/server/external-identity-client';

import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import {
  EnrollmentAttemptSnapshotSchema,
  EnrollmentOwnerOperationSnapshotSchema,
} from '../../shared/enrollment-contracts.ts';
import type { EnrollmentAttemptSnapshot } from '../../shared/enrollment-contracts.ts';
import {
  CommerceEnrollmentAttemptNotFound,
  CommerceEnrollmentAttemptRejected,
  CommerceEnrollmentAttemptUnavailable,
} from '../../src/enrollment/attempts/errors.ts';
import type { CommerceEnrollmentOwnerAttemptStore } from '../../src/enrollment/orchestration/owner-transition-driver.ts';
import { commerceEnrollmentPreparationSubjectForPorts } from '../../src/enrollment/orchestration/preparation-subject.ts';
import {
  PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY,
  PARTY_REGISTRY_OWNER_MODULE_KEY,
} from '../../src/enrollment/journeys/retail-self-enrollment-contracts.ts';

/**
 * The resolver is the seam that turns a durable Enrollment Attempt into the journey subject the
 * Retail preparation ports vouch against. Every scenario below pins one crash-safety property: the
 * refs must come back from durable state, never from a fresh mint, so a re-run after an
 * INDETERMINATE outcome converges on the Party and Principal the first run established.
 */

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const ATTEMPT_ID = '20000000-0000-4000-8000-000000000001';
const OTHER_ATTEMPT_ID = '20000000-0000-4000-8000-000000000002';
const LEGAL_ENTITY_ID = '40000000-0000-4000-8000-000000000001';
const PRINCIPAL_ID = '50000000-0000-4000-8000-000000000001';
const BINDING_ID = '80000000-0000-4000-8000-000000000001';
const PARTY_RESOURCE_ID = 'party-registry-party-1';
const INTENT_DIGEST = 'a'.repeat(64);
const OTHER_INTENT_DIGEST = 'b'.repeat(64);

const clientOptions = (): ExternalIdentityClientOptions => ({
  apiKey: Redacted.make('preparation-subject-unit'),
  baseUrl: 'https://core.invalid',
  requestCorrelation: 'preparation-subject-unit',
});

const attemptFor = (overrides: {
  readonly intentDigest?: string;
  readonly portalEnrollmentAttemptId?: string;
  readonly withAccountSubject: boolean;
}): EnrollmentAttemptSnapshot => {
  const base = {
    createdAt: '2026-09-19T00:00:00.000Z',
    createdByPrincipalId: PRINCIPAL_ID,
    intentDigest: overrides.intentDigest ?? INTENT_DIGEST,
    intentKey: 'commerce.customer-context.portal-enrollment.retail_self_enrollment',
    journey: 'RETAIL_SELF_ENROLLMENT' as const,
    portalEnrollmentAttemptId: overrides.portalEnrollmentAttemptId ?? ATTEMPT_ID,
    revision: 2,
    state: 'IN_PROGRESS' as const,
    targetLegalEntityId: LEGAL_ENTITY_ID,
    tenantId: TENANT_ID,
    updatedAt: '2026-09-19T00:00:01.000Z',
  };
  return Schema.decodeSync(EnrollmentAttemptSnapshotSchema)(
    overrides.withAccountSubject
      ? {
          ...base,
          accountSubject: {
            authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
            providerSubjectId: 'preparation-subject-provider-1',
            subjectType: 'user' as const,
          },
        }
      : base,
  );
};

const partyOperationFor = (overrides: {
  readonly resultReference?: string;
  readonly status: 'FAILED' | 'SUCCEEDED';
}) => {
  const base = {
    actorPrincipalId: PRINCIPAL_ID,
    createdAt: '2026-09-19T00:00:00.000Z',
    ownerInvocationId: '30000000-0000-4000-8000-000000000001',
    ownerModuleKey: PARTY_REGISTRY_OWNER_MODULE_KEY,
    portalEnrollmentAttemptId: ATTEMPT_ID,
    portalEnrollmentOwnerOperationId: '60000000-0000-4000-8000-000000000001',
    requestDigest: 'c'.repeat(64),
    required: true,
    revision: 1,
    status: overrides.status,
    tenantId: TENANT_ID,
    transitionKey: PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY,
    updatedAt: '2026-09-19T00:00:01.000Z',
  };
  return Schema.decodeSync(EnrollmentOwnerOperationSnapshotSchema)(
    overrides.resultReference === undefined ? base : { ...base, resultReference: overrides.resultReference },
  );
};

const storeFor = (
  attempt: EnrollmentAttemptSnapshot,
  operation: ReturnType<typeof partyOperationFor> | undefined,
): CommerceEnrollmentOwnerAttemptStore => ({
  claimTransition: () => Effect.die('The resolver must never claim a transition'),
  read: () => Effect.succeed(attempt),
  readOwnerOperation: () =>
    operation === undefined
      ? Effect.fail(
          new CommerceEnrollmentAttemptNotFound({
            attemptId: attempt.portalEnrollmentAttemptId,
            code: 'attempt_not_found',
            reason: 'No Party transition has been journaled for this Attempt',
            retryable: false,
          }),
        )
      : Effect.succeed(operation),
  reconcileOutcome: () => Effect.die('The resolver must never reconcile an outcome'),
  recordOutcome: () => Effect.die('The resolver must never record an outcome'),
});

const refusingClient: ExternalIdentityClientPort = {
  activatePrincipalBinding: () => Effect.die('The resolver must not activate here'),
  changePrincipalBindingStatus: () => Effect.die('Enrollment never administers a binding status'),
  issueExternalGatewayContext: () => Effect.die('The resolver must not issue a gateway context'),
  readPrincipalBinding: () => Effect.die('The resolver must not read Core here'),
  reservePrincipalBinding: () => Effect.die('The resolver must not reserve here'),
  resolveExternalSubject: () => Effect.die('The resolver must not resolve a subject'),
};

const readingClient = (result: ReadPrincipalBindingResult): ExternalIdentityClientPort => ({
  ...refusingClient,
  readPrincipalBinding: () => Effect.succeed(result),
});

const foundBinding = (bindingStatus: 'active' | 'disabled' | 'pending' | 'revoked'): ReadPrincipalBindingResult =>
  Schema.decodeSync(ReadPrincipalBindingResultSchema)({
    authBindingId: BINDING_ID,
    authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
    bindingRevision: 1,
    bindingStatus,
    originalInvocationId: null,
    outcome: 'FOUND',
    principalId: PRINCIPAL_ID,
    principalStatus: 'active',
    tenantStatus: 'active',
  });

const missingBinding: ReadPrincipalBindingResult = Schema.decodeSync(ReadPrincipalBindingResultSchema)({
  outcome: 'NOT_FOUND',
});

const reservedBinding = Schema.decodeSync(ReservePrincipalBindingResultSchema)({
  authBindingId: BINDING_ID,
  bindingRevision: 1,
  bindingStatus: 'pending',
  outcome: 'RESERVED',
  principalId: PRINCIPAL_ID,
});

const activatedBinding = Schema.decodeSync(ActivatePrincipalBindingResultSchema)({
  authBindingId: BINDING_ID,
  bindingRevision: 2,
  bindingStatus: 'active',
  outcome: 'ACTIVATED',
  principalId: PRINCIPAL_ID,
});

interface RecordedCall {
  readonly activateKeys: string[];
  readonly activatePayloads: ActivatePrincipalBindingRequest[];
  readonly reserveKeys: string[];
  readonly reservePayloads: ReservePrincipalBindingRequest[];
}

const establishingClient = (recorded: RecordedCall): ExternalIdentityClientPort => ({
  ...refusingClient,
  activatePrincipalBinding: (payload, options) => {
    recorded.activateKeys.push(options.idempotencyKey);
    recorded.activatePayloads.push(payload);
    return Effect.succeed(activatedBinding);
  },
  readPrincipalBinding: () => Effect.succeed(missingBinding),
  reservePrincipalBinding: (payload, options) => {
    recorded.reserveKeys.push(options.idempotencyKey);
    recorded.reservePayloads.push(payload);
    return Effect.succeed(reservedBinding);
  },
});

const emptyRecord = (): RecordedCall => ({
  activateKeys: [],
  activatePayloads: [],
  reserveKeys: [],
  reservePayloads: [],
});

const resolveFor = (
  attempt: EnrollmentAttemptSnapshot,
  operation: ReturnType<typeof partyOperationFor> | undefined,
  client: ExternalIdentityClientPort,
) =>
  commerceEnrollmentPreparationSubjectForPorts(storeFor(attempt, operation), client, clientOptions, {
    portalEnrollmentAttemptId: attempt.portalEnrollmentAttemptId,
    tenantId: attempt.tenantId,
  });

it.effect('names the Party the durable owner journal already recorded', () =>
  Effect.gen(function* reusesJournaledParty() {
    const attempt = attemptFor({ withAccountSubject: true });
    const subject = yield* resolveFor(
      attempt,
      partyOperationFor({ resultReference: PARTY_RESOURCE_ID, status: 'SUCCEEDED' }),
      readingClient(foundBinding('active')),
    );

    // Removing the owner-journal read — deriving a Party from the request instead — breaks this:
    // the resolved Party would no longer be the one the first run committed.
    expect(Option.isSome(subject.partyRef)).toBe(true);
    expect(Option.getOrThrow(subject.partyRef).resourceId).toBe(PARTY_RESOURCE_ID);
    expect(Option.getOrThrow(subject.partyRef).tenantId).toBe(TENANT_ID);
  }),
);

it.effect('leaves the Party unresolved while its owner transition has not succeeded', () =>
  Effect.gen(function* unresolvedParty() {
    const attempt = attemptFor({ withAccountSubject: true });
    const halted = yield* resolveFor(
      attempt,
      partyOperationFor({ status: 'FAILED' }),
      readingClient(foundBinding('active')),
    );
    const absent = yield* resolveFor(attempt, undefined, readingClient(foundBinding('active')));

    // Dropping the status/result guards would hand the later steps a Party the owner never
    // resolved, and the preparation port would vouch for a binding against nothing.
    expect(Option.isNone(halted.partyRef)).toBe(true);
    expect(Option.isNone(absent.partyRef)).toBe(true);
  }),
);

it.effect('binds the Principal Core already retains for the Attempt subject', () =>
  Effect.gen(function* reusesRetainedPrincipal() {
    const attempt = attemptFor({ withAccountSubject: true });
    // The client dies on reserve, so a resolver that minted a second binding fails here.
    const subject = yield* resolveFor(attempt, undefined, readingClient(foundBinding('active')));

    expect(subject.principalRef.resourceId).toBe(PRINCIPAL_ID);
    expect(subject.principalRef.tenantId).toBe(TENANT_ID);
  }),
);

it.effect('reserves and activates under keys derived from the Attempt, so a re-run converges', () =>
  Effect.gen(function* convergentEstablish() {
    const attempt = attemptFor({ withAccountSubject: true });
    const recorded = emptyRecord();
    const client = establishingClient(recorded);

    const first = yield* resolveFor(attempt, undefined, client);
    const second = yield* resolveFor(attempt, undefined, client);
    const other = yield* resolveFor(
      attemptFor({ portalEnrollmentAttemptId: OTHER_ATTEMPT_ID, withAccountSubject: true }),
      undefined,
      client,
    );

    expect(first.principalRef).toStrictEqual(second.principalRef);
    // Both runs present the same idempotency key, so Core replays the first binding instead of
    // reserving a second one. Deriving the key from a fresh invocation id breaks exactly this.
    expect(recorded.reserveKeys[0]).toBe(recorded.reserveKeys[1]);
    expect(recorded.activateKeys[0]).toBe(recorded.activateKeys[1]);
    // A different Attempt must never share those keys.
    expect(recorded.reserveKeys[2]).not.toBe(recorded.reserveKeys[0]);
    expect(other.principalRef.resourceId).toBe(PRINCIPAL_ID);
    // Activation always names the exact binding the reserve answered with.
    expect(recorded.activatePayloads[0]?.activation.authBindingId).toBe(BINDING_ID);
    expect(recorded.activatePayloads[0]?.activation.expectedRevision).toBe(1);
  }),
);

it.effect('refuses an Attempt whose retained Core binding is no longer current', () =>
  Effect.gen(function* refusesRevoked() {
    const attempt = attemptFor({ withAccountSubject: true });
    const failure = yield* Effect.flip(resolveFor(attempt, undefined, readingClient(foundBinding('revoked'))));

    // A retryable answer here would loop an enrollment over an identity an operator withdrew.
    expect(failure.retryable).toBe(false);
    expect(Schema.is(CommerceEnrollmentAttemptRejected)(failure)).toBe(true);
  }),
);

it.effect('stays retryable, and never calls Core, until the account transition records a subject', () =>
  Effect.gen(function* waitsForSubject() {
    const attempt = attemptFor({ withAccountSubject: false });
    // Every client method dies, so any Core call at all fails this scenario.
    const failure = yield* Effect.flip(resolveFor(attempt, undefined, refusingClient));

    expect(failure.retryable).toBe(true);
    expect(Schema.is(CommerceEnrollmentAttemptUnavailable)(failure)).toBe(true);
  }),
);

it.effect('derives the Party candidate digest from the Attempt intent alone', () =>
  Effect.gen(function* deterministicDigest() {
    const attempt = attemptFor({ withAccountSubject: true });
    const client = readingClient(foundBinding('active'));
    const first = yield* resolveFor(attempt, undefined, client);
    const second = yield* resolveFor(attempt, undefined, client);
    const different = yield* resolveFor(
      attemptFor({ intentDigest: OTHER_INTENT_DIGEST, withAccountSubject: true }),
      undefined,
      client,
    );

    // A digest that moved between runs would make every retry a new Party candidate.
    expect(first.partyCandidateDigest).toBe(second.partyCandidateDigest);
    expect(first.partyCandidateDigest).not.toBe(different.partyCandidateDigest);
    expect(first.sellingLegalEntityRef.resourceId).toBe(LEGAL_ENTITY_ID);
  }),
);
