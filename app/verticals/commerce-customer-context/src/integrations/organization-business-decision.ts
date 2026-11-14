import type { OperationalScope } from '@app/core-runtime';
import { OrganizationBusinessSourceProfileCreateLiveProofSchema } from '@app/privacy/api/organization-business-applicability';
import type {
  OrganizationBusinessApplicabilityRequest,
  OrganizationBusinessApplicabilityCurrent,
  OrganizationBusinessApplicabilityResponse,
} from '@app/privacy/api/organization-business-applicability';
import {
  CurrentOrganizationCustomerRecordFactsSchema,
  CurrentCanonicalOrganizationCustomerRecordFactsSchema,
  OrganizationBusinessSourceReferenceSchema,
} from '@app/party-registry/apis/organization-record-facts';
import { Effect, Schema } from 'effect';
import {
  CustomerProfileOrganizationIcoFactsCurrentSchema,
  CustomerProfileOrganizationIcoFactsHistoricalIdentitySchema,
} from '../../shared/apis/customer-profile-organization-ico-facts.ts';
import { CommerceSourceProcessingRejected } from './source-processing-rejected.ts';
import {
  ORGANIZATION_PROFILE_SOURCE_CREATE_FIELDS,
  ORGANIZATION_PROFILE_SOURCE_CREATE_VERSION,
  ORGANIZATION_PROFILE_SOURCE_CREATE_TEMPLATE_VERSION,
} from '../../shared/domain/organization-profile-source.ts';

export type CommerceOrganizationBusinessRequest = Extract<
  OrganizationBusinessApplicabilityRequest,
  { readonly consumerModuleId: 'commerce.customer-context' }
>;
export type CommerceOrganizationBusinessAuthority = Extract<
  OrganizationBusinessApplicabilityCurrent,
  { readonly consumerModuleId: 'commerce.customer-context' }
>;

const denied = () =>
  new CommerceSourceProcessingRejected({
    code: 'DENIED',
    reason: 'Current Organization authority does not permit the exact native business projection',
  });
const sameRef = (
  left: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
  right: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
) =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const currentCustomerProof = Schema.Union([
  CurrentOrganizationCustomerRecordFactsSchema,
  CurrentCanonicalOrganizationCustomerRecordFactsSchema,
]);
const profileIdentityProof = Schema.Union([
  CustomerProfileOrganizationIcoFactsCurrentSchema,
  CustomerProfileOrganizationIcoFactsHistoricalIdentitySchema,
]);
const matchesCustomerTuple = (
  profile: typeof profileIdentityProof.Type,
  organization: typeof currentCustomerProof.Type,
) =>
  sameRef(profile.partyRef, organization.partyRef) &&
  profile.partyRevision === organization.partyRevision &&
  sameRef(profile.counterpartyRef, organization.counterpartyRef) &&
  profile.counterpartyRevision === organization.counterpartyRevision &&
  sameRef(profile.legalEntityRef, organization.legalEntityRef) &&
  sameRef(profile.currentCustomerRoleRef, organization.currentCustomerRoleRef) &&
  profile.currentCustomerRoleRevision === organization.currentCustomerRoleRevision;

const matchesProfileProof = (
  scope: OperationalScope,
  input: Extract<CommerceOrganizationBusinessRequest, { readonly kind: 'COUNTERPARTY_PROFILE' }>,
  proof: Extract<CommerceOrganizationBusinessAuthority['liveProof'], { readonly kind: 'COUNTERPARTY_PROFILE' }>,
) => {
  // Parse the public proof variants before using their fields, including during declaration refreshes.
  const { organization, profile }: { readonly organization: unknown; readonly profile: unknown } = proof;
  if (!Schema.is(currentCustomerProof)(organization) || !Schema.is(profileIdentityProof)(profile)) {
    return false;
  }
  const historical = input.identityState === 'HISTORICAL';
  if (historical !== Schema.is(CustomerProfileOrganizationIcoFactsHistoricalIdentitySchema)(profile)) {
    return false;
  }
  return (
    sameRef(input.profileRef, profile.profileRef) &&
    input.profileRef.tenantId === scope.tenantId &&
    profile.legalEntityRef.tenantId === scope.tenantId &&
    profile.legalEntityRef.resourceId === scope.legalEntityId &&
    profile.counterpartyRef.tenantId === scope.tenantId &&
    profile.currentCustomerRoleRef.tenantId === scope.tenantId &&
    profile.partyRef.tenantId === scope.tenantId &&
    matchesCustomerTuple(profile, organization) &&
    (input.expectedProfileRevision === undefined || profile.profileRevision === input.expectedProfileRevision)
  );
};

const matchesCustomerProof = (
  scope: OperationalScope,
  input: Extract<CommerceOrganizationBusinessRequest, { readonly kind: 'COUNTERPARTY_CUSTOMER' }>,
  proof: Extract<CommerceOrganizationBusinessAuthority['liveProof'], { readonly kind: 'COUNTERPARTY_CUSTOMER' }>,
) =>
  sameRef(input.counterpartyRef, proof.organization.counterpartyRef) &&
  input.counterpartyRef.tenantId === scope.tenantId &&
  proof.organization.legalEntityRef.tenantId === scope.tenantId &&
  proof.organization.legalEntityRef.resourceId === scope.legalEntityId &&
  proof.organization.currentCustomerRoleRef.tenantId === scope.tenantId &&
  proof.organization.partyRef.tenantId === scope.tenantId;

type SourceProfileCreateRequest = Extract<
  CommerceOrganizationBusinessRequest,
  { readonly kind: 'SOURCE_ASSERTED'; readonly operation: 'COUNTERPARTY_PROFILE_CREATE' }
