import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type { PricingDiscountIdentityKey } from '../../src/domain/discount.ts';

import {
  PricingDiscountAudienceEvidenceBindingSchema,
  PricingDiscountCurrentResolutionSchema,
  PricingDiscountDefinitionSchema,
  PricingDiscountIdentityKeySchema,
  PricingDiscountProductBulkResultSchema,
  PricingDiscountProductBulkRetrySchema,
  PricingDiscountScheduleSnapshotSchema,
  PricingWholePurchaseContractualApplicabilitySchema,
  pricingDiscountIdentityKeysEqual,
} from '../../src/domain/discount.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const capturedAt = '2026-09-27T10:00:00.000Z';
const commercialScope = {
  channelId: 'B2B' as const,
  marketId: 'cz-launch',
  sellingLegalEntityId: '22222222-2222-4222-8222-222222222222',
};

const catalogRef = <const ResourceType extends string>(resourceId: string, resourceType: ResourceType) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId,
});

const productRef = catalogRef('33333333-3333-4333-8333-333333333333', 'commerce.catalog.product');
const firstVariantRef = catalogRef('44444444-4444-4444-8444-444444444444', 'commerce.catalog.variant');
const secondVariantRef = catalogRef('55555555-5555-4555-8555-555555555555', 'commerce.catalog.variant');
const laterVariantRef = catalogRef('66666666-6666-4666-8666-666666666666', 'commerce.catalog.variant');
const unitRef = catalogRef('77777777-7777-4777-8777-777777777777', 'commerce.catalog.product-unit');
const firstTarget = { productRef, variantRef: firstVariantRef };
const secondTarget = { productRef, variantRef: secondVariantRef };
const laterTarget = { productRef, variantRef: laterVariantRef };

const counterpartyAudience = {
  counterpartyRef: {
    moduleId: 'party.registry' as const,
    resourceId: '88888888-8888-4888-8888-888888888888',
    resourceType: 'party.registry.counterparty' as const,
    tenantId,
  },
  kind: 'COUNTERPARTY' as const,
};
const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog' as const,
  resourceId: '99999999-9999-4999-8999-999999999999',
  resourceType: 'pricing.price-group-catalog.price-group' as const,
  tenantId,
};
const priceGroupAudience = { kind: 'PRICE_GROUP' as const, priceGroupRef };
const noGroupPricePath = {
  kind: 'NO_GROUP_PRICE' as const,
  priceRef: {
    moduleId: 'commerce.pricing' as const,
    resourceId: '12121212-1212-4121-8121-121212121212',
    resourceType: 'commerce.pricing.price' as const,
    tenantId,
  },
  priceRevisionId: '13131313-1313-4131-8131-131313131313',
};

type PricingDiscountVariantLineBasis = Extract<PricingDiscountIdentityKey['basis'], { readonly kind: 'VARIANT_LINE' }>;
type PricingDiscountLineIdentityOverrides = Partial<Omit<PricingDiscountIdentityKey, 'basis'>> & {
  readonly basis?: PricingDiscountVariantLineBasis;
};

const lineIdentityFor = (target: typeof firstTarget, overrides: PricingDiscountLineIdentityOverrides = {}) => ({
  audience: counterpartyAudience,
  basis: {
    catalogSelection: target,
    kind: 'VARIANT_LINE' as const,
    unitBasis: { quantity: '1', unitRef },
  },
  commercialScope,
  currencyCode: 'CZK',
  effectKind: 'PERCENTAGE' as const,
  family: 'CONTRACTUAL_DISCOUNT' as const,
  monetaryBoundary: 'PRE_TAX' as const,
  scope: 'VARIANT_LINE' as const,
  ...overrides,
});

const wholeIdentity = {
  audience: counterpartyAudience,
  basis: { kind: 'WHOLE_PURCHASE' as const },
  commercialScope,
  currencyCode: 'CZK',
  effectKind: 'FIXED_MONETARY_AMOUNT' as const,
  family: 'CONTRACTUAL_DISCOUNT' as const,
  monetaryBoundary: 'PRE_TAX' as const,
  scope: 'WHOLE_PURCHASE' as const,
};

