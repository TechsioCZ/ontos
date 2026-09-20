import { DateTime, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ReadPrincipalBindingResultSchema } from '../../../../packages/core-runtime/src/auth/external-identity-contracts.ts';
import { ExternalIdentityClient } from '../../../../packages/shared-contracts/src/external-identity-client.ts';
import type { ExternalIdentityClientPort } from '../../../../packages/shared-contracts/src/external-identity-client.ts';
import { CommercePortalAuthAccountLookupService } from '../../api/portal-auth/provider/account-lookup-service.ts';
import { CommerceCoreIdentityClientConfig } from '../../api/portal-auth/provider/core-identity-client-config.ts';
import {
  ACTIVATE_PRINCIPAL_BINDING_TRANSITION_KEY,
  CORE_IDENTITY_OWNER_MODULE_KEY,
  RESERVE_PRINCIPAL_BINDING_TRANSITION_KEY,
} from '../../src/enrollment/journeys/existing-account.ts';
import type { JourneyTransitionSpec } from '../../src/enrollment/journeys/journey-contracts.ts';
import {
  CommerceEnrollmentOwnerEffectRegistry,
  CommerceEnrollmentOwnerEffectRegistryLive,
} from '../../src/enrollment/orchestration/owner-effect-registry.ts';
import type { CommerceEnrollmentOwnerEffectContext } from '../../src/enrollment/orchestration/owner-effect-registry.ts';
import { CommerceEnrollmentOwnerEffectUnavailable } from '../../src/enrollment/orchestration/owner-transition-errors.ts';
import { CommerceEnrollmentOwnerTransitionSchema } from '../../src/enrollment/orchestration/owner-transition-driver.ts';
import type { CommerceEnrollmentOwnerReconciliationInput } from '../../src/enrollment/orchestration/owner-transition-driver.ts';
import {
  CommercePortalAccountSubjectSchema,
  EnrollmentActionInvocationIdSchema,
  EnrollmentAttemptIdSchema,
  EnrollmentKeySchema,
  EnrollmentLegalEntityIdSchema,
  EnrollmentModuleKeySchema,
  EnrollmentOwnerOperationIdSchema,
  EnrollmentPrincipalIdSchema,
  EnrollmentResourceIdSchema,
  EnrollmentTenantIdSchema,
  EnrollmentTransitionKeySchema,
} from '../../shared/enrollment-contracts.ts';
import type { EnrollmentAttemptSnapshot, EnrollmentOwnerOperationSnapshot } from '../../shared/enrollment-contracts.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';

/**
 * Reconciling a Core Principal Auth Binding activation whose response never arrived.
 *
 * Core publishes one invocation reference on a binding read — `originalInvocationId` — and it names
 * the invocation that *created* the binding, which is always the reservation. An activation that
 * committed and lost its answer can therefore never be recognised by invocation identity, so the
 * activation entry reconciles on the binding's own activation provenance instead.
 */

const TENANT_ID = '10000000-0000-4000-8000-0000000000a1';
const ATTEMPT_ID = '20000000-0000-4000-8000-0000000000a1';
const PRINCIPAL_ID = '30000000-0000-4000-8000-0000000000a1';
const LEGAL_ENTITY_ID = '80000000-0000-4000-8000-0000000000a1';
const AUTH_BINDING_ID = '40000000-0000-4000-8000-0000000000a1';
const RESERVE_INVOCATION_ID = '50000000-0000-4000-8000-0000000000a1';
const ACTIVATE_INVOCATION_ID = '60000000-0000-4000-8000-0000000000a2';
const RESERVE_OPERATION_ID = '70000000-0000-4000-8000-0000000000a1';
const ACTIVATE_OPERATION_ID = '70000000-0000-4000-8000-0000000000a2';
const REQUEST_DIGEST = 'c'.repeat(64);

const accountSubject = Schema.decodeSync(CommercePortalAccountSubjectSchema)({
  authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
  providerSubjectId: 'portal-user-existing-account',
  subjectType: 'user',
});

