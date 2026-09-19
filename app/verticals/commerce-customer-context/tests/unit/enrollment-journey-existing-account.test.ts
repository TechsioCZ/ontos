import type { ReadPrincipalBindingRequest } from '@app/shared-contracts/server/external-identity-client';
import {
  ActivatePrincipalBindingResultSchema,
  AuthBindingIdSchema,
  ReservePrincipalBindingResultSchema,
} from '@app/core-runtime/auth/external-identity-contracts';
import { Effect, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  ACTIVATE_PRINCIPAL_BINDING_TRANSITION_KEY,
  CORE_IDENTITY_OWNER_MODULE_KEY,
  EXISTING_ACCOUNT_CORE_IDENTITY_TRANSITIONS,
  ExistingAccountEnrollmentRejected,
  ExistingAccountEnrollmentSubjectSchema,
  RESERVE_PRINCIPAL_BINDING_TRANSITION_KEY,
  existingAccountCoreIdentityActivateRequest,
  existingAccountCoreIdentityReadByBindingRequest,
  existingAccountCoreIdentityReserveRequest,
  existingAccountJourneyDefinitionFor,
  existingAccountRequestDigest,
  makeExistingAccountTransition,
  validateExistingAccountEnrollmentSubject,
} from '../../src/enrollment/journeys/existing-account.ts';
import type {
  ExistingAccountEnrollmentTransitionInput,
  ExistingAccountEnrollmentTransitionIntent,
} from '../../src/enrollment/journeys/existing-account.ts';
import { retailSelfEnrollmentJourneyDefinition } from '../../src/enrollment/journeys/retail-self-enrollment-contracts.ts';
import type { JourneyTransitionSpec } from '../../src/enrollment/journeys/journey-contracts.ts';
import { PORTAL_ACCOUNT_CREATION_TRANSITION_KEY } from '../../src/enrollment/orchestration/prepared-owner-authority.ts';
import type { CommerceEnrollmentCoreIdentityOwnerEffectOptions } from '../../src/enrollment/orchestration/owner-transition-driver.ts';
import {
  CommerceEnrollmentOwnerTransitionSchema,
  commerceEnrollmentCoreIdentityOwnerEffectFor,
} from '../../src/enrollment/orchestration/owner-transition-driver.ts';
import { CommerceEnrollmentOwnerEffectRejected } from '../../src/enrollment/orchestration/owner-transition-errors.ts';
import {
  CommercePortalAccountSubjectSchema,
  EnrollmentActionInvocationIdSchema,
  EnrollmentAttemptIdSchema,
  EnrollmentPrincipalIdSchema,
  EnrollmentResourceIdSchema,
  EnrollmentTenantIdSchema,
} from '../../shared/enrollment-contracts.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';

/**
 * Unit coverage for issue #338's Existing-account enrollment journey. Every test uses doubles: no
 * database, no HTTP transport, no Core service. The revoked-target-binding scenario reuses
 * `commerceEnrollmentCoreIdentityOwnerEffectFor` exactly as `enrollment-owner-transition-driver.test.ts`
 * does — proving this module wires the Core adapter correctly, not re-deriving the rejection itself.
 */

const tenantId = Schema.decodeSync(EnrollmentTenantIdSchema)('10000000-0000-4000-8000-000000000009');
const otherTenantId = Schema.decodeSync(EnrollmentTenantIdSchema)('10000000-0000-4000-8000-000000000013');
const attemptId = Schema.decodeSync(EnrollmentAttemptIdSchema)('20000000-0000-4000-8000-000000000009');
const actorPrincipalId = Schema.decodeSync(EnrollmentPrincipalIdSchema)('40000000-0000-4000-8000-000000000009');
const ownerInvocationId = Schema.decodeSync(EnrollmentActionInvocationIdSchema)('30000000-0000-4000-8000-000000000009');

const accountSubject = Schema.decodeSync(CommercePortalAccountSubjectSchema)({
  authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
  providerSubjectId: 'existing-account-subject-1',
  subjectType: 'user',
});

const otherSubject = Schema.decodeSync(CommercePortalAccountSubjectSchema)({
  authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
  providerSubjectId: 'existing-account-subject-2',
  subjectType: 'user',
});

