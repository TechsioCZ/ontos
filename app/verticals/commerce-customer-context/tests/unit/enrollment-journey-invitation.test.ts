import { Effect, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type {
  AccessInstant,
  CounterpartyAccessDecision,
  CounterpartyPermissionScope,
  PrincipalRef,
} from '../../shared/domain/access-contract.ts';
import { CounterpartyAccessUnavailable } from '../../shared/domain/access-error.ts';
import { CounterpartyAccessContractViolation } from '../../shared/domain/access-port.ts';
import {
  CounterpartyAccessInvitationSchema,
  VerifiedInvitationClaimAttestationSchema,
} from '../../shared/domain/invitation-contract.ts';
import type { CounterpartyAccessInvitation, InvitationGrantProgress } from '../../shared/domain/invitation-contract.ts';
import type { CounterpartyPermissionCode } from '../../shared/domain/permission-catalog.ts';
import {
  EnrollmentActionInvocationIdSchema,
  EnrollmentAttemptIdSchema,
  EnrollmentEvidenceReferenceSchema,
  EnrollmentPrincipalIdSchema,
  EnrollmentTenantIdSchema,
} from '../../shared/enrollment-contracts.ts';
import {
  CounterpartyInvitationClaimGateway,
  CounterpartyInvitationClaimObservationSchema,
} from '../../src/enrollment/journeys/counterparty-invitation-claim-gateway.ts';
import type {
  CounterpartyInvitationClaimDispatchResult,
  CounterpartyInvitationClaimGatewayService,
  CounterpartyInvitationClaimObservation,
} from '../../src/enrollment/journeys/counterparty-invitation-claim-gateway.ts';
import { counterpartyInvitationClaimOwnerEffect } from '../../src/enrollment/journeys/counterparty-invitation-claim-owner.ts';
import { CounterpartyInvitationClaimRejected } from '../../src/enrollment/journeys/counterparty-invitation-claim-rejection.ts';
import {
  COUNTERPARTY_INVITATION_GRANTOR_PERMISSION,
  preflightCounterpartyInvitationClaim,
} from '../../src/enrollment/journeys/counterparty-invitation-preflight.ts';
import type {
  CounterpartyInvitationClaimPreflight,
  CounterpartyInvitationClaimPreflightRequest,
} from '../../src/enrollment/journeys/counterparty-invitation-preflight.ts';
import { CounterpartyInvitationReads } from '../../src/enrollment/journeys/counterparty-invitation-reads.ts';
import type { CounterpartyInvitationReadsService } from '../../src/enrollment/journeys/counterparty-invitation-reads.ts';
import {
  CLAIM_COUNTERPARTY_ACCESS_INVITATION_TRANSITION_KEY,
  COUNTERPARTY_ACCESS_OWNER_MODULE_KEY,
  CORE_IDENTITY_OWNER_MODULE_KEY,
  CORE_PRINCIPAL_BINDING_ACTIVATION_TRANSITION_KEY,
  CounterpartyInvitationSubjectSchema,
  CounterpartyInvitationTransitionRejected,
  counterpartyInvitationJourneyDefinition,
  counterpartyInvitationStepPlan,
  makeCounterpartyInvitationRequestDigest,
  makeCounterpartyInvitationTransition,
} from '../../src/enrollment/journeys/counterparty-invitation.ts';
import type {
  CounterpartyInvitationSubject,
  CounterpartyInvitationTransitionInput,
  CounterpartyInvitationTransitionIntent,
} from '../../src/enrollment/journeys/counterparty-invitation.ts';
import type { JourneyTransitionSpec } from '../../src/enrollment/journeys/journey-contracts.ts';
import type {
  CommerceEnrollmentOwnerReconciliationInput,
  CommerceEnrollmentOwnerTransition,
} from '../../src/enrollment/orchestration/owner-transition-driver.ts';
import {
  CommerceEnrollmentOwnerEffectRejected,
  CommerceEnrollmentOwnerEffectUnavailable,
} from '../../src/enrollment/orchestration/owner-transition-errors.ts';

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_TENANT_ID = '10000000-0000-4000-8000-0000000000ff';
const CLAIMANT_PRINCIPAL_ID = '40000000-0000-4000-8000-000000000001';
const OTHER_PRINCIPAL_ID = '40000000-0000-4000-8000-0000000000ff';
const INVITER_PRINCIPAL_ID = '40000000-0000-4000-8000-000000000002';
const INVITATION_RESOURCE_ID = '90000000-0000-4000-8000-000000000001';
const COUNTERPARTY_RESOURCE_ID = '80000000-0000-4000-8000-000000000001';
const LEGAL_ENTITY_ID = 'a0000000-0000-4000-8000-000000000001';
const OWNER_INVOCATION_UUID = '30000000-0000-4000-8000-000000000001';
const OBSERVED_AT: AccessInstant = '2026-09-17T10:00:00.000Z';
const EXPIRES_AT: AccessInstant = '2026-09-30T10:00:00.000Z';

const CorrelationIdSchema = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
).pipe(Schema.brand('CommerceEnrollmentOwnerCorrelationId'));