const at = DateTime.makeUnsafe('2026-01-01T00:00:00.000Z');
const attemptId = Schema.decodeSync(EnrollmentAttemptIdSchema)(ATTEMPT_ID);
const tenantId = Schema.decodeSync(EnrollmentTenantIdSchema)(TENANT_ID);
const actorPrincipalId = Schema.decodeSync(EnrollmentPrincipalIdSchema)(PRINCIPAL_ID);
const coreOwnerModuleKey = Schema.decodeSync(EnrollmentModuleKeySchema)(CORE_IDENTITY_OWNER_MODULE_KEY);
const invocation = (value: string) => Schema.decodeSync(EnrollmentActionInvocationIdSchema)(value);

const activateTransition: JourneyTransitionSpec = {
  ownerModuleKey: CORE_IDENTITY_OWNER_MODULE_KEY,
  required: true,
  transitionKey: ACTIVATE_PRINCIPAL_BINDING_TRANSITION_KEY,
};

const operation = (
  overrides: Pick<
    EnrollmentOwnerOperationSnapshot,
    'ownerInvocationId' | 'portalEnrollmentOwnerOperationId' | 'status' | 'transitionKey'
  > &
    Partial<EnrollmentOwnerOperationSnapshot>,
): EnrollmentOwnerOperationSnapshot => ({
  actorPrincipalId,
  createdAt: at,
  ownerModuleKey: coreOwnerModuleKey,
  portalEnrollmentAttemptId: attemptId,
  requestDigest: REQUEST_DIGEST,
  required: true,
  revision: 1,
  tenantId,
  updatedAt: at,
  ...overrides,
});

const attempt: EnrollmentAttemptSnapshot = {
  accountSubject,
  createdAt: at,
  createdByPrincipalId: actorPrincipalId,
  intentDigest: 'd'.repeat(64),
  intentKey: Schema.decodeSync(EnrollmentKeySchema)(
    'commerce.customer-context.portal-enrollment.existing_account.reconciliation',
  ),
  journey: 'EXISTING_ACCOUNT',
  portalEnrollmentAttemptId: attemptId,
  revision: 4,
  state: 'RECONCILIATION_REQUIRED',
  targetLegalEntityId: Schema.decodeSync(EnrollmentLegalEntityIdSchema)(LEGAL_ENTITY_ID),
  tenantId,
  updatedAt: at,
};

/** The reserve has committed and named the binding; the activation's answer was lost. */
const context: CommerceEnrollmentOwnerEffectContext = {
  attempt,
  operations: [
    operation({
      outcomeCode: Schema.decodeSync(EnrollmentKeySchema)('core_binding_reserved'),
      ownerInvocationId: invocation(RESERVE_INVOCATION_ID),
      portalEnrollmentOwnerOperationId: Schema.decodeSync(EnrollmentOwnerOperationIdSchema)(RESERVE_OPERATION_ID),
      resultReference: Schema.decodeSync(EnrollmentResourceIdSchema)(AUTH_BINDING_ID),
      status: 'SUCCEEDED',
      transitionKey: Schema.decodeSync(EnrollmentTransitionKeySchema)(RESERVE_PRINCIPAL_BINDING_TRANSITION_KEY),
    }),
    operation({
      ownerInvocationId: invocation(ACTIVATE_INVOCATION_ID),
      portalEnrollmentOwnerOperationId: Schema.decodeSync(EnrollmentOwnerOperationIdSchema)(ACTIVATE_OPERATION_ID),
      status: 'INDETERMINATE',
      transitionKey: Schema.decodeSync(EnrollmentTransitionKeySchema)(ACTIVATE_PRINCIPAL_BINDING_TRANSITION_KEY),
    }),
  ],
  requestCorrelation: 'enrollment-core-identity-reconciliation',
  subject: {
    partyCandidateDigest: 'e'.repeat(64),
    partyRef: Option.none(),
    portalEnrollmentAttemptId: attempt.portalEnrollmentAttemptId,
    principalRef: {
      moduleId: 'core.identity',
      resourceId: PRINCIPAL_ID,
      resourceType: 'core.identity.principal',
      tenantId: TENANT_ID,
    },
    sellingLegalEntityRef: {
      moduleId: 'core.identity',
      resourceId: LEGAL_ENTITY_ID,
      resourceType: 'core.identity.legal-entity',
      tenantId: TENANT_ID,
    },
  },
};