/**
 * Build the trusted identity half of a transition input by decoding the full driver schema (which
 * brands `correlationId`) and letting the `Omit<...>` field type structurally retain only what
 * `ExistingAccountEnrollmentTransitionInput['identity']` needs; `ownerModuleKey`, `transitionKey`
 * and `requestDigest` here are placeholders the Omit type erases.
 */
const identityFor = (
  overrides: Partial<ExistingAccountEnrollmentTransitionInput['identity']> = {},
): ExistingAccountEnrollmentTransitionInput['identity'] =>
  Schema.decodeSync(CommerceEnrollmentOwnerTransitionSchema)({
    actorPrincipalId,
    correlationId: 'existing-account-unit',
    expectedRevision: 1,
    ownerInvocationId,
    ownerModuleKey: CORE_IDENTITY_OWNER_MODULE_KEY,
    portalEnrollmentAttemptId: attemptId,
    requestDigest: 'a'.repeat(64),
    tenantId,
    transitionKey: RESERVE_PRINCIPAL_BINDING_TRANSITION_KEY,
    ...overrides,
  });

const subjectFor = (accountSubjectValue: typeof accountSubject, targetTenantId: typeof tenantId = tenantId) =>
  Schema.decodeSync(ExistingAccountEnrollmentSubjectSchema)({
    accountSubject: accountSubjectValue,
    targetTenantId,
  });

const transitionInput = (
  overrides: Partial<ExistingAccountEnrollmentTransitionInput['identity']> = {},
): ExistingAccountEnrollmentTransitionInput => ({
  identity: identityFor(overrides),
  subject: subjectFor(accountSubject),
});

const clientOptions = () => ({
  apiKey: Redacted.make('test'),
  baseUrl: 'https://core.invalid',
  requestCorrelation: 'existing-account-core-unit',
});

/** Find a step this journey declares by its transition key, failing loudly if the fixture drifts. */
const requireTransition = (
  transitions: readonly JourneyTransitionSpec[],
  transitionKey: string,
): JourneyTransitionSpec => {
  const found = transitions.find((candidate) => candidate.transitionKey === transitionKey);
  if (found === undefined) {
    throw new Error(`Expected a declared transition for ${transitionKey}`);
  }
  return found;
};

const reserveStep = requireTransition(
  EXISTING_ACCOUNT_CORE_IDENTITY_TRANSITIONS,
  RESERVE_PRINCIPAL_BINDING_TRANSITION_KEY,
);
const activateStep = requireTransition(
  EXISTING_ACCOUNT_CORE_IDENTITY_TRANSITIONS,
  ACTIVATE_PRINCIPAL_BINDING_TRANSITION_KEY,
);
const delegatedStep = requireTransition(
  retailSelfEnrollmentJourneyDefinition.requiredTransitions,
  PORTAL_ACCOUNT_CREATION_TRANSITION_KEY,
);

// --- Journey composition -----------------------------------------------------------------------

it.effect(
  'composes the Existing-account journey from a target definition, dropping the target account-creation step',
  () =>
    Effect.gen(function* composesJourney() {
      const definition = yield* existingAccountJourneyDefinitionFor(retailSelfEnrollmentJourneyDefinition);
      expect(definition.kind).toBe('EXISTING_ACCOUNT');
      const keys = definition.requiredTransitions.map((step) => `${step.ownerModuleKey}\u0000${step.transitionKey}`);
      expect(keys[0]).toBe(`${CORE_IDENTITY_OWNER_MODULE_KEY}\u0000${RESERVE_PRINCIPAL_BINDING_TRANSITION_KEY}`);
      expect(keys[1]).toBe(`${CORE_IDENTITY_OWNER_MODULE_KEY}\u0000${ACTIVATE_PRINCIPAL_BINDING_TRANSITION_KEY}`);
      expect(
        definition.requiredTransitions.some((step) => step.transitionKey === PORTAL_ACCOUNT_CREATION_TRANSITION_KEY),
      ).toBe(false);
      // Every non-account-creation step of the target is still inherited, unmodified.
      expect(definition.requiredTransitions.length).toBe(
        2 + retailSelfEnrollmentJourneyDefinition.requiredTransitions.length - 1,
      );
    }),
);

it.effect('rejects composing Existing-account against itself as a target', () =>
  Effect.gen(function* rejectsSelfTarget() {
    const definition = yield* Effect.gen(function* selfComposition() {
      const composed = yield* existingAccountJourneyDefinitionFor(retailSelfEnrollmentJourneyDefinition);
      return yield* existingAccountJourneyDefinitionFor(composed);
    }).pipe(Effect.flip);
    expect(definition).toBeInstanceOf(ExistingAccountEnrollmentRejected);
    expect(definition.code).toBe('existing_account_target_journey_invalid');
  }),
);

