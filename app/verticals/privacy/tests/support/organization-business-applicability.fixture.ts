import { ReadHandlerUnavailable, TrustedPrincipalContextSchema } from '@app/core-runtime';
import { computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';
import {
  OrganizationBusinessSourceFields,
  OrganizationBusinessSourceProjectionVersion,
  CurrentCanonicalOrganizationCustomerRecordFactsSchema,
  CurrentOrganizationRecordFactsSchema,
  CurrentOrganizationCustomerRecordFactsSchema,
  OrganizationBusinessOnboardFields,
  OrganizationBusinessOnboardInputSchema,
  OrganizationBusinessOnboardTemplateSchema,
  OrganizationBusinessCounterpartyContextReason,
  OrganizationBusinessCustomerRoleReason,
  organizationBusinessOnboardTemplateDigest,
  organizationBusinessRecordInputDigest,
} from '@app/party-registry/apis/organization-record-facts';
import {
  OrganizationBusinessNameExportFields,
  OrganizationBusinessNameExportProjectionVersion,
  organizationBusinessNameExportInputDigest,
} from '@app/party-registry/apis/organization-business-name-export';
import { CustomerProfileOrganizationIcoFactsCurrentSchema } from '@app/commerce-customer-context/api/customer-profile-organization-ico-facts';
import {
  SymmySourceOrganizationFactsCurrentSchema,
  SymmySourceOrganizationFactsMaterializedSchema,
} from '@app/symmy-integration/api/symmy-source-organization-facts';
import {
  ORGANIZATION_PROFILE_SOURCE_CREATE_FIELDS,
  ORGANIZATION_PROFILE_SOURCE_CREATE_TEMPLATE_VERSION,
  ORGANIZATION_PROFILE_SOURCE_CREATE_VERSION,
  OrganizationProfileSourceCreateSchema,
  OrganizationProfileSourceCreateTemplateSchema,
  fingerprintOrganizationProfileSourceCreate,
  fingerprintOrganizationProfileSourceCreateTemplate,
} from '@app/commerce-customer-context/domain/organization-profile-source';
import {
  ORGANIZATION_MEMBERSHIP_PROJECTION_VERSION,
  ORGANIZATION_MEMBERSHIP_WRITE_FIELDS,
} from '@app/commerce-customer-context/domain/organization-membership-source';
import {
  ORGANIZATION_PRICE_ASSIGNMENT_PROJECTION_VERSION,
  ORGANIZATION_PRICE_ASSIGNMENT_WRITE_FIELDS,
} from '@app/commerce-customer-context/domain/organization-price-assignment-fields';
import { Effect, Match, Option, Schema } from 'effect';
import {
  OrganizationBusinessApplicabilityContextSchema,
  OrganizationBusinessApplicabilityIntentSchema,
  OrganizationBusinessApplicabilityRequestSchema,
  OrganizationBusinessSourceOnboardLiveProofSchema,
  OrganizationBusinessSourceProfileCreateLiveProofSchema,
} from '../../shared/apis/organization-business-applicability.ts';
import { AntiResurrectionProtectionSchema } from '../../shared/domain/anti-resurrection.ts';
import {
  PrivacyApplicabilityPolicySchema,
  resolvePrivacyApplicability,
} from '../../shared/domain/privacy-applicability.ts';
import type { PrivacyIsoTimestampSchema } from '../../shared/domain/privacy-subject.ts';
import { PrivacySubjectRecordSchema } from '../../shared/domain/privacy-subject.ts';
import {
  organizationBusinessFacts,
  evaluateOrganizationBusinessApplicability,
} from '../../src/services/organization-business-applicability.service.ts';
import type { OrganizationBusinessApplicabilityServices } from '../../src/services/organization-business-applicability.service.ts';
import { makeOrganizationProfileIcoApplicabilityFixture } from './organization-profile-ico-applicability.fixture.ts';

const ModeSchema = Schema.Literals(['SOURCE_CREATE', 'SOURCE_MATCH', 'MEMBERSHIP', 'PRICE', 'NAME_EXPORT']);
type Mode = typeof ModeSchema.Type;
const DagModeSchema = Schema.Literals(['ONBOARD', 'PROFILE_CREATE']);
type DagMode = typeof DagModeSchema.Type;
interface FixtureOptions {
  readonly authMethod?: string;
  readonly evaluatedAt?: typeof PrivacyIsoTimestampSchema.Type;
  readonly legalEntityId?: string;
  readonly partyId?: string;
  readonly principalId?: string;
  readonly profileId?: string;
  readonly purposeId?: string;
  readonly tenantId?: string;
  readonly versionId?: string;
}
const sourceFixtureProofSchema = Schema.Struct({
  kind: Schema.Literal('SOURCE_ASSERTED'),
  source: SymmySourceOrganizationFactsCurrentSchema,
  sourceSubjectRef: PrivacySubjectRecordSchema.fields.subjectRef,
  sourceSubjectRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});
const profileFixtureProofSchema = Schema.Struct({
  kind: Schema.Literal('COUNTERPARTY_PROFILE'),
  organization: CurrentCanonicalOrganizationCustomerRecordFactsSchema,
  profile: CustomerProfileOrganizationIcoFactsCurrentSchema,
});
const partyFixtureProofSchema = Schema.Struct({
  kind: Schema.Literal('PARTY'),
  organization: CurrentOrganizationRecordFactsSchema,
});
export const organizationBusinessFixtureIds = {
  legalEntityId: '81000000-0000-4000-8000-000000000002',
  principalId: '81000000-0000-4000-8000-000000000003',
  tenantId: '81000000-0000-4000-8000-000000000001',
};
const partyModuleId = 'party.registry';

/** Unit-only trusted owner DTOs. This fixture does not establish a receiving-owner or gateway proof. */
export const makeOrganizationBusinessApplicabilityFixture = Effect.fn('Test.organizationBusinessFixture')(
  function* make(mode: Mode = 'SOURCE_CREATE', options: FixtureOptions = {}) {
    const ids = { ...organizationBusinessFixtureIds, ...options };
    const base = makeOrganizationProfileIcoApplicabilityFixture(ids);
    const sourceReference = {
      occurrenceId: 'organization-observation-1',
      recordId: 'organization-record-1',
      source: {
        issuer: 'internal-organization-fixture',
        namespace: 'company-records',
        recordType: 'company',
        routeRef: 'organization-source-route',
      },
    };
    const originalAdmissionInvocationId = '81000000-0000-4000-8000-000000000010';
    const effectId = '81000000-0000-4000-8000-000000000011';
    const execution = { jobId: '81000000-0000-4000-8000-000000000012', kind: 'JOB' };
    const scope = {
      ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
        ...ids,
        authBindingId: '81000000-0000-4000-8000-000000000004',
        authContextRef: 'internal:organization-business-unit',
        authenticationNamespaceId: 'core.staff',
        authMethod: base.context.authMethod,
      }),
      correlationId: 'internal:organization-business-unit',
    };
    const record = Schema.decodeUnknownSync(PrivacySubjectRecordSchema)({
      createdAt: base.from,
      subject: { kind: 'SOURCE_ASSERTED', source: { ...sourceReference.source, recordId: sourceReference.recordId } },
      subjectRef: {
        moduleId: 'privacy.core',
        resourceId: '81000000-0000-4000-8000-000000000013',
        resourceType: 'privacy.core.privacy-subject',
        tenantId: ids.tenantId,
      },
      updatedAt: base.from,
    });
    const [encodedRecord, nameExportProjection] = yield* Effect.all(
      [
        Schema.encodeEffect(PrivacySubjectRecordSchema)(record),
        organizationBusinessNameExportInputDigest({ partyRef: base.proof.partyRef, sourceReference }),
      ],
      { concurrency: 2 },
    );
    const sourceRevision = computeCanonicalValueHash(encodedRecord);
    const sourceSnapshot = { protections: [], reconciled: false, record, revision: sourceRevision };
    const operation = mode === 'SOURCE_MATCH' ? 'MATCH' : 'CREATE';
    const sourceIntent = {
      consumerModuleId: partyModuleId,
      fields: OrganizationBusinessSourceFields,
      inputDigest: 'a'.repeat(64),
      kind: 'SOURCE_ASSERTED',
      operation,
      projectionVersion: OrganizationBusinessSourceProjectionVersion,
      sourceReference,
    };
    const profileIntent = Match.value(mode).pipe(
      Match.when('PRICE', () => ({
        fields: ORGANIZATION_PRICE_ASSIGNMENT_WRITE_FIELDS,
        operation: 'PRICE_GROUP_ASSIGN',
        projectionVersion: ORGANIZATION_PRICE_ASSIGNMENT_PROJECTION_VERSION,
      })),
      Match.orElse(() => ({
        fields: ORGANIZATION_MEMBERSHIP_WRITE_FIELDS,
        operation: 'customer-group-membership.write',
        projectionVersion: ORGANIZATION_MEMBERSHIP_PROJECTION_VERSION,
      })),
    );
    const isSource = mode === 'SOURCE_CREATE' || mode === 'SOURCE_MATCH';
    const intentInput = Match.value(mode).pipe(
      Match.when('NAME_EXPORT', () => ({
        consumerModuleId: partyModuleId,
        expectedPartyRevision: 7,
        fields: OrganizationBusinessNameExportFields,
        inputDigest: nameExportProjection.inputDigest,
        kind: 'PARTY',
        operation: 'ORGANIZATION_BUSINESS_NAME_EXPORT',
        partyRef: nameExportProjection.partyRef,
        projectionVersion: OrganizationBusinessNameExportProjectionVersion,
        sourceReference: nameExportProjection.sourceReference,
      })),
      Match.orElse(() =>
        isSource
          ? sourceIntent
          : {
              ...profileIntent,
              consumerModuleId: 'commerce.customer-context',
              expectedProfileRevision: 5,
              inputDigest: 'b'.repeat(64),
              kind: 'COUNTERPARTY_PROFILE',
              profileRef: base.request.profileRef,
            },
      ),
    );
    const intent = Schema.decodeUnknownSync(OrganizationBusinessApplicabilityIntentSchema)(intentInput);
    const request = Schema.decodeUnknownSync(OrganizationBusinessApplicabilityRequestSchema)(
      isSource
        ? {
            ...sourceIntent,
            processingWitness: { effectId, originalAdmissionInvocationId, purpose: 'PROCESSING' },
          }
        : intent,
    );
    const processingScopeRef = {
      scopeId: `internal:organization-business:${mode}`,
      scopeType: 'privacy.processing-scope',
    };
    const contextFields = {
      ...base.context,
      authorityIncarnation: 'internal:organization-business-incarnation:1',
      authorityRevision: 'internal:organization-business-revision:1',
      decisionRef: `internal:organization-business-decision:${mode}`,
      processingScopeRef,
      request: intent,
    };
    const context = Schema.decodeUnknownSync(OrganizationBusinessApplicabilityContextSchema)(
      isSource
        ? {
            ...contextFields,
            governanceSelector: { effectKey: 'company-effect', execution, purpose: 'GOVERNANCE', sourceReference },
          }
        : contextFields,
    );
    const sourceProof = Schema.decodeUnknownSync(sourceFixtureProofSchema)({
      kind: 'SOURCE_ASSERTED',
      source: {
        acceptedAdmissionInvocationId: originalAdmissionInvocationId,
        admittedIntentDigest: 'c'.repeat(64),
        classification: 'SOURCE_ASSERTED_ORGANIZATION',
        effectId,
        enrollmentMappingVersion: 'organization-mapping-v1',
        enrollmentRouteId: 'organization-route',
        enrollmentRouteRevision: 'organization-route-v1',
        execution,
        inputDigest: sourceIntent.inputDigest,
        logicalRoute: { integrationRouteId: 'organization-route', tenantId: ids.tenantId },
        mappingVersion: 'organization-mapping-v1',
        operation: {
          entrypointKey: operation === 'CREATE' ? 'party.registry.create-party' : 'party.registry.match-party',
          moduleId: partyModuleId,
          schemaVersion: '1',
        },
        originalAdmissionInvocationId,
        outcome: 'CURRENT_SOURCE_ASSERTED_ORGANIZATION',
        projectionVersion: OrganizationBusinessSourceProjectionVersion,
        routeRevision: 'organization-route-v1',
        sourceReference,
      },
      sourceSubjectRef: record.subjectRef,
      sourceSubjectRevision: sourceRevision,
    });
    const counterpartyRef = {
      moduleId: partyModuleId,
      resourceId: '81000000-0000-4000-8000-000000000014',
      resourceType: 'party.registry.counterparty',
      tenantId: ids.tenantId,
    };
    const currentCustomerRoleRef = {
      moduleId: partyModuleId,
      resourceId: '81000000-0000-4000-8000-000000000015',
      resourceType: 'party.registry.counterparty-role-period',
      tenantId: ids.tenantId,
    };
    const profileProof = Schema.decodeUnknownSync(profileFixtureProofSchema)({
      kind: 'COUNTERPARTY_PROFILE',
      organization: {
        counterpartyRef,
        counterpartyRevision: 'd'.repeat(64),
        currentCustomerRoleRef,
        currentCustomerRoleRevision: 'e'.repeat(64),
        legalEntityRef: base.context.authority.controllerRef,
        outcome: 'CURRENT_CANONICAL_ORGANIZATION_CUSTOMER',
        partyRef: base.proof.partyRef,
        partyRevision: 7,
        sourceCitation: null,
        typeAssertionId: base.proof.organization.typeAssertionId,
        typeAssertionRevision: 'f'.repeat(64),
        typeRecordedAt: base.from,
        typeValidFrom: base.from,
        typeValidTo: null,
      },
      profile: {
        _tag: 'CURRENT',
        counterpartyRef,
        counterpartyRevision: 'd'.repeat(64),
        currentCustomerRoleRef,
        currentCustomerRoleRevision: 'e'.repeat(64),
        legalEntityRef: base.context.authority.controllerRef,
        partyRef: base.proof.partyRef,
        partyRevision: 7,
        profileRef: base.request.profileRef,
        profileRevision: 5,
      },
    });
    const { organization } = profileProof;
    const partyProof = Schema.decodeUnknownSync(partyFixtureProofSchema)({
      kind: 'PARTY',
      organization: {
        outcome: 'CURRENT_ORGANIZATION',
        partyRef: organization.partyRef,
        partyRevision: organization.partyRevision,
        sourceCitation: {
          originalOccurrenceId: sourceReference.occurrenceId,
          sourceActionInvocationId: '81000000-0000-4000-8000-000000000031',
          sourceDecisionRef: {
            moduleId: partyModuleId,
            resourceId: '81000000-0000-4000-8000-000000000030',
            resourceType: 'party.registry.party-match-decision',
            tenantId: ids.tenantId,
          },
        },
        typeAssertionId: organization.typeAssertionId,
        typeAssertionRevision: organization.typeAssertionRevision,
        typeRecordedAt: organization.typeRecordedAt,
        typeValidFrom: organization.typeValidFrom,
        typeValidTo: organization.typeValidTo,
      },
    });
    const proof = Match.value(mode).pipe(
      Match.when('NAME_EXPORT', () => partyProof),
      Match.orElse(() => (isSource ? sourceProof : profileProof)),
    );
    const business = yield* organizationBusinessFacts(context, proof, base.evaluatedAt);
    const policy = Schema.decodeUnknownSync(PrivacyApplicabilityPolicySchema)({
      composition: { precedence: 10, strategy: 'EXPLICIT_PRECEDENCE' },
      effectiveFrom: base.from,
      effectiveTo: base.until,
      factPredicates: business.scope.facts.map(({ dimension, value }) => ({
        dimension,
        operator: 'EQUALS',
        values: [value],
      })),
      jurisdictionProfile: { profileKey: 'internal:organization-business-classification', profileVersion: '1' },
      mandatoryDimensions: business.scope.facts.map(({ dimension }) => dimension),
      nonPersonalApplicability: {
        allowedFields: intent.fields,
        classification: isSource ? 'SOURCE_ASSERTED_ORGANIZATION' : 'CANONICAL_ORGANIZATION',
        consumerModuleId: intent.consumerModuleId,
        holdBehavior: 'NO_ACTIVE_SCOPE_HOLD',
        kind: 'ORGANIZATION_BUSINESS_ONLY',
        operation: intent.operation,
        projectionVersion: intent.projectionVersion,
      },
      policyKey: `internal:organization-business-policy:${mode}`,
      policyVersion: '1',
      scopeKey: `privacy.processing-scope:${processingScopeRef.scopeId}:${intent.operation}`,
      sourceEvidenceRefs: ['internal:explicit-organization-business-policy'],
    });
    const responsibility = { ...base.responsibility, scopeRef: context.processingScopeRef };
    const purpose = {
      ...base.purpose,
      businessCode: 'INTERNAL_ORGANIZATION_BUSINESS',
      versions: base.purpose.versions.map((version) => ({
        ...version,
        meaning: 'Explicit finite organization business field classification',
      })),
    };
    const decision = resolvePrivacyApplicability({
      authority: business.authority,
      authorityEvidenceRefs: business.evidenceRefs,
      authorityReceiptRef: business.receiptRef,
      evaluatedAt: base.evaluatedAt,
      policies: [policy],
      proposedActivity: false,
      responsibilityAssignmentRefs: [responsibility.assignmentRef],
      scope: business.scope,
    });
    const services: OrganizationBusinessApplicabilityServices = {
      contexts: [context],
      decision: () => Effect.succeed(Option.some(decision)),
      holds: () => Effect.succeed('CLEAR'),
      proof: () => Effect.succeed(proof),
      purposes: { get: () => Effect.succeed(Option.some(purpose)) },
      repository: {
        listApplicabilityDecisions: () => Effect.succeed([decision]),
        listApplicabilityPolicies: () => Effect.succeed([policy]),
        listResponsibilities: () => Effect.succeed([responsibility]),
      },
      sourceAuthority: { read: () => Effect.succeed(sourceSnapshot) },
    };
    const protection = Schema.decodeUnknownSync(AntiResurrectionProtectionSchema)({
      contentScopeRefs: ['internal:original-source-fields'],
      enforcementReceipt: {
        authorityRef: 'internal:source-enforcement',
        contentScopeRefs: ['internal:original-source-fields'],
        evidenceRefs: ['internal:source-owner-enforcement'],
        measure: 'DELETE',
        operations: ['IMPORT', 'REPLAY', 'PROJECTION_REBUILD', 'BACKUP_RECOVERY'],
        ownerModuleId: partyModuleId,
        receiptRef: 'internal:source-enforced',
        resourceRefs: ['internal:original-source-material'],
        subjectRef: record.subjectRef.resourceId,
        taskId: 'internal:source-task',
        tenantId: ids.tenantId,
      },
      evidenceRefs: ['internal:source-deletion'],
      measure: 'DELETE',
      outcomeStatus: 'SUCCEEDED',
      ownerExecutionOutcomeRef: 'internal:source-deleted',
      protectedAt: base.from,
      protectionId: 'internal:source-protection',
      resourceRefs: ['internal:original-source-material'],
      sourceDecisionRef: 'internal:source-erasure-decision',
      sourceDecisionRevision: 1,
      subjectRef: record.subjectRef.resourceId,
      tenantId: ids.tenantId,
    });
    return {
      business,
      context,
      decision,
      evaluatedAt: base.evaluatedAt,
      intent,
      nameExportProjection,
      partyProof,
      policy,
      profileProof,
      proof,
      protection,
      purpose,
      request,
      responsibility,
      run: (ports = services) => evaluateOrganizationBusinessApplicability(request, scope, ports, base.evaluatedAt),
      scope,
      services,
      sourceProof,
      sourceSnapshot,
    };
  },
);