const reconciliationInput: CommerceEnrollmentOwnerReconciliationInput = {
  ...Schema.decodeUnknownSync(CommerceEnrollmentOwnerTransitionSchema)({
    actorPrincipalId: PRINCIPAL_ID,
    correlationId: 'enrollment-core-identity-reconciliation',
    expectedRevision: attempt.revision,
    // The activation's own invocation, which Core never names back on a binding read.
    ownerInvocationId: ACTIVATE_INVOCATION_ID,
    ownerModuleKey: CORE_IDENTITY_OWNER_MODULE_KEY,
    portalEnrollmentAttemptId: ATTEMPT_ID,
    requestDigest: REQUEST_DIGEST,
    tenantId: TENANT_ID,
    transitionKey: ACTIVATE_PRINCIPAL_BINDING_TRANSITION_KEY,
  }),
  observedRevision: attempt.revision,
  ownerOperationRevision: 1,
};

const unreachable = (operationName: string) => () => Effect.die(`${operationName} is not part of this scenario`);

/**
 * Core as it really answers after a lost activation response: the binding stands `active`, and the
 * one invocation reference it publishes is still the reservation's.
 */
const coreClient = (bindingStatus: 'active' | 'pending'): ExternalIdentityClientPort => ({
  activatePrincipalBinding: unreachable('activatePrincipalBinding'),
  changePrincipalBindingStatus: unreachable('changePrincipalBindingStatus'),
  issueExternalGatewayContext: unreachable('issueExternalGatewayContext'),
  readPrincipalBinding: () =>
    Effect.succeed(
      Schema.decodeUnknownSync(ReadPrincipalBindingResultSchema)({
        authBindingId: AUTH_BINDING_ID,
        authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
        bindingRevision: bindingStatus === 'active' ? 2 : 1,
        bindingStatus,
        originalInvocationId: RESERVE_INVOCATION_ID,
        outcome: 'FOUND',
        principalId: PRINCIPAL_ID,
        principalStatus: 'active',
        tenantStatus: 'active',
      }),
    ),
  reservePrincipalBinding: unreachable('reservePrincipalBinding'),
  resolveExternalSubject: unreachable('resolveExternalSubject'),
});

const registryLive = (bindingStatus: 'active' | 'pending') =>
  CommerceEnrollmentOwnerEffectRegistryLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ExternalIdentityClient, coreClient(bindingStatus)),
        Layer.succeed(CommerceCoreIdentityClientConfig, {
          apiKey: Redacted.make('enrollment-core-identity-reconciliation'),
          baseUrl: 'https://core-identity.invalid',
        }),
        Layer.succeed(CommercePortalAuthAccountLookupService, {
          existsByEmail: unreachable('existsByEmail'),
          existsByProviderSubject: unreachable('existsByProviderSubject'),
        }),
      ),
    ),
  );

const reconcileActivation = (bindingStatus: 'active' | 'pending') =>
  CommerceEnrollmentOwnerEffectRegistry.pipe(
    Effect.flatMap((registry) => registry.resolve(activateTransition, context)),
    Effect.flatMap((resolved) =>
      Option.isNone(resolved)
        ? Effect.die('The registry declares no owner effect for the Core activation transition')
        : resolved.value.reconcile(reconciliationInput),
    ),
    Effect.provide(registryLive(bindingStatus)),
  );

it.effect('a lost activation response converges to SUCCEEDED from the binding, not an invocation id', () =>
  Effect.gen(function* lostActivationConverges() {
    const resolution = yield* reconcileActivation('active');

    // Comparing Core's `originalInvocationId` — the reservation's — against the activation's own
    // invocation reports every lost activation as unavailable and leaves the Attempt stuck in
    // RECONCILIATION_REQUIRED for good. This assertion fails the moment that comparison returns.
    expect(resolution.status).toBe('SUCCEEDED');
    expect(String(resolution.outcomeCode)).toBe('core_binding_activated');
    expect(String(resolution.resultReference)).toBe(AUTH_BINDING_ID);
  }),
);

it.effect('an activation that did not commit stays unresolved rather than claiming success', () =>
  Effect.gen(function* pendingActivationStaysUnresolved() {
    const failure = yield* Effect.flip(reconcileActivation('pending'));

    // The binding is still the reservation's pending one, so nothing proves the activation ran.
    expect(Schema.is(CommerceEnrollmentOwnerEffectUnavailable)(failure)).toBe(true);
  }),
);
