import { DateTime, Schema } from 'effect';
import { SourceProcessingEligibilityRequestSchema } from '@app/privacy-contracts/source-processing-eligibility';
import {
  PrivacyApplicabilityAuthoritySchema,
  PrivacyApplicabilityPolicySchema,
  resolvePrivacyApplicability,
} from '../../shared/domain/privacy-applicability.ts';
import {
  SourceProcessingAuthorizationSchema,
  SourceRouteProcessingOperation,
  sourceProcessingApplicabilityScope,
  sourceProcessingScopeId,
} from '../../shared/domain/privacy-source-processing-authorization.ts';
import type { SourceProcessingScopeTemplate } from '../../shared/domain/privacy-source-processing-authorization.ts';
import { ProcessingScopeRefSchema } from '../../shared/domain/privacy-responsibility-assignment.ts';
import { ProcessingPurposeSchema } from '../../shared/domain/processing-purpose.ts';

/** Explicit internal standing source-route authorization fixture; no statement about Symmy or production lawfulness. */
export const makeStandingSourceFixture = (ids: {
  authorizationId?: string;
  evaluatedAt?: string;
  legalEntityId: string;
  principalId: string;
  purposeId?: string;
  tenantId: string;
  versionId?: string;
}) => {
  const evaluatedAt = ids.evaluatedAt ?? '2026-11-07T12:00:00.000Z';
  const from = '2026-11-01T00:00:00.000Z';
  const until = DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(evaluatedAt), { days: 30 }));
  const consumerModuleId = 'party.registry' as const;
  const privacyModuleId = 'privacy.core' as const;
  const dataCategory = 'party:name';
  const authorizationId = ids.authorizationId ?? '10000000-0000-4000-8000-000000000020';
  const purposeId = ids.purposeId ?? '10000000-0000-4000-8000-000000000010';
  const versionId = ids.versionId ?? '10000000-0000-4000-8000-000000000011';
  const route = {
    issuer: 'internal:ebs-fixture',
    namespace: 'clients',
    recordType: 'customer',
    routeRef: 'route:approved-internal',
  };
  /** One request of the route; each customer and each request carries its own record and occurrence. */
  const requestFor = (recordId: string, occurrenceId: string) =>
    Schema.decodeUnknownSync(SourceProcessingEligibilityRequestSchema)({
      consumerModuleId,
      operation: 'CREATE',
      source: { ...route, occurrenceId, recordId },
      target: null,
    });
  const request = requestFor('client:one', 'occurrence:one');
  const controllerRef = 'controller:internal-test';
  const processingScopeRef = Schema.decodeUnknownSync(ProcessingScopeRefSchema)({
    scopeId: sourceProcessingScopeId(authorizationId),
    scopeType: 'privacy.processing-scope',
  });
  const authority = Schema.decodeUnknownSync(PrivacyApplicabilityAuthoritySchema)({
    controllerRef: {
      moduleId: 'core.identity',
      resourceId: controllerRef,
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
  const scopeTemplate: SourceProcessingScopeTemplate = {
    controllerRef,
    dataCategoryRefs: [dataCategory],
    operation: SourceRouteProcessingOperation,
    processingScopeRef,
    purposeRef: purposeId,
    purposeVersionId: versionId,
    recipientRefs: [consumerModuleId],
  };
  const policy = Schema.decodeUnknownSync(PrivacyApplicabilityPolicySchema)({
    composition: { precedence: 1, strategy: 'EXPLICIT_PRECEDENCE' },
    effectiveFrom: from,
    effectiveTo: until,
    factPredicates: [{ dimension: 'CATEGORY', operator: 'EQUALS', values: [dataCategory] }],
    jurisdictionProfile: { profileKey: 'internal-fixture:explicit', profileVersion: '1' },
    mandatoryDimensions: ['CATEGORY'],
    policyKey: 'source:internal-test',
    policyVersion: '1',
    scopeKey: `${processingScopeRef.scopeType}:${processingScopeRef.scopeId}:${SourceRouteProcessingOperation}`,
    sourceEvidenceRefs: ['fixture:policy:explicit'],
  });
  const responsibilityRef = {
    moduleId: privacyModuleId,
    resourceId: '10000000-0000-4000-8000-000000000021',
    resourceType: 'privacy.core.privacy-responsibility-assignment' as const,
    tenantId: ids.tenantId,
  };
  const receiptRef = `privacy.source-processing-authorization:${authorizationId}`;
  const decision = resolvePrivacyApplicability({
    authority,
    authorityEvidenceRefs: ['fixture:explicit-contract'],
    authorityReceiptRef: receiptRef,
    evaluatedAt: from,
    policies: [policy],
    proposedActivity: true,
    responsibilityAssignmentRefs: [responsibilityRef],
    scope: sourceProcessingApplicabilityScope(scopeTemplate),
  });
  const authorization = Schema.decodeUnknownSync(SourceProcessingAuthorizationSchema)({
    applicability: {
      authority,
      decisionRef: `fixture:applicability:${authorizationId}`,
      evaluatedAt: from,
      evidenceRefs: ['fixture:explicit-contract'],
      receiptRef,
    },
    authorizationRef: {
      moduleId: privacyModuleId,
      resourceId: authorizationId,
      resourceType: 'privacy.core.source-processing-authorization',
      tenantId: ids.tenantId,
    },
    createdAt: from,
    createdBy: { principalId: ids.principalId, tenantId: ids.tenantId },
    endedAt: null,
    endedBy: null,
    endReason: null,
    grants: [
      { allowTargetless: true, consumerModuleId, operation: 'CREATE', organizationBusinessUses: [], targetKinds: [] },
    ],
    legalBasisAssignmentRef: {
      moduleId: privacyModuleId,
      resourceId: '10000000-0000-4000-8000-000000000022',
      resourceType: 'privacy.core.legal-basis-assignment',
      tenantId: ids.tenantId,
    },
    legalEntityId: ids.legalEntityId,
    lifecycle: 'ACTIVE',
    principals: [{ authMethod: 'api_key', principalId: ids.principalId }],
    responsibilityAssignmentRefs: [responsibilityRef],
    revision: 1,
    scopeTemplate,
    source: {
      issuer: route.issuer,
      namespace: route.namespace,
      recordTypes: [route.recordType],
      routeRef: route.routeRef,
    },
  });
  const ended = Schema.decodeUnknownSync(SourceProcessingAuthorizationSchema)({
    ...Schema.encodeSync(SourceProcessingAuthorizationSchema)(authorization),
    endedAt: from,
    endedBy: { principalId: ids.principalId, tenantId: ids.tenantId },
    endReason: 'fixture:integration-removed',
    lifecycle: 'ENDED',
    revision: 2,
  });
  const purpose = Schema.decodeUnknownSync(ProcessingPurposeSchema)({
    businessCode: 'SYMMY_INTEGRATION',
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
        meaning: 'Explicit internal source ingestion fixture',
        recordedAt: from,
        versionId,
        versionNumber: 1,
      },
    ],
  });
  return { authorization, decision, ended, evaluatedAt, from, policy, purpose, request, requestFor, route, until };
};
