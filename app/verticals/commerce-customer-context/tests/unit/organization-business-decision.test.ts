import type { OperationalScope } from '@app/core-runtime';
import {
  OrganizationBusinessApplicabilityRequestSchema,
  OrganizationBusinessApplicabilityResponseSchema,
} from '@app/privacy/api/organization-business-applicability';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  ORGANIZATION_MEMBERSHIP_PROJECTION_VERSION,
  ORGANIZATION_MEMBERSHIP_RECOVER_FIELDS,
  ORGANIZATION_MEMBERSHIP_WRITE_FIELDS,
} from '../../shared/domain/organization-membership-source.ts';
import { CounterpartyPurchasingProfileRefSchema } from '../../shared/resources/counterparty-purchasing-profile.ts';
import { validateOrganizationBusinessDecision } from '../../src/integrations/organization-business-decision.ts';
import type { CommerceOrganizationBusinessRequest } from '../../src/integrations/organization-business-decision.ts';
import {
  ORGANIZATION_PROFILE_SOURCE_CREATE_FIELDS,
  ORGANIZATION_PROFILE_SOURCE_CREATE_VERSION,
  ORGANIZATION_PROFILE_SOURCE_CREATE_TEMPLATE_VERSION,
} from '../../shared/domain/organization-profile-source.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const profileRef = Schema.decodeUnknownSync(CounterpartyPurchasingProfileRefSchema)({
  moduleId: 'commerce.customer-context',
  resourceId: '30000000-0000-4000-8000-000000000001',
  resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
  tenantId,
});
const partyRef = {
  moduleId: 'party.registry',
  resourceId: '40000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.party',
  tenantId,
};
const scope: OperationalScope = {
  authMethod: 'system',
  correlationId: 'organization-decision-unit',
  legalEntityId,
  principalId: '50000000-0000-4000-8000-000000000001',
  tenantId,
};
const request: CommerceOrganizationBusinessRequest = {
  consumerModuleId: 'commerce.customer-context',
  expectedProfileRevision: 1,
  fields: ORGANIZATION_MEMBERSHIP_WRITE_FIELDS,
  inputDigest: 'a'.repeat(64),
  kind: 'COUNTERPARTY_PROFILE',
  operation: 'customer-group-membership.write',
  profileRef,
  projectionVersion: ORGANIZATION_MEMBERSHIP_PROJECTION_VERSION,
};
const currentProfile = {
  _tag: 'CURRENT',
  counterpartyRef: {
    ...partyRef,
    resourceId: '60000000-0000-4000-8000-000000000001',
    resourceType: 'party.registry.counterparty',
  },
  counterpartyRevision: 'b'.repeat(64),
  currentCustomerRoleRef: {
    ...partyRef,
    resourceId: '70000000-0000-4000-8000-000000000001',
    resourceType: 'party.registry.counterparty-role-period',
  },
  currentCustomerRoleRevision: 'c'.repeat(64),
  legalEntityRef: {
    moduleId: 'core.identity',
    resourceId: legalEntityId,
    resourceType: 'core.identity.legal-entity',
    tenantId,
  },
  partyRef,
  partyRevision: 1,
  profileRef,
  profileRevision: 1,
};
const currentOrganization = {
  counterpartyRef: currentProfile.counterpartyRef,
  counterpartyRevision: currentProfile.counterpartyRevision,
  currentCustomerRoleRef: currentProfile.currentCustomerRoleRef,
  currentCustomerRoleRevision: currentProfile.currentCustomerRoleRevision,
  legalEntityRef: currentProfile.legalEntityRef,
  outcome: 'CURRENT_CANONICAL_ORGANIZATION_CUSTOMER',
  partyRef,
  partyRevision: 1,
  sourceCitation: null,
  typeAssertionId: '80000000-0000-4000-8000-000000000001',
  typeAssertionRevision: 'd'.repeat(64),
  typeRecordedAt: '2026-11-07T10:00:00.000Z',
  typeValidFrom: '2026-11-07T10:00:00.000Z',
  typeValidTo: null,
};
const positive = {
  allowedFields: ORGANIZATION_MEMBERSHIP_WRITE_FIELDS,
  applicabilityDecisionRef: 'internal-native-decision',
  authorityIncarnation: 'internal-authority',
  authorityRevision: '1',
  classification: 'CANONICAL_ORGANIZATION',
  consumerModuleId: 'commerce.customer-context',
  evaluatedAt: '2026-11-07T10:00:00.000Z',
  evidenceRefs: ['internal-owner-evidence'],
  holdBehavior: 'NO_ACTIVE_SCOPE_HOLD',
  inputDigest: request.inputDigest,
  kind: 'ORGANIZATION_BUSINESS_ONLY',
  liveProof: { kind: 'COUNTERPARTY_PROFILE', organization: currentOrganization, profile: currentProfile },
  operation: request.operation,
  outcome: 'NOT_APPLICABLE',
  policyRevisions: [],
  projectionVersion: ORGANIZATION_MEMBERSHIP_PROJECTION_VERSION,
};