const tenantId = Schema.decodeSync(EnrollmentTenantIdSchema)(TENANT_ID);
const otherTenantId = Schema.decodeSync(EnrollmentTenantIdSchema)(OTHER_TENANT_ID);
const attemptId = Schema.decodeSync(EnrollmentAttemptIdSchema)('20000000-0000-4000-8000-000000000001');
const ownerInvocationId = Schema.decodeSync(EnrollmentActionInvocationIdSchema)(OWNER_INVOCATION_UUID);
const actorPrincipalId = Schema.decodeSync(EnrollmentPrincipalIdSchema)(CLAIMANT_PRINCIPAL_ID);
const evidenceRef = Schema.decodeSync(EnrollmentEvidenceReferenceSchema)('70000000-0000-4000-8000-000000000001');
const selfEvidenceRef = Schema.decodeSync(EnrollmentEvidenceReferenceSchema)(OWNER_INVOCATION_UUID);
const correlationId = Schema.decodeSync(CorrelationIdSchema)('counterparty-invitation-unit');

const scope: CounterpartyPermissionScope = { kind: 'counterparty' };
const counterpartyRef = {
  moduleId: 'party.registry',
  resourceId: COUNTERPARTY_RESOURCE_ID,
  resourceType: 'party.registry.counterparty',
  tenantId: TENANT_ID,
} as const;
const invitationRef = {
  moduleId: 'commerce.customer-context',
  resourceId: INVITATION_RESOURCE_ID,
  resourceType: 'commerce.customer-context.counterparty-access-invitation',
  tenantId: TENANT_ID,
} as const;
const claimant: PrincipalRef = { principalId: CLAIMANT_PRINCIPAL_ID, tenantId: TENANT_ID };
const otherClaimant: PrincipalRef = { principalId: OTHER_PRINCIPAL_ID, tenantId: TENANT_ID };
const invitedBy: PrincipalRef = { principalId: INVITER_PRINCIPAL_ID, tenantId: TENANT_ID };

const FIRST_PERMISSION: CounterpartyPermissionCode = 'counterparty.profile.read';
const SECOND_PERMISSION: CounterpartyPermissionCode = 'counterparty.purchase.prepare';
const INTENDED_PERMISSIONS: readonly CounterpartyPermissionCode[] = [FIRST_PERMISSION, SECOND_PERMISSION];

const subject: CounterpartyInvitationSubject = Schema.decodeSync(CounterpartyInvitationSubjectSchema)({
  claimant,
  counterpartyRef,
  invitationRef,
  scope,
});

const grantRef = (index: number) =>
  ({
    moduleId: 'commerce.customer-context',
    resourceId: `b000000${index}-0000-4000-8000-000000000001`,
    resourceType: 'commerce.customer-context.counterparty-commerce-access-grant',
    tenantId: TENANT_ID,
  }) as const;

const activeProgress: readonly InvitationGrantProgress[] = [
  { grantRef: grantRef(1), permission: FIRST_PERMISSION, state: 'ACTIVE' },
  { grantRef: grantRef(2), permission: SECOND_PERMISSION, state: 'ACTIVE' },
];

const partialProgress: readonly InvitationGrantProgress[] = [
  { grantRef: grantRef(1), permission: FIRST_PERMISSION, state: 'ACTIVE' },
  { permission: SECOND_PERMISSION, state: 'PENDING_GRANT' },
];

