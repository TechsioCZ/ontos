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
  EXISTING_ACCOUNT_OWNERSHIP_TRANSITIONS,
  ExistingAccountEnrollmentRejected,
  PORTAL_ACCOUNT_VERIFICATION_TRANSITION_KEY,
  RESERVE_PRINCIPAL_BINDING_TRANSITION_KEY,
  existingAccountCoreIdentityActivateRequest,
  existingAccountCoreIdentityReadByBindingRequest,
  existingAccountCoreIdentityReserveRequest,
  existingAccountJourneyDefinitionFor,
  existingAccountRequestDigest,
} from '../../src/enrollment/journeys/existing-account.ts';
import type { ExistingAccountEnrollmentTransitionIntent } from '../../src/enrollment/journeys/existing-account.ts';
import { retailSelfEnrollmentJourneyDefinition } from '../../src/enrollment/journeys/retail-self-enrollment-contracts.ts';
import {
  PORTAL_ACCOUNT_CREATION_TRANSITION_KEY,
  PORTAL_AUTH_OWNER_MODULE_KEY,
} from '../../src/enrollment/orchestration/prepared-owner-authority.ts';
import type {
  CommerceEnrollmentCoreIdentityOwnerEffectOptions,
  CommerceEnrollmentOwnerTransition,
} from '../../src/enrollment/orchestration/owner-transition-driver.ts';
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
 * Unit coverage for the Existing-account enrollment journey. Every test uses doubles: no database,
 * no HTTP transport, no Core service. The revoked-target-binding scenario reuses
 * `commerceEnrollmentCoreIdentityOwnerEffectFor` exactly as the registry wires it.
 */

const tenantId = Schema.decodeSync(EnrollmentTenantIdSchema)('10000000-0000-4000-8000-000000000009');
const attemptId = Schema.decodeSync(EnrollmentAttemptIdSchema)('20000000-0000-4000-8000-000000000009');
const actorPrincipalId = Schema.decodeSync(EnrollmentPrincipalIdSchema)('40000000-0000-4000-8000-000000000009');
const ownerInvocationId = Schema.decodeSync(EnrollmentActionInvocationIdSchema)('30000000-0000-4000-8000-000000000009');

const accountSubject = Schema.decodeSync(CommercePortalAccountSubjectSchema)({
  authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
  providerSubjectId: 'existing-account-subject-1',
  subjectType: 'user',
});

const intentFor = (transitionKey: string): ExistingAccountEnrollmentTransitionIntent => ({
  journey: 'EXISTING_ACCOUNT',
  ownerModuleKey: CORE_IDENTITY_OWNER_MODULE_KEY,
  portalEnrollmentAttemptId: attemptId,
  subject: { accountSubject, targetTenantId: tenantId },
  transitionKey,
});

/** The owner transition the registry builds for one declared Core identity step. */
const transitionFor = (transitionKey: string): Effect.Effect<CommerceEnrollmentOwnerTransition> =>
  existingAccountRequestDigest(intentFor(transitionKey)).pipe(
    Effect.map((requestDigest) =>
      Schema.decodeSync(CommerceEnrollmentOwnerTransitionSchema)({
        actorPrincipalId,
        correlationId: 'existing-account-unit',
        expectedRevision: 1,
        ownerInvocationId,
        ownerModuleKey: CORE_IDENTITY_OWNER_MODULE_KEY,
        portalEnrollmentAttemptId: attemptId,
        requestDigest,
        tenantId,
        transitionKey,
      }),
    ),
    Effect.orDie,
  );

const clientOptions = () => ({
  apiKey: Redacted.make('test'),
  baseUrl: 'https://core.invalid',
  requestCorrelation: 'existing-account-core-unit',
});