const definitionFor = ({
  discountId,
  effectiveFrom,
  identityKey = lineIdentityFor(firstTarget),
  level = '10',
  revision,
  revisionId,
}: {
  readonly discountId: string;
  readonly effectiveFrom: string;
  readonly identityKey?: ReturnType<typeof lineIdentityFor>;
  readonly level?: string;
  readonly revision: number;
  readonly revisionId: string;
}) => ({
  discountId,
  identityKey,
  revision: {
    configuredEffect: { kind: 'PERCENTAGE' as const, level },
    effectiveFrom,
    revision,
    revisionId,
  },
});

const discountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const firstRevisionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const secondRevisionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const scheduledRevision = ({
  effectiveFrom,
  effectiveTo,
  level,
  revision,
  revisionId,
}: {
  readonly effectiveFrom: string;
  readonly effectiveTo: null | string;
  readonly level: string;
  readonly revision: number;
  readonly revisionId: string;
}) => ({
  definition: definitionFor({ discountId, effectiveFrom, level, revision, revisionId }),
  effectivePeriod: { effectiveFrom, effectiveTo },
  lineage: {
    correctedRevisionId: null,
    kind: revision === 1 ? ('INITIAL' as const) : ('SCHEDULED' as const),
    previousRevisionId: revision === 1 ? null : firstRevisionId,
  },
});

const catalogEvidenceFor = (target: typeof firstTarget) => ({
  assessedAt: capturedAt,
  basis: [
    { role: 'PRODUCT' as const, source: { resourceRef: target.productRef, revision: 1 } },
    { role: 'VARIANT' as const, source: { resourceRef: target.variantRef, revision: 2 } },
    {
      provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION' as const,
      role: 'PRODUCT_TYPE_UNTYPED_DECISION' as const,
      source: { resourceRef: target.productRef, revision: 1 },
    },
  ],
  membership: {
    attestationId: `catalog-membership:${target.variantRef.resourceId}`,
    observedAt: capturedAt,
    productRef: target.productRef,
    source: 'CATALOG_OWNER_CURRENT_READ' as const,
    variant: { resourceRef: target.variantRef, revision: 2 },
  },
  purpose: 'PRICING' as const,
  selection: target,
  status: 'VALID' as const,
});

const snapshotEntryFor = (target: typeof firstTarget, targetId: string) => ({
  catalogEvidence: catalogEvidenceFor(target),
  target,
  targetId,
});
const snapshot = {
  capturedAt,
  catalogOwnerRevision: 'catalog-product-variants:771',
  productRef,
  snapshotId: 'discount-product-snapshot:771',
  targets: [
    snapshotEntryFor(firstTarget, 'discount-target:first'),
    snapshotEntryFor(secondTarget, 'discount-target:second'),
  ],
  targetSetCompleteness: {
    observedAt: capturedAt,
    ownerRevision: 'catalog-product-variants:771',
    scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: 'catalog-product:active-variants' },
  },
};

const wholePurchaseBasisFor = (amount: string) => ({
  currencyCode: 'CZK',
  eligibleAmount: amount,
  recipients: [
    {
      intermediateValue: { amount, currencyCode: 'CZK' },
      occurrenceId: 'pricing-line:first',
      recipientKind: 'MERCHANDISE' as const,
    },
  ],
});

const decodeIdentity = Schema.decodeUnknownSync(PricingDiscountIdentityKeySchema, {
  onExcessProperty: 'error',
});
const decodeDefinition = Schema.decodeUnknownSync(PricingDiscountDefinitionSchema, {
  onExcessProperty: 'error',
});
const decodeCurrentResolution = Schema.decodeUnknownSync(PricingDiscountCurrentResolutionSchema, {
  onExcessProperty: 'error',
});
const decodeSchedule = Schema.decodeUnknownSync(PricingDiscountScheduleSnapshotSchema, {
  onExcessProperty: 'error',
});
const decodeAudienceBinding = Schema.decodeUnknownSync(PricingDiscountAudienceEvidenceBindingSchema, {
  onExcessProperty: 'error',
});
const decodeWholeApplicability = Schema.decodeUnknownSync(PricingWholePurchaseContractualApplicabilitySchema, {
  onExcessProperty: 'error',
});
const decodeBulkResult = Schema.decodeUnknownSync(PricingDiscountProductBulkResultSchema, {
  onExcessProperty: 'error',
});
const decodeBulkRetry = Schema.decodeUnknownSync(PricingDiscountProductBulkRetrySchema, {
  onExcessProperty: 'error',
});