type InvitationInput = typeof CounterpartyAccessInvitationSchema.Encoded;
type ObservationInput = typeof CounterpartyInvitationClaimObservationSchema.Encoded;

interface InvitationOverrides {
  readonly claimantRef?: PrincipalRef;
  readonly expiresAt?: AccessInstant;
  readonly grantProgress?: readonly InvitationGrantProgress[];
  readonly intendedPermissions?: readonly CounterpartyPermissionCode[];
  readonly state?: CounterpartyAccessInvitation['state'];
}

const invitation = (overrides: InvitationOverrides = {}): CounterpartyAccessInvitation => {
  const base: InvitationInput = {
    catalogVersion: '1',
    claimProofVersion: 'commerce-invitation-proof.v1',
    counterpartyRef,
    createdAt: '2026-09-01T10:00:00.000Z',
    deliveryMethod: 'VERIFIED_CONTACT_POINT',
    deliveryReference: 'verified-contact-point-1',
    expiresAt: overrides.expiresAt ?? EXPIRES_AT,
    grantProgress: overrides.grantProgress ?? [],
    intendedPermissions: overrides.intendedPermissions ?? INTENDED_PERMISSIONS,
    invitationRef,
    invitedBy,
    reason: 'Counterparty buyer onboarding',
    revision: 3,
    scope,
    state: overrides.state ?? 'PENDING',
  };
  return Schema.decodeSync(CounterpartyAccessInvitationSchema)(
    overrides.claimantRef === undefined ? base : { ...base, claimant: overrides.claimantRef },
  );
};

const attestation = Schema.decodeSync(VerifiedInvitationClaimAttestationSchema)({
  attestationReference: 'attestation-1',
  claimant,
  counterpartyRef,
  invitationRef,
  inviterAuthority: {
    decision: 'ALLOWED',
    inviter: invitedBy,
    permission: COUNTERPARTY_INVITATION_GRANTOR_PERMISSION,
    scope,
  },
  proofVersion: 'commerce-invitation-proof.v1',
  state: 'VERIFIED_AND_CONSUMED',
  verifiedAt: OBSERVED_AT,
});

const allowAll = (): Effect.Effect<CounterpartyAccessDecision, CounterpartyAccessUnavailable> =>
  Effect.succeed('ALLOWED');

const staticReads = (
  observed: CounterpartyAccessInvitation,
  check: CounterpartyInvitationReadsService['check'] = allowAll,
): CounterpartyInvitationReadsService => ({ check, getInvitation: () => Effect.succeed(observed) });

const preflightRequest = (
  overrides: Partial<CounterpartyInvitationClaimPreflightRequest> = {},
): CounterpartyInvitationClaimPreflightRequest => ({
  claimant,
  counterpartyRef,
  invitationRef,
  legalEntityId: LEGAL_ENTITY_ID,
  observedAt: OBSERVED_AT,
  scope,
  tenantId: TENANT_ID,
  ...overrides,
});

const preflight = (
  reads: CounterpartyInvitationReadsService,
  overrides: Partial<CounterpartyInvitationClaimPreflightRequest> = {},
): Effect.Effect<
  CounterpartyInvitationClaimPreflight,
  CounterpartyInvitationClaimRejected | CounterpartyAccessUnavailable | CounterpartyAccessContractViolation
> =>
  preflightCounterpartyInvitationClaim(preflightRequest(overrides)).pipe(
    Effect.provide(Layer.succeed(CounterpartyInvitationReads, reads)),
  );

const step = (transitionKey: string): JourneyTransitionSpec => {
  const found = counterpartyInvitationStepPlan().find((candidate) => candidate.transitionKey === transitionKey);
  if (found === undefined) {
    throw new Error(`the Counterparty invitation journey must declare ${transitionKey}`);
  }
  return found;
};

const claimStep = step(CLAIM_COUNTERPARTY_ACCESS_INVITATION_TRANSITION_KEY);
const coreBindingStep = step(CORE_PRINCIPAL_BINDING_ACTIVATION_TRANSITION_KEY);

const transitionInput = (
  overrides: Partial<CounterpartyInvitationTransitionInput> = {},
): CounterpartyInvitationTransitionInput => ({
  identity: {
    actorPrincipalId,
    correlationId,
    expectedRevision: 1,
    ownerInvocationId,
    portalEnrollmentAttemptId: attemptId,
    tenantId,
  },
  subject,
  ...overrides,
});

