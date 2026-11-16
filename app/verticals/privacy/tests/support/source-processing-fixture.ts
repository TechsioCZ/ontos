import { DateTime, Schema } from 'effect';
import {
  PrivacyApplicabilityAuthoritySchema,
  PrivacyApplicabilityPolicySchema,
  PrivacyApplicabilityScopeSchema,
  resolvePrivacyApplicability,
} from '../../shared/domain/privacy-applicability.ts';
import { ProcessingPurposeSchema } from '../../shared/domain/processing-purpose.ts';
import { SourceProcessingContextSchema } from '../../shared/apis/source-processing-eligibility.ts';

/** Explicit internal source contract fixture; no statement about Symmy or production lawfulness. */
export const makeSourceProcessingFixture = (ids: {
  authMethod?: string;
  evaluatedAt?: string;
  legalEntityId: string;
  principalId: string;
  purposeId?: string;
  subjectId?: string;
  tenantId: string;
  versionId?: string;
}) => {
  const evaluatedAt = ids.evaluatedAt ?? '2026-11-07T12:00:00.000Z';
  const from = '2026-11-01T00:00:00.000Z';
  const until = DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(evaluatedAt), { days: 30 }));
  const consumerModuleId = 'party.registry' as const;
  const privacyModuleId = 'privacy.core' as const;
  const dataCategory = 'party:name';
  const processingScopeType = 'privacy.processing-scope';
  const purposeId = ids.purposeId ?? '10000000-0000-4000-8000-000000000010';
  const versionId = ids.versionId ?? '10000000-0000-4000-8000-000000000011';
  const request = {
    consumerModuleId,
    operation: 'CREATE',
    source: {
      issuer: 'internal:ebs-fixture',
      namespace: 'clients',
      occurrenceId: 'occurrence:one',
      recordId: 'client:one',
      recordType: 'customer',
      routeRef: 'route:approved-internal',
    },
    target: null,
  };
  const subjectRef = {
    moduleId: privacyModuleId,
    resourceId: ids.subjectId ?? '10000000-0000-4000-8000-000000000012',
    resourceType: 'privacy.core.privacy-subject' as const,
    tenantId: ids.tenantId,
  };
  const intendedScope = {
    controllerRef: 'controller:internal-test',
    dataCategoryRefs: [dataCategory],
    operation: request.operation,
    processingScopeRef: { scopeId: `source-processing:${ids.tenantId}`, scopeType: processingScopeType },
    purposeRef: purposeId,
    purposeVersionId: versionId,
    recipientRefs: [consumerModuleId],
    subjectRef,
  };
  const authority = Schema.decodeUnknownSync(PrivacyApplicabilityAuthoritySchema)({
    controllerRef: {
      moduleId: privacyModuleId,
      resourceId: intendedScope.controllerRef,
      resourceType: 'privacy.core.controller',
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
  const facts = [
    { dimension: 'CATEGORY' as const, value: dataCategory },
    { dimension: 'CONTROLLER_SCOPE' as const, value: intendedScope.controllerRef },
    { dimension: 'PRIVACY_SUBJECT' as const, value: subjectRef.resourceId },
    { dimension: 'PROCESSING_PURPOSE' as const, value: purposeId },
    { dimension: 'PROCESSING_PURPOSE_VERSION' as const, value: versionId },
    { dimension: 'RECIPIENT' as const, value: consumerModuleId },
  ];
  const policy = Schema.decodeUnknownSync(PrivacyApplicabilityPolicySchema)({
    composition: { precedence: 1, strategy: 'EXPLICIT_PRECEDENCE' },
    effectiveFrom: from,
    effectiveTo: until,
    factPredicates: [{ dimension: 'CATEGORY', operator: 'EQUALS', values: [dataCategory] }],
    jurisdictionProfile: { profileKey: 'internal-fixture:explicit', profileVersion: '1' },
    mandatoryDimensions: ['CATEGORY'],
    policyKey: 'source:internal-test',
    policyVersion: '1',
    scopeKey: `${intendedScope.processingScopeRef.scopeType}:${intendedScope.processingScopeRef.scopeId}:CREATE`,
    sourceEvidenceRefs: ['fixture:policy:explicit'],
  });
  const applicabilityScope = Schema.decodeUnknownSync(PrivacyApplicabilityScopeSchema)({
    facts,
    operation: 'CREATE',
    processingScopeRef: intendedScope.processingScopeRef,
  });
  const decision = resolvePrivacyApplicability({
    authority,
    authorityEvidenceRefs: ['fixture:current-business-facts'],
    authorityReceiptRef: 'fixture:durable-authority-receipt',
    evaluatedAt: from,
    policies: [policy],
    proposedActivity: true,
    scope: applicabilityScope,
  });
  const context = Schema.decodeUnknownSync(SourceProcessingContextSchema)({
    ...ids,
    applicabilityAuthority: {
      asOf: from,
      authority,
      decisionEvaluatedAt: from,
      decisionOutcome: decision.outcome,
      decisionRef: `fixture:applicability:${ids.tenantId}`,
      evidenceRefs: ['fixture:current-business-facts'],
      receiptRef: 'fixture:durable-authority-receipt',
      scope: applicabilityScope,
      status: 'CURRENT',
      validUntil: until,
    },
    authMethod: ids.authMethod ?? 'session',
    authorityIncarnation: 'fixture:incarnation:one',
    authorityRevision: 'fixture:revision:one',
    contentScopeRefs: [dataCategory],
    effectiveFrom: from,
    intendedScope,
    request,
    resourceRefs: ['source:internal-client-one'],
    validUntil: until,
  });
  const purpose = Schema.decodeUnknownSync(ProcessingPurposeSchema)({
    businessCode: 'INTERNAL_SOURCE_FIXTURE',
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
  return { context, decision, evaluatedAt, from, policy, purpose, request, until };
};