const sourceEffectId = 'a0000000-0000-4000-8000-000000000001';
const originalAdmissionId = 'a0000000-0000-4000-8000-000000000002';
const independentPartySource = {
  occurrenceId: 'party-create-1',
  recordId: 'company-1',
  source: { issuer: 'party-test', namespace: 'companies', recordType: 'COMPANY', routeRef: 'party-source-route' },
};
const sourceInput = {
  consumerModuleId: 'commerce.customer-context',
  fields: ORGANIZATION_PROFILE_SOURCE_CREATE_FIELDS,
  inputDigest: 'a'.repeat(64),
  kind: 'SOURCE_ASSERTED',
  operation: 'COUNTERPARTY_PROFILE_CREATE',
  processingWitness: {
    effectId: sourceEffectId,
    materializationWitness: {
      inputDigest: 'e'.repeat(64),
      projectionVersion: ORGANIZATION_PROFILE_SOURCE_CREATE_VERSION,
    },
    originalAdmissionInvocationId: originalAdmissionId,
    purpose: 'PROCESSING',
  },
  profileSource: {
    effectId: sourceEffectId,
    issuer: 'commerce-test',
    mappingRevision: '1',
    namespace: 'profile-assertions',
    occurrenceId: 'profile-occurrence-7',
    order: 1,
    recordId: 'profile-42',
    recordType: 'CUSTOMER_PROFILE',
    revision: '1',
    route: { id: 'commerce-receiver-route', revision: '1' },
  },
  projectionVersion: ORGANIZATION_PROFILE_SOURCE_CREATE_TEMPLATE_VERSION,
  resolvedTarget: { counterpartyRef: currentProfile.counterpartyRef, kind: 'COUNTERPARTY_CUSTOMER' },
  sourceReference: independentPartySource,
};
const sourcePositive = {
  ...positive,
  allowedFields: ORGANIZATION_PROFILE_SOURCE_CREATE_FIELDS,
  classification: 'SOURCE_ASSERTED_ORGANIZATION',
  liveProof: {
    kind: 'SOURCE_ASSERTED',
    resolvedOwner: {
      kind: 'COUNTERPARTY_CUSTOMER',
      organization: {
        ...currentOrganization,
        outcome: 'CURRENT_ORGANIZATION_CUSTOMER',
        sourceCitation: {
          originalOccurrenceId: 'party-create-1',
          sourceActionInvocationId: 'b0000000-0000-4000-8000-000000000002',
          sourceDecisionRef: {
            moduleId: 'party.registry',
            resourceId: 'b0000000-0000-4000-8000-000000000001',
            resourceType: 'party.registry.party-match-decision',
            tenantId,
          },
        },
      },
    },
    source: {
      acceptedAdmissionInvocationId: 'b0000000-0000-4000-8000-000000000003',
      admittedIntentDigest: 'c'.repeat(64),
      classification: 'SOURCE_ASSERTED_ORGANIZATION',
      effectId: sourceEffectId,
      enrollmentMappingVersion: '1',
      enrollmentRouteId: 'source-profile-route',
      enrollmentRouteRevision: '1',
      execution: { jobId: 'b0000000-0000-4000-8000-000000000004', kind: 'JOB' },
      inputDigest: sourceInput.inputDigest,
      logicalRoute: { integrationRouteId: 'source-profile-route', tenantId },
      mappingVersion: '1',
      materialization: {
        inputDigest: 'e'.repeat(64),
        parents: [
          {
            actionInvocationId: 'b0000000-0000-4000-8000-000000000005',
            effectId: 'b0000000-0000-4000-8000-000000000006',
          },
        ],
        projectionVersion: ORGANIZATION_PROFILE_SOURCE_CREATE_VERSION,
        target: {
          counterpartyRef: currentProfile.counterpartyRef,
          kind: 'COUNTERPARTY_CUSTOMER',
          legalEntityRef: currentProfile.legalEntityRef,
          partyRef,
          rolePeriodRef: currentProfile.currentCustomerRoleRef,
        },
      },
      operation: {
        entrypointKey: 'commerce.customer-context.create-counterparty-purchasing-profile',
        moduleId: 'commerce.customer-context',
        schemaVersion: '1',
      },
      originalAdmissionInvocationId: originalAdmissionId,
      outcome: 'CURRENT_SOURCE_ASSERTED_ORGANIZATION',
      projectionVersion: sourceInput.projectionVersion,
      routeRevision: '1',
      sourceReference: independentPartySource,
    },
    sourceSubjectRef: {
      moduleId: 'privacy.core',
      resourceId: 'b0000000-0000-4000-8000-000000000007',
      resourceType: 'privacy.core.privacy-subject',
      tenantId,
    },
    sourceSubjectRevision: 'f'.repeat(64),
  },
  operation: sourceInput.operation,
  projectionVersion: sourceInput.projectionVersion,
};