const claimTransition: Effect.Effect<CommerceEnrollmentOwnerTransition> = makeCounterpartyInvitationTransition(
  claimStep,
  transitionInput(),
).pipe(Effect.orDie);

const reconciliationInput = (
  transition: CommerceEnrollmentOwnerTransition,
): CommerceEnrollmentOwnerReconciliationInput => ({
  ...transition,
  observedRevision: 2,
  ownerOperationRevision: 2,
});

const dispatchResult = (
  result: CounterpartyInvitationClaimDispatchResult,
): Effect.Effect<CounterpartyInvitationClaimDispatchResult> => Effect.succeed(result);

const gatewayUnavailable = () =>
  Effect.fail(new CounterpartyAccessUnavailable({ code: 'counterparty_access_unavailable', reason: 'not composed' }));

const gatewayLayer = (service: Partial<CounterpartyInvitationClaimGatewayService>) =>
  Layer.succeed(CounterpartyInvitationClaimGateway, {
    claim: gatewayUnavailable,
    observe: gatewayUnavailable,
    ...service,
  });

const dispatchClaim = (claim: CounterpartyInvitationClaimGatewayService['claim']) =>
  Effect.gen(function* dispatchThroughOwner() {
    const transition = yield* claimTransition;
    const owner = yield* counterpartyInvitationClaimOwnerEffect;
    return yield* owner.dispatch(transition);
  }).pipe(Effect.provide(gatewayLayer({ claim })));

const reconcileClaim = (observe: CounterpartyInvitationClaimGatewayService['observe']) =>
  Effect.gen(function* reconcileThroughOwner() {
    const transition = yield* claimTransition;
    const owner = yield* counterpartyInvitationClaimOwnerEffect;
    return yield* owner.reconcile(reconciliationInput(transition));
  }).pipe(Effect.provide(gatewayLayer({ observe })));

const observation = (input: ObservationInput): CounterpartyInvitationClaimObservation =>
  Schema.decodeSync(CounterpartyInvitationClaimObservationSchema)(input);

it('composes exactly the account, claim and binding transitions with no duplicate grant loop', () => {
  expect(counterpartyInvitationJourneyDefinition.kind).toBe('COUNTERPARTY_INVITATION');
  expect(counterpartyInvitationJourneyDefinition.optionalTransitions).toHaveLength(0);
  expect(counterpartyInvitationStepPlan().map((entry) => `${entry.ownerModuleKey}/${entry.transitionKey}`)).toEqual([
    'commerce.portal-auth/provider.account.create',
    `${COUNTERPARTY_ACCESS_OWNER_MODULE_KEY}/${CLAIM_COUNTERPARTY_ACCESS_INVITATION_TRANSITION_KEY}`,
    `${CORE_IDENTITY_OWNER_MODULE_KEY}/${CORE_PRINCIPAL_BINDING_ACTIVATION_TRANSITION_KEY}`,
  ]);
  expect(counterpartyInvitationStepPlan().every((entry) => entry.required)).toBe(true);
});

it.effect('derives one stable request digest per transition from the trusted subject alone', () =>
  Effect.gen(function* derivesStableDigest() {
    const intent = (transitionKey: CounterpartyInvitationTransitionIntent['transitionKey']) =>
      ({
        journey: 'COUNTERPARTY_INVITATION',
        ownerModuleKey: claimStep.ownerModuleKey,
        portalEnrollmentAttemptId: attemptId,
        subject,
        transitionKey,
      }) satisfies CounterpartyInvitationTransitionIntent;
    const first = yield* makeCounterpartyInvitationRequestDigest(intent(claimStep.transitionKey));
    const second = yield* makeCounterpartyInvitationRequestDigest(intent(claimStep.transitionKey));
    const other = yield* makeCounterpartyInvitationRequestDigest(intent(coreBindingStep.transitionKey));
    const transition = yield* claimTransition;
    expect(second).toBe(first);
    expect(other).not.toBe(first);
    expect(transition.requestDigest).toBe(first);
    expect(transition.ownerModuleKey).toBe(COUNTERPARTY_ACCESS_OWNER_MODULE_KEY);
    expect(transition.transitionKey).toBe(CLAIM_COUNTERPARTY_ACCESS_INVITATION_TRANSITION_KEY);
  }),
);