it.effect('the composed definition orders the two Core identity steps before the delegated target steps', () =>
  Effect.gen(function* stepPlanOrdered() {
    const { requiredTransitions } = yield* existingAccountJourneyDefinitionFor(retailSelfEnrollmentJourneyDefinition);
    expect(requiredTransitions[0]?.transitionKey).toBe(RESERVE_PRINCIPAL_BINDING_TRANSITION_KEY);
    expect(requiredTransitions[1]?.transitionKey).toBe(ACTIVATE_PRINCIPAL_BINDING_TRANSITION_KEY);
    expect(requiredTransitions.every((step) => step.required)).toBe(true);
  }),
);

// --- (b) Subject mismatch -----------------------------------------------------------------------

it.effect('rejects when the requested subject does not match the exact current session subject', () =>
  Effect.gen(function* rejectsMismatch() {
    const error = yield* validateExistingAccountEnrollmentSubject({
      currentSessionSubject: accountSubject,
      requestedAccountSubject: otherSubject,
    }).pipe(Effect.flip);
    expect(error).toBeInstanceOf(ExistingAccountEnrollmentRejected);
    expect(error.code).toBe('existing_account_subject_mismatch');
    expect(error.retryable).toBe(false);
  }),
);

it.effect('accepts the exact current session subject unchanged', () =>
  Effect.gen(function* acceptsMatch() {
    const subject = yield* validateExistingAccountEnrollmentSubject({
      currentSessionSubject: accountSubject,
      requestedAccountSubject: accountSubject,
    });
    expect(subject).toStrictEqual(accountSubject);
  }),
);

// --- Transition building -------------------------------------------------------------------------

it.effect('builds the reserve and activate owner transitions it uniquely owns', () =>
  Effect.gen(function* buildsOwnedTransitions() {
    const reserve = yield* makeExistingAccountTransition(reserveStep, transitionInput());
    expect(reserve.ownerModuleKey).toBe(CORE_IDENTITY_OWNER_MODULE_KEY);
    expect(reserve.transitionKey).toBe(RESERVE_PRINCIPAL_BINDING_TRANSITION_KEY);
    expect(reserve.requestDigest).toMatch(/^[0-9a-f]{64}$/u);

    const activate = yield* makeExistingAccountTransition(activateStep, transitionInput());
    expect(activate.transitionKey).toBe(ACTIVATE_PRINCIPAL_BINDING_TRANSITION_KEY);
    expect(activate.requestDigest).not.toBe(reserve.requestDigest);
  }),
);

it.effect('rejects building a transition for a step it does not own, delegated or otherwise', () =>
  Effect.gen(function* rejectsUndeclared() {
    const error = yield* makeExistingAccountTransition(delegatedStep, transitionInput()).pipe(Effect.flip);
    expect(error).toBeInstanceOf(ExistingAccountEnrollmentRejected);
    expect(error.code).toBe('existing_account_transition_undeclared');
  }),
);

it.effect(
  'rejects building a transition when the requested second Tenant does not match the trusted Attempt Tenant',
  () =>
    Effect.gen(function* rejectsTenantMismatch() {
      const mismatchedInput: ExistingAccountEnrollmentTransitionInput = {
        identity: identityFor(),
        subject: subjectFor(accountSubject, otherTenantId),
      };
      const error = yield* makeExistingAccountTransition(reserveStep, mismatchedInput).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ExistingAccountEnrollmentRejected);
      expect(error.code).toBe('existing_account_tenant_mismatch');
      expect(error.retryable).toBe(false);
    }),
);

it.effect(
  'a mismatched target Tenant is rejected before a digest is derived, so it never produces a second digest for the same step',
  () =>
    Effect.gen(function* mismatchNeverProducesASecondDigest() {
      const matching = yield* makeExistingAccountTransition(reserveStep, transitionInput());
      const mismatchedInput: ExistingAccountEnrollmentTransitionInput = {
        identity: identityFor(),
        subject: subjectFor(accountSubject, otherTenantId),
      };
      const error = yield* makeExistingAccountTransition(reserveStep, mismatchedInput).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ExistingAccountEnrollmentRejected);
      expect(error.code).toBe('existing_account_tenant_mismatch');
      // The mismatched request never reached digest derivation, so there is only ever the one
      // digest for this step — a mismatched `targetTenantId` cannot masquerade as a second,
      // differently-digested request for the same reserve transition.
      expect(matching.requestDigest).toMatch(/^[0-9a-f]{64}$/u);
    }),
);