it.effect('accepts only the exact current profile and Organization decision for the native business intent', () =>
  Effect.gen(function* exactNativeDecision() {
    const response = yield* Schema.decodeUnknownEffect(OrganizationBusinessApplicabilityResponseSchema)(positive);
    expect(yield* validateOrganizationBusinessDecision(scope, request, response)).toEqual(response);
  }),
);

it.effect(
  'rejects changed digest, incomplete field permission, stale profile and mismatched canonical Organization pins',
  () =>
    Effect.gen(function* changedDecisionBinding() {
      for (const invalid of [
        { ...positive, inputDigest: 'e'.repeat(64) },
        {
          ...positive,
          liveProof: {
            ...positive.liveProof,
            organization: { ...currentOrganization, counterpartyRevision: 'e'.repeat(64) },
          },
        },
        {
          ...positive,
          liveProof: {
            ...positive.liveProof,
            organization: { ...currentOrganization, currentCustomerRoleRevision: 'e'.repeat(64) },
          },
        },
        { ...positive, allowedFields: ORGANIZATION_MEMBERSHIP_WRITE_FIELDS.slice(1) },
        { ...positive, liveProof: { ...positive.liveProof, profile: { ...currentProfile, profileRevision: 2 } } },
        {
          ...positive,
          liveProof: { ...positive.liveProof, organization: { ...currentOrganization, partyRevision: 2 } },
        },
        {
          ...positive,
          liveProof: {
            ...positive.liveProof,
            profile: {
              ...currentProfile,
              profileRef: { ...profileRef, resourceId: '90000000-0000-4000-8000-000000000001' },
            },
          },
        },
      ]) {
        const response = yield* Schema.decodeUnknownEffect(OrganizationBusinessApplicabilityResponseSchema)(invalid);
        expect(yield* Effect.flip(validateOrganizationBusinessDecision(scope, request, response))).toMatchObject({
          code: 'DENIED',
        });
      }
    }),
);