it.effect('refuses a transition the journey does not declare', () =>
  Effect.gen(function* refusesUndeclared() {
    const failure = yield* Effect.flip(
      makeCounterpartyInvitationTransition(
        {
          ownerModuleKey: claimStep.ownerModuleKey,
          required: true,
          transitionKey: coreBindingStep.transitionKey,
        },
        transitionInput(),
      ),
    );
    expect(Schema.is(CounterpartyInvitationTransitionRejected)(failure)).toBe(true);
    expect(failure.code).toBe('counterparty_invitation_transition_undeclared');
  }),
);

it.effect('refuses an invitation subject from another Tenant before any owner effect runs', () =>
  Effect.gen(function* refusesWrongTenantSubject() {
    const failure = yield* Effect.flip(
      makeCounterpartyInvitationTransition(
        claimStep,
        transitionInput({
          identity: {
            actorPrincipalId,
            correlationId,
            expectedRevision: 1,
            ownerInvocationId,
            portalEnrollmentAttemptId: attemptId,
            tenantId: otherTenantId,
          },
        }),
      ),
    );
    expect(failure.code).toBe('counterparty_invitation_tenant_mismatch');
  }),
);

it.effect('rejects an expired invitation as a typed rejection', () =>
  Effect.gen(function* rejectsExpired() {
    const failure = yield* Effect.flip(preflight(staticReads(invitation({ expiresAt: '2026-09-02T10:00:00.000Z' }))));
    expect(failure.code).toBe('invitation_expired');
  }),
);

it.effect('rejects a replayed invitation whose proof an earlier claim already consumed', () =>
  Effect.gen(function* rejectsReplayed() {
    const failure = yield* Effect.flip(
      preflight(staticReads(invitation({ grantProgress: activeProgress, state: 'REVOKED' }))),
    );
    expect(Schema.is(CounterpartyInvitationClaimRejected)(failure)).toBe(true);
    expect(failure.code).toBe('invitation_replayed');
  }),
);

it.effect('rejects an invitation held by a different Principal', () =>
  Effect.gen(function* rejectsWrongSubject() {
    const failure = yield* Effect.flip(
      preflight(
        staticReads(invitation({ claimantRef: otherClaimant, grantProgress: activeProgress, state: 'CLAIMED' })),
      ),
    );
    expect(failure.code).toBe('invitation_recipient_mismatch');
  }),
);

it.effect('rejects a cross-Tenant claim request without reading the invitation at all', () =>
  Effect.gen(function* rejectsWrongTenantRequest() {
    let reads = 0;
    const failure = yield* Effect.flip(
      preflight(
        {
          check: allowAll,
          getInvitation: () => {
            reads += 1;
            return Effect.succeed(invitation());
          },
        },
        { tenantId: OTHER_TENANT_ID },
      ),
    );
    expect(failure.code).toBe('invitation_tenant_mismatch');
    expect(reads).toBe(0);
  }),
);

it.effect('converges a losing concurrent claim on the winning claim exact retained progress', () =>
  Effect.gen(function* convergesConcurrentClaim() {
    const decided = yield* preflight(
      staticReads(invitation({ claimantRef: claimant, grantProgress: partialProgress, state: 'CLAIMING' })),
    );
    if (decided.decision !== 'ALREADY_CLAIMED') {
      throw new Error('the losing claimant must converge on the winning claim');
    }
    expect(decided.retainedGrantProgress).toEqual(partialProgress);
  }),
);

it.effect('refuses the claim when the grantor lost authority over one invited Permission', () =>
  Effect.gen(function* refusesStaleGrantorAuthority() {
    const failure = yield* Effect.flip(
      preflight(
        staticReads(invitation(), ({ permission }) =>
          Effect.succeed(permission === SECOND_PERMISSION ? 'DENIED' : 'ALLOWED'),
        ),
      ),
    );
    expect(failure.code).toBe('invitation_grantor_authority_lost');
  }),
);

