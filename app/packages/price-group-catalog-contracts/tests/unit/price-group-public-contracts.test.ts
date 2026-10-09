import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import {
  PriceGroupActionInvocationIdSchema as PublicPriceGroupActionInvocationIdSchema,
  PriceGroupCompatibilityDecisionSchema as PublicPriceGroupCompatibilityDecisionSchema,
  PriceGroupOwnerFailureSchema as PublicPriceGroupOwnerFailureSchema,
  PriceGroupRefSchema as PublicPriceGroupRefSchema,
} from '../../src/index.ts';
import { PriceGroupDefinitionResponseSchema } from '../../src/apis/price-group-definition.ts';
import {
  CatalogFenceRevisionSchema,
  PriceGroupCompatibilityDecisionSchema,
  PriceGroupCompatibilityEvidenceSchema,
  PriceGroupDefinitionRevisionSchema,
  PriceGroupIncompatibleEvidenceSchema,
  PriceGroupRetirementAcceptanceSchema,
  PriceGroupRetirementEvidenceSchema,
} from '../../src/domain/price-group.ts';
import {
  PriceGroupCurrentnessFailure,
  PriceGroupEffectivePeriodConflict,
  PriceGroupIdempotencyReuseConflict,
  PriceGroupMeaningChangeRequired,
  PriceGroupOwnerFailureSchema,
  PriceGroupPersistenceUnavailable,
  PriceGroupRetirementEffectiveTimeConflict,
  PriceGroupSemanticIdentityConflict,
  PriceGroupTenantScopeFailure,
} from '../../src/domain/price-group-errors.ts';
import {
  PriceGroupCatalogRootRefSchema,
  makePriceGroupCatalogAuthorizationTarget,
  makePriceGroupCatalogRootRef,
} from '../../src/resources/price-group-catalog-root.ts';
import { PriceGroupRefSchema, PriceGroupTenantIdSchema } from '../../src/resources/price-group.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = '99999999-9999-4999-8999-999999999999';
const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog' as const,
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'pricing.price-group-catalog.price-group' as const,
  tenantId,
};
const definitionRevisionId = '33333333-3333-4333-8333-333333333333';
const period = {
  effectiveFrom: '2026-10-01T00:00:00.000Z',
  effectiveTo: '2027-01-01T00:00:00.000Z',
};
const provenance = {
  actionInvocationId: '44444444-4444-4444-8444-444444444444',
  actorPrincipalId: '55555555-5555-4555-8555-555555555555',
  reason: 'Approved clarification of the existing dealer classification.',
  trustedAt: '2026-09-23T12:00:00.000Z',
};
const requiredContract = { contractId: 'commerce.customer-price-group-assignment', version: 1 };
const meaningFingerprint = 'a'.repeat(64);

describe('canonical Price Group Catalog package surface', () => {
  it('publishes canonical resource and domain schemas from one browser-safe package', () => {
    expect(PublicPriceGroupRefSchema).toBe(PriceGroupRefSchema);
    expect(PublicPriceGroupCompatibilityDecisionSchema).toBe(PriceGroupCompatibilityDecisionSchema);
    expect(PublicPriceGroupOwnerFailureSchema).toBe(PriceGroupOwnerFailureSchema);
  });

  it('uses one canonical UUID catalog identity per Tenant and builds the exact Core target', () => {
    const decodedTenantId = Schema.decodeSync(PriceGroupTenantIdSchema)(tenantId);
    const rootRef = makePriceGroupCatalogRootRef(decodedTenantId);

    expect(Schema.decodeSync(PriceGroupCatalogRootRefSchema)(rootRef)).toEqual({
      moduleId: 'pricing.price-group-catalog',
      resourceId: tenantId,
      resourceType: 'pricing.price-group-catalog.price-group-catalog-root',
      tenantId,
    });
    expect(makePriceGroupCatalogAuthorizationTarget(decodedTenantId)).toEqual({
      kind: 'pricing_catalog',
      pricingCatalogId: tenantId,
      tenantId,
    });
    expect(() =>
      Schema.decodeSync(PriceGroupCatalogRootRefSchema)({ ...rootRef, resourceId: otherTenantId }),
    ).toThrow();
    expect(() => Schema.decodeSync(PriceGroupTenantIdSchema)('tenant-business-code')).toThrow();
  });

  it('keeps Price Group technical identity independent from business code', () => {
    const decode = Schema.decodeUnknownSync(PriceGroupRefSchema, { onExcessProperty: 'error' });

    expect(decode(priceGroupRef)).toEqual(priceGroupRef);
    expect(() => decode({ ...priceGroupRef, resourceId: 'DEALER' })).toThrow();
    expect(() => decode({ ...priceGroupRef, businessCode: 'DEALER' })).toThrow();
  });
});