it.effect('rejects another Tenant or Legal Entity even with an otherwise current native decision', () =>
  Effect.gen(function* exactBusinessScope() {
    const response = yield* Schema.decodeUnknownEffect(OrganizationBusinessApplicabilityResponseSchema)(positive);
    for (const otherScope of [
      { ...scope, tenantId: '90000000-0000-4000-8000-000000000001' },
      { ...scope, legalEntityId: '90000000-0000-4000-8000-000000000001' },
    ]) {
      expect(yield* Effect.flip(validateOrganizationBusinessDecision(otherScope, request, response))).toMatchObject({
        code: 'DENIED',
      });
    }
  }),
);

it.effect('never turns denied or unavailable classification into a personal-data fallback', () =>
  Effect.gen(function* noPersonalFallback() {
    for (const outcome of ['DENIED', 'INDETERMINATE'] as const) {
      const response = yield* Schema.decodeUnknownEffect(OrganizationBusinessApplicabilityResponseSchema)({
        evaluatedAt: positive.evaluatedAt,
        outcome,
        reason: 'CURRENT_OWNER_PROOF_REQUIRED',
      });
      expect(yield* Effect.flip(validateOrganizationBusinessDecision(scope, request, response))).toMatchObject({
        code: 'DENIED',
      });
    }
  }),
);

it.effect('requires an explicit historical intent and matching historical identity proof', () =>
  Effect.gen(function* exactHistoricalIdentity() {
    const historicalRequest = {
      ...request,
      expectedProfileRevision: 2,
      fields: ORGANIZATION_MEMBERSHIP_RECOVER_FIELDS,
      identityState: 'HISTORICAL' as const,
      operation: 'customer-group-membership.recover' as const,
    };
    const historicalResponse = yield* Schema.decodeUnknownEffect(OrganizationBusinessApplicabilityResponseSchema)({
      ...positive,
      allowedFields: ORGANIZATION_MEMBERSHIP_RECOVER_FIELDS,
      applicabilityDecisionRef: 'internal-new-historical-native-decision',
      authorityRevision: '2',
      liveProof: {
        ...positive.liveProof,
        profile: {
          ...currentProfile,
          _tag: 'CURRENT_HISTORICAL_IDENTITY',
          profileRevision: 2,
          profileState: 'ARCHIVED',
        },
      },
      operation: historicalRequest.operation,
    });
    expect(yield* validateOrganizationBusinessDecision(scope, historicalRequest, historicalResponse)).toEqual(
      historicalResponse,
    );
    const { identityState: _identityState, ...currentRequest } = historicalRequest;
    expect(
      yield* Effect.flip(validateOrganizationBusinessDecision(scope, currentRequest, historicalResponse)),
    ).toMatchObject({ code: 'DENIED' });
    const currentResponse = yield* Schema.decodeUnknownEffect(OrganizationBusinessApplicabilityResponseSchema)({
      ...positive,
      allowedFields: ORGANIZATION_MEMBERSHIP_RECOVER_FIELDS,
      liveProof: { ...positive.liveProof, profile: { ...currentProfile, profileRevision: 2 } },
      operation: historicalRequest.operation,
    });
    expect(
      yield* Effect.flip(validateOrganizationBusinessDecision(scope, historicalRequest, currentResponse)),
    ).toMatchObject({ code: 'DENIED' });
  }),
);

it.effect('accepts exact admitted source semantics and native materialization with independent Party provenance', () =>
  Effect.gen(function* exactSourceMaterialization() {
    const input = yield* Schema.decodeUnknownEffect(OrganizationBusinessApplicabilityRequestSchema)(sourceInput);
    if (input.consumerModuleId !== 'commerce.customer-context') {
      return yield* Effect.die('Invalid source fixture owner');
    }
    const response = yield* Schema.decodeUnknownEffect(OrganizationBusinessApplicabilityResponseSchema)(sourcePositive);
    expect(yield* validateOrganizationBusinessDecision(scope, input, response)).toEqual(response);
    return yield* Effect.void;
  }),
);

