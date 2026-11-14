import type {
  CreateCounterpartyPurchasingProfilePayload,
  CreateCounterpartyPurchasingProfileResult,
} from '../shared/actions/create-counterparty-purchasing-profile.ts';
import type { CurrentOrganizationCustomerRecordFactsSchema } from '@app/party-registry/apis/organization-record-facts';
import {
  fingerprintOrganizationProfileSourceCreate,
  OrganizationProfileSourceCurrentSchema,
  ORGANIZATION_PROFILE_SOURCE_CREATE_FIELDS,
  ORGANIZATION_PROFILE_SOURCE_CREATE_VERSION,
  ORGANIZATION_PROFILE_SOURCE_CREATE_TEMPLATE_VERSION,
  ORGANIZATION_PROFILE_SOURCE_CURRENT_FIELDS,
  ORGANIZATION_PROFILE_SOURCE_CURRENT_VERSION,
} from '../shared/domain/organization-profile-source.ts';
import { CommerceOrganizationBusinessEligibility } from './integrations/organization-business-eligibility.ts';
import type {
  CustomerProfilePartySourceReference,
  CustomerProfileSourceAssertion,
} from '../shared/domain/customer-profile-source.ts';
import { readVerifiedGatewayActor, requireModuleOperation, OperationContextUnavailable } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { computeCanonicalValueHash, readScopedAdmittedWorkload } from '@app/core-runtime/access/enforcement';
import { EnsureRetailCustomerProfileRejected } from '../shared/actions/ensure-retail-customer-profile.ts';
import { CreateCounterpartyPurchasingProfileRejected } from '../shared/actions/create-counterparty-purchasing-profile.ts';
import { accessPortalWritesForTransaction } from '@app/core-runtime/access/portal';
import type { AccessPortalTransaction, AccessPortalWrites } from '@app/core-runtime/access/portal';
import { Crypto, Effect, Option, Schema } from 'effect';
import { CommerceSourceProcessingEligibility } from './integrations/source-processing-eligibility.ts';
import type {
  CommerceSourceProcessingRejected,
  CommerceSourceProcessingRequest,
} from './integrations/source-processing-eligibility.ts';
import { CommerceSourceProfileOwnerProof } from './integrations/source-profile-owner-proof.ts';

import { ProfileReactivationEligibilityEvaluatorFactory } from './integrations/profile-reactivation-eligibility.ts';
import {
  ProfilePersistenceDependencyFailure,
  profilePersistenceServicesForTransaction,
  profileReconciliationOwnerVerifierForTransaction,
} from './persistence/profile-persistence.ts';
import { addressBookReconciliationOwnerVerifierForTransaction } from './persistence/address-persistence.ts';
import { paymentTermsReconciliationOwnerEvidenceVerifierForTransaction } from './persistence/payment-term-persistence.ts';
import type {
  ProfilePersistenceServices,
  ProfilePersistenceDependencies,
  ProfilePersistenceScope,
  ProfileScopedRoutineInvoker,
} from './persistence/profile-persistence.ts';
import { ProfileCounterpartyRoleEligibilityResolverFactory } from './profile-counterparty-role-eligibility.ts';
import type { ProfileReconciliationOwnerVerifierService } from './profile-reconciliation-owner-verifier.ts';
import { PartyRegistryGuestResolverFactory } from './integrations/party-registry-guest-resolver.ts';
import { PartyRegistryRetailPartyResolverFactory } from './integrations/party-registry-retail-party-resolver.ts';

const sourceDependencyFailure = (cause: unknown) =>
  Object.defineProperty(
    new ProfilePersistenceDependencyFailure({ reason: 'Current source owner authority is unavailable' }),
    'cause',
    { configurable: true, value: cause },
  );

const organizationSourceEligibility = (org: typeof CurrentOrganizationCustomerRecordFactsSchema.Type) => ({
  counterpartyResourceRevision: org.counterpartyRevision,
  managedLegalEntityId: org.legalEntityRef.resourceId,
  organizationProof: org,
  outcome: 'ELIGIBLE' as const,
  partyResourceId: org.partyRef.resourceId,
  partyResourceRevision: String(org.partyRevision),
  roleResourceId: org.currentCustomerRoleRef.resourceId,
  roleResourceRevision: org.currentCustomerRoleRevision,
});