/** Retained semantic templates and later owner DTOs remain separate unit proof seams. */
export const makeOrganizationBusinessSourceDagFixture = Effect.fn('Test.organizationBusinessSourceDagFixture')(
  function* make(mode: DagMode, options: FixtureOptions = {}) {
    const base = yield* makeOrganizationBusinessApplicabilityFixture('SOURCE_CREATE', options);
    const reference = base.sourceProof.source.sourceReference;
    const source = {
      effectId: '81000000-0000-4000-8000-000000000021',
      issuer: 'internal-organization-profile-fixture',
      mappingRevision: 'profile-mapping-v1',
      namespace: 'organization-profiles',
      occurrenceId: reference.occurrenceId,
      order: 1,
      recordId: reference.recordId,
      recordType: 'company-profile',
      revision: 'profile-source-v1',
      route: { id: 'profile-route', revision: 'profile-route-v1' },
    };
    const template = Schema.decodeUnknownSync(OrganizationBusinessOnboardTemplateSchema)({
      _tag: 'OnboardCounterpartyCustomerFromParty',
      fromPartyEffect: { effectKey: 'party-effect', itemKey: 'company-item' },
      payload: {
        counterpartyProvenance: {
          evidenceReference: reference.recordId,
          method: 'APPROVED_COMMERCIAL_RELATIONSHIP',
          reason: OrganizationBusinessCounterpartyContextReason,
          source: reference.source.routeRef,
        },
        customerEvidence: {
          evidenceReference: reference.recordId,
          method: 'APPROVED_PURCHASING_RELATIONSHIP',
          reason: OrganizationBusinessCustomerRoleReason,
          source: reference.source.routeRef,
        },
        sourceReference: reference,
        validFrom: base.sourceSnapshot.record.createdAt,
      },
    });
    const profileTemplate = Schema.decodeUnknownSync(OrganizationProfileSourceCreateTemplateSchema)({
      _tag: 'CreateCounterpartyProfileFromCounterparty',
      fromCounterpartyEffect: { effectKey: 'onboard-effect', itemKey: 'company-item' },
      payload: {
        effectiveAt: base.sourceSnapshot.record.createdAt,
        partySourceReference: reference,
        source,
        subject: { kind: 'COUNTERPARTY', sellingLegalEntityRef: base.profileProof.organization.legalEntityRef },
        trigger: 'AUTHORIZED_ONBOARDING',
      },
    });
    const encodedTemplate = yield* Schema.encodeEffect(OrganizationBusinessOnboardTemplateSchema)(template);
    const encodedProfileTemplate = yield* Schema.encodeEffect(OrganizationProfileSourceCreateTemplateSchema)(
      profileTemplate,
    );
    const [onboardSemantic, profileSemanticDigest] = yield* Effect.all(
      [
        organizationBusinessOnboardTemplateDigest(encodedTemplate),
        fingerprintOrganizationProfileSourceCreateTemplate(encodedProfileTemplate),
      ],
      { concurrency: 2 },
    );
    const nativeOnboard = Schema.decodeUnknownSync(OrganizationBusinessOnboardInputSchema)({
      ...template.payload,
      partyRef: base.profileProof.organization.partyRef,
    });
    const nativeProfile = Schema.decodeUnknownSync(OrganizationProfileSourceCreateSchema)({
      ...profileTemplate.payload,
      subject: { ...profileTemplate.payload.subject, counterpartyRef: base.profileProof.organization.counterpartyRef },
    });
    const encodedOnboard = yield* Schema.encodeEffect(OrganizationBusinessOnboardInputSchema)(nativeOnboard);
    const encodedProfile = yield* Schema.encodeEffect(OrganizationProfileSourceCreateSchema)(nativeProfile);
    const [onboardNative, profileNativeDigest] = yield* Effect.all(
      [
        organizationBusinessRecordInputDigest({ operation: 'ONBOARD_COUNTERPARTY_CUSTOMER', payload: encodedOnboard }),
        fingerprintOrganizationProfileSourceCreate(encodedProfile),
      ],
      { concurrency: 2 },
    );
    const isOnboard = mode === 'ONBOARD';
    const selected = Match.value(mode).pipe(
      Match.when('ONBOARD', () => ({
        consumerModuleId: partyModuleId,
        effectId: '81000000-0000-4000-8000-000000000020',
        fields: OrganizationBusinessOnboardFields,
        inputDigest: onboardSemantic.semanticInputDigest,
        operation: 'ONBOARD_COUNTERPARTY_CUSTOMER',
        projectionVersion: onboardSemantic.projectionVersion,
      })),
      Match.when('PROFILE_CREATE', () => ({
        consumerModuleId: 'commerce.customer-context',
        effectId: source.effectId,
        fields: ORGANIZATION_PROFILE_SOURCE_CREATE_FIELDS,
        inputDigest: profileSemanticDigest,
        operation: 'COUNTERPARTY_PROFILE_CREATE',
        projectionVersion: ORGANIZATION_PROFILE_SOURCE_CREATE_TEMPLATE_VERSION,
      })),
      Match.exhaustive,
    );
    const semanticFields = {
      consumerModuleId: selected.consumerModuleId,
      fields: selected.fields,
      inputDigest: selected.inputDigest,
      kind: 'SOURCE_ASSERTED',
      operation: selected.operation,
      projectionVersion: selected.projectionVersion,
      sourceReference: reference,
    };
    const intent = Schema.decodeUnknownSync(OrganizationBusinessApplicabilityIntentSchema)(
      isOnboard
        ? semanticFields
        : {
            ...semanticFields,
            profileSource: source,
          },
    );
    const governanceProof = Schema.decodeUnknownSync(sourceFixtureProofSchema)({
      ...base.sourceProof,
      source: {
        ...base.sourceProof.source,
        effectId: selected.effectId,
        inputDigest: selected.inputDigest,
        operation: {
          entrypointKey: isOnboard
            ? 'party.registry.counterparty-customer-onboard'
            : 'commerce.customer-context.create-counterparty-purchasing-profile',
          moduleId: selected.consumerModuleId,
          schemaVersion: '1',
        },
        projectionVersion: selected.projectionVersion,
      },
    });
    const citation = {
      originalOccurrenceId: reference.occurrenceId,
      sourceActionInvocationId: '81000000-0000-4000-8000-000000000031',
      sourceDecisionRef: {
        moduleId: partyModuleId,
        resourceId: '81000000-0000-4000-8000-000000000030',
        resourceType: 'party.registry.party-match-decision',
        tenantId: base.scope.tenantId,
      },
    };
    const current = base.profileProof.organization;
    const organization = Schema.decodeUnknownSync(CurrentOrganizationRecordFactsSchema)({
      outcome: 'CURRENT_ORGANIZATION',
      partyRef: current.partyRef,
      partyRevision: current.partyRevision,
      sourceCitation: citation,
      typeAssertionId: current.typeAssertionId,
      typeAssertionRevision: current.typeAssertionRevision,
      typeRecordedAt: current.typeRecordedAt,
      typeValidFrom: current.typeValidFrom,
      typeValidTo: current.typeValidTo,
    });
    const customer = Schema.decodeUnknownSync(CurrentOrganizationCustomerRecordFactsSchema)({
      ...current,
      outcome: 'CURRENT_ORGANIZATION_CUSTOMER',
      sourceCitation: citation,
    });
    const parentCreate = {
      actionInvocationId: citation.sourceActionInvocationId,
      effectId: base.sourceProof.source.effectId,
    };
    const onboardMaterialization = Schema.decodeUnknownSync(SymmySourceOrganizationFactsMaterializedSchema)({
      ...governanceProof.source,
      materialization: {
        inputDigest: onboardNative.inputDigest,
        parents: [parentCreate],
        projectionVersion: onboardNative.projectionVersion,
        target: { kind: 'PARTY', partyRef: organization.partyRef },
      },
    });
    const profileMaterialization = Schema.decodeUnknownSync(SymmySourceOrganizationFactsMaterializedSchema)({
      ...governanceProof.source,
      materialization: {
        inputDigest: profileNativeDigest,
        parents: [
          parentCreate,
          {
            actionInvocationId: '81000000-0000-4000-8000-000000000033',
            effectId: '81000000-0000-4000-8000-000000000020',
          },
        ],
        projectionVersion: ORGANIZATION_PROFILE_SOURCE_CREATE_VERSION,
        target: {
          counterpartyRef: customer.counterpartyRef,
          kind: 'COUNTERPARTY_CUSTOMER',
          legalEntityRef: customer.legalEntityRef,
          partyRef: customer.partyRef,
          rolePeriodRef: customer.currentCustomerRoleRef,
        },
      },
    });
    const onboardProof = Schema.decodeUnknownSync(OrganizationBusinessSourceOnboardLiveProofSchema)({
      ...governanceProof,
      resolvedOwner: { kind: 'PARTY', organization },
      source: onboardMaterialization,
    });
    const profileCreateProof = Schema.decodeUnknownSync(OrganizationBusinessSourceProfileCreateLiveProofSchema)({
      ...governanceProof,
      resolvedOwner: { kind: 'COUNTERPARTY_CUSTOMER', organization: customer },
      source: profileMaterialization,
    });
    const proof = isOnboard ? onboardProof : profileCreateProof;
    const request = Schema.decodeUnknownSync(OrganizationBusinessApplicabilityRequestSchema)({
      ...intent,
      processingWitness: {
        effectId: selected.effectId,
        materializationWitness: isOnboard
          ? {
              inputDigest: onboardNative.inputDigest,
              projectionVersion: onboardNative.projectionVersion,
            }
          : { inputDigest: profileNativeDigest, projectionVersion: ORGANIZATION_PROFILE_SOURCE_CREATE_VERSION },
        originalAdmissionInvocationId: governanceProof.source.originalAdmissionInvocationId,
        purpose: 'PROCESSING',
      },
      resolvedTarget: isOnboard
        ? { kind: 'PARTY', partyRef: organization.partyRef }
        : {
            counterpartyRef: customer.counterpartyRef,
            kind: 'COUNTERPARTY_CUSTOMER',
          },
    });
    if (request.kind !== 'SOURCE_ASSERTED' || !('resolvedTarget' in request)) {
      return yield* new ReadHandlerUnavailable({
        code: 'read_handler_unavailable',
        reason: 'Expected an explicit deferred source fixture request',
      });
    }
    const context = Schema.decodeUnknownSync(OrganizationBusinessApplicabilityContextSchema)({
      ...base.context,
      decisionRef: `internal:source-dag-decision:${mode}`,
      governanceSelector: {
        ...base.context.governanceSelector,
        effectKey: isOnboard ? 'onboard-effect' : 'profile-effect',
      },
      processingScopeRef: { ...base.context.processingScopeRef, scopeId: `internal:source-dag:${mode}` },
      request: intent,
    });
    const business = yield* organizationBusinessFacts(context, governanceProof, base.evaluatedAt);
    const policy = Schema.decodeUnknownSync(PrivacyApplicabilityPolicySchema)({
      ...base.policy,
      factPredicates: business.scope.facts.map(({ dimension, value }) => ({
        dimension,
        operator: 'EQUALS',
        values: [value],
      })),
      mandatoryDimensions: business.scope.facts.map(({ dimension }) => dimension),
      nonPersonalApplicability: {
        allowedFields: intent.fields,
        classification: 'SOURCE_ASSERTED_ORGANIZATION',
        consumerModuleId: intent.consumerModuleId,
        holdBehavior: 'NO_ACTIVE_SCOPE_HOLD',
        kind: 'ORGANIZATION_BUSINESS_ONLY',
        operation: intent.operation,
        projectionVersion: intent.projectionVersion,
      },
      policyKey: `internal:source-dag-policy:${mode}`,
      scopeKey: `privacy.processing-scope:${context.processingScopeRef.scopeId}:${intent.operation}`,
    });
    const responsibility = { ...base.responsibility, scopeRef: context.processingScopeRef };
    const decision = resolvePrivacyApplicability({
      authority: business.authority,
      authorityEvidenceRefs: business.evidenceRefs,
      authorityReceiptRef: business.receiptRef,
      evaluatedAt: base.evaluatedAt,
      policies: [policy],
      proposedActivity: false,
      responsibilityAssignmentRefs: [responsibility.assignmentRef],
      scope: business.scope,
    });
    const services: OrganizationBusinessApplicabilityServices = {
      ...base.services,
      contexts: [context],
      decision: () => Effect.succeed(Option.some(decision)),
      proof: () => Effect.succeed(proof),
      repository: {
        listApplicabilityDecisions: () => Effect.succeed([decision]),
        listApplicabilityPolicies: () => Effect.succeed([policy]),
        listResponsibilities: () => Effect.succeed([responsibility]),
      },
    };
    return {
      ...base,
      business,
      context,
      decision,
      governanceProof,
      onboardProof,
      policy,
      profileCreateProof,
      proof,
      request,
      responsibility,
      run: (ports = services) =>
        evaluateOrganizationBusinessApplicability(request, base.scope, ports, base.evaluatedAt),
      services,
    };
  },
);