// --- (d) Replay converges -------------------------------------------------------------------------

it.effect('produces the same digest for an equivalent retry, so replay converges on one durable operation', () =>
  Effect.gen(function* digestConverges() {
    const intent: ExistingAccountEnrollmentTransitionIntent = {
      journey: 'EXISTING_ACCOUNT',
      ownerModuleKey: CORE_IDENTITY_OWNER_MODULE_KEY,
      portalEnrollmentAttemptId: attemptId,
      subject: { accountSubject, targetTenantId: tenantId },
      transitionKey: RESERVE_PRINCIPAL_BINDING_TRANSITION_KEY,
    };
    const first = yield* existingAccountRequestDigest(intent);
    const second = yield* existingAccountRequestDigest(intent);
    expect(second).toBe(first);
  }),
);

it.effect('replaying the exact same transition build produces an identical request digest', () =>
  Effect.gen(function* replayConverges() {
    const first = yield* makeExistingAccountTransition(reserveStep, transitionInput());
    const second = yield* makeExistingAccountTransition(reserveStep, transitionInput());
    expect(second.requestDigest).toBe(first.requestDigest);
  }),
);

// --- Core identity request builders -----------------------------------------------------------

it.effect('builds the Core reserve request from the exact current subject', () =>
  Effect.gen(function* buildsReserveRequest() {
    const request = yield* existingAccountCoreIdentityReserveRequest({
      accountSubject,
      authenticationRef: 'existing-account-authentication-ref',
    });
    expect(request.reservation.providerSubjectId).toBe(accountSubject.providerSubjectId);
    expect(request.reservation.authenticationNamespaceId).toBe(COMMERCE_AUTHENTICATION_NAMESPACE_ID);
  }),
);

it.effect('builds the Core activate request from the reserved binding reference', () =>
  Effect.gen(function* buildsActivateRequest() {
    const authBindingId = Schema.decodeSync(EnrollmentResourceIdSchema)('80000000-0000-4000-8000-000000000009');
    const request = yield* existingAccountCoreIdentityActivateRequest({
      authBindingId,
      authenticationRef: 'existing-account-authentication-ref',
      expectedRevision: 1,
    });
    expect(request.activation.authBindingId).toBe('80000000-0000-4000-8000-000000000009');
    expect(request.activation.expectedRevision).toBe(1);
  }),
);

// --- (a) Happy second-Tenant enrollment: reserve then activate against a fake Core client --------