it.effect('rejects changed source witnesses, materialized digest and resolved CUSTOMER target', () =>
  Effect.gen(function* sourceMaterializationFences() {
    const input = yield* Schema.decodeUnknownEffect(OrganizationBusinessApplicabilityRequestSchema)(sourceInput);
    if (input.consumerModuleId !== 'commerce.customer-context') {
      return yield* Effect.die('Invalid source fixture owner');
    }
    const proof = sourcePositive.liveProof;
    expect(
      Schema.is(OrganizationBusinessApplicabilityResponseSchema)({
        ...sourcePositive,
        liveProof: { ...proof, source: { ...proof.source, inputDigest: 'd'.repeat(64) } },
      }),
    ).toBe(false);
    const otherSemanticIntent = yield* Schema.decodeUnknownEffect(OrganizationBusinessApplicabilityResponseSchema)({
      ...sourcePositive,
      inputDigest: 'd'.repeat(64),
      liveProof: { ...proof, source: { ...proof.source, inputDigest: 'd'.repeat(64) } },
    });
    expect(yield* Effect.flip(validateOrganizationBusinessDecision(scope, input, otherSemanticIntent))).toMatchObject({
      code: 'DENIED',
    });
    for (const alteredSource of [
      { ...proof.source, originalAdmissionInvocationId: 'c0000000-0000-4000-8000-000000000001' },
      { ...proof.source, effectId: 'c0000000-0000-4000-8000-000000000002' },
      { ...proof.source, sourceReference: { ...independentPartySource, recordId: 'unrelated-company' } },
      { ...proof.source, materialization: { ...proof.source.materialization, inputDigest: 'd'.repeat(64) } },
      {
        ...proof.source,
        materialization: {
          ...proof.source.materialization,
          target: {
            ...proof.source.materialization.target,
            counterpartyRef: { ...currentProfile.counterpartyRef, resourceId: 'c0000000-0000-4000-8000-000000000003' },
          },
        },
      },
      {
        ...proof.source,
        materialization: {
          ...proof.source.materialization,
          target: {
            ...proof.source.materialization.target,
            rolePeriodRef: {
              ...currentProfile.currentCustomerRoleRef,
              resourceId: 'c0000000-0000-4000-8000-000000000004',
            },
          },
        },
      },
    ]) {
      const response = yield* Schema.decodeUnknownEffect(OrganizationBusinessApplicabilityResponseSchema)({
        ...sourcePositive,
        liveProof: { ...proof, source: alteredSource },
      });
      expect(yield* Effect.flip(validateOrganizationBusinessDecision(scope, input, response))).toMatchObject({
        code: 'DENIED',
      });
    }
    return yield* Effect.void;
  }),
);

it.effect('requires the whole native create field projection for the source template', () =>
  Effect.gen(function* completeNativeFieldScope() {
    const input = yield* Schema.decodeUnknownEffect(OrganizationBusinessApplicabilityRequestSchema)({
      ...sourceInput,
      fields: ORGANIZATION_PROFILE_SOURCE_CREATE_FIELDS.slice(1),
    });
    if (input.consumerModuleId !== 'commerce.customer-context') {
      return yield* Effect.die('Invalid source fixture owner');
    }
    const response = yield* Schema.decodeUnknownEffect(OrganizationBusinessApplicabilityResponseSchema)({
      ...sourcePositive,
      allowedFields: ORGANIZATION_PROFILE_SOURCE_CREATE_FIELDS.slice(1),
    });
    expect(yield* Effect.flip(validateOrganizationBusinessDecision(scope, input, response))).toMatchObject({
      code: 'DENIED',
    });
    return yield* Effect.void;
  }),
);
