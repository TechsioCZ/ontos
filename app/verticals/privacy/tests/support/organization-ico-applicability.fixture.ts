import { DateTime, Schema } from 'effect';
import { ProcessingPurposeSchema } from '../../shared/domain/processing-purpose.ts';
import { OrganizationIcoFactsResponseSchema } from '@app/party-registry/apis/organization-ico-facts';
import {
  OrganizationIcoApplicabilityContextSchema,
  OrganizationIcoApplicabilityRequestSchema,
} from '../../shared/apis/organization-ico-applicability.ts';
import {
  PrivacyApplicabilityAuthoritySchema,
  PrivacyApplicabilityPolicySchema,
  resolvePrivacyApplicability,
} from '../../shared/domain/privacy-applicability.ts';
import { PrivacyResponsibilityAssignmentSchema } from '../../shared/domain/privacy-responsibility-assignment.ts';
import { organizationIcoBusinessFacts } from '../../src/services/organization-ico-applicability.service.ts';

export const makeOrganizationIcoApplicabilityFixture = (ids: {
  authMethod?: string;
  effectiveFrom?: string;
  evaluatedAt?: string;
  legalEntityId: string;
  partyId?: string;
  principalId: string;
  purposeId?: string;
  tenantId: string;
  versionId?: string;
}) => {
  const from = ids.effectiveFrom ?? '2026-11-01T00:00:00.000Z';
  const evaluatedAt = ids.evaluatedAt ?? '2026-11-07T12:00:00.000Z';
  const until = DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(evaluatedAt), { days: 30 }));
  const purposeId = ids.purposeId ?? '71000000-0000-4000-8000-000000000010';
  const versionId = ids.versionId ?? '71000000-0000-4000-8000-000000000011';
  const version = 'party.registry.organization-ico-business-fields.v1';
  const privacyModuleId = 'privacy.core';
  const partyId = ids.partyId ?? '70000000-0000-4000-8000-000000000003';
  const fields = [
    'assertionRef',
    'partyRef',
    'revision',
    'normalizedValue',
    'originalInput.kind',
    'originalInput.digits',
    'state',
    'isCurrent',
    'validFrom',
    'validTo',
    'recordedAt',
    'provenance.ownerReceiptRef',
  ];
  const request = Schema.decodeUnknownSync(OrganizationIcoApplicabilityRequestSchema)({
    fields,
    operation: 'party-ico-legacy-inventory.read',
    partyRef: {
      moduleId: 'party.registry',
      resourceId: partyId,
      resourceType: 'party.registry.party',
      tenantId: ids.tenantId,
    },
  });
  const authority = Schema.decodeUnknownSync(PrivacyApplicabilityAuthoritySchema)({
    controllerRef: {
      moduleId: 'core.identity',
      resourceId: ids.legalEntityId,
      resourceType: 'core.identity.legal-entity',
      tenantId: ids.tenantId,
    },
    legalEntityId: ids.legalEntityId,
    purposeRef: {
      moduleId: privacyModuleId,
      resourceId: purposeId,
      resourceType: 'privacy.core.processing-purpose',
      tenantId: ids.tenantId,
    },
    purposeVersionRef: {
      moduleId: privacyModuleId,
      resourceId: versionId,
      resourceType: 'privacy.core.processing-purpose-version',
      tenantId: ids.tenantId,
    },
    tenantId: ids.tenantId,
  });
  const processingScopeRef = { scopeId: `${version}:${partyId}`, scopeType: 'privacy.processing-scope' };
  const context = Schema.decodeUnknownSync(OrganizationIcoApplicabilityContextSchema)({
    authMethod: ids.authMethod ?? 'session',
    authority,
    authorityIncarnation: 'internal:org-ico-incarnation:1',
    authorityRevision: 'internal:org-ico-revision:1',
    decisionRef: `fixture:org-decision:${ids.tenantId}`,
    effectiveFrom: from,
    legalEntityId: ids.legalEntityId,
    principalId: ids.principalId,
    processingScopeRef,
    request,
    tenantId: ids.tenantId,
    validUntil: until,
  });
  const proof = Schema.decodeUnknownSync(OrganizationIcoFactsResponseSchema.members[1])({
    allowedFields: fields,
    fieldContractVersion: version,
    outcome: 'CURRENT_ORGANIZATION',
    partyRef: request.partyRef,
    partyRevision: 7,
    typeAssertionId: '70000000-0000-4000-8000-000000000004',
    typeAssertionIsCurrent: true,
    typeAssertionRecordedAt: from,
    typeAssertionState: 'ACTIVE',
    typeAssertionValidFrom: from,
    typeAssertionValidTo: null,
  });
  const business = organizationIcoBusinessFacts(context, proof, evaluatedAt);
  const policy = Schema.decodeUnknownSync(PrivacyApplicabilityPolicySchema)({
    composition: { precedence: 10, strategy: 'EXPLICIT_PRECEDENCE' },
    effectiveFrom: from,
    effectiveTo: until,
    factPredicates: business.scope.facts.map(({ dimension, value }) => ({
      dimension,
      operator: 'EQUALS',
      values: [value],
    })),
    jurisdictionProfile: { profileKey: 'internal:organization-ico-classification', profileVersion: '1' },
    mandatoryDimensions: business.scope.facts.map(({ dimension }) => dimension),
    nonPersonalApplicability: {
      allowedFields: fields,
      fieldContractVersion: version,
      holdBehavior: 'NO_ACTIVE_SCOPE_HOLD',
      kind: 'ORGANIZATION_ICO_ONLY',
    },
    policyKey: `fixture:org-policy:${ids.tenantId}`,
    policyVersion: '1',
    scopeKey: `privacy.processing-scope:${processingScopeRef.scopeId}:${request.operation}`,
    sourceEvidenceRefs: ['internal:approved-nonpersonal-classification'],
  });
  const responsibility = Schema.decodeUnknownSync(PrivacyResponsibilityAssignmentSchema)({
    actor: { principalId: ids.principalId, tenantId: ids.tenantId },
    assignmentRef: {
      moduleId: privacyModuleId,
      resourceId: `fixture:org-controller:${ids.tenantId}`,
      resourceType: 'privacy.core.privacy-responsibility-assignment',
      tenantId: ids.tenantId,
    },
    effectiveFrom: from,
    effectiveTo: null,
    holder: { holder: authority.controllerRef, holderKind: 'LEGAL_ENTITY' },
    provenance: {
      decisionEvidenceRefs: ['internal:controller-arrangement'],
      reason: 'Explicit internal organization ICO classification context',
      recordedAt: from,
    },
    role: 'CONTROLLER',
    scopeRef: processingScopeRef,
  });
  const decision = resolvePrivacyApplicability({
    authority,
    authorityEvidenceRefs: business.evidenceRefs,
    authorityReceiptRef: business.receiptRef,
    evaluatedAt,
    policies: [policy],
    proposedActivity: false,
    responsibilityAssignmentRefs: [responsibility.assignmentRef],
    scope: business.scope,
  });
  const purpose = Schema.decodeUnknownSync(ProcessingPurposeSchema)({
    businessCode: 'INTERNAL_ORGANIZATION_ICO',
    createdAt: from,
    governanceOwnerId: ids.principalId,
    legalEntityId: ids.legalEntityId,
    lifecycle: 'ACTIVE',
    purposeRef: authority.purposeRef,
    retiredAt: null,
    versions: [
      {
        effectiveFrom: from,
        effectiveTo: until,
        materialChangeAssessment: null,
        meaning: 'Explicit approved organization ICO business field classification',
        recordedAt: from,
        versionId,
        versionNumber: 1,
      },
    ],
  });
  return { business, context, decision, evaluatedAt, from, policy, proof, purpose, request, responsibility, until };
};