it.effect(
  'composes the Existing-account journey from a target definition, dropping the target account-creation step',
  () =>
    Effect.gen(function* composesJourney() {
      const definition = yield* existingAccountJourneyDefinitionFor(retailSelfEnrollmentJourneyDefinition);
      expect(definition.kind).toBe('EXISTING_ACCOUNT');
      // The ownership proof is declared first: it is the precondition of the reservation that
      // follows, and the continuation runs required transitions in declaration order.
      expect(definition.requiredTransitions[0]).toStrictEqual({
        ownerModuleKey: PORTAL_AUTH_OWNER_MODULE_KEY,
        required: true,
        transitionKey: PORTAL_ACCOUNT_VERIFICATION_TRANSITION_KEY,
      });
      expect(definition.requiredTransitions[1]?.transitionKey).toBe(RESERVE_PRINCIPAL_BINDING_TRANSITION_KEY);
      expect(definition.requiredTransitions[2]?.transitionKey).toBe(ACTIVATE_PRINCIPAL_BINDING_TRANSITION_KEY);
      expect(
        definition.requiredTransitions.some((step) => step.transitionKey === PORTAL_ACCOUNT_CREATION_TRANSITION_KEY),
      ).toBe(false);
      // Every non-account-creation step of the target is still inherited, unmodified.
      expect(definition.requiredTransitions.length).toBe(
        EXISTING_ACCOUNT_OWNERSHIP_TRANSITIONS.length +
          EXISTING_ACCOUNT_CORE_IDENTITY_TRANSITIONS.length +
          retailSelfEnrollmentJourneyDefinition.requiredTransitions.length -
          1,
      );
      expect(definition.requiredTransitions.every((step) => step.required)).toBe(true);
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

it.effect('produces the same digest for an equivalent retry, so replay converges on one durable operation', () =>
  Effect.gen(function* digestConverges() {
    const intent = intentFor(RESERVE_PRINCIPAL_BINDING_TRANSITION_KEY);
    const first = yield* existingAccountRequestDigest(intent);
    const second = yield* existingAccountRequestDigest(intent);
    const other = yield* existingAccountRequestDigest(intentFor(ACTIVATE_PRINCIPAL_BINDING_TRANSITION_KEY));
    expect(second).toBe(first);
    expect(other).not.toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
  }),
);

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
    const reserveOutcome = yield* commerceEnrollmentCoreIdentityOwnerEffectFor(reserveOptions).dispatch(
      yield* transitionFor(RESERVE_PRINCIPAL_BINDING_TRANSITION_KEY),
    );
    expect(reserveOutcome.status).toBe('SUCCEEDED');
    expect(reserveOutcome.resultReference).toBe('80000000-0000-4000-8000-000000000010');
    if (reserveOutcome.resultReference === undefined) {
      throw new Error('the reserve dispatch must report a result reference');
    }
    const activateRequest = yield* existingAccountCoreIdentityActivateRequest({
      authBindingId: reserveOutcome.resultReference,
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
    const activateOutcome = yield* commerceEnrollmentCoreIdentityOwnerEffectFor(activateOptions).dispatch(
      yield* transitionFor(ACTIVATE_PRINCIPAL_BINDING_TRANSITION_KEY),
    );
    expect(activateOutcome.status).toBe('SUCCEEDED');
    expect(activateOutcome.resultReference).toBe('80000000-0000-4000-8000-000000000010');
  }),
);

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
    const error = yield* commerceEnrollmentCoreIdentityOwnerEffectFor(options)
      .dispatch(yield* transitionFor(RESERVE_PRINCIPAL_BINDING_TRANSITION_KEY))
      .pipe(Effect.flip);
    expect(error).toBeInstanceOf(CommerceEnrollmentOwnerEffectRejected);
    expect(error.code).toBe('core_binding_not_current');
  }),
);

it.effect('builds the exact-binding Core read used to reconcile an indeterminate reserve/activate result', () =>
  Effect.gen(function* buildsReadRequest() {
    const authBindingId = Schema.decodeSync(EnrollmentResourceIdSchema)('80000000-0000-4000-8000-000000000012');
    const request: ReadPrincipalBindingRequest = yield* existingAccountCoreIdentityReadByBindingRequest(authBindingId);
    expect(request).toStrictEqual({ authBindingId: '80000000-0000-4000-8000-000000000012', lookup: 'binding' });
  }),
);