/** The calling module of this module's own enrollment continuation (`retail-owner-gateway-credential.ts`). */
const preserveOrganizationFallbackFailure =
  (organization: CommerceSourceProcessingRejected) => (person: ProfilePersistenceDependencyFailure) =>
    sourceDependencyFailure({ organization, person });
const COMMERCE_MODULE_KEY = 'commerce.customer-context';
const ENROLLMENT_CONTINUATION_APP_ID = 'commerce-customer-context';

const profileServicesFor = (
  transaction: ProfileScopedRoutineInvoker,
  scope: OperationalScope,
  portalAccess?: AccessPortalWrites,
  resolveEnrollmentTargetBinding?: ProfilePersistenceDependencies['resolveEnrollmentTargetBinding'],
): Effect.Effect<
  ProfilePersistenceServices,
  OperationContextUnavailable,
  | Crypto.Crypto
  | ProfileCounterpartyRoleEligibilityResolverFactory
  | ProfileReactivationEligibilityEvaluatorFactory
  | PartyRegistryGuestResolverFactory
  | PartyRegistryRetailPartyResolverFactory
> => {
  if (scope.legalEntityId === undefined) {
    return Effect.fail(
      new OperationContextUnavailable({
        code: 'operation_context_unavailable',
        reason: 'Customer Profile persistence requires a trusted Legal Entity scope',
      }),
    );
  }
  const baseScope = {
    legalEntityId: scope.legalEntityId,
    principalId: scope.principalId,
    tenantId: scope.tenantId,
  };
  let verifiedScope: ProfilePersistenceScope = baseScope;
  if (scope.authBindingId !== undefined) {
    verifiedScope = { ...verifiedScope, authBindingId: scope.authBindingId };
  }
  if (readVerifiedGatewayActor(scope)?.appId === ENROLLMENT_CONTINUATION_APP_ID) {
    verifiedScope = { ...verifiedScope, enrollmentContinuation: true };
  }
  return Effect.gen(function* profileServices() {
    const roleResolverFactory = yield* ProfileCounterpartyRoleEligibilityResolverFactory;
    const reactivationEvaluatorFactory = yield* ProfileReactivationEligibilityEvaluatorFactory;
    const guestResolverFactory = yield* PartyRegistryGuestResolverFactory;
    const crypto = yield* Crypto.Crypto;
    const sourcePrivacy = yield* Effect.serviceOption(CommerceSourceProcessingEligibility);
    const sourceProof = yield* Effect.serviceOption(CommerceSourceProfileOwnerProof);
    const organizationBusiness = yield* Effect.serviceOption(CommerceOrganizationBusinessEligibility);
    const retailPartyResolverFactory = yield* PartyRegistryRetailPartyResolverFactory;
    const resolveCounterpartyRole = roleResolverFactory.make({
      legalEntityId: verifiedScope.legalEntityId,
      operationalScope: scope,
      requestCorrelation: scope.correlationId,
      tenantId: verifiedScope.tenantId,
    });
    const evaluateReactivation = reactivationEvaluatorFactory.make({
      resolveCounterpartyRole,
      scope: verifiedScope,
      transaction,
    });
    const guestParty = guestResolverFactory.make({ crypto, scope });
    const retailParty = retailPartyResolverFactory.make({
      legalEntityId: verifiedScope.legalEntityId,
      principalId: verifiedScope.principalId,
      requestCorrelation: scope.correlationId,
      tenantId: verifiedScope.tenantId,
    });
    const resolveGuestParty: typeof guestParty = (input) =>
      requireModuleOperation('commerce.customer-context.requirement.attribute-guest-retail-customer-party').pipe(
        Effect.mapError((cause) =>
          Object.defineProperty(
            new ProfilePersistenceDependencyFailure({ reason: 'Required Party guest resolution is unavailable' }),
            'cause',
            { configurable: true, value: cause },
          ),
        ),
        Effect.flatMap(() => guestParty(input)),
      );
    const resolveRetailParty: typeof retailParty = (input) =>
      requireModuleOperation('commerce.customer-context.requirement.ensure-retail-customer-profile-party').pipe(
        Effect.mapError((cause) =>
          Object.defineProperty(
            new ProfilePersistenceDependencyFailure({ reason: 'Required Party identity resolution is unavailable' }),
            'cause',
            { configurable: true, value: cause },
          ),
        ),
        Effect.flatMap(() => retailParty(input)),
      );
    const profileOwnerVerifier = profileReconciliationOwnerVerifierForTransaction(transaction, verifiedScope);
    const paymentTermsOwnerVerifier = paymentTermsReconciliationOwnerEvidenceVerifierForTransaction(transaction);
    const addressBookOwnerVerifier = addressBookReconciliationOwnerVerifierForTransaction(transaction, scope);
    const reconciliationOwnerVerifier: ProfileReconciliationOwnerVerifierService = {
      verify: (request, context) => {
        if (request.desiredOutcome.owner === 'PAYMENT_TERMS') {
          return paymentTermsOwnerVerifier.verify(request, context);
        }
        if (request.desiredOutcome.owner === 'ADDRESS_BOOK') {
          return addressBookOwnerVerifier.verify(request, context);
        }
        return profileOwnerVerifier.verify(request, context);
      },
    };
    const targetBinding =
      readVerifiedGatewayActor(scope)?.appId === ENROLLMENT_CONTINUATION_APP_ID
        ? resolveEnrollmentTargetBinding
        : undefined;
    let dependencies: ProfilePersistenceDependencies = {
      checkOrganizationSourceProfile: Effect.fn('ProfileSource.checkOrganizationProfile')(
        function* checkKnownOrganizationProfile(
          payload: CreateCounterpartyPurchasingProfilePayload,
          result: CreateCounterpartyPurchasingProfileResult,
          proof: typeof CurrentOrganizationCustomerRecordFactsSchema.Type,
        ) {
          if (
            Option.isNone(organizationBusiness) ||
            payload.source === undefined ||
            payload.partySourceReference === undefined
          ) {
            return yield* new ProfilePersistenceDependencyFailure({
              reason: 'Current Organization Profile authority is unavailable',
            });
          }
          const current = yield* Schema.decodeUnknownEffect(OrganizationProfileSourceCurrentSchema)({
            partyRef: proof.partyRef,
            partySourceReference: payload.partySourceReference,
            profile: {
              profileRef: { ...result.profileRef, kind: 'COUNTERPARTY' },
              revision: result.revision,
              state: result.state,
              subject: { counterpartyRef: payload.subject.counterpartyRef, kind: 'COUNTERPARTY' },
            },
            source: payload.source,
          }).pipe(Effect.mapError(sourceDependencyFailure));
          yield* organizationBusiness.value
            .check(
              scope,
              {
                consumerModuleId: COMMERCE_MODULE_KEY,
                expectedProfileRevision: result.revision,
                fields: ORGANIZATION_PROFILE_SOURCE_CURRENT_FIELDS,
                inputDigest: computeCanonicalValueHash(
                  yield* Schema.encodeEffect(OrganizationProfileSourceCurrentSchema)(current).pipe(
                    Effect.mapError(sourceDependencyFailure),
                  ),
                ),
                kind: 'COUNTERPARTY_PROFILE',
                operation: 'customer-profile-source.write',
                profileRef: result.profileRef,
                profileSource: payload.source,
                projectionVersion: ORGANIZATION_PROFILE_SOURCE_CURRENT_VERSION,
                sourceReference: payload.partySourceReference,
              },
              'commerce.customer-context.requirement.customer-profile-source-organization',
            )
            .pipe(Effect.mapError(sourceDependencyFailure));
          return yield* Effect.void;
        },
      ),
      checkSourceProfile: (
        source: CustomerProfileSourceAssertion,
        target: Readonly<{
          kind: 'PARTY' | 'RETAIL_CUSTOMER_PROFILE' | 'COUNTERPARTY_PURCHASING_PROFILE';
          resourceId: string;
        }>,
        profileKind: 'RETAIL' | 'COUNTERPARTY',
        partySourceReference?: CustomerProfilePartySourceReference,
      ) => {
        if (Option.isNone(sourcePrivacy)) {
          return Effect.fail(
            new ProfilePersistenceDependencyFailure({ reason: 'Current source processing authority is unavailable' }),
          );
        }
        const requirement =
          profileKind === 'RETAIL'
            ? 'commerce.customer-context.requirement.ensure-retail-profile-source-privacy'
            : 'commerce.customer-context.requirement.create-counterparty-profile-source-privacy';
        const profileCreate = profileKind === 'RETAIL' && target.kind === 'PARTY';
        const baseRequest: CommerceSourceProcessingRequest = {
          operation: profileCreate ? 'PROFILE_CREATE' : 'customer-profile-source.write',
          source: {
            issuer: source.issuer,
            namespace: source.namespace,
            occurrenceId: source.occurrenceId,
            recordId: source.recordId,
            recordType: source.recordType,
            routeRef: source.route.id,
          },
          target,
        };
        let request = baseRequest;
        if (profileCreate) {
          if (partySourceReference === undefined) {
            return Effect.fail(
              new ProfilePersistenceDependencyFailure({ reason: 'Original Party source admission is unavailable' }),
            );
          }
          request = { ...baseRequest, partySourceReference };
        }
        return requireModuleOperation(requirement).pipe(
          Effect.flatMap(() => sourcePrivacy.value.check(scope, request, requirement)),
          Effect.mapError(sourceDependencyFailure),
        );
      },
      evaluateReactivation,
      reconciliationOwnerVerifier,
      resolveCounterpartyRole,
      resolveGuestParty,
      resolveRetailParty,
      resolveSourceCounterpartyRole: Effect.fn('ProfileSource.resolveCounterparty')(function* resolveSourceCounterparty(
        input: { readonly counterpartyResourceId: string; readonly tenantId: string },
        source: CustomerProfileSourceAssertion,
        partySourceReference: CustomerProfilePartySourceReference,
        payload: CreateCounterpartyPurchasingProfilePayload,
      ) {
        if (payload.sourceOrganizationWitness !== undefined) {
          if (
            Option.isNone(organizationBusiness) ||
            payload.sourceOrganizationWitness.semanticProjectionVersion !==
              ORGANIZATION_PROFILE_SOURCE_CREATE_TEMPLATE_VERSION
          ) {
            return yield* new ProfilePersistenceDependencyFailure({
              reason: 'Current source Organization materialization authority is unavailable',
            });
          }
          const witness = payload.sourceOrganizationWitness;
          const authority = yield* organizationBusiness.value
            .check(
              scope,
              {
                consumerModuleId: COMMERCE_MODULE_KEY,
                fields: ORGANIZATION_PROFILE_SOURCE_CREATE_FIELDS,
                inputDigest: witness.semanticInputDigest,
                kind: 'SOURCE_ASSERTED',
                operation: 'COUNTERPARTY_PROFILE_CREATE',
                processingWitness: {
                  effectId: witness.effectId,
                  materializationWitness: {
                    inputDigest: yield* fingerprintOrganizationProfileSourceCreate(payload).pipe(
                      Effect.mapError(sourceDependencyFailure),
                    ),
                    projectionVersion: ORGANIZATION_PROFILE_SOURCE_CREATE_VERSION,
                  },
                  originalAdmissionInvocationId: witness.originalAdmissionInvocationId,
                  purpose: 'PROCESSING',
                },
                profileSource: source,
                projectionVersion: ORGANIZATION_PROFILE_SOURCE_CREATE_TEMPLATE_VERSION,
                resolvedTarget: { counterpartyRef: payload.subject.counterpartyRef, kind: 'COUNTERPARTY_CUSTOMER' },
                sourceReference: partySourceReference,
              },
              'commerce.customer-context.requirement.create-counterparty-profile-source-organization',
            )
            .pipe(Effect.mapError(sourceDependencyFailure));
          if (
            authority.liveProof.kind !== 'SOURCE_ASSERTED' ||
            authority.liveProof.resolvedOwner.kind !== 'COUNTERPARTY_CUSTOMER'
          ) {
            return yield* new ProfilePersistenceDependencyFailure({
              reason: 'The exact materialized Organization CUSTOMER authority is required',
            });
          }
          return organizationSourceEligibility(authority.liveProof.resolvedOwner.organization);
        }
        const person = Effect.gen(function* currentPersonCounterparty() {
          if (Option.isNone(sourceProof)) {
            return yield* new ProfilePersistenceDependencyFailure({
              reason: 'Current source Counterparty admission is unavailable',
            });
          }
          const roleKey = 'commerce.customer-context.requirement.create-counterparty-profile-source-role';
          yield* requireModuleOperation(roleKey).pipe(Effect.mapError(sourceDependencyFailure));
          const role = yield* sourceProof.value.counterparty(
            scope,
            input.counterpartyResourceId,
            source,
            partySourceReference,
            roleKey,
          );
          if (role.outcome !== 'ELIGIBLE' || role.partyResourceId === undefined) {
            return role;
          }
          const personKey = 'commerce.customer-context.requirement.create-counterparty-profile-source-person';
          yield* requireModuleOperation(personKey).pipe(Effect.mapError(sourceDependencyFailure));
          const admission = yield* sourceProof.value.retail(
            scope,
            {
              moduleId: 'party.registry',
              resourceId: role.partyResourceId,
              resourceType: 'party.registry.party',
              tenantId: scope.tenantId,
            },
            source,
            partySourceReference,
            personKey,
          );
          if (admission.outcome !== 'CURRENT_PARTY_RESOLVED' || admission.partyResourceId !== role.partyResourceId) {
            return yield* new ProfilePersistenceDependencyFailure({
              reason: 'Current source PERSON classification is required for personal Counterparty admission',
            });
          }
          return role;
        });
        if (Option.isNone(organizationBusiness)) {
          return yield* person;
        }
        return yield* organizationBusiness.value
          .check(
            scope,
            {
              consumerModuleId: COMMERCE_MODULE_KEY,
              counterpartyRef: payload.subject.counterpartyRef,
              fields: ORGANIZATION_PROFILE_SOURCE_CREATE_FIELDS,
              inputDigest: yield* fingerprintOrganizationProfileSourceCreate(payload).pipe(
                Effect.mapError(sourceDependencyFailure),
              ),
              kind: 'COUNTERPARTY_CUSTOMER',
              operation: 'COUNTERPARTY_PROFILE_CREATE',
              profileSource: source,
              projectionVersion: ORGANIZATION_PROFILE_SOURCE_CREATE_VERSION,
              sourceReference: partySourceReference,
            },
            'commerce.customer-context.requirement.create-counterparty-profile-source-organization',
          )
          .pipe(
            Effect.matchEffect({
              onFailure: (organizationFailure) =>
                person.pipe(Effect.mapError(preserveOrganizationFallbackFailure(organizationFailure))),
              onSuccess: (authority) => {
                if (authority.liveProof.kind !== 'COUNTERPARTY_CUSTOMER') {
                  return Effect.fail(
                    new ProfilePersistenceDependencyFailure({
                      reason: 'Exact Organization CUSTOMER authority is required',
                    }),
                  );
                }
                return Effect.succeed(organizationSourceEligibility(authority.liveProof.organization));
              },
            }),
          );
      }),
      resolveSourceRetailParty: (
        input: { readonly partyResourceId: string; readonly tenantId: string },
        source: CustomerProfileSourceAssertion,
        partySourceReference: CustomerProfilePartySourceReference,
      ) => {
        if (Option.isNone(sourceProof)) {
          return Effect.fail(
            new ProfilePersistenceDependencyFailure({ reason: 'Current source Party admission is unavailable' }),
          );
        }
        return requireModuleOperation('commerce.customer-context.requirement.ensure-retail-profile-source-person').pipe(
          Effect.mapError(sourceDependencyFailure),
          Effect.flatMap(() =>
            sourceProof.value.retail(
              scope,
              {
                moduleId: 'party.registry',
                resourceId: input.partyResourceId,
                resourceType: 'party.registry.party',
                tenantId: input.tenantId,
              },
              source,
              partySourceReference,
              'commerce.customer-context.requirement.ensure-retail-profile-source-person',
            ),
          ),
        );
      },
    };
    if (targetBinding !== undefined) {
      dependencies = { ...dependencies, resolveEnrollmentTargetBinding: targetBinding };
    }
    const services = profilePersistenceServicesForTransaction(
      transaction,
      verifiedScope,
      portalAccess === undefined ? dependencies : { ...dependencies, portalAccess },
    );
    return {
      ...services,
      createCounterpartyPurchasingProfile: {
        create: Effect.fn('SourceProfile.createWithCarrier')(function* createWithCarrier(payload, context) {
          if (payload.source === undefined) {
            const sourceSelected = yield* readScopedAdmittedWorkload(
              transaction,
              scope,
              'commerce.customer-context.source-write',
            ).pipe(
              Effect.mapError((cause) =>
                Object.defineProperty(
                  new CreateCounterpartyPurchasingProfileRejected({
                    code: 'DEPENDENCY_UNAVAILABLE',
                    reason: 'Current Profile carrier authority is unavailable',
                    retryable: true,
                  }),
                  'cause',
                  { value: cause },
                ),
              ),
            );
            if (sourceSelected) {
              return yield* new CreateCounterpartyPurchasingProfileRejected({
                code: 'SOURCE_AUTHORITY_DENIED',
                reason: 'Source workloads require an exact admitted source assertion',
                retryable: false,
              });
            }
          }
          return yield* services.createCounterpartyPurchasingProfile.create(payload, context);
        }),
      },
      ensureRetailCustomerProfile: {
        ensure: Effect.fn('SourceProfile.ensureWithCarrier')(function* ensureWithCarrier(payload, context) {
          if (payload.source === undefined) {
            const sourceSelected = yield* readScopedAdmittedWorkload(
              transaction,
              scope,
              'commerce.customer-context.source-write',
            ).pipe(
              Effect.mapError((cause) =>
                Object.defineProperty(
                  new EnsureRetailCustomerProfileRejected({
                    code: 'DEPENDENCY_UNAVAILABLE',
                    reason: 'Current Profile carrier authority is unavailable',
                    retryable: true,
                  }),
                  'cause',
                  { value: cause },
                ),
              ),
            );
            if (sourceSelected) {
              return yield* new EnsureRetailCustomerProfileRejected({
                code: 'SOURCE_AUTHORITY_DENIED',
                reason: 'Source workloads require an exact admitted source assertion',
                retryable: false,
              });
            }
          }
          return yield* services.ensureRetailCustomerProfile.ensure(payload, context);
        }),
      },
    } satisfies ProfilePersistenceServices;
  });
};

