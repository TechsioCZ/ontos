import { getVerticalRuntimeActions } from '@app/core-runtime';
import { PriceProductTargetSnapshotSchema } from '@app/pricing-contracts/domain/catalog-price-target';
import {
  PricingCommercialFeeIdentityKeySchema,
  pricingCommercialFeeIdentityKeysEqual,
} from '@app/pricing-contracts/domain/commercial-fee';
import {
  PricingDiscountIdentityKeySchema,
  pricingDiscountIdentityKeysEqual,
} from '@app/pricing-contracts/domain/discount';
import { PricingZeroFloorAuthorizationSchema } from '@app/pricing-contracts/domain/line-composition';
import { DateTime, Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { ManageContractualDiscountPayloadSchema } from '../../shared/actions/manage-contractual-discount.ts';
import { manageContractualDiscountAction } from '../../src/actions/manage-contractual-discount.action.ts';
import type { ProductPriceBulkCommandPort } from '../../src/services/product-price-bulk.service.ts';
import { makeProductPriceBulkService } from '../../src/services/product-price-bulk.service.ts';
import { makeZeroFloorAuthorizationAdministration } from '../../src/services/zero-floor-authorization-administration.service.ts';
import type {
  ManageZeroFloorAuthorizationPersistenceOutcome,
  ZeroFloorAuthorizationPersistence,
} from '../../src/services/zero-floor-authorization-persistence.service.ts';
import { ZeroFloorAuthorizationPersistenceUnavailable } from '../../src/services/zero-floor-authorization-persistence.service.ts';
import { pricingManifest } from '../../vertical.manifest.ts';
import { pricingRegistration } from '../../vertical.registration.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const principalId = '33333333-3333-4333-8333-333333333333';
const operationAt = '2026-09-27T12:00:00.000Z';
const productRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.product' as const,
  tenantId,
};
const variantRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'commerce.catalog.variant' as const,
  tenantId,
};
const otherVariantRef = {
  ...variantRef,
  resourceId: '66666666-6666-4666-8666-666666666666',
};
const unitRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '77777777-7777-4777-8777-777777777777',
  resourceType: 'commerce.catalog.product-unit' as const,
  tenantId,
};
const priceRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: '88888888-8888-4888-8888-888888888888',
  resourceType: 'commerce.pricing.price' as const,
  tenantId,
};
const commercialScope = {
  channelId: 'B2C' as const,
  marketId: 'cz-launch',
  sellingLegalEntityId: legalEntityId,
};
const catalogSelection = { productRef, variantRef };
const unitBasis = { quantity: '1', unitRef };

const snapshot = Schema.decodeUnknownSync(PriceProductTargetSnapshotSchema)({
  capturedAt: operationAt,
  catalogOwnerRevision: 'catalog-product-active-variants:r797',
  productRef,
  snapshotId: 'catalog-snapshot:797',
  targets: [variantRef, otherVariantRef].map((targetVariantRef) => ({
    catalogEvidence: {
      assessedAt: operationAt,
      basis: [
        { role: 'PRODUCT', source: { resourceRef: productRef, revision: 4 } },
        { role: 'VARIANT', source: { resourceRef: targetVariantRef, revision: 7 } },
        {
          provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION',
          role: 'PRODUCT_TYPE_UNTYPED_DECISION',
          source: { resourceRef: productRef, revision: 4 },
        },
      ],
      membership: {
        attestationId: `catalog-membership:${targetVariantRef.resourceId}`,
        observedAt: operationAt,
        productRef,
        source: 'CATALOG_OWNER_CURRENT_READ',
        variant: { resourceRef: targetVariantRef, revision: 7 },
      },
      purpose: 'PRICING',
      selection: { productRef, variantRef: targetVariantRef },
      status: 'VALID',
    },
    target: { productRef, variantRef: targetVariantRef },
    targetId: `catalog-target:${targetVariantRef.resourceId}`,
  })),
  targetSetCompleteness: {
    observedAt: operationAt,
    ownerRevision: 'catalog-product-active-variants:r797',
    scope: { kind: 'EXACT_PREDICATE', predicateRef: 'catalog-product:active-variants' },
  },
});
const bulkIntents = snapshot.targets.map(({ target, targetId }, index) => ({
  identity: { snapshotId: snapshot.snapshotId, target, targetId },
  intentId: `price-intent:${index + 1}`,
  operation: 'DEFINE_PRICE' as const,
  targetCorrelationRef: `price-target:${index + 1}`,
}));
const trustedBulk = {
  actionInvocationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  compositionRevision: 'a'.repeat(64),
  principalContext: {
    authBindingId: 'ffffffff-ffff-4fff-8fff-fffffffffff1',
    authContextRef: 'session:issue-797',
    authMethod: 'session' as const,
    correlationId: 'issue-797-bulk',
    legalEntityId,
    principalId,
    tenantId,
  },
  requestCorrelationId: 'issue-797-bulk',
  trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe(operationAt)),
};