>;
type SourceProfileCreateProof = typeof OrganizationBusinessSourceProfileCreateLiveProofSchema.Type;
const sameSourceReference = Schema.toEquivalence(OrganizationBusinessSourceReferenceSchema);

const matchesSourceProfileWitness = (
  scope: OperationalScope,
  input: SourceProfileCreateRequest,
  proof: SourceProfileCreateProof,
) => {
  const { source } = proof;
  const witness = input.processingWitness;
  return (
    source.projectionVersion === input.projectionVersion &&
    source.inputDigest === input.inputDigest &&
    source.originalAdmissionInvocationId === witness.originalAdmissionInvocationId &&
    source.effectId === witness.effectId &&
    source.effectId === input.profileSource.effectId &&
    sameSourceReference(source.sourceReference, input.sourceReference) &&
    source.logicalRoute.tenantId === scope.tenantId &&
    proof.sourceSubjectRef.tenantId === scope.tenantId &&
    source.operation.moduleId === 'commerce.customer-context' &&
    source.operation.entrypointKey === 'commerce.customer-context.create-counterparty-purchasing-profile' &&
    source.operation.schemaVersion === '1' &&
    source.materialization.projectionVersion === ORGANIZATION_PROFILE_SOURCE_CREATE_VERSION &&
    witness.materializationWitness.projectionVersion === ORGANIZATION_PROFILE_SOURCE_CREATE_VERSION &&
    source.materialization.inputDigest === witness.materializationWitness.inputDigest
  );
};

const matchesSourceProfileTarget = (
  scope: OperationalScope,
  input: SourceProfileCreateRequest,
  proof: SourceProfileCreateProof,
) => {
  const { target } = proof.source.materialization;
  const { organization } = proof.resolvedOwner;
  if (target.kind !== 'COUNTERPARTY_CUSTOMER') {
    return false;
  }
  return (
    sameRef(input.resolvedTarget.counterpartyRef, organization.counterpartyRef) &&
    sameRef(target.counterpartyRef, organization.counterpartyRef) &&
    sameRef(target.partyRef, organization.partyRef) &&
    sameRef(target.legalEntityRef, organization.legalEntityRef) &&
    sameRef(target.rolePeriodRef, organization.currentCustomerRoleRef) &&
    input.resolvedTarget.counterpartyRef.tenantId === scope.tenantId &&
    organization.counterpartyRef.tenantId === scope.tenantId &&
    organization.partyRef.tenantId === scope.tenantId &&
    organization.currentCustomerRoleRef.tenantId === scope.tenantId &&
    organization.legalEntityRef.tenantId === scope.tenantId &&
    organization.legalEntityRef.resourceId === scope.legalEntityId
  );
};

const matchesSourceProfileCreate = (
  scope: OperationalScope,
  input: SourceProfileCreateRequest,
  proof: CommerceOrganizationBusinessAuthority['liveProof'],
) => {
  if (
    !Schema.is(OrganizationBusinessSourceProfileCreateLiveProofSchema)(proof) ||
    input.projectionVersion !== ORGANIZATION_PROFILE_SOURCE_CREATE_TEMPLATE_VERSION ||
    input.fields.length !== ORGANIZATION_PROFILE_SOURCE_CREATE_FIELDS.length
  ) {
    return false;
  }
  const fields = new Set<string>(input.fields);
  return (
    ORGANIZATION_PROFILE_SOURCE_CREATE_FIELDS.every((field) => fields.has(field)) &&
    matchesSourceProfileWitness(scope, input, proof) &&
    matchesSourceProfileTarget(scope, input, proof)
  );
};

/** The API owns classification; consumers still bind its exact current proof to their own intent. */
export const validateOrganizationBusinessDecision = Effect.fn('OrganizationBusinessDecision.validate')(
  function* validate(
    scope: OperationalScope,
    input: CommerceOrganizationBusinessRequest,
    response: OrganizationBusinessApplicabilityResponse,
  ) {
    if (
      response.outcome !== 'NOT_APPLICABLE' ||
      response.consumerModuleId !== 'commerce.customer-context' ||
      response.classification !==
        (input.kind === 'SOURCE_ASSERTED' ? 'SOURCE_ASSERTED_ORGANIZATION' : 'CANONICAL_ORGANIZATION') ||
      response.operation !== input.operation ||
      response.projectionVersion !== input.projectionVersion ||
      response.inputDigest !== input.inputDigest ||
      scope.legalEntityId === undefined
    ) {
      return yield* denied();
    }
    const allowed = new Set<string>(response.allowedFields);
    if (allowed.size !== input.fields.length || !input.fields.every((field) => allowed.has(field))) {
      return yield* denied();
    }
    const proof = response.liveProof;
    if (input.kind === 'COUNTERPARTY_PROFILE') {
      if (proof.kind !== 'COUNTERPARTY_PROFILE' || !matchesProfileProof(scope, input, proof)) {
        return yield* denied();
      }
    } else if (input.kind === 'COUNTERPARTY_CUSTOMER') {
      if (proof.kind !== 'COUNTERPARTY_CUSTOMER' || !matchesCustomerProof(scope, input, proof)) {
        return yield* denied();
      }
    } else if (input.kind === 'SOURCE_ASSERTED') {
      if (input.operation !== 'COUNTERPARTY_PROFILE_CREATE' || !matchesSourceProfileCreate(scope, input, proof)) {
        return yield* denied();
      }
    } else {
      return yield* denied();
    }
    return response;
  },
);
