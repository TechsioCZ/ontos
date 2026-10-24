import { RetailEnrollmentEvidenceSchema, PartyCommandUnavailableProblemSchema } from '@app/party-registry/api';
import { DateTime, Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { RetailPortalBindingResult } from '../../shared/actions/bind-retail-portal-profile.ts';
import type { EnsureRetailCustomerProfileResult } from '../../shared/actions/ensure-retail-customer-profile.ts';
import {
  RETAIL_PORTAL_SELF_SERVICE_BASELINE,
  RetailPortalPermissionCodeSchema,
} from '../../shared/domain/profile-contracts.ts';
import {
  EnrollmentActionInvocationIdSchema,
  EnrollmentAttemptIdSchema,
  EnrollmentModuleKeySchema,
  EnrollmentPrincipalIdSchema,
  EnrollmentTenantIdSchema,
  EnrollmentTransitionKeySchema,
} from '../../shared/enrollment-contracts.ts';
import {
  BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY,
  COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY,
  ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY,
  PARTY_CANDIDATE_AMBIGUOUS_OUTCOME_CODE,
  PARTY_CANDIDATE_CREATED_OUTCOME_CODE,
  PARTY_CANDIDATE_MATCHED_OUTCOME_CODE,
  PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY,
  PARTY_REGISTRY_OWNER_MODULE_KEY,
  RETAIL_CUSTOMER_PROFILE_ENSURED_OUTCOME_CODE,
  RETAIL_PORTAL_GRANTS_INCOMPLETE_OUTCOME_CODE,
  RETAIL_PORTAL_PROFILE_BOUND_OUTCOME_CODE,
  retailPartyCandidateDigest,
  retailSelfEnrollmentRequestDigest,
  retailSelfEnrollmentStepPlan,
} from '../../src/enrollment/journeys/retail-self-enrollment-contracts.ts';
import type { JourneyTransitionSpec } from '../../src/enrollment/journeys/journey-contracts.ts';
import { retailPartyCandidateOwnerEffect } from '../../src/enrollment/journeys/retail-self-enrollment-party-owner.ts';
import type {
  RetailPartyCandidateOwnerExecutors,
  RetailPartyCandidateOwnerInput,
} from '../../src/enrollment/journeys/retail-self-enrollment-party-owner.ts';
import { retailSelfEnrollmentPrepareStep } from '../../src/enrollment/journeys/retail-self-enrollment-preparation.ts';
import {
  CommerceActionCommitResolutionFailed,
  retailCustomerProfileOwnerEffect,
  retailPortalBindingOwnerEffect,
  retailPortalGrantsAreComplete,
} from '../../src/enrollment/journeys/retail-self-enrollment-profile-owners.ts';
import type {
  CommerceActionCommitResolution,
  RetailCustomerProfileOwnerExecutors,
  RetailCustomerProfileOwnerInput,
  RetailPortalBindingOwnerExecutors,
  RetailPortalBindingOwnerInput,
} from '../../src/enrollment/journeys/retail-self-enrollment-profile-owners.ts';
import { CommerceEnrollmentOwnerTransitionSchema } from '../../src/enrollment/orchestration/owner-transition-driver.ts';
import type { CommerceEnrollmentOwnerReconciliationInput } from '../../src/enrollment/orchestration/owner-transition-driver.ts';
import { CommerceEnrollmentOwnerEffectUnavailable } from '../../src/enrollment/orchestration/owner-transition-errors.ts';
import type { CommerceEnrollmentPreparedOwnerBinding } from '../../src/enrollment/orchestration/prepared-owner-authority.ts';

const tenantId = Schema.decodeSync(EnrollmentTenantIdSchema)('10000000-0000-4000-8000-000000000001');
const attemptId = Schema.decodeSync(EnrollmentAttemptIdSchema)('20000000-0000-4000-8000-000000000001');
const ownerInvocationId = Schema.decodeSync(EnrollmentActionInvocationIdSchema)('30000000-0000-4000-8000-000000000001');
const actionInvocationId = Schema.decodeSync(EnrollmentActionInvocationIdSchema)(
  '31000000-0000-4000-8000-000000000001',
);
const actorPrincipalId = Schema.decodeSync(EnrollmentPrincipalIdSchema)('40000000-0000-4000-8000-000000000001');
const requestCorrelation = 'retail-owner-unit';
const effectiveAt = DateTime.makeUnsafe('2026-09-19T10:00:00.000Z');

interface TestPartyRef {
  readonly moduleId: 'party.registry';
  readonly resourceId: string;
  readonly resourceType: 'party.registry.party';
  readonly tenantId: typeof tenantId;
}

const partyRef: TestPartyRef = {
  moduleId: 'party.registry',
  resourceId: 'party-1',
  resourceType: 'party.registry.party',
  tenantId,
};
const decisionRef = {
  moduleId: 'party.registry',
  resourceId: 'decision-1',
  resourceType: 'party.registry.party-match-decision',
  tenantId,
} as const;
const caseRef = {
  moduleId: 'party.registry',
  resourceId: 'case-1',
  resourceType: 'party.registry.duplicate-candidate-case',
  tenantId,
} as const;
const sellingLegalEntityRef = {
  moduleId: 'core.identity',
  resourceId: 'selling-legal-entity-1',
  resourceType: 'core.identity.legal-entity',
  tenantId,
} as const;
const principalRef = {
  moduleId: 'core.identity',
  resourceId: '80000000-0000-4000-8000-000000000001',
  resourceType: 'core.identity.principal',
  tenantId,
} as const;
const profileRef = {
  moduleId: 'commerce.customer-context',
  resourceId: 'retail-profile-1',
  resourceType: 'commerce.customer-context.retail-customer-profile',
  tenantId,
} as const;
const bindingRef = {
  moduleId: 'commerce.customer-context',
  resourceId: 'retail-binding-1',
  resourceType: 'commerce.customer-context.retail-portal-profile-binding',
  tenantId,
} as const;

const candidate: RetailPartyCandidateOwnerInput['candidate'] = {
  evidenceRefs: [],
  officialIdentifiers: [],
  partyType: 'PERSON',
  provenance: { method: 'RETAIL_SELF_ENROLLMENT', source: 'commerce.customer-context' },
  validFrom: effectiveAt,
};

const partyOwnerInput = {
  candidate,
  compositionRevision: 'c'.repeat(64),
  legalEntityId: '50000000-0000-4000-8000-000000000001',
  requestCorrelation,
  tenantId,
  verifiedEvidence: Effect.succeed(
    Schema.decodeUnknownSync(RetailEnrollmentEvidenceSchema)({
      authenticationNamespaceId: 'ontos.commerce.portal.better-auth.v1' as const,
      candidateEvidenceRef: '10000000-0000-4000-8000-000000000001',
      emailOwnership: 'VERIFIED' as const,
      enrollmentAttemptId: '20000000-0000-4000-8000-000000000001',
      journey: 'RETAIL_SELF_ENROLLMENT' as const,
      providerOwnerInvocationId: ownerInvocationId,
      providerSubjectId: 'provider-subject',
      sellingLegalEntityId: '50000000-0000-4000-8000-000000000001',
      tenantId,
    }),
  ),
};

const transition = Schema.decodeSync(CommerceEnrollmentOwnerTransitionSchema)({
  actorPrincipalId,
  compositionRevision: 'c'.repeat(64),
  correlationId: requestCorrelation,
  expectedRevision: 1,
  ownerInvocationId,
  ownerModuleKey: PARTY_REGISTRY_OWNER_MODULE_KEY,
  portalEnrollmentAttemptId: attemptId,
  requestDigest: 'a'.repeat(64),
  tenantId,
  transitionKey: PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY,
});

const reconciliationInput: CommerceEnrollmentOwnerReconciliationInput = {
  ...transition,
  observedRevision: 2,
  ownerOperationRevision: 1,
};

const partyExecutors = (
  overrides: Partial<RetailPartyCandidateOwnerExecutors> = {},
): RetailPartyCandidateOwnerExecutors => ({
  acceptEvidence: () => Effect.succeed({ caseRef, decisionRef, outcome: 'AMBIGUOUS' }),
  createParty: () => Effect.succeed({ decisionRef, outcome: 'CREATED', partyRef }),

  recoverPartyCreate: () =>
    Effect.succeed({ _tag: 'PartyCreateRecovered', result: { decisionRef, outcome: 'CREATED', partyRef } }),
  resolveOriginalInvocation: () => Effect.succeed(ownerInvocationId),
  ...overrides,
});

it.effect('never creates a Party before exact provider verification evidence is available', () =>
  Effect.gen(function* noPreVerificationParty() {
    let creates = 0;
    const owner = retailPartyCandidateOwnerEffect(
      {
        ...partyOwnerInput,
        verifiedEvidence: Effect.fail(
          new CommerceEnrollmentOwnerEffectUnavailable({
            code: 'provider_email_verification_required',
            reason: 'Email is not verified',
          }),
        ),
      },
      partyExecutors({
        createParty: () =>
          Effect.sync(() => {
            creates += 1;
            return { decisionRef, outcome: 'CREATED' as const, partyRef };
          }),
      }),
    );
    expect(yield* owner.dispatch(transition).pipe(Effect.isFailure)).toBe(true);
    expect(creates).toBe(0);
  }),
);

it.effect('records an exact matched Party as the owner outcome', () =>
  Effect.gen(function* matched() {
    const outcome = yield* retailPartyCandidateOwnerEffect(
      partyOwnerInput,
      partyExecutors({ createParty: () => Effect.succeed({ decisionRef, outcome: 'MATCHED_EXISTING', partyRef }) }),
    ).dispatch(transition);
    expect(outcome.status).toBe('SUCCEEDED');
    expect(outcome.outcomeCode).toBe(PARTY_CANDIDATE_MATCHED_OUTCOME_CODE);
    expect(outcome.resultReference).toBe(partyRef.resourceId);
  }),
);

it.effect('halts into reconciliation when the Party match is ambiguous', () =>
  Effect.gen(function* ambiguous() {
    const outcome = yield* retailPartyCandidateOwnerEffect(
      partyOwnerInput,
      partyExecutors({ createParty: () => Effect.succeed({ caseRef, decisionRef, outcome: 'AMBIGUOUS' }) }),
    ).dispatch(transition);
    expect(outcome.status).toBe('FAILED');
    expect(outcome.outcomeCode).toBe(PARTY_CANDIDATE_AMBIGUOUS_OUTCOME_CODE);
    expect(outcome.nextState).toBe('RECONCILIATION_REQUIRED');
  }),
);

it.effect('never picks one Party when a match names several inside the Tenant', () =>
  Effect.gen(function* multipleMatches() {
    const outcome = yield* retailPartyCandidateOwnerEffect(
      partyOwnerInput,
      partyExecutors({ createParty: () => Effect.succeed({ caseRef, decisionRef, outcome: 'AMBIGUOUS' }) }),
    ).dispatch(transition);
    expect(outcome.status).toBe('FAILED');
    expect(outcome.outcomeCode).toBe(PARTY_CANDIDATE_AMBIGUOUS_OUTCOME_CODE);
  }),
);

it.effect('submits canonical Create with the immutable owner invocation key', () =>
  Effect.gen(function* createdOnNoMatch() {
    let idempotencyKey: string | null = null;
    const outcome = yield* retailPartyCandidateOwnerEffect(
      partyOwnerInput,
      partyExecutors({
        createParty: (_payload, options) =>
          Effect.sync(() => {
            ({ idempotencyKey } = options);
            return { decisionRef, outcome: 'CREATED' as const, partyRef };
          }),
      }),
    ).dispatch(transition);
    expect(outcome.status).toBe('SUCCEEDED');
    expect(outcome.outcomeCode).toBe(PARTY_CANDIDATE_CREATED_OUTCOME_CODE);
    expect(idempotencyKey).toBe(ownerInvocationId);
  }),
);

it.effect('records an ambiguous committed create as a reconciliation halt', () =>
  Effect.gen(function* ambiguousCreate() {
    const outcome = yield* retailPartyCandidateOwnerEffect(
      partyOwnerInput,
      partyExecutors({
        createParty: () => Effect.succeed({ caseRef, decisionRef, outcome: 'AMBIGUOUS' }),
      }),
    ).dispatch(transition);
    expect(outcome.status).toBe('FAILED');
    expect(outcome.outcomeCode).toBe(PARTY_CANDIDATE_AMBIGUOUS_OUTCOME_CODE);
  }),
);

it.effect('reconciles an indeterminate Party submission by reading the committed decision', () =>
  Effect.gen(function* reconcileCommitted() {
    const resolution = yield* retailPartyCandidateOwnerEffect(partyOwnerInput, partyExecutors()).reconcile(
      reconciliationInput,
    );
    expect(resolution.status).toBe('SUCCEEDED');
    expect(resolution.resultReference).toBe(partyRef.resourceId);
    expect(resolution.actorPrincipalId).toBe(actorPrincipalId);
    expect(String(resolution.reconciliationRef)).not.toBe(String(ownerInvocationId));
  }),
);

it.effect('never resubmits a Party create while the original invocation is still open', () =>
  Effect.gen(function* reconcilePending() {
    const error = yield* retailPartyCandidateOwnerEffect(
      partyOwnerInput,
      partyExecutors({
        recoverPartyCreate: () =>
          Effect.succeed({
            _tag: 'PartyCreateRecoveryPending',
            resolution: {
              _tag: 'PartyCommandCommitResolution',
              invocationId: ownerInvocationId,
              retryCommand: false,
              state: 'RUNNING',
            },
          }),
      }),
    )
      .reconcile(reconciliationInput)
      .pipe(Effect.flip);
    expect(Schema.is(CommerceEnrollmentOwnerEffectUnavailable)(error)).toBe(true);
  }),
);

const commitResolutionNotStarted = () =>
  Effect.succeed({
    _tag: 'PartyCreateRecoveryPending' as const,
    resolution: {
      _tag: 'PartyCommandCommitResolution' as const,
      retryCommand: true as const,
      state: 'NOT_STARTED' as const,
    },
  });

it.effect('submits the same canonical Create only when native recovery proves no invocation', () =>
  Effect.gen(function* reconcileAfterMatchOutage() {
    let idempotencyKey: string | null = null;
    const resolution = yield* retailPartyCandidateOwnerEffect(
      partyOwnerInput,
      partyExecutors({
        createParty: (_payload, options) =>
          Effect.sync(() => {
            ({ idempotencyKey } = options);
            return { decisionRef, outcome: 'CREATED' as const, partyRef };
          }),

        recoverPartyCreate: commitResolutionNotStarted,
      }),
    ).reconcile(reconciliationInput);

    // Native absence authorizes only the same immutable original request/key.
    expect(resolution.status).toBe('SUCCEEDED');
    expect(resolution.outcomeCode).toBe(PARTY_CANDIDATE_CREATED_OUTCOME_CODE);
    expect(resolution.resultReference).toBe(partyRef.resourceId);
    expect(resolution.actorPrincipalId).toBe(actorPrincipalId);
    // The Create still runs under the immutable owner invocation, so a repeated recovery cannot
    // produce a second Party.
    expect(idempotencyKey).toBe(ownerInvocationId);
  }),
);

it.effect('recovery consumes a governed MATCH_EXISTING result without dispatching another Create', () =>
  Effect.gen(function* recoveredMatch() {
    let created = 0;
    const resolution = yield* retailPartyCandidateOwnerEffect(
      partyOwnerInput,
      partyExecutors({
        createParty: () =>
          Effect.sync(() => {
            created += 1;
            return { decisionRef, outcome: 'CREATED' as const, partyRef };
          }),
        recoverPartyCreate: () =>
          Effect.succeed({
            _tag: 'PartyCreateRecovered',
            result: { decisionRef, outcome: 'MATCHED_EXISTING', partyRef },
          }),
      }),
    ).reconcile(reconciliationInput);
    expect(resolution.status).toBe('SUCCEEDED');
    expect(resolution.outcomeCode).toBe(PARTY_CANDIDATE_MATCHED_OUTCOME_CODE);
    expect(created).toBe(0);
  }),
);

it.effect('surfaces a commit resolution that is merely unavailable as an unavailable owner effect', () =>
  Effect.gen(function* reconcileWhenResolutionUnavailable() {
    let matched = 0;
    const error = yield* retailPartyCandidateOwnerEffect(
      partyOwnerInput,
      partyExecutors({
        createParty: () =>
          Effect.sync(() => {
            matched += 1;
            return { decisionRef, outcome: 'CREATED' as const, partyRef };
          }),
        recoverPartyCreate: () =>
          Effect.fail(
            PartyCommandUnavailableProblemSchema.make({
              detail: 'The Party Registry commit resolution could not be reached.',
              retryable: true,
              status: 503,
              title: 'Unavailable',
              type: 'https://ontos.dev/problems/party-command-unavailable',
            }),
          ),
      }),
    )
      .reconcile(reconciliationInput)
      .pipe(Effect.flip);

    // A Party Registry that cannot answer is not a Party Registry that has never heard of this
    // invocation: re-running the submission here could dispatch a Create alongside a committed one.
    expect(Schema.is(CommerceEnrollmentOwnerEffectUnavailable)(error)).toBe(true);
    expect(matched).toBe(0);
  }),
);

const ensureResult = (state: EnsureRetailCustomerProfileResult['state']): EnsureRetailCustomerProfileResult => ({
  outcome: state === 'ACTIVE' ? 'PROFILE_CREATED' : 'PROFILE_ALREADY_EXISTS_SUSPENDED',
  profileRef,
  revision: 1,
  state,
});

const profileOwnerInput: RetailCustomerProfileOwnerInput = {
  compositionRevision: 'a'.repeat(64),
  effectiveAt,
  partyRef,
  requestCorrelation,
  sellingLegalEntityRef,
};

const committedEnsure: CommerceActionCommitResolution<EnsureRetailCustomerProfileResult> = () =>
  Effect.succeed({ result: ensureResult('ACTIVE'), state: 'COMMITTED' });

const profileExecutors = (
  overrides: Partial<RetailCustomerProfileOwnerExecutors> = {},
): RetailCustomerProfileOwnerExecutors => ({
  commitResolution: committedEnsure,
  ensureProfile: () => Effect.succeed(ensureResult('ACTIVE')),
  ...overrides,
});

it.effect('ensures the Retail Customer Profile and reports the exact profile reference', () =>
  Effect.gen(function* ensured() {
    let idempotencyKey: string | null = null;
    const outcome = yield* retailCustomerProfileOwnerEffect(
      profileOwnerInput,
      profileExecutors({
        ensureProfile: (_payload, _correlation, options) =>
          Effect.sync(() => {
            ({ idempotencyKey } = options);
            return ensureResult('ACTIVE');
          }),
      }),
    ).dispatch(transition);
    expect(outcome.status).toBe('SUCCEEDED');
    expect(outcome.outcomeCode).toBe(RETAIL_CUSTOMER_PROFILE_ENSURED_OUTCOME_CODE);
    expect(outcome.resultReference).toBe(profileRef.resourceId);
    expect(idempotencyKey).toBe(ownerInvocationId);
  }),
);

it.effect('refuses to carry portal access on a profile that is not ACTIVE', () =>
  Effect.gen(function* notActive() {
    const outcome = yield* retailCustomerProfileOwnerEffect(
      profileOwnerInput,
      profileExecutors({ ensureProfile: () => Effect.succeed(ensureResult('SUSPENDED')) }),
    ).dispatch(transition);
    expect(outcome.status).toBe('FAILED');
    expect(outcome.nextState).toBeUndefined();
  }),
);

it.effect('reconciles an indeterminate profile ensure through its committed invocation', () =>
  Effect.gen(function* reconcileEnsure() {
    const resolution = yield* retailCustomerProfileOwnerEffect(profileOwnerInput, profileExecutors()).reconcile(
      reconciliationInput,
    );
    expect(resolution.status).toBe('SUCCEEDED');
    expect(resolution.resultReference).toBe(profileRef.resourceId);
  }),
);

it.effect('leaves a running profile ensure to later reconciliation', () =>
  Effect.gen(function* openEnsure() {
    const error = yield* retailCustomerProfileOwnerEffect(
      profileOwnerInput,
      profileExecutors({ commitResolution: () => Effect.succeed({ state: 'RUNNING' }) }),
    )
      .reconcile(reconciliationInput)
      .pipe(Effect.flip);
    expect(Schema.is(CommerceEnrollmentOwnerEffectUnavailable)(error)).toBe(true);
  }),
);

it.effect('surfaces a failed commit resolution as an unavailable owner effect', () =>
  Effect.gen(function* unavailableEnsure() {
    const error = yield* retailCustomerProfileOwnerEffect(
      profileOwnerInput,
      profileExecutors({
        commitResolution: () =>
          Effect.fail(
            new CommerceActionCommitResolutionFailed({
              code: 'commit_resolution_unavailable',
              reason: 'the commit resolution endpoint is down',
            }),
          ),
      }),
    )
      .reconcile(reconciliationInput)
      .pipe(Effect.flip);
    expect(Schema.is(CommerceEnrollmentOwnerEffectUnavailable)(error)).toBe(true);
  }),
);

const permissionMutation = (permission: string, index: number, staged: boolean) => ({
  mutationId: `9000000${String(index)}-0000-4000-8000-000000000001`,
  operation: 'grant' as const,
  permission: Schema.decodeUnknownSync(RetailPortalPermissionCodeSchema)(permission),
  staged,
});

const bindingResult = (staged: boolean, complete = true): RetailPortalBindingResult => {
  const baseline = complete ? RETAIL_PORTAL_SELF_SERVICE_BASELINE : RETAIL_PORTAL_SELF_SERVICE_BASELINE.slice(1);
  return {
    authorizationOperation: 'grant',
    authorizationState: 'PENDING_GRANT',
    bindingRef,
    effectiveAt: '2026-09-19T10:00:00.000Z',
    outcome: 'BINDING_ACTIVATED',
    permissionMutations: baseline.map((permission, index) => permissionMutation(permission, index, staged)),
    revision: 1,
    state: 'ACTIVE',
  };
};

const bindingOwnerInput: RetailPortalBindingOwnerInput = {
  compositionRevision: 'a'.repeat(64),
  effectiveAt,
  enrollmentEvidenceRef: 'enrollment-evidence-1',
  principalRef,
  profileRef,
  reason: 'Retail self-enrollment',
  requestCorrelation,
  sellingLegalEntityRef,
};

const bindingExecutors = (
  overrides: Partial<RetailPortalBindingOwnerExecutors> = {},
): RetailPortalBindingOwnerExecutors => ({
  bindProfile: () => Effect.succeed(bindingResult(true)),
  commitResolution: () => Effect.succeed({ result: bindingResult(true), state: 'COMMITTED' }),
  ...overrides,
});

it.effect('binds the Retail Portal profile when the reviewed grant baseline is staged in full', () =>
  Effect.gen(function* boundWithGrants() {
    const outcome = yield* retailPortalBindingOwnerEffect(bindingOwnerInput, bindingExecutors()).dispatch(transition);
    expect(outcome.status).toBe('SUCCEEDED');
    expect(outcome.outcomeCode).toBe(RETAIL_PORTAL_PROFILE_BOUND_OUTCOME_CODE);
    expect(outcome.resultReference).toBe(bindingRef.resourceId);
  }),
);

it.effect('treats a partially completed grant as a reconciliation halt, not portal access', () =>
  Effect.gen(function* partialGrants() {
    const partial = yield* retailPortalBindingOwnerEffect(
      bindingOwnerInput,
      bindingExecutors({ bindProfile: () => Effect.succeed(bindingResult(true, false)) }),
    ).dispatch(transition);
    expect(partial.status).toBe('FAILED');
    expect(partial.outcomeCode).toBe(RETAIL_PORTAL_GRANTS_INCOMPLETE_OUTCOME_CODE);
    expect(partial.nextState).toBe('RECONCILIATION_REQUIRED');

    const unstaged = yield* retailPortalBindingOwnerEffect(
      bindingOwnerInput,
      bindingExecutors({ bindProfile: () => Effect.succeed(bindingResult(false)) }),
    ).dispatch(transition);
    expect(unstaged.outcomeCode).toBe(RETAIL_PORTAL_GRANTS_INCOMPLETE_OUTCOME_CODE);
    expect(retailPortalGrantsAreComplete(bindingResult(true))).toBe(true);
    expect(retailPortalGrantsAreComplete(bindingResult(true, false))).toBe(false);
  }),
);

it.effect('reconciles an indeterminate binding through its committed invocation', () =>
  Effect.gen(function* reconcileBinding() {
    const resolution = yield* retailPortalBindingOwnerEffect(bindingOwnerInput, bindingExecutors()).reconcile(
      reconciliationInput,
    );
    expect(resolution.status).toBe('SUCCEEDED');
    expect(resolution.resultReference).toBe(bindingRef.resourceId);
  }),
);

const preparationSubject = {
  partyCandidateDigest: retailPartyCandidateDigest(['PERSON', 'Jana Nova']),
  partyRef: Option.some(partyRef),
  portalEnrollmentAttemptId: attemptId,
  principalRef,
  sellingLegalEntityRef,
};

const preparedBinding = (
  transitionKey: string,
  requestDigest: string | null = null,
): CommerceEnrollmentPreparedOwnerBinding => {
  const base = {
    actionInvocationId,
    actionKey: 'commerce.customer-context.claim-portal-enrollment-transition' as const,
    actorPrincipalId,
    expectedRevision: 1,
    ownerInvocationId,
    ownerModuleKey: Schema.decodeSync(EnrollmentModuleKeySchema)(COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY),
    portalEnrollmentAttemptId: attemptId,
    tenantId,
    transitionKey: Schema.decodeSync(EnrollmentTransitionKeySchema)(transitionKey),
  };
  return requestDigest === null ? base : { ...base, requestDigest };
};

const ensureDigest = retailSelfEnrollmentRequestDigest({
  intent: { partyRef, sellingLegalEntityRef, step: 'RETAIL_CUSTOMER_PROFILE' },
  ownerModuleKey: COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY,
  portalEnrollmentAttemptId: attemptId,
  transitionKey: ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY,
});

const stepFor = (transitionKey: string): JourneyTransitionSpec => {
  const step = retailSelfEnrollmentStepPlan().find((declared) => declared.transitionKey === transitionKey);
  if (step === undefined) {
    throw new Error(`The Retail self-enrollment plan declares no ${transitionKey} step`);
  }
  return step;
};

it.effect('prepares only the exact declared transition with the journey-derived digest', () =>
  Effect.gen(function* preparation() {
    expect(retailSelfEnrollmentStepPlan()).toHaveLength(5);
    const ensureStep = stepFor(ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY);
    const prepared = yield* retailSelfEnrollmentPrepareStep(
      preparationSubject,
      ensureStep,
      preparedBinding(ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY, ensureDigest),
    );
    expect(prepared.outcome).toBe('prepared');

    const forged = yield* retailSelfEnrollmentPrepareStep(
      preparationSubject,
      ensureStep,
      preparedBinding(ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY, 'f'.repeat(64)),
    );
    expect(forged.outcome).toBe('denied');

    const foreignTransition = yield* retailSelfEnrollmentPrepareStep(
      preparationSubject,
      ensureStep,
      preparedBinding(BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY),
    );
    expect(foreignTransition.outcome).toBe('denied');
  }),
);

it.effect('vouches for nothing that depends on a Party the journey has not resolved yet', () =>
  Effect.gen(function* withoutParty() {
    const result = yield* retailSelfEnrollmentPrepareStep(
      {
        partyCandidateDigest: preparationSubject.partyCandidateDigest,
        partyRef: Option.none(),
        portalEnrollmentAttemptId: attemptId,
        principalRef,
        sellingLegalEntityRef,
      },
      stepFor(BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY),
      preparedBinding(BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY),
    );
    expect(result.outcome).toBe('not_applicable');
  }),
);

it.effect('rejects a Create result that would link the Attempt to a Party in another Tenant', () =>
  Effect.gen(function* foreignTenantCreateResult() {
    const foreignTenantId = Schema.decodeSync(EnrollmentTenantIdSchema)('90000000-0000-4000-8000-000000000001');
    const failure = yield* retailPartyCandidateOwnerEffect(
      partyOwnerInput,
      partyExecutors({
        createParty: () =>
          Effect.succeed({ decisionRef, outcome: 'CREATED', partyRef: { ...partyRef, tenantId: foreignTenantId } }),
      }),
    )
      .dispatch(transition)
      .pipe(Effect.flip);
    expect(Schema.is(CommerceEnrollmentOwnerEffectUnavailable)(failure)).toBe(true);
    expect(failure.reason).toContain('original Attempt Tenant');
  }),
);

it.effect('rejects a recovered decision owned by another Tenant before producing durable success', () =>
  Effect.gen(function* foreignTenantRecoveryResult() {
    const foreignTenantId = Schema.decodeSync(EnrollmentTenantIdSchema)('90000000-0000-4000-8000-000000000001');
    const failure = yield* retailPartyCandidateOwnerEffect(
      partyOwnerInput,
      partyExecutors({
        recoverPartyCreate: () =>
          Effect.succeed({
            _tag: 'PartyCreateRecovered',
            result: {
              decisionRef: { ...decisionRef, tenantId: foreignTenantId },
              outcome: 'CREATED',
              partyRef,
            },
          }),
      }),
    )
      .reconcile(reconciliationInput)
      .pipe(Effect.flip);
    expect(Schema.is(CommerceEnrollmentOwnerEffectUnavailable)(failure)).toBe(true);
    expect(failure.reason).toContain('original Attempt Tenant');
  }),
);

for (const state of ['NOT_STARTED', 'RETRYABLE'] as const) {
  it.effect(`recovers ${state} profile and binding with the exact original payload and owner key`, () =>
    Effect.gen(function* originalKeyRetry() {
      const profileRequests: unknown[] = [];
      const bindingRequests: unknown[] = [];
      const profile = retailCustomerProfileOwnerEffect(
        profileOwnerInput,
        profileExecutors({
          commitResolution: () => Effect.succeed({ state }),
          ensureProfile: (payload, correlation, options) =>
            Effect.sync(() => {
              profileRequests.push({ correlation, options, payload });
              return ensureResult('ACTIVE');
            }),
        }),
      );
      const binding = retailPortalBindingOwnerEffect(
        bindingOwnerInput,
        bindingExecutors({
          bindProfile: (payload, correlation, options) =>
            Effect.sync(() => {
              bindingRequests.push({ correlation, options, payload });
              return bindingResult(true);
            }),
          commitResolution: () => Effect.succeed({ state }),
        }),
      );
      yield* profile.dispatch(transition);
      expect((yield* profile.reconcile(reconciliationInput)).status).toBe('SUCCEEDED');
      expect(profileRequests).toHaveLength(2);
      expect(profileRequests[0]).toEqual(profileRequests[1]);
      yield* binding.dispatch(transition);
      expect((yield* binding.reconcile(reconciliationInput)).status).toBe('SUCCEEDED');
      expect(bindingRequests).toHaveLength(2);
      expect(bindingRequests[0]).toEqual(bindingRequests[1]);
      expect(bindingRequests[1]).toMatchObject({ options: { idempotencyKey: ownerInvocationId } });
    }),
  );
}
for (const state of ['COMMITTED', 'RUNNING', 'REJECTED'] as const) {
  it.effect(`never redispatches profile or binding in ${state} state`, () =>
    Effect.gen(function* noNativeReplay() {
      const profile = retailCustomerProfileOwnerEffect(
        profileOwnerInput,
        profileExecutors({
          commitResolution: () =>
            Effect.succeed(state === 'COMMITTED' ? { result: ensureResult('ACTIVE'), state } : { state }),
          ensureProfile: () => Effect.die('A nonretryable profile was dispatched'),
        }),
      );
      const binding = retailPortalBindingOwnerEffect(
        bindingOwnerInput,
        bindingExecutors({
          bindProfile: () => Effect.die('A nonretryable binding was dispatched'),
          commitResolution: () =>
            Effect.succeed(state === 'COMMITTED' ? { result: bindingResult(true), state } : { state }),
        }),
      );
      if (state === 'RUNNING') {
        expect(
          Schema.is(CommerceEnrollmentOwnerEffectUnavailable)(
            yield* profile.reconcile(reconciliationInput).pipe(Effect.flip),
          ),
        ).toBe(true);
        expect(
          Schema.is(CommerceEnrollmentOwnerEffectUnavailable)(
            yield* binding.reconcile(reconciliationInput).pipe(Effect.flip),
          ),
        ).toBe(true);
      } else {
        const profileResult = yield* profile.reconcile(reconciliationInput);
        const bindingResultValue = yield* binding.reconcile(reconciliationInput);
        expect(profileResult.status).toBe(state === 'COMMITTED' ? 'SUCCEEDED' : 'FAILED');
        expect(bindingResultValue.status).toBe(state === 'COMMITTED' ? 'SUCCEEDED' : 'FAILED');
        expect(profileResult.nextState).toBeUndefined();
        expect(bindingResultValue.nextState).toBeUndefined();
      }
    }),
  );
}