const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog' as const,
  resourceId: 'ffffffff-ffff-4fff-8fff-fffffffffff2',
  resourceType: 'pricing.price-group-catalog.price-group' as const,
  tenantId,
};
const discountIdentity = Schema.decodeSync(PricingDiscountIdentityKeySchema)({
  audience: { kind: 'PRICE_GROUP', priceGroupRef },
  basis: { catalogSelection, kind: 'VARIANT_LINE', unitBasis },
  commercialScope,
  currencyCode: 'CZK',
  effectKind: 'PERCENTAGE',
  family: 'CONTRACTUAL_DISCOUNT',
  monetaryBoundary: 'PRE_TAX',
  scope: 'VARIANT_LINE',
});
const feeIdentity = Schema.decodeSync(PricingCommercialFeeIdentityKeySchema)({
  calculationBasis: { kind: 'FIXED_PER_UNIT', unitBasis },
  commercialScope,
  currencyCode: 'CZK',
  family: 'RECYCLING_FEE',
  monetaryBoundary: 'PRE_TAX',
  target: { variantRef },
});

const zeroFloorAuthorization = Schema.decodeSync(PricingZeroFloorAuthorizationSchema)({
  authorizationRef: 'zero-floor:797',
  authorizationRevision: 'zero-floor:797:r1',
  businessScope: {
    catalogSelection,
    commercialScope,
    pricingBasis: unitBasis,
    tenantId,
  },
  coveredMeaning: {
    audienceRefs: ['price-group:launch'],
    materialRevisionRefs: ['price:r1', 'discount:r1', 'fee:r1'],
  },
  currencyCode: 'CZK',
  economicCoverage: { maximumFloorAdjustment: '20', minimumRawAmount: '-20' },
  effectivePeriod: { endsAt: '2027-01-01T00:00:00.000Z', startsAt: '2026-01-01T00:00:00.000Z' },
  governanceEvidence: {
    approvalEvidenceRef: 'approval:797',
    approvedByPrincipalRef: principalId,
    reason: 'Bound the exact launch pricing risk',
  },
});
const zeroFloorSchedule = {
  authorizationRef: zeroFloorAuthorization.authorizationRef,
  revisions: [
    {
      authorization: zeroFloorAuthorization,
      lineage: { rootAuthorizationRef: zeroFloorAuthorization.authorizationRef, transition: 'CREATED' as const },
      recordedAt: operationAt,
      revisionNumber: 1,
      scheduleRevision: 1,
    },
  ],
  scheduleRevision: 1,
  tenantId,
};
const zeroFloorExpectedCurrent = {
  authorizationRef: zeroFloorAuthorization.authorizationRef,
  authorizationRevision: zeroFloorAuthorization.authorizationRevision,
  effectivePeriod: zeroFloorAuthorization.effectivePeriod,
  scheduleRevision: 1,
};
const zeroFloorTrusted = {
  actingPrincipalId: principalId,
  actionInvocationId: 'ffffffff-ffff-4fff-8fff-fffffffffff3',
  expectedCurrent: zeroFloorExpectedCurrent,
  expectedSetGeneration: 1,
  governanceProof: {
    approvalEvidence: {
      approvalEvidenceRef: zeroFloorAuthorization.governanceEvidence.approvalEvidenceRef,
      approvalRevision: 'zero-floor-governance-approval:r797',
      approvedAt: operationAt,
      approvedByPrincipalRef: zeroFloorAuthorization.governanceEvidence.approvedByPrincipalRef,
      approvedEffectivePeriod: zeroFloorAuthorization.effectivePeriod,
      authorityRef: 'zero-floor-governance-authority:797',
      authorization: zeroFloorAuthorization,
      authorizationFingerprint: 'a'.repeat(64),
      sellingLegalEntityId: legalEntityId,
      tenantId,
      validityPeriod: { endsAt: '2027-01-01T00:00:00.000Z', startsAt: '2026-09-01T00:00:00.000Z' },
    },
    authorization: zeroFloorAuthorization,
    completenessEvidence: {
      observedAt: operationAt,
      ownerRevision: 'zero-floor-owner:r797',
      scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: 'zero-floor:predicate:797' },
    },
    currentness: {
      evaluatedAt: operationAt,
      observedAt: operationAt,
      revalidatedAt: operationAt,
      status: 'CURRENT' as const,
    },
    exactPredicateRef: 'zero-floor:predicate:797',
    ownerRevision: 'zero-floor-owner:r797',
  },
  intent: 'SUCCESSOR' as const,
  reason: 'Verify bounded successor governance',
  requestCorrelationId: 'issue-797-zero-floor',
  trustedOperationAt: operationAt,
};
const zeroFloorPersistence = (
  outcome: ManageZeroFloorAuthorizationPersistenceOutcome,
): ZeroFloorAuthorizationPersistence => ({
  create: () => Effect.die('not used'),
  lookupResult: () => Effect.die('not used'),
  manage: () => Effect.succeed(outcome),
  readCurrentSet: () => Effect.die('not used'),
  readGovernanceProof: () => Effect.die('not used'),
  readSchedule: () => Effect.die('not used'),
  verifyGeneration: () => Effect.die('not used'),
});