it.effect('dispatches reserve then activate through the Core identity owner effect for a second Tenant', () =>
  Effect.gen(function* happyPath() {
    const reservedBindingId = Schema.decodeSync(AuthBindingIdSchema)('80000000-0000-4000-8000-000000000010');
    const reserved = Schema.decodeSync(ReservePrincipalBindingResultSchema)({
      authBindingId: reservedBindingId,
      bindingRevision: 1,
      bindingStatus: 'pending',
      outcome: 'RESERVED',
      principalId: '90000000-0000-4000-8000-000000000010',
    });
    const activated = Schema.decodeSync(ActivatePrincipalBindingResultSchema)({
      authBindingId: reservedBindingId,
      bindingRevision: 2,
      bindingStatus: 'active',
      outcome: 'ACTIVATED',
      principalId: '90000000-0000-4000-8000-000000000010',
    });
    const client = {
      activatePrincipalBinding: () => Effect.succeed(activated),
      changePrincipalBindingStatus: () => Effect.die('unused'),
      issueExternalGatewayContext: () => Effect.die('unused'),
      readPrincipalBinding: () => Effect.die('unused'),
      reservePrincipalBinding: () => Effect.succeed(reserved),
      resolveExternalSubject: () => Effect.die('unused'),
    };

    const reserveRequest = yield* existingAccountCoreIdentityReserveRequest({
      accountSubject,
      authenticationRef: 'existing-account-second-tenant',
    });
    const reserveOptions: CommerceEnrollmentCoreIdentityOwnerEffectOptions = {
      client,
      clientOptions,
      makeDispatchRequest: () => ({ operation: 'reserve', payload: reserveRequest }),
      makeReconciliationRequest: () => {
        throw new Error('The dispatch-only path must not reconcile');
      },
    };
    const reserveTransition = yield* makeExistingAccountTransition(reserveStep, transitionInput());
    const reserveOutcome =
      yield* commerceEnrollmentCoreIdentityOwnerEffectFor(reserveOptions).dispatch(reserveTransition);
    expect(reserveOutcome.status).toBe('SUCCEEDED');
    expect(reserveOutcome.resultReference).toBe('80000000-0000-4000-8000-000000000010');
    if (reserveOutcome.resultReference === undefined) {
      throw new Error('the reserve dispatch must report a result reference');
    }
    const authBindingId = reserveOutcome.resultReference;
    const activateRequest = yield* existingAccountCoreIdentityActivateRequest({
      authBindingId,
      authenticationRef: 'existing-account-second-tenant',
      expectedRevision: 1,
    });
    const activateOptions: CommerceEnrollmentCoreIdentityOwnerEffectOptions = {
      client,
      clientOptions,
      makeDispatchRequest: () => ({ operation: 'activate', payload: activateRequest }),
      makeReconciliationRequest: () => {
        throw new Error('The dispatch-only path must not reconcile');
      },
    };
    const activateTransition = yield* makeExistingAccountTransition(activateStep, transitionInput());
    const activateOutcome =
      yield* commerceEnrollmentCoreIdentityOwnerEffectFor(activateOptions).dispatch(activateTransition);
    expect(activateOutcome.status).toBe('SUCCEEDED');
    expect(activateOutcome.resultReference).toBe('80000000-0000-4000-8000-000000000010');
  }),
);

// --- (c) Revoked target binding must not be bypassed ---------------------------------------------

it.effect('rejects a second-Tenant reserve when Core reports the existing target binding is revoked', () =>
  Effect.gen(function* rejectsRevokedTargetBinding() {
    const revokedBindingId = Schema.decodeSync(AuthBindingIdSchema)('80000000-0000-4000-8000-000000000011');
    const existing = Schema.decodeSync(ReservePrincipalBindingResultSchema)({
      authBindingId: revokedBindingId,
      bindingRevision: 4,
      bindingStatus: 'revoked',
      outcome: 'EXISTING',
      principalId: '90000000-0000-4000-8000-000000000011',
    });
    const client = {
      activatePrincipalBinding: () => Effect.die('unused'),
      changePrincipalBindingStatus: () => Effect.die('unused'),
      issueExternalGatewayContext: () => Effect.die('unused'),
      readPrincipalBinding: () => Effect.die('unused'),
      reservePrincipalBinding: () => Effect.succeed(existing),
      resolveExternalSubject: () => Effect.die('unused'),
    };
    const reserveRequest = yield* existingAccountCoreIdentityReserveRequest({
      accountSubject,
      authenticationRef: 'existing-account-revoked-target',
    });
    const options: CommerceEnrollmentCoreIdentityOwnerEffectOptions = {
      client,
      clientOptions,
      makeDispatchRequest: () => ({ operation: 'reserve', payload: reserveRequest }),
      makeReconciliationRequest: () => {
        throw new Error('The dispatch-only test must not reconcile');
      },
    };
    const reserveTransition = yield* makeExistingAccountTransition(reserveStep, transitionInput());
    const error = yield* commerceEnrollmentCoreIdentityOwnerEffectFor(options)
      .dispatch(reserveTransition)
      .pipe(Effect.flip);
    expect(error).toBeInstanceOf(CommerceEnrollmentOwnerEffectRejected);
    expect(error.code).toBe('core_binding_not_current');
  }),
);

// --- Reconciliation read builder --------------------------------------------------------------

it.effect('builds the exact-binding Core read used to reconcile an indeterminate reserve/activate result', () =>
  Effect.gen(function* buildsReadRequest() {
    const authBindingId = Schema.decodeSync(EnrollmentResourceIdSchema)('80000000-0000-4000-8000-000000000012');
    const request: ReadPrincipalBindingRequest = yield* existingAccountCoreIdentityReadByBindingRequest(authBindingId);
    expect(request).toStrictEqual({ authBindingId: '80000000-0000-4000-8000-000000000012', lookup: 'binding' });
  }),
);