export const profileServicesForVerifiedScope = (transaction: ProfileScopedRoutineInvoker, scope: OperationalScope) =>
  profileServicesFor(transaction, scope);

/**
 * Profile Reads need only the verified scope and the Counterparty role resolver. They never build the
 * write-side Party, guest, reactivation or source-carrier dependencies of the Action factory above.
 */
const profileReadServicesFor = (
  transaction: ProfileScopedRoutineInvoker,
  scope: OperationalScope,
): Effect.Effect<
  ProfilePersistenceServices,
  OperationContextUnavailable,
  ProfileCounterpartyRoleEligibilityResolverFactory
> => {
  if (scope.legalEntityId === undefined) {
    return Effect.fail(
      new OperationContextUnavailable({
        code: 'operation_context_unavailable',
        reason: 'Customer Profile persistence requires a trusted Legal Entity scope',
      }),
    );
  }
  const baseScope = {
    legalEntityId: scope.legalEntityId,
    principalId: scope.principalId,
    tenantId: scope.tenantId,
  };
  let verifiedScope: ProfilePersistenceScope = baseScope;
  if (scope.authBindingId !== undefined) {
    verifiedScope = { ...verifiedScope, authBindingId: scope.authBindingId };
  }
  if (readVerifiedGatewayActor(scope)?.appId === ENROLLMENT_CONTINUATION_APP_ID) {
    verifiedScope = { ...verifiedScope, enrollmentContinuation: true };
  }
  return Effect.gen(function* profileReadServices() {
    const roleResolverFactory = yield* ProfileCounterpartyRoleEligibilityResolverFactory;
    const resolveCounterpartyRole = roleResolverFactory.make({
      legalEntityId: verifiedScope.legalEntityId,
      operationalScope: scope,
      requestCorrelation: scope.correlationId,
      tenantId: verifiedScope.tenantId,
    });
    const dependencies: ProfilePersistenceDependencies = { resolveCounterpartyRole };
    return profilePersistenceServicesForTransaction(transaction, verifiedScope, dependencies);
  });
};

export const profileReadServicesForVerifiedScope = (
  transaction: ProfileScopedRoutineInvoker,
  scope: OperationalScope,
) => profileReadServicesFor(transaction, scope);

/**
 * The profile services of a Retail Portal binding Action: a binding and the bound person's portal access
 * commit in the Action's one transaction, so the binding services carry Core's portal writes over it.
 */
export const retailPortalBindingServicesForVerifiedScope = (
  transaction: ProfileScopedRoutineInvoker & AccessPortalTransaction,
  scope: OperationalScope,
  resolveEnrollmentTargetBinding?: ProfilePersistenceDependencies['resolveEnrollmentTargetBinding'],
) =>
  profileServicesFor(
    transaction,
    scope,
    accessPortalWritesForTransaction(transaction, scope),
    resolveEnrollmentTargetBinding,
  );