describe('Pricing Price Management Actions issue #797 acceptance', () => {
  it('registers every supported generated management Action in both public manifest and runtime', () => {
    const expectedActionKeys = [
      'commerce.pricing.compensate-currency-support-recovery',
      'commerce.pricing.define-commercial-fee',
      'commerce.pricing.define-price',
      'commerce.pricing.grant-external-price-source-authority',
      'commerce.pricing.manage-commitment-confirmation',
      'commerce.pricing.manage-contractual-discount',
      'commerce.pricing.manage-product-commercial-fees-bulk',
      'commerce.pricing.manage-product-prices-bulk',
      'commerce.pricing.manage-quantity-tier',
      'commerce.pricing.manage-quotation',
      'commerce.pricing.manage-zero-floor-authorization',
      'commerce.pricing.revise-commercial-fee',
      'commerce.pricing.revise-price',
      'commerce.pricing.set-supported-currencies',
    ];
    const publicActionKeys = pricingManifest.publicSurface.actions.map(({ descriptor }) => descriptor.actionKey);
    const runtimeActions = getVerticalRuntimeActions(pricingRegistration);
    const runtimeActionKeys = runtimeActions.map(({ descriptor }) => descriptor.actionKey);

    expect(publicActionKeys.toSorted()).toEqual(expectedActionKeys);
    expect(runtimeActionKeys.toSorted()).toEqual(expectedActionKeys);
    expect(pricingManifest.publicSurface.actions.map(({ descriptor }) => descriptor.entrypoint.authorization)).toEqual(
      expectedActionKeys.map(() => ({ kind: 'protected' })),
    );
    // Every manifest Action carries its own declared capability (O62, O67-Q2).
    expect(
      pricingManifest.publicSurface.actions.map(({ descriptor }) => descriptor.accessDeclaration === undefined),
    ).toEqual(expectedActionKeys.map(() => false));
    expect(
      runtimeActions.map(({ descriptor }) => ({
        auditProfile: descriptor.auditProfile,
        idempotency: descriptor.idempotency,
      })),
    ).toEqual(expectedActionKeys.map(() => ({ auditProfile: 'standard', idempotency: 'required' })));
  });

  it.effect('reconciles each fixed Variant target and never retries an already successful target', () =>
    Effect.gen(function* perTargetRetry() {
      const reconciled: string[] = [];
      const executed: string[] = [];
      const port: ProductPriceBulkCommandPort<(typeof bulkIntents)[number]['operation']> = {
        executeAuthorizedExactPriceAction: (command) => {
          executed.push(command.intentId);
          return Effect.succeed({ outcome: 'CONFLICT' as const, reasonCode: 'EXPECTED_CURRENT_MISMATCH' });
        },
        reconcileAuthorizedExactPriceAction: (command) => {
          reconciled.push(command.intentId);
          return command.intentId === bulkIntents[0]?.intentId
            ? Effect.succeed({
                outcome: { canonical: { priceRef }, outcome: 'APPLIED' as const },
                status: 'RESOLVED' as const,
              })
            : Effect.succeed({ status: 'RETRY_ALLOWED' as const });
        },
      };
      const result = yield* makeProductPriceBulkService(port).execute({
        snapshot,
        targetIntents: bulkIntents,
        trusted: trustedBulk,
      });

      expect(reconciled).toEqual(bulkIntents.map(({ intentId }) => intentId));
      expect(executed).toEqual([bulkIntents[1]?.intentId]);
      expect(result.snapshotId).toBe(snapshot.snapshotId);
      expect(result.outcomes).toMatchObject([
        { outcome: 'APPLIED', resolvedBy: 'OWNER_RECONCILIATION' },
        { outcome: 'CONFLICT', resolvedBy: 'OWNER_COMMAND' },
      ]);
      expect(result.outcomes.map(({ identity }) => identity.target.variantRef)).toEqual([variantRef, otherVariantRef]);
    }),
  );

  it('preserves Discount logical uniqueness while treating identity changes as different facts', () => {
    const sameLogicalKey = Schema.decodeUnknownSync(PricingDiscountIdentityKeySchema)({
      ...discountIdentity,
      basis: { ...discountIdentity.basis, unitBasis: { quantity: '1.0', unitRef } },
    });
    const differentVariant = Schema.decodeUnknownSync(PricingDiscountIdentityKeySchema)({
      ...discountIdentity,
      basis: { ...discountIdentity.basis, catalogSelection: { productRef, variantRef: otherVariantRef } },
    });
    const createPayload = Schema.decodeSync(ManageContractualDiscountPayloadSchema)({
      configuredEffect: { kind: 'PERCENTAGE', level: '10' },
      effectivePeriod: { effectiveFrom: operationAt, effectiveTo: null },
      expectedState: { state: 'ABSENT' },
      identityKey: discountIdentity,
      intent: 'CREATE',
      reason: 'Create one stable logical contractual Discount',
    });

    expect(pricingDiscountIdentityKeysEqual(discountIdentity, sameLogicalKey)).toBe(true);
    expect(pricingDiscountIdentityKeysEqual(discountIdentity, differentVariant)).toBe(false);
    expect('reason' in discountIdentity).toBe(false);
    expect(Schema.is(manageContractualDiscountAction.descriptor.payloadSchema)({})).toBe(false);
    expect(() =>
      Schema.decodeSync(manageContractualDiscountAction.descriptor.payloadSchema, {
        onExcessProperty: 'error',
      })(createPayload),
    ).not.toThrow();
  });

  it('keeps Fee identity exact across family, Variant, Market, and per-line/per-unit basis', () => {
    const sameLogicalFee = Schema.decodeSync(PricingCommercialFeeIdentityKeySchema)({
      ...feeIdentity,
      calculationBasis: { kind: 'FIXED_PER_UNIT', unitBasis: { quantity: '1.0', unitRef } },
    });
    const otherFamily = Schema.decodeSync(PricingCommercialFeeIdentityKeySchema)({
      ...feeIdentity,
      family: 'COPYRIGHT_FEE',
    });
    const perLine = Schema.decodeSync(PricingCommercialFeeIdentityKeySchema)({
      ...feeIdentity,
      calculationBasis: { kind: 'FIXED_PER_LINE' },
    });
    const decodeExact = Schema.decodeUnknownSync(PricingCommercialFeeIdentityKeySchema, {
      onExcessProperty: 'error',
    });

    expect(pricingCommercialFeeIdentityKeysEqual(feeIdentity, sameLogicalFee)).toBe(true);
    expect(pricingCommercialFeeIdentityKeysEqual(feeIdentity, otherFamily)).toBe(false);
    expect(pricingCommercialFeeIdentityKeysEqual(feeIdentity, perLine)).toBe(false);
    expect(() => decodeExact({ ...feeIdentity, productRef })).toThrow();
    expect(() => decodeExact({ ...feeIdentity, storefrontId: 'storefront-cz' })).toThrow();
  });

  it.effect('allows bounded ZERO_FLOOR reuse but rejects unchanged evidence for expanded scope or bounds', () =>
    Effect.gen(function* boundedSuccessor() {
      const unchangedOutcome = {
        outcome: 'ZERO_FLOOR_AUTHORIZATION_UNCHANGED' as const,
        schedule: zeroFloorSchedule,
        setGeneration: 1,
      };
      const administration = makeZeroFloorAuthorizationAdministration(zeroFloorPersistence(unchangedOutcome));
      const reused = yield* administration.manage({
        ...zeroFloorTrusted,
        authorization: zeroFloorAuthorization,
      });
      expect(reused).toEqual(unchangedOutcome);

      for (const authorization of [
        {
          ...zeroFloorAuthorization,
          economicCoverage: { maximumFloorAdjustment: '30', minimumRawAmount: '-30' },
        },
        {
          ...zeroFloorAuthorization,
          businessScope: {
            ...zeroFloorAuthorization.businessScope,
            commercialScope: { ...commercialScope, marketId: 'expanded-market' },
          },
        },
      ]) {
        const failure = yield* administration.manage({ ...zeroFloorTrusted, authorization }).pipe(Effect.flip);
        expect(failure).toBeInstanceOf(ZeroFloorAuthorizationPersistenceUnavailable);
      }
    }),
  );
});
