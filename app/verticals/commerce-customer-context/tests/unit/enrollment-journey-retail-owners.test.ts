import { PartyCommandNotFoundProblemSchema, PartyCommandUnavailableProblemSchema } from '@app/party-registry/api';
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
  retailCustomerProfileActionExecutor,
  retailCustomerProfileOwnerEffect,
  retailPortalBindingActionExecutor,
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
import {
  CommerceEnrollmentOwnerEffectRejected,
  CommerceEnrollmentOwnerEffectUnavailable,
} from '../../src/enrollment/orchestration/owner-transition-errors.ts';
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
const otherPartyRef: TestPartyRef = { ...partyRef, resourceId: 'party-2' };
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

const partyOwnerInput: RetailPartyCandidateOwnerInput = { candidate, requestCorrelation, tenantId };

const transition = Schema.decodeSync(CommerceEnrollmentOwnerTransitionSchema)({
  actorPrincipalId,
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

const matchResponse = (outcome: 'AMBIGUOUS' | 'MATCHED' | 'NO_MATCH', candidateParties: readonly TestPartyRef[]) => ({
  candidateParties,
  caseRef: outcome === 'AMBIGUOUS' ? caseRef : null,
  decisionRef,
  evidenceExplanation: [],
  matchRuleVersion: '1',
  outcome,
});

const partyExecutors = (
  overrides: Partial<RetailPartyCandidateOwnerExecutors> = {},
): RetailPartyCandidateOwnerExecutors => ({
  createParty: () => Effect.succeed({ decisionRef, outcome: 'CREATED', partyRef }),
  matchParty: () => Effect.succeed(matchResponse('MATCHED', [partyRef])),
  recoverPartyCreate: () =>
    Effect.succeed({ _tag: 'PartyCreateRecovered', result: { decisionRef, outcome: 'CREATED', partyRef } }),
  ...overrides,
});

it.effect('records an exact matched Party as the owner outcome', () =>
  Effect.gen(function* matched() {
    const outcome = yield* retailPartyCandidateOwnerEffect(partyOwnerInput, partyExecutors()).dispatch(transition);
    expect(outcome.status).toBe('SUCCEEDED');
    expect(outcome.outcomeCode).toBe(PARTY_CANDIDATE_MATCHED_OUTCOME_CODE);
    expect(outcome.resultReference).toBe(partyRef.resourceId);
  }),
);

it.effect('halts into reconciliation when the Party match is ambiguous', () =>
  Effect.gen(function* ambiguous() {
    const outcome = yield* retailPartyCandidateOwnerEffect(
      partyOwnerInput,
      partyExecutors({ matchParty: () => Effect.succeed(matchResponse('AMBIGUOUS', [partyRef, otherPartyRef])) }),
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
      partyExecutors({ matchParty: () => Effect.succeed(matchResponse('MATCHED', [partyRef, otherPartyRef])) }),
    ).dispatch(transition);
    expect(outcome.status).toBe('FAILED');
    expect(outcome.outcomeCode).toBe(PARTY_CANDIDATE_AMBIGUOUS_OUTCOME_CODE);
  }),
);

it.effect('creates a Party only on NO_MATCH and keys the create by the immutable owner invocation', () =>
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
        matchParty: () => Effect.succeed(matchResponse('NO_MATCH', [])),
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
        matchParty: () => Effect.succeed(matchResponse('NO_MATCH', [])),
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
              state: 'OPEN',
            },
          }),
      }),
    )
      .reconcile(reconciliationInput)
      .pipe(Effect.flip);
    expect(Schema.is(CommerceEnrollmentOwnerEffectRejected)(error)).toBe(true);
  }),
);

/**
 * The match is the first Party Registry call this transition makes and it is read-only, so a match
 * outage fences the transition indeterminate without any Create having been dispatched. The Party
 * Registry then holds no invocation of that identity at all and answers the commit resolution with
 * its 404: that absence is the proof nothing committed.
 */
const commitResolutionNotFound = () =>
  Effect.fail(
    PartyCommandNotFoundProblemSchema.make({
      detail: 'The Party Registry holds no invocation of this identity.',
      status: 404,
      title: 'Not found',
      type: 'https://ontos.dev/problems/party-command-not-found',
    }),
  );

it.effect('re-runs the read-only match when the Party Registry holds no Create for this invocation', () =>
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
        matchParty: () => Effect.succeed(matchResponse('NO_MATCH', [])),
        recoverPartyCreate: commitResolutionNotFound,
      }),
    ).reconcile(reconciliationInput);

    // Without this, the 404 is read as "the commit resolution is unavailable" and the transition
    // stays indeterminate on every later pass: the Party is never submitted and the journey stalls.
    expect(resolution.status).toBe('SUCCEEDED');
    expect(resolution.outcomeCode).toBe(PARTY_CANDIDATE_CREATED_OUTCOME_CODE);
    expect(resolution.resultReference).toBe(partyRef.resourceId);
    expect(resolution.actorPrincipalId).toBe(actorPrincipalId);
    // The Create still runs under the immutable owner invocation, so a repeated recovery cannot
    // produce a second Party.
    expect(idempotencyKey).toBe(ownerInvocationId);
  }),
);

it.effect('creates no Party when the re-run match names the one Party this Tenant already holds', () =>
  Effect.gen(function* reconcileAfterMatchOutageMatches() {
    let created = 0;
    const resolution = yield* retailPartyCandidateOwnerEffect(
      partyOwnerInput,
      partyExecutors({
        createParty: () =>
          Effect.sync(() => {
            created += 1;
            return { decisionRef, outcome: 'CREATED' as const, partyRef };
          }),
        matchParty: () => Effect.succeed(matchResponse('MATCHED', [partyRef])),
        recoverPartyCreate: commitResolutionNotFound,
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
        matchParty: () =>
          Effect.sync(() => {
            matched += 1;
            return matchResponse('NO_MATCH', []);
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

it.effect('leaves an uncommitted profile ensure to a later retry', () =>
  Effect.gen(function* openEnsure() {
    const error = yield* retailCustomerProfileOwnerEffect(
      profileOwnerInput,
      profileExecutors({ commitResolution: () => Effect.succeed({ state: 'OPEN' }) }),
    )
      .reconcile(reconciliationInput)
      .pipe(Effect.flip);
    expect(Schema.is(CommerceEnrollmentOwnerEffectRejected)(error)).toBe(true);
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
    expect(retailSelfEnrollmentStepPlan()).toHaveLength(4);
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

it('publishes production executors over the vertical typed Action clients', () => {
  const productionExecutors: readonly [
    RetailCustomerProfileOwnerExecutors['ensureProfile'],
    RetailPortalBindingOwnerExecutors['bindProfile'],
  ] = [retailCustomerProfileActionExecutor, retailPortalBindingActionExecutor];
  expect(productionExecutors).toHaveLength(2);
  expect(productionExecutors.every((executor) => executor.length === 3)).toBe(true);
});