describe('canonical Price Group definition and compatibility evidence', () => {
  it('binds immutable definitions to exact positive revision identity', () => {
    const definition = {
      acceptedCatalogRevision: 7,
      classificationPurpose: 'Classifies customers eligible for the dealer pricing path.',
      compatibilityContracts: [requiredContract],
      created: provenance,
      definitionRevisionId,
      description: 'Dealer classification for approved resellers.',
      displayName: 'Dealer',
      effectivePeriod: period,
      meaningFingerprint,
      previousDefinitionRevisionId: null,
      priceGroupRef,
      revisionNumber: 1,
      semanticContinuity: null,
    };

    expect(Schema.decodeSync(PriceGroupDefinitionRevisionSchema)(definition)).toMatchObject({
      definitionRevisionId,
      revisionNumber: 1,
    });
    expect(() => Schema.decodeSync(PriceGroupDefinitionRevisionSchema)({ ...definition, revisionNumber: 0 })).toThrow();
  });

  it('returns exact Price Group identity, lifecycle, and revision compatibility metadata', () => {
    const definition = {
      acceptedCatalogRevision: 7,
      classificationPurpose: 'Classifies customers eligible for the dealer pricing path.',
      compatibilityContracts: [requiredContract],
      created: provenance,
      definitionRevisionId,
      description: 'Dealer classification for approved resellers.',
      displayName: 'Dealer',
      effectivePeriod: period,
      meaningFingerprint,
      previousDefinitionRevisionId: null,
      priceGroupRef,
      revisionNumber: 1,
      semanticContinuity: null,
    };
    const identity = {
      businessCode: 'DEALER',
      created: provenance,
      createdAtCatalogRevision: 1,
      lifecycle: {
        activeFrom: '2026-10-01T00:00:00.000Z',
        retiredAt: '2026-12-01T00:00:00.000Z',
        state: 'RETIRED',
      },
      meaningFingerprint,
      priceGroupRef,
    };
    const historical = {
      definition,
      identity,
      observedAt: '2026-12-02T00:00:00.000Z',
      selection: 'HISTORICAL',
    };

    expect(Schema.decodeUnknownSync(PriceGroupDefinitionResponseSchema)(historical)).toMatchObject({
      definition: { compatibilityContracts: [requiredContract] },
      identity: { lifecycle: { retiredAt: '2026-12-01T00:00:00.000Z', state: 'RETIRED' } },
      selection: 'HISTORICAL',
    });
    const { identity: _identity, ...missingIdentity } = historical;
    expect(() => Schema.decodeUnknownSync(PriceGroupDefinitionResponseSchema)(missingIdentity)).toThrow();
  });

  it('requires complete USABLE evidence and rejects fabricated or incomplete revision identity', () => {
    const evidence = {
      catalogRevision: 7,
      definitionEffectivePeriod: period,
      definitionRevisionId,
      definitionRevisionNumber: 1,
      meaningFingerprint,
      priceGroupRef,
      requiredContract,
      trustedOperationAt: '2026-11-01T00:00:00.000Z',
      verifiedAt: '2026-11-01T00:00:01.000Z',
    };

    expect(Schema.decodeSync(PriceGroupCompatibilityEvidenceSchema)(evidence)).toMatchObject({
      definitionRevisionId,
      definitionRevisionNumber: 1,
    });
    expect(Schema.decodeSync(PriceGroupCompatibilityDecisionSchema)({ evidence, kind: 'USABLE' }).kind).toBe('USABLE');
    const { definitionRevisionNumber: _omitted, ...incomplete } = evidence;
    expect(() => Schema.decodeUnknownSync(PriceGroupCompatibilityEvidenceSchema)(incomplete)).toThrow();
    expect(() =>
      Schema.decodeSync(PriceGroupCompatibilityEvidenceSchema)({
        ...evidence,
        definitionRevisionId: 'revision-1',
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeSync(PriceGroupCompatibilityEvidenceSchema)({
        ...evidence,
        definitionRevisionNumber: 1.5,
      }),
    ).toThrow();
  });

  it('represents an authoritative empty-catalog MISSING observation without definition identity', () => {
    const missing = {
      catalogObservation: {
        catalogRevision: 0,
        observedAt: '2026-11-01T00:00:01.000Z',
        trustedOperationAt: '2026-11-01T00:00:00.000Z',
      },
      kind: 'MISSING' as const,
      priceGroupRef,
    };

    expect(Schema.decodeSync(CatalogFenceRevisionSchema)(0)).toBe(0);
    expect(Schema.decodeSync(CatalogFenceRevisionSchema)(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => Schema.decodeSync(CatalogFenceRevisionSchema)(-1)).toThrow();
    expect(() => Schema.decodeSync(CatalogFenceRevisionSchema)(Number.MAX_SAFE_INTEGER + 1)).toThrow();
    expect(Schema.decodeSync(PriceGroupCompatibilityDecisionSchema)(missing)).toEqual(missing);
    expect(() =>
      Schema.decodeUnknownSync(PriceGroupCompatibilityDecisionSchema, { onExcessProperty: 'error' })({
        ...missing,
        definitionRevisionId,
      }),
    ).toThrow();
  });

  it('carries exact RETIRED and INCOMPATIBLE evidence instead of an UNUSABLE escape hatch', () => {
    const retirementEvidence = {
      acceptedCatalogRevision: 8,
      currentDefinitionRevisionId: definitionRevisionId,
      currentDefinitionRevisionNumber: 1,
      priceGroupRef,
      retiredAt: '2026-11-01T00:00:00.000Z',
      retirementProvenance: provenance,
      trustedOperationAt: '2026-11-01T00:00:00.000Z',
      verifiedAt: '2026-11-01T00:00:01.000Z',
    };
    const incompatibleEvidence = {
      definitionRevisionId,
      definitionRevisionNumber: 1,
      evaluatedCatalogRevision: 7,
      meaningFingerprint,
      priceGroupRef,
      requiredContract,
      trustedOperationAt: '2026-11-01T00:00:00.000Z',
      verifiedAt: '2026-11-01T00:00:01.000Z',
    };

    expect(Schema.decodeSync(PriceGroupRetirementEvidenceSchema)(retirementEvidence)).toMatchObject({
      acceptedCatalogRevision: 8,
    });
    expect(Schema.decodeSync(PriceGroupIncompatibleEvidenceSchema)(incompatibleEvidence)).toMatchObject({
      evaluatedCatalogRevision: 7,
    });
    expect(
      Schema.decodeSync(PriceGroupCompatibilityDecisionSchema)({ evidence: retirementEvidence, kind: 'RETIRED' }).kind,
    ).toBe('RETIRED');
    expect(
      Schema.decodeSync(PriceGroupCompatibilityDecisionSchema)({
        evidence: incompatibleEvidence,
        kind: 'INCOMPATIBLE',
      }).kind,
    ).toBe('INCOMPATIBLE');
    expect(() =>
      Schema.decodeUnknownSync(PriceGroupCompatibilityDecisionSchema)({
        catalogRevision: 7,
        kind: 'UNUSABLE',
        reasonCode: 'OWNER_UNAVAILABLE',
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeSync(PriceGroupRetirementEvidenceSchema)({
        ...retirementEvidence,
        retirementProvenance: {
          ...retirementEvidence.retirementProvenance,
          trustedAt: '2026-11-01T00:00:00.001Z',
        },
      }),
    ).toThrow();
  });

  it('separates scheduled retirement acceptance from at-boundary RETIRED compatibility evidence', () => {
    const acceptance = {
      acceptedCatalogRevision: 8,
      currentDefinitionRevisionId: definitionRevisionId,
      currentDefinitionRevisionNumber: 1,
      priceGroupRef,
      retirementEffectiveAt: '2027-01-01T00:00:00.000Z',
      retirementProvenance: provenance,
      trustedOperationAt: provenance.trustedAt,
      verifiedAt: '2026-09-23T12:00:01.000Z',
    };

    expect(Schema.decodeSync(PriceGroupRetirementAcceptanceSchema)(acceptance)).toMatchObject({
      retirementEffectiveAt: '2027-01-01T00:00:00.000Z',
      trustedOperationAt: provenance.trustedAt,
    });
    expect(() =>
      Schema.decodeSync(PriceGroupRetirementAcceptanceSchema)({
        ...acceptance,
        trustedOperationAt: '2026-09-23T12:00:00.001Z',
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeSync(PriceGroupRetirementAcceptanceSchema)({
        ...acceptance,
        retirementEffectiveAt: '2026-09-23T11:59:59.999Z',
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeSync(PriceGroupRetirementAcceptanceSchema)({
        ...acceptance,
        verifiedAt: '2026-09-23T11:59:59.999Z',
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeSync(PriceGroupRetirementEvidenceSchema)({
        acceptedCatalogRevision: acceptance.acceptedCatalogRevision,
        currentDefinitionRevisionId: acceptance.currentDefinitionRevisionId,
        currentDefinitionRevisionNumber: acceptance.currentDefinitionRevisionNumber,
        priceGroupRef,
        retiredAt: acceptance.retirementEffectiveAt,
        retirementProvenance: provenance,
        trustedOperationAt: acceptance.trustedOperationAt,
        verifiedAt: acceptance.verifiedAt,
      }),
    ).toThrow();
  });
});

describe('canonical Price Group owner failures', () => {
  it('represents retroactive definition scheduling as an exact typed conflict', () => {
    const conflict = new PriceGroupEffectivePeriodConflict({
      code: 'price_group_effective_period_conflict',
      effectiveFrom: '2026-09-10T00:00:00.000Z',
      priceGroupRef: Schema.decodeSync(PriceGroupRefSchema)(priceGroupRef),
      reason: 'A definition cannot rewrite owner history.',
      trustedEffectiveAt: '2026-09-20T00:00:00.000Z',
    });

    expect(Schema.is(PriceGroupOwnerFailureSchema)(conflict)).toBe(true);
    expect(conflict.effectiveFrom).toBe('2026-09-10T00:00:00.000Z');
    expect(conflict.trustedEffectiveAt).toBe('2026-09-20T00:00:00.000Z');
  });

  it('represents backdated retirement scheduling as an exact typed conflict', () => {
    const conflict = new PriceGroupRetirementEffectiveTimeConflict({
      code: 'price_group_retirement_effective_time_conflict',
      effectiveAt: '2026-09-19T00:00:00.000Z',
      priceGroupRef: Schema.decodeSync(PriceGroupRefSchema)(priceGroupRef),
      reason: 'A retirement cannot become effective before its trusted operation time.',
      trustedEffectiveAt: '2026-09-20T00:00:00.000Z',
    });

    expect(Schema.is(PriceGroupOwnerFailureSchema)(conflict)).toBe(true);
  });

  it('keeps idempotency, semantic identity, and tenant-scope conflicts distinct', () => {
    const decodedPriceGroupRef = Schema.decodeSync(PriceGroupRefSchema)(priceGroupRef);
    const decodedTenantId = Schema.decodeSync(PriceGroupTenantIdSchema)(tenantId);
    const decodedOtherTenantId = Schema.decodeSync(PriceGroupTenantIdSchema)(otherTenantId);
    const idempotency = new PriceGroupIdempotencyReuseConflict({
      actionInvocationId: Schema.decodeSync(PublicPriceGroupActionInvocationIdSchema)(provenance.actionInvocationId),
      code: 'price_group_idempotency_reuse_conflict',
      reason: 'The Action invocation was already accepted with different semantics.',
    });
    const semantic = new PriceGroupMeaningChangeRequired({
      code: 'price_group_meaning_change_requires_new_identity',
      priceGroupRef: decodedPriceGroupRef,
      reason: 'The stable classification identity cannot be reused for a different meaning.',
    });
    const duplicateSemanticIdentity = new PriceGroupSemanticIdentityConflict({
      code: 'price_group_semantic_identity_conflict',
      existingMeaningFingerprint: 'a'.repeat(64),
      existingPriceGroupRef: decodedPriceGroupRef,
      reason: 'This classification meaning already owns a distinct Price Group identity in the Tenant.',
      requestedMeaningFingerprint: 'a'.repeat(64),
    });
    const scope = new PriceGroupTenantScopeFailure({
      code: 'price_group_tenant_scope_failure',
      expectedTenantId: decodedTenantId,
      reason: 'The referenced Price Group belongs to another Tenant.',
      receivedTenantId: decodedOtherTenantId,
    });

    expect(Schema.is(PriceGroupOwnerFailureSchema)(idempotency)).toBe(true);
    expect(Schema.is(PriceGroupOwnerFailureSchema)(semantic)).toBe(true);
    expect(Schema.is(PriceGroupOwnerFailureSchema)(duplicateSemanticIdentity)).toBe(true);
    expect(Schema.is(PriceGroupOwnerFailureSchema)(scope)).toBe(true);
    expect(new Set([idempotency.code, semantic.code, duplicateSemanticIdentity.code, scope.code]).size).toBe(4);
  });

  it('keeps corrupted currentness and owner unavailability as typed failures, never business outcomes', () => {
    const decodedPriceGroupRef = Schema.decodeSync(PriceGroupRefSchema)(priceGroupRef);
    const currentness = new PriceGroupCurrentnessFailure({
      candidateDefinitionRevisionIds: [],
      code: 'price_group_currentness_failure',
      priceGroupRef: decodedPriceGroupRef,
      reason: 'ZERO_CURRENT_DEFINITIONS',
    });
    const unavailable = new PriceGroupPersistenceUnavailable({
      code: 'price_group_persistence_unavailable',
      reason: 'The owner could not establish authoritative catalog state.',
      retryable: true,
    });

    expect(Schema.is(PriceGroupOwnerFailureSchema)(currentness)).toBe(true);
    expect(Schema.is(PriceGroupOwnerFailureSchema)(unavailable)).toBe(true);
    expect(currentness.code).not.toBe('MISSING');
    expect(unavailable.code).not.toBe('INCOMPATIBLE');
  });
});