it.effect('stays retryable when Current grantor authority cannot be established', () =>
  Effect.gen(function* staysRetryable() {
    const failure = yield* Effect.flip(preflight(staticReads(invitation(), () => Effect.succeed('UNAVAILABLE'))));
    expect(Schema.is(CounterpartyAccessUnavailable)(failure)).toBe(true);
  }),
);

it.effect('rejects a claim whose requested Permission scope no longer matches the invitation scope', () =>
  Effect.gen(function* refusesScopeMismatch() {
    const failure = yield* Effect.flip(
      preflight(staticReads(invitation()), { scope: { kind: 'storefront', storefrontKey: 'storefront-1' } }),
    );
    expect(failure).toBeInstanceOf(CounterpartyInvitationClaimRejected);
    expect(Schema.is(CounterpartyInvitationClaimRejected)(failure) ? failure.code : undefined).toBe(
      'invitation_scope_mismatch',
    );
  }),
);

it.effect('rejects a claim whose invited Permission is no longer delegable under the Current catalog', () =>
  Effect.gen(function* refusesCatalogRevisionChanged() {
    const failure = yield* Effect.flip(
      preflight(staticReads(invitation({ intendedPermissions: ['counterparty.address_book.manage'] }))),
    );
    expect(failure).toBeInstanceOf(CounterpartyInvitationClaimRejected);
    expect(Schema.is(CounterpartyInvitationClaimRejected)(failure) ? failure.code : undefined).toBe(
      'invitation_catalog_revision_changed',
    );
  }),
);

it.effect('reports exactly the invitation own intended Permissions and nothing inherited', () =>
  Effect.gen(function* noPermissionInheritance() {
    const checked: string[] = [];
    const decided = yield* preflight(
      staticReads(invitation(), ({ permission }) => {
        checked.push(permission);
        return Effect.succeed('ALLOWED');
      }),
    );
    if (decided.decision !== 'CLAIMABLE') {
      throw new Error('a current pending invitation must be claimable');
    }
    expect(decided.grantablePermissions).toEqual(INTENDED_PERMISSIONS);
    expect(decided.expectedRevision).toBe(3);
    expect(checked).toEqual([COUNTERPARTY_INVITATION_GRANTOR_PERMISSION, ...INTENDED_PERMISSIONS]);
  }),
);

it.effect('records a claim that staged only part of its grants without any rollback', () =>
  Effect.gen(function* retainsPartialGrants() {
    const outcome = yield* dispatchClaim(() =>
      dispatchResult({
        attestation,
        invitation: invitation({ claimantRef: claimant, grantProgress: partialProgress, state: 'CLAIMING' }),
        outcome: 'CLAIMED',
      }),
    );
    expect(outcome.status).toBe('SUCCEEDED');
    expect(outcome.nextState).toBe('RECONCILIATION_REQUIRED');
    expect(outcome.outcomeCode).toBe('invitation_claim_grants_pending');
    expect(outcome.resultReference).toBe(INVITATION_RESOURCE_ID);
  }),
);

it.effect('projects a fully granted claim as a plain success with no owner-chosen completion', () =>
  Effect.gen(function* recordsCompletedClaim() {
    const outcome = yield* dispatchClaim(() =>
      dispatchResult({
        attestation,
        invitation: invitation({ claimantRef: claimant, grantProgress: activeProgress, state: 'CLAIMED' }),
        outcome: 'CLAIMED',
      }),
    );
    expect(outcome.status).toBe('SUCCEEDED');
    expect(outcome.outcomeCode).toBe('invitation_claimed');
    expect(outcome.nextState).toBeUndefined();
  }),
);

it.effect('turns a consumed invitation proof into one typed owner rejection', () =>
  Effect.gen(function* rejectsConsumedProof() {
    const failure = yield* Effect.flip(
      dispatchClaim(() =>
        dispatchResult({ invitation: invitation(), outcome: 'REJECTED', rejection: 'ALREADY_CONSUMED' }),
      ),
    );
    expect(Schema.is(CommerceEnrollmentOwnerEffectRejected)(failure)).toBe(true);
    expect(failure.code).toBe('invitation_claim_already_consumed');
  }),
);

it.effect('keeps a rate limited claim retryable instead of recording a durable failure', () =>
  Effect.gen(function* keepsRateLimitRetryable() {
    const failure = yield* Effect.flip(
      dispatchClaim(() => dispatchResult({ invitation: invitation(), outcome: 'REJECTED', rejection: 'RATE_LIMITED' })),
    );
    expect(Schema.is(CommerceEnrollmentOwnerEffectUnavailable)(failure)).toBe(true);
  }),
);