describe('Issue #771 Pricing Discount applicability acceptance', () => {
  it('keeps logical identity stable across value Revisions and distinct across identity-defining meaning', () => {
    const identity = decodeIdentity(lineIdentityFor(firstTarget));
    const numericallyEquivalent = decodeIdentity({
      ...lineIdentityFor(firstTarget),
      basis: { ...lineIdentityFor(firstTarget).basis, unitBasis: { quantity: '1.0', unitRef } },
    });
    expect(pricingDiscountIdentityKeysEqual(identity, numericallyEquivalent)).toBe(true);

    const first = decodeDefinition(
      definitionFor({
        discountId,
        effectiveFrom: '2026-09-01T00:00:00.000Z',
        revision: 1,
        revisionId: firstRevisionId,
      }),
    );
    const changedValue = decodeDefinition(
      definitionFor({
        discountId,
        effectiveFrom: '2026-10-01T00:00:00.000Z',
        level: '15',
        revision: 2,
        revisionId: secondRevisionId,
      }),
    );
    expect(pricingDiscountIdentityKeysEqual(first.identityKey, changedValue.identityKey)).toBe(true);
    expect(first.revision.configuredEffect).not.toEqual(changedValue.revision.configuredEffect);

    const distinct = [
      lineIdentityFor(secondTarget),
      lineIdentityFor(firstTarget, { audience: priceGroupAudience }),
      lineIdentityFor(firstTarget, { commercialScope: { ...commercialScope, marketId: 'sk-launch' } }),
      lineIdentityFor(firstTarget, { currencyCode: 'EUR' }),
      lineIdentityFor(firstTarget, { effectKind: 'FIXED_MONETARY_AMOUNT' }),
      lineIdentityFor(firstTarget, {
        basis: { ...lineIdentityFor(firstTarget).basis, unitBasis: { quantity: '2', unitRef } },
      }),
    ].map((candidate) => decodeIdentity(candidate));
    expect(distinct.every((candidate) => !pricingDiscountIdentityKeysEqual(identity, candidate))).toBe(true);
  });

  it('uses exact half-open effectivity and rejects overlapping Revisions instead of choosing a winner', () => {
    const first = scheduledRevision({
      effectiveFrom: '2026-09-01T00:00:00.000Z',
      effectiveTo: '2026-10-01T00:00:00.000Z',
      level: '10',
      revision: 1,
      revisionId: firstRevisionId,
    });
    const second = scheduledRevision({
      effectiveFrom: '2026-10-01T00:00:00.000Z',
      effectiveTo: null,
      level: '15',
      revision: 2,
      revisionId: secondRevisionId,
    });
    const atBoundary = decodeSchedule({
      current: second,
      discountId,
      future: [],
      identityKey: lineIdentityFor(firstTarget),
      observedAt: '2026-10-01T00:00:00.000Z',
      revisions: [first, second],
      scheduleRevision: 2,
    });
    expect(atBoundary.current?.definition.revision.revisionId).toBe(secondRevisionId);

    expect(() =>
      decodeSchedule({
        current: first,
        discountId,
        future: [second],
        identityKey: lineIdentityFor(firstTarget),
        observedAt: '2026-09-30T12:00:00.000Z',
        revisions: [
          { ...first, effectivePeriod: { ...first.effectivePeriod, effectiveTo: '2026-10-02T00:00:00.000Z' } },
          second,
        ],
        scheduleRevision: 2,
      }),
    ).toThrow();

    const duplicateRevisionId = {
      ...second,
      definition: {
        ...second.definition,
        revision: { ...second.definition.revision, revisionId: first.definition.revision.revisionId },
      },
    };
    expect(() =>
      decodeSchedule({
        current: duplicateRevisionId,
        discountId,
        future: [],
        identityKey: lineIdentityFor(firstTarget),
        observedAt: '2026-10-01T00:00:00.000Z',
        revisions: [first, duplicateRevisionId],
        scheduleRevision: 2,
      }),
    ).toThrow();

    const duplicateRevisionNumber = {
      ...second,
      definition: {
        ...second.definition,
        revision: { ...second.definition.revision, revision: first.definition.revision.revision },
      },
    };
    expect(() =>
      decodeSchedule({
        current: duplicateRevisionNumber,
        discountId,
        future: [],
        identityKey: lineIdentityFor(firstTarget),
        observedAt: '2026-10-01T00:00:00.000Z',
        revisions: [first, duplicateRevisionNumber],
        scheduleRevision: 2,
      }),
    ).toThrow();

    expect(
      decodeCurrentResolution({
        claimants: [
          { revision: 1, revisionId: firstRevisionId },
          { revision: 2, revisionId: firstRevisionId },
        ],
        identityKey: lineIdentityFor(firstTarget),
        observedAt: '2026-10-01T00:00:00.000Z',
        outcome: 'DISCOUNT_REVISION_INVARIANT_VIOLATION',
        reason: 'DUPLICATE_REVISION_ID',
      }),
    ).toMatchObject({
      outcome: 'DISCOUNT_REVISION_INVARIANT_VIOLATION',
      reason: 'DUPLICATE_REVISION_ID',
    });
    expect(
      decodeCurrentResolution({
        claimants: [
          { revision: 1, revisionId: firstRevisionId },
          { revision: 1, revisionId: secondRevisionId },
        ],
        identityKey: lineIdentityFor(firstTarget),
        observedAt: '2026-10-01T00:00:00.000Z',
        outcome: 'DISCOUNT_REVISION_INVARIANT_VIOLATION',
        reason: 'DUPLICATE_REVISION_NUMBER',
      }),
    ).toMatchObject({
      outcome: 'DISCOUNT_REVISION_INVARIANT_VIOLATION',
      reason: 'DUPLICATE_REVISION_NUMBER',
    });
    expect(() =>
      decodeCurrentResolution({
        claimants: [
          { revision: 1, revisionId: firstRevisionId },
          { revision: 2, revisionId: firstRevisionId },
        ],
        identityKey: lineIdentityFor(firstTarget),
        observedAt: '2026-10-01T00:00:00.000Z',
        outcome: 'DISCOUNT_REVISION_INVARIANT_VIOLATION',
        reason: 'DUPLICATE_REVISION_NUMBER',
      }),
    ).toThrow();
  });

  it('requires exact owner-proven Group and Counterparty audiences without principal or email substitutes', () => {
    const counterpartyIdentity = decodeIdentity(lineIdentityFor(firstTarget));
    expect(
      decodeAudienceBinding({
        applicabilityBasis: {
          basis: counterpartyIdentity.basis,
          commercialScope,
          currencyCode: 'CZK',
          observedAt: capturedAt,
        },
        basePricePath: noGroupPricePath,
        evidence: {
          audience: counterpartyAudience,
          kind: 'COUNTERPARTY_OWNER_EVIDENCE',
          observedAt: capturedAt,
          ownerRevision: 'party-registry:counterparty:771',
          source: 'PARTY_REGISTRY',
        },
        identityKey: counterpartyIdentity,
      }).evidence.kind,
    ).toBe('COUNTERPARTY_OWNER_EVIDENCE');
    expect(() =>
      decodeAudienceBinding({
        applicabilityBasis: {
          basis: counterpartyIdentity.basis,
          commercialScope,
          currencyCode: 'CZK',
          observedAt: capturedAt,
        },
        basePricePath: noGroupPricePath,
        evidence: {
          actingPrincipalId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          audience: counterpartyAudience,
          email: 'buyer@example.invalid',
          kind: 'COUNTERPARTY_OWNER_EVIDENCE',
          observedAt: capturedAt,
          ownerRevision: 'party-registry:counterparty:771',
          source: 'PARTY_REGISTRY',
        },
        identityKey: counterpartyIdentity,
      }),
    ).toThrow();

    const compatibilityEvidence = {
      catalogRevision: 7,
      definitionEffectivePeriod: { effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null },
      definitionRevisionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      definitionRevisionNumber: 4,
      meaningFingerprint: 'a'.repeat(64),
      priceGroupRef,
      requiredContract: { contractId: 'commerce.customer-price-group-assignment.v1', version: 1 },
      trustedOperationAt: capturedAt,
      verifiedAt: '2026-09-27T10:00:01.000Z',
    } as const;
    const assignmentResolution = {
      _tag: 'ASSIGNED' as const,
      assignmentRef: {
        moduleId: 'commerce.customer-context' as const,
        resourceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        resourceType: 'commerce.customer-context.customer-price-group-assignment' as const,
        tenantId,
      },
      assignmentRevision: 3,
      compatibility: compatibilityEvidence,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveTo: null,
      priceGroupRef,
    };
    const interpretation = {
      _tag: 'ASSIGNED' as const,
      assignmentResolution,
      basis: {
        catalogSelection: firstTarget,
        commercialScope,
        currencyCode: 'CZK',
        unitBasis: { quantity: '1', unitRef },
      },
      compatibilityEvidence,
      discountAudience: priceGroupAudience,
      priceGroupRef,
      priceSelector: { kind: 'PRICE_GROUP' as const, priceGroupRef },
    };
    const groupIdentity = decodeIdentity(lineIdentityFor(firstTarget, { audience: priceGroupAudience }));
    const groupBoundToNoGroupPrice = decodeAudienceBinding({
      applicabilityBasis: {
        basis: groupIdentity.basis,
        commercialScope,
        currencyCode: 'CZK',
        observedAt: capturedAt,
      },
      basePricePath: noGroupPricePath,
      evidence: {
        audience: priceGroupAudience,
        interpretation,
        kind: 'PRICE_GROUP_OWNER_EVIDENCE',
      },
      identityKey: groupIdentity,
    });
    expect(groupBoundToNoGroupPrice.evidence.kind).toBe('PRICE_GROUP_OWNER_EVIDENCE');
    expect(groupBoundToNoGroupPrice.basePricePath.kind).toBe('NO_GROUP_PRICE');
    expect(() =>
      decodeAudienceBinding({
        applicabilityBasis: {
          basis: groupIdentity.basis,
          commercialScope,
          currencyCode: 'CZK',
          observedAt: capturedAt,
        },
        basePricePath: noGroupPricePath,
        evidence: {
          audience: { ...priceGroupAudience, priceGroupRef: { ...priceGroupRef, resourceId: discountId } },
          interpretation,
          kind: 'PRICE_GROUP_OWNER_EVIDENCE',
        },
        identityKey: groupIdentity,
      }),
    ).toThrow();
  });

  it('keeps exact currencies generalized without FX, support activation, or Storefront identity fields', () => {
    const eurIdentity = decodeIdentity(lineIdentityFor(firstTarget, { currencyCode: 'EUR' }));
    expect(eurIdentity.currencyCode).toBe('EUR');
    expect(() => decodeIdentity({ ...lineIdentityFor(firstTarget), storefrontId: 'prague-shop' })).toThrow();
    expect(() => decodeIdentity({ ...lineIdentityFor(firstTarget), exchangeRate: '25' })).toThrow();
    expect(() => decodeIdentity({ ...lineIdentityFor(firstTarget), supportedCurrencies: ['CZK', 'EUR'] })).toThrow();
  });

  it('applies a fixed whole-purchase benefit only for B > D and exposes no allocation result', () => {
    const definition = {
      discountId,
      identityKey: wholeIdentity,
      revision: {
        configuredEffect: {
          kind: 'FIXED_MONETARY_AMOUNT' as const,
          level: { amount: '100', currencyCode: 'CZK' },
        },
        effectiveFrom: '2026-09-01T00:00:00.000Z',
        revision: 1,
        revisionId: firstRevisionId,
      },
    };
    for (const amount of ['99', '100']) {
      expect(
        decodeWholeApplicability({
          basis: wholePurchaseBasisFor(amount),
          definition,
          outcome: 'WHOLE_PURCHASE_DISCOUNT_NOT_APPLICABLE',
          reason: 'BASIS_NOT_GREATER_THAN_DISCOUNT',
        }).outcome,
      ).toBe('WHOLE_PURCHASE_DISCOUNT_NOT_APPLICABLE');
    }
    const applicable = decodeWholeApplicability({
      basis: wholePurchaseBasisFor('100.01'),
      contribution: { amount: '-100', currencyCode: 'CZK' },
      definition,
      outcome: 'WHOLE_PURCHASE_DISCOUNT_APPLICABLE',
    });
    expect(applicable.outcome).toBe('WHOLE_PURCHASE_DISCOUNT_APPLICABLE');
    expect('allocations' in applicable).toBe(false);
    expect(() =>
      decodeWholeApplicability({
        ...applicable,
        allocations: [{ amount: '-100', occurrenceId: 'pricing-line:first' }],
      }),
    ).toThrow();
  });

  it('freezes Product administration to explicit Variant targets with per-target retry reconciliation', () => {
    const firstIdentity = decodeIdentity(lineIdentityFor(firstTarget));
    const secondIdentity = decodeIdentity(lineIdentityFor(secondTarget));
    const priorResult = decodeBulkResult({
      operationId: 'discount-bulk:771:first',
      outcomes: [
        {
          discountId,
          discountIdentityKey: firstIdentity,
          identity: {
            operationId: 'discount-bulk:771:first',
            snapshotId: snapshot.snapshotId,
            target: firstTarget,
            targetId: 'discount-target:first',
          },
          outcome: 'DISCOUNT_TARGET_APPLIED',
          revisionId: firstRevisionId,
        },
        {
          discountIdentityKey: secondIdentity,
          identity: {
            operationId: 'discount-bulk:771:first',
            snapshotId: snapshot.snapshotId,
            target: secondTarget,
            targetId: 'discount-target:second',
          },
          outcome: 'DISCOUNT_TARGET_RETRYABLE_FAILURE',
          reason: 'UNKNOWN_COMMIT',
        },
      ],
      snapshot,
    });
    expect(priorResult.snapshot.targets.map(({ target }) => target.variantRef.resourceId)).toEqual([
      firstVariantRef.resourceId,
      secondVariantRef.resourceId,
    ]);
    expect(
      priorResult.snapshot.targets.some(({ target }) => target.variantRef.resourceId === laterVariantRef.resourceId),
    ).toBe(false);
    expect(() =>
      decodeBulkResult({
        ...priorResult,
        outcomes: priorResult.outcomes.map((outcome, index) =>
          index === 1 ? { ...outcome, discountIdentityKey: firstIdentity } : outcome,
        ),
      }),
    ).toThrow();
    expect(
      decodeBulkRetry({
        priorResult,
        retryOperationId: 'discount-bulk:771:retry',
        retryTargetIds: ['discount-target:second'],
      }).retryTargetIds,
    ).toEqual(['discount-target:second']);
    expect(() =>
      decodeBulkRetry({
        priorResult,
        retryOperationId: 'discount-bulk:771:retry',
        retryTargetIds: ['discount-target:first'],
      }),
    ).toThrow();
    expect(() =>
      decodeBulkResult({
        ...priorResult,
        outcomes: [
          ...priorResult.outcomes,
          {
            discountIdentityKey: decodeIdentity(lineIdentityFor(laterTarget)),
            identity: {
              operationId: priorResult.operationId,
              snapshotId: priorResult.snapshot.snapshotId,
              target: laterTarget,
              targetId: 'discount-target:later',
            },
            outcome: 'DISCOUNT_TARGET_RETRYABLE_FAILURE',
            reason: 'OWNER_UNAVAILABLE',
          },
        ],
      }),
    ).toThrow();
  });

  it('keeps Promotion, composition, cardinality, and allocation outside the #771 contract', () => {
    expect(() => decodeIdentity({ ...lineIdentityFor(firstTarget), family: 'PROMOTION' })).toThrow();
    expect(() => decodeIdentity({ ...lineIdentityFor(firstTarget), priority: 1 })).toThrow();
    expect(() => decodeIdentity({ ...lineIdentityFor(firstTarget), composition: 'BEST_DISCOUNT_WINS' })).toThrow();
    expect(() => decodeIdentity({ ...lineIdentityFor(firstTarget), allocationStrategy: 'PROPORTIONAL' })).toThrow();
  });
});
