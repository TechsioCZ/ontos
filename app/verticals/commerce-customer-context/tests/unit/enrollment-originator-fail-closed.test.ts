import { layer as nodeCryptoLayer } from '@effect/platform-node/NodeCrypto';
import { DateTime, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ExternalIdentityClient } from '../../../../packages/shared-contracts/src/external-identity-client.ts';
import type { ExternalIdentityClientPort } from '../../../../packages/shared-contracts/src/external-identity-client.ts';
import { CommercePortalAuthAccountLookupService } from '../../api/portal-auth/provider/account-lookup-service.ts';
import { CommercePortalAuthAccountCreationReconciliationService } from '../../api/portal-auth/provider/account-creation-reconciliation-service.ts';
import { CommerceCoreIdentityClientConfig } from '../../api/portal-auth/provider/core-identity-client-config.ts';
import { CommerceEnrollmentAttemptRejected } from '../../src/enrollment/attempts/errors.ts';
import {
  PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY,
  PARTY_REGISTRY_OWNER_MODULE_KEY,
} from '../../src/enrollment/journeys/retail-self-enrollment-contracts.ts';
import type { JourneyTransitionSpec } from '../../src/enrollment/journeys/journey-contracts.ts';
import {
  CommerceEnrollmentOwnerEffectRegistry,
  CommerceEnrollmentOwnerEffectRegistryLive,
} from '../../src/enrollment/orchestration/owner-effect-registry.ts';
import type { CommerceEnrollmentOwnerEffectContext } from '../../src/enrollment/orchestration/owner-effect-registry.ts';
import {
  CommercePortalAccountSubjectSchema,
  EnrollmentAttemptIdSchema,
  EnrollmentKeySchema,
  EnrollmentLegalEntityIdSchema,
  EnrollmentPrincipalIdSchema,
  EnrollmentTenantIdSchema,
} from '../../shared/enrollment-contracts.ts';
import type { EnrollmentAttemptSnapshot } from '../../shared/enrollment-contracts.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';

/**
 * An Attempt that never recorded the Action invocation it was created under cannot name an
 * originator. Every owner entry that calls another module must refuse it before it builds an owner
 * effect, so no gateway credential is acquired and no owner call is made.
 */

const TENANT_ID = '10000000-0000-4000-8000-0000000000b1';
const ATTEMPT_ID = '20000000-0000-4000-8000-0000000000b1';
const PRINCIPAL_ID = '30000000-0000-4000-8000-0000000000b1';
const LEGAL_ENTITY_ID = '80000000-0000-4000-8000-0000000000b1';
const at = DateTime.makeUnsafe('2026-01-01T00:00:00.000Z');

const attemptId = Schema.decodeSync(EnrollmentAttemptIdSchema)(ATTEMPT_ID);
const tenantId = Schema.decodeSync(EnrollmentTenantIdSchema)(TENANT_ID);
const actorPrincipalId = Schema.decodeSync(EnrollmentPrincipalIdSchema)(PRINCIPAL_ID);

const accountSubject = Schema.decodeSync(CommercePortalAccountSubjectSchema)({
  authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
  providerSubjectId: 'portal-user-without-originator',
  subjectType: 'user',
});

/** Built without `originatorActionInvocationId`, the optional field the Attempt never recorded. */
const attemptWithoutOriginator: EnrollmentAttemptSnapshot = {
  accountSubject,
  compositionRevision: 'e'.repeat(64),
  createdAt: at,
  createdByPrincipalId: actorPrincipalId,
  intentDigest: 'f'.repeat(64),
  intentKey: Schema.decodeSync(EnrollmentKeySchema)('commerce.customer-context.portal-enrollment.originator-missing'),
  journey: 'RETAIL_SELF_ENROLLMENT',
  portalEnrollmentAttemptId: attemptId,
  revision: 1,
  state: 'IN_PROGRESS',
  targetLegalEntityId: Schema.decodeSync(EnrollmentLegalEntityIdSchema)(LEGAL_ENTITY_ID),
  tenantId,
  updatedAt: at,
};

const partyCandidateTransition: JourneyTransitionSpec = {
  ownerModuleKey: PARTY_REGISTRY_OWNER_MODULE_KEY,
  required: true,
  transitionKey: PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY,
};

const context: CommerceEnrollmentOwnerEffectContext = {
  attempt: attemptWithoutOriginator,
  operations: [],
  requestCorrelation: 'enrollment-originator-fail-closed',
  subject: {
    partyCandidateDigest: '1'.repeat(64),
    partyRef: Option.none(),
    portalEnrollmentAttemptId: attemptWithoutOriginator.portalEnrollmentAttemptId,
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

const unreachable = (operationName: string) => () => Effect.die(`${operationName} must not run`);

const coreClient: ExternalIdentityClientPort = {
  activatePrincipalBinding: unreachable('activatePrincipalBinding'),
  changePrincipalBindingStatus: unreachable('changePrincipalBindingStatus'),
  issueExternalGatewayContext: unreachable('issueExternalGatewayContext'),
  readPrincipalBinding: unreachable('readPrincipalBinding'),
  reservePrincipalBinding: unreachable('reservePrincipalBinding'),
  resolveExternalSubject: unreachable('resolveExternalSubject'),
};

const registryLive = CommerceEnrollmentOwnerEffectRegistryLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(ExternalIdentityClient, coreClient),
      Layer.succeed(CommerceCoreIdentityClientConfig, {
        apiKey: Redacted.make('enrollment-originator-fail-closed'),
        baseUrl: 'https://core-identity.invalid',
      }),
      Layer.succeed(CommercePortalAuthAccountLookupService, {
        existsByEmail: unreachable('existsByEmail'),
        existsByProviderSubject: unreachable('existsByProviderSubject'),
        subjectForOwnerInvocation: unreachable('subjectForOwnerInvocation'),
      }),
      Layer.succeed(CommercePortalAuthAccountCreationReconciliationService, {
        reissueVerificationEmail: unreachable('reissueVerificationEmail'),
      }),
      nodeCryptoLayer,
    ),
  ),
);

it.effect('refuses to resolve a party owner effect for an Attempt with no recorded originator', () =>
  Effect.gen(function* withoutOriginatorFailsClosed() {
    const failure = yield* CommerceEnrollmentOwnerEffectRegistry.pipe(
      Effect.flatMap((registry) => registry.resolve(partyCandidateTransition, context)),
      Effect.flip,
      Effect.provide(registryLive),
    );

    // Resolution never returns a dispatchable effect, so no owner call and no gateway acquisition run.
    expect(Schema.is(CommerceEnrollmentAttemptRejected)(failure)).toBe(true);
  }),
);