it.effect('converges an already claimed invitation held by the Enrollment Attempt Actor', () =>
  Effect.gen(function* convergesAlreadyClaimed() {
    const outcome = yield* dispatchClaim(() =>
      dispatchResult({
        invitation: invitation({ claimantRef: claimant, grantProgress: activeProgress, state: 'CLAIMED' }),
        outcome: 'ALREADY_CLAIMED',
      }),
    );
    expect(outcome.status).toBe('SUCCEEDED');
    expect(outcome.outcomeCode).toBe('invitation_already_claimed');
  }),
);

it.effect('never inherits an invitation claimed by another Principal', () =>
  Effect.gen(function* refusesForeignClaim() {
    const failure = yield* Effect.flip(
      dispatchClaim(() =>
        dispatchResult({
          invitation: invitation({ claimantRef: otherClaimant, grantProgress: activeProgress, state: 'CLAIMED' }),
          outcome: 'ALREADY_CLAIMED',
        }),
      ),
    );
    expect(failure.code).toBe('invitation_claimant_mismatch');
  }),
);

it.effect('resolves a lost claim outcome from the exact original owner invocation', () =>
  Effect.gen(function* reconcilesLostOutcome() {
    const lookedUp: string[] = [];
    const resolution = yield* reconcileClaim((input) => {
      lookedUp.push(String(input.ownerInvocationId));
      return Effect.succeed(
        observation({
          evidenceRef,
          invitation: invitation({ claimantRef: claimant, grantProgress: partialProgress, state: 'CLAIMING' }),
          outcome: 'CLAIMED',
        }),
      );
    });
    expect(lookedUp).toEqual([OWNER_INVOCATION_UUID]);
    expect(resolution.status).toBe('SUCCEEDED');
    expect(resolution.nextState).toBe('RECONCILIATION_REQUIRED');
    expect(resolution.reconciliationRef).toBe(evidenceRef);
    expect(resolution.actorPrincipalId).toBe(actorPrincipalId);
  }),
);

it.effect('refuses owner evidence that is merely the original invocation replayed back', () =>
  Effect.gen(function* refusesSelfEvidence() {
    const failure = yield* Effect.flip(
      reconcileClaim(() =>
        Effect.succeed(
          observation({
            evidenceRef: selfEvidenceRef,
            invitation: invitation({ claimantRef: claimant, grantProgress: activeProgress, state: 'CLAIMED' }),
            outcome: 'CLAIMED',
          }),
        ),
      ),
    );
    expect(Schema.is(CommerceEnrollmentOwnerEffectUnavailable)(failure)).toBe(true);
  }),
);

it.effect('resolves an owner invocation that never claimed as a durable failure', () =>
  Effect.gen(function* reconcilesAbsentClaim() {
    const resolution = yield* reconcileClaim(() =>
      Effect.succeed(observation({ evidenceRef, outcome: 'NOT_CLAIMED' })),
    );
    expect(resolution.status).toBe('FAILED');
    expect(resolution.failureCode).toBe('invitation_claim_not_found');
  }),
);

it.effect('maps an unavailable claim owner to a retryable failure and a violation to a rejection', () =>
  Effect.gen(function* mapsOwnerFailures() {
    const unavailable = yield* Effect.flip(
      dispatchClaim(() =>
        Effect.fail(new CounterpartyAccessUnavailable({ code: 'counterparty_access_unavailable', reason: 'down' })),
      ),
    );
    expect(Schema.is(CommerceEnrollmentOwnerEffectUnavailable)(unavailable)).toBe(true);
    const violation = yield* Effect.flip(
      dispatchClaim(() =>
        Effect.fail(
          new CounterpartyAccessContractViolation({
            code: 'invitation_claimant_mismatch',
            reason: 'An invitation can only be claimed by the authenticated Principal',
          }),
        ),
      ),
    );
    expect(Schema.is(CommerceEnrollmentOwnerEffectRejected)(violation)).toBe(true);
    expect(violation.code).toBe('invitation_claim_invitation_claimant_mismatch');
  }),
);
