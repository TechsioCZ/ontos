import {
  PricingDiscountCompositionCandidateSchema,
  PricingDiscountCompositionRequestSchema,
  PricingDiscountCompositionResultSchema,
} from '@app/pricing-contracts/domain/discount-composition';
import type { PricingDiscountCompositionCandidate } from '@app/pricing-contracts/domain/discount-composition';
import {
  PricingDiscountCurrentResolutionSchema,
  PricingDiscountIdentityKeySchema,
} from '@app/pricing-contracts/domain/discount';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PricingDiscountCompositionRejected,
  composePricingDiscounts,
} from '../../src/services/discount-composition.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const operationTime = '2026-09-27T10:00:00.000Z';
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
const variantRef = catalogRef('44444444-4444-4444-8444-444444444444', 'commerce.catalog.variant');
const unitRef = catalogRef('55555555-5555-4555-8555-555555555555', 'commerce.catalog.product-unit');
const selection = { productRef, variantRef };
const occurrenceId = 'pricing-line:issue-772';
const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog' as const,
  resourceId: '66666666-6666-4666-8666-666666666666',
  resourceType: 'pricing.price-group-catalog.price-group' as const,
  tenantId,
};
const counterpartyRef = {
  moduleId: 'party.registry' as const,
  resourceId: '77777777-7777-4777-8777-777777777777',
  resourceType: 'party.registry.counterparty' as const,
  tenantId,
};
const groupPricePath = {
  kind: 'PRICE_GROUP_PRICE' as const,
  priceGroupRef,
  priceRef: {
    moduleId: 'commerce.pricing' as const,
    resourceId: '88888888-8888-4888-8888-888888888888',
    resourceType: 'commerce.pricing.price' as const,
    tenantId,
  },
  priceRevisionId: '99999999-9999-4999-8999-999999999999',
};

const catalogEvidence = {
  assessedAt: '2026-09-27T09:59:59.000Z',
  basis: [
    { role: 'PRODUCT' as const, source: { resourceRef: productRef, revision: 1 } },
    { role: 'VARIANT' as const, source: { resourceRef: variantRef, revision: 2 } },
    {
      provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION' as const,
      role: 'PRODUCT_TYPE_UNTYPED_DECISION' as const,
      source: { resourceRef: productRef, revision: 1 },
    },
  ],
  membership: {
    attestationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    observedAt: '2026-09-27T09:59:59.000Z',
    productRef,
    source: 'CATALOG_OWNER_CURRENT_READ' as const,
    variant: { resourceRef: variantRef, revision: 2 },
  },
  purpose: 'PRICING' as const,
  selection,
  status: 'VALID' as const,
};

const decisionFor = (quantity: string, currencyCode = 'CZK', occurrenceIds: readonly string[] = [occurrenceId]) => ({
  commercialScope,
  currencyCode,
  lines: occurrenceIds.map((lineOccurrenceId) => ({
    catalog: {
      completeness: {
        observedAt: '2026-09-27T09:59:59.000Z',
        ownerRevision: 'catalog-quantity:772',
        scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: 'catalog-quantity:issue-772' },
      },
      divisible: true,
      equivalentSelectionKey: 'catalog-selection:issue-772',
      evidence: catalogEvidence,
      hierarchyRevision: 'catalog-hierarchy:772',
      ownerRevision: 'catalog-quantity:772',
      quantity: {
        changed: false,
        notice: null,
        requested: quantity,
        resulting: quantity,
        rounding: 'HALF_UP' as const,
        status: 'VALID' as const,
        step: '1',
        targetId: variantRef.resourceId,
        tenantId,
        unitId: unitRef.resourceId,
        unitRuleRevision: 7,
      },
      quantityBasis: {
        targetDivisibilityRevision: 3,
        targetRef: variantRef,
        unitRef,
        unitRuleRevision: 7,
      },
      selection,
      status: 'READY' as const,
      unitRef,
    },
    occurrenceId: lineOccurrenceId,
    pricingBasis: { quantity, unitRef },
  })),
  monetaryBoundary: 'PRE_TAX' as const,
  operationTime,
  purchasingContext: {
    accessDecision: {
      decisionRef: 'commerce-access-decision:772',
      decisionRevision: 'commerce-access-decision-revision:772',
    },
    actor: { kind: 'PRINCIPAL' as const, principalId: 'pricing-principal:772' },
    commercialSettingsDecision: {
      decisionRef: 'commerce-settings-decision:772',
      decisionRevision: 'commerce-settings-decision-revision:772',
    },
    contextRef: 'commerce-purchasing-context:772',
    contextRevision: 'commerce-purchasing-context-revision:772',
    currencyResolution: {
      currencyCode,
      resolutionRef: 'purchase-currency-resolution:772',
      resolutionRevision: 'purchase-currency-resolution-revision:772',
    },
    subject: {
      authorizationSubject: { counterpartyRef, kind: 'COUNTERPARTY' as const },
      kind: 'PROFILE' as const,
      profileRef: {
        moduleId: 'commerce.customer-context' as const,
        resourceId: 'counterparty-profile:772',
        resourceType: 'commerce.customer-context.counterparty-purchasing-profile' as const,
        tenantId,
      },
    },
  },
  tenantId,
});

const supportVerificationRef = 'pricing:currency-support:proof:772';
const launchCurrencySupport = {
  completenessEvidence: {
    observedAt: '2026-09-27T10:00:01.000Z',
    ownerRevision: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    scope: {
      kind: 'EXACT_PREDICATE' as const,
      predicateRef: `commerce.pricing.current-supported-currencies:${tenantId}`,
    },
  },
  currentnessEvidence: {
    evaluatedAt: operationTime,
    evaluationMode: 'CURRENT_WITH_REVALIDATION' as const,
    observedAt: '2026-09-27T10:00:01.000Z',
    revalidatedAt: '2026-09-27T10:00:02.000Z',
    scheduleRevision: 7,
    supportRevisionRef: {
      moduleId: 'commerce.pricing' as const,
      resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      resourceType: 'commerce.pricing.currency-support-revision' as const,
      supportRootId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      tenantId,
    },
    supportRootRef: {
      moduleId: 'commerce.pricing' as const,
      resourceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      resourceType: 'commerce.pricing.currency-support' as const,
      tenantId,
    },
  },
  effectiveAt: operationTime,
  effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
  factProofs: [
    {
      factRef: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      factRevisionRef: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      verificationRef: supportVerificationRef,
    },
  ],
  generation: 4,
  observedAt: '2026-09-27T10:00:01.000Z',
  outcome: 'SUPPORTED_CURRENCIES_CURRENT' as const,
  pricingRevision: 'pricing-currency-support:772',
  scheduleRevision: 7,
  supportedCurrencies: ['CZK'],
  supportRevisionRef: {
    moduleId: 'commerce.pricing' as const,
    resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    resourceType: 'commerce.pricing.currency-support-revision' as const,
    supportRootId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    tenantId,
  },
  supportRootRef: {
    moduleId: 'commerce.pricing' as const,
    resourceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    resourceType: 'commerce.pricing.currency-support' as const,
    tenantId,
  },
  tenantId,
  verificationRef: supportVerificationRef,
};

const compatibilityEvidence = {
  catalogRevision: 7,
  definitionEffectivePeriod: { effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null },
  definitionRevisionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  definitionRevisionNumber: 4,
  meaningFingerprint: 'a'.repeat(64),
  priceGroupRef,
  requiredContract: { contractId: 'commerce.customer-price-group-assignment.v1', version: 1 },
  trustedOperationAt: operationTime,
  verifiedAt: '2026-09-27T10:00:01.000Z',
} as const;
const assignmentResolution = {
  _tag: 'ASSIGNED' as const,
  assignmentRef: {
    moduleId: 'commerce.customer-context' as const,
    resourceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    resourceType: 'commerce.customer-context.customer-price-group-assignment' as const,
    tenantId,
  },
  assignmentRevision: 3,
  compatibility: compatibilityEvidence,
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  effectiveTo: null,
  priceGroupRef,
};

const identityFor = ({
  audience,
  currencyCode = 'CZK',
  effectKind = 'PERCENTAGE',
  quantity = '1',
  scope = 'VARIANT_LINE',
}: {
  readonly audience:
    | { readonly kind: 'CATALOG_PATH'; readonly selection: typeof selection }
    | { readonly counterpartyRef: typeof counterpartyRef; readonly kind: 'COUNTERPARTY' }
    | { readonly kind: 'PRICE_GROUP'; readonly priceGroupRef: typeof priceGroupRef };
  readonly currencyCode?: string;
  readonly effectKind?: 'FIXED_MONETARY_AMOUNT' | 'PERCENTAGE';
  readonly quantity?: string;
  readonly scope?: 'VARIANT_LINE' | 'WHOLE_PURCHASE';
}) => ({
  audience,
  basis:
    scope === 'WHOLE_PURCHASE'
      ? ({ kind: 'WHOLE_PURCHASE' as const } as const)
      : ({
          catalogSelection: selection,
          kind: 'VARIANT_LINE' as const,
          unitBasis: { quantity, unitRef },
        } as const),
  commercialScope,
  currencyCode,
  effectKind,
  family: audience.kind === 'CATALOG_PATH' ? ('CATALOG_DISCOUNT' as const) : ('CONTRACTUAL_DISCOUNT' as const),
  monetaryBoundary: 'PRE_TAX' as const,
  scope,
});

const definitionFor = (
  discountId: string,
  revisionId: string,
  identityKey: ReturnType<typeof identityFor>,
  level: string,
) => ({
  discountId,
  identityKey,
  revision: {
    configuredEffect:
      identityKey.effectKind === 'PERCENTAGE'
        ? ({ kind: 'PERCENTAGE' as const, level } as const)
        : ({
            kind: 'FIXED_MONETARY_AMOUNT' as const,
            level: { amount: level, currencyCode: identityKey.currencyCode },
          } as const),
    effectiveFrom: '2026-09-01T00:00:00.000Z',
    revision: 1,
    revisionId,
  },
});

const bindingFor = (identityKey: ReturnType<typeof identityFor>) => {
  const applicabilityBasis = {
    basis: identityKey.basis,
    commercialScope,
    currencyCode: identityKey.currencyCode,
    observedAt: operationTime,
  };
  if (identityKey.audience.kind === 'CATALOG_PATH') {
    return {
      applicabilityBasis,
      basePricePath: groupPricePath,
      evidence: {
        audience: identityKey.audience,
        catalogEvidence,
        kind: 'CATALOG_OWNER_EVIDENCE' as const,
      },
      identityKey,
    };
  }
  if (identityKey.audience.kind === 'PRICE_GROUP') {
    return {
      applicabilityBasis,
      basePricePath: groupPricePath,
      evidence: {
        audience: identityKey.audience,
        interpretation: {
          _tag: 'ASSIGNED' as const,
          assignmentResolution,
          basis: {
            catalogSelection: selection,
            commercialScope,
            currencyCode: identityKey.currencyCode,
            unitBasis: {
              quantity: identityKey.basis.kind === 'VARIANT_LINE' ? identityKey.basis.unitBasis.quantity : '1',
              unitRef,
            },
          },
          compatibilityEvidence,
          discountAudience: identityKey.audience,
          priceGroupRef,
          priceSelector: { kind: 'PRICE_GROUP' as const, priceGroupRef },
        },
        kind: 'PRICE_GROUP_OWNER_EVIDENCE' as const,
      },
      identityKey,
    };
  }
  return {
    applicabilityBasis,
    basePricePath: groupPricePath,
    evidence: {
      audience: identityKey.audience,
      kind: 'COUNTERPARTY_OWNER_EVIDENCE' as const,
      observedAt: operationTime,
      ownerRevision: 'party-registry:counterparty:772',
      source: 'PARTY_REGISTRY' as const,
    },
    identityKey,
  };
};

const lineCandidate = ({
  audience,
  discountId,
  effectKind = 'PERCENTAGE',
  layer,
  level,
  quantity = '1',
  revisionId,
}: {
  readonly audience: Parameters<typeof identityFor>[0]['audience'];
  readonly discountId: string;
  readonly effectKind?: 'FIXED_MONETARY_AMOUNT' | 'PERCENTAGE';
  readonly layer: 'CATALOG' | 'COUNTERPARTY_CONTRACTUAL' | 'PRICE_GROUP_CONTRACTUAL';
  readonly level: string;
  readonly quantity?: string;
  readonly revisionId: string;
}) => {
  const identityKey = identityFor({ audience, effectKind, quantity });
  return {
    applicationCount: 'ONCE_PER_STABLE_LINE' as const,
    audienceBinding: bindingFor(identityKey),
    definition: definitionFor(discountId, revisionId, identityKey, level),
    kind: 'VARIANT_LINE' as const,
    layer,
    occurrenceId,
    outcome: 'DISCOUNT_APPLICABLE' as const,
  };
};

const catalogCandidate = lineCandidate({
  audience: { kind: 'CATALOG_PATH', selection },
  discountId: '10101010-1010-4101-8101-101010101010',
  layer: 'CATALOG',
  level: '10',
  revisionId: '11111111-2222-4222-8222-111111111111',
});
const groupCandidate = lineCandidate({
  audience: { kind: 'PRICE_GROUP', priceGroupRef },
  discountId: '12121212-1212-4121-8121-121212121212',
  layer: 'PRICE_GROUP_CONTRACTUAL',
  level: '5',
  revisionId: '13131313-1313-4131-8131-131313131313',
});
const counterpartyCandidate = lineCandidate({
  audience: { counterpartyRef, kind: 'COUNTERPARTY' },
  discountId: '14141414-1414-4141-8141-141414141414',
  layer: 'COUNTERPARTY_CONTRACTUAL',
  level: '3',
  revisionId: '15151515-1515-4151-8151-151515151515',
});

const wholeCandidate = (() => {
  const identityKey = identityFor({
    audience: { counterpartyRef, kind: 'COUNTERPARTY' },
    effectKind: 'FIXED_MONETARY_AMOUNT',
    scope: 'WHOLE_PURCHASE',
  });
  const definition = definitionFor(
    '16161616-1616-4161-8161-161616161616',
    '17171717-1717-4171-8171-171717171717',
    identityKey,
    '100',
  );
  return {
    applicability: {
      basis: {
        currencyCode: 'CZK',
        eligibleAmount: '820',
        recipients: [
          {
            intermediateValue: { amount: '820', currencyCode: 'CZK' },
            occurrenceId,
            recipientKind: 'MERCHANDISE' as const,
          },
        ],
      },
      contribution: { amount: '-100', currencyCode: 'CZK' },
      definition,
      outcome: 'WHOLE_PURCHASE_DISCOUNT_APPLICABLE' as const,
    },
    applicationCount: 'ONCE_PER_PRICING_DECISION' as const,
    audienceBinding: bindingFor(identityKey),
    decision: decisionFor('1'),
    definition,
    kind: 'WHOLE_PURCHASE' as const,
    layer: 'COUNTERPARTY_WHOLE_PURCHASE' as const,
    outcome: 'DISCOUNT_APPLICABLE' as const,
  };
})();

const decodeCandidate = Schema.decodeUnknownSync(PricingDiscountCompositionCandidateSchema, {
  onExcessProperty: 'error',
});
const decodeRequest = Schema.decodeUnknownSync(PricingDiscountCompositionRequestSchema, {
  onExcessProperty: 'error',
});
const decodeResult = Schema.decodeUnknownSync(PricingDiscountCompositionResultSchema, {
  onExcessProperty: 'error',
});
const requestFor = (
  candidates: readonly unknown[],
  quantity = '1',
  occurrenceIds: readonly string[] = [occurrenceId],
) => {
  const decodedCandidates = candidates.map((candidate) => decodeCandidate(candidate));
  const input = {
    candidates: decodedCandidates,
    currencySupport: launchCurrencySupport,
    decision: decisionFor(quantity, 'CZK', occurrenceIds),
    lineBases: occurrenceIds.map((lineOccurrenceId) => ({
      amount: { amount: '1000', currencyCode: 'CZK' },
      applicablePricingFeeTotal: { amount: '0', currencyCode: 'CZK' },
      baseLineValue: { amount: '1000', currencyCode: 'CZK' },
      occurrenceId: lineOccurrenceId,
    })),
  };
  return decodedCandidates.some(({ kind }) => kind === 'WHOLE_PURCHASE')
    ? decodeRequest({ ...input, wholePurchaseBasis: wholeCandidate.applicability.basis })
    : decodeRequest(input);
};

describe('Issue #772 Pricing Discount composition acceptance', () => {
  it.effect('composes Catalog, Group, and Counterparty percentages independently from the same basis', () =>
    Effect.gen(function* composesIndependentLayers() {
      const request = requestFor([catalogCandidate, groupCandidate, counterpartyCandidate, wholeCandidate]);
      const result = yield* composePricingDiscounts(request);

      expect(result.outcome).toBe('DISCOUNT_COMPOSITION_READY');
      if (result.outcome !== 'DISCOUNT_COMPOSITION_READY') {
        throw new Error('fixture must compose without a cardinality conflict');
      }
      expect(result.lineContributions.map(({ amount }) => amount.amount)).toEqual(['-100', '-50', '-30']);
      expect(
        result.lineContributions.reduce((sum, contribution) => sum + Number(contribution.amount.amount), 1000),
      ).toBe(820);
      expect(result.lineContributions.map(({ candidate }) => candidate.layer)).toEqual([
        'CATALOG',
        'PRICE_GROUP_CONTRACTUAL',
        'COUNTERPARTY_CONTRACTUAL',
      ]);
      expect(
        result.lineContributions.every(
          ({ candidate }) => candidate.audienceBinding.basePricePath.kind === 'PRICE_GROUP_PRICE',
        ),
      ).toBe(true);
      expect(result.wholePurchaseContribution).toMatchObject({
        amount: { amount: '-100', currencyCode: 'CZK' },
        applicationCount: 'ONCE_PER_PRICING_DECISION',
      });
      expect('allocations' in (result.wholePurchaseContribution ?? {})).toBe(false);
      expect(820 + Number(result.wholePurchaseContribution?.amount.amount)).toBe(720);
    }),
  );

  it.effect('applies a fixed Variant-line Discount once even when Quantity is greater than one', () =>
    Effect.gen(function* appliesFixedOnce() {
      const fixed = lineCandidate({
        audience: { counterpartyRef, kind: 'COUNTERPARTY' },
        discountId: '18181818-1818-4181-8181-181818181818',
        effectKind: 'FIXED_MONETARY_AMOUNT',
        layer: 'COUNTERPARTY_CONTRACTUAL',
        level: '25',
        quantity: '7',
        revisionId: '19191919-1919-4191-8191-191919191919',
      });
      const result = yield* composePricingDiscounts(requestFor([fixed], '7'));

      expect(result).toMatchObject({
        lineContributions: [
          {
            amount: { amount: '-25', currencyCode: 'CZK' },
            applicationCount: 'ONCE_PER_STABLE_LINE',
          },
        ],
        outcome: 'DISCOUNT_COMPOSITION_READY',
      });
    }),
  );

  it.effect('applies the same Discount Revision independently to two distinct stable occurrences', () =>
    Effect.gen(function* preservesOccurrenceCardinality() {
      const secondOccurrenceId = 'pricing-line:issue-772-second';
      const secondOccurrenceCandidate = { ...catalogCandidate, occurrenceId: secondOccurrenceId };
      const result = yield* composePricingDiscounts(
        requestFor([catalogCandidate, secondOccurrenceCandidate], '1', [occurrenceId, secondOccurrenceId]),
      );

      expect(result).toMatchObject({ outcome: 'DISCOUNT_COMPOSITION_READY' });
      if (result.outcome !== 'DISCOUNT_COMPOSITION_READY') {
        throw new Error('one Revision on distinct stable occurrences must not conflict');
      }
      expect(result.lineContributions.map(({ amount }) => amount.amount)).toEqual(['-100', '-100']);
      expect(result.lineContributions.map(({ basis }) => basis.occurrenceId)).toEqual([
        occurrenceId,
        secondOccurrenceId,
      ]);
      expect(result.lineContributions.map(({ candidate }) => candidate.definition.revision.revisionId)).toEqual([
        catalogCandidate.definition.revision.revisionId,
        catalogCandidate.definition.revision.revisionId,
      ]);
    }),
  );

  it.effect('keeps a literal duplicate on the same stable occurrence as a typed layer conflict', () =>
    Effect.gen(function* preservesSamePathConflict() {
      const result = yield* composePricingDiscounts(requestFor([catalogCandidate, catalogCandidate]));

      expect(result).toMatchObject({
        conflict: {
          conflictKind: 'DISCOUNT_LAYER_CARDINALITY',
          path: { kind: 'VARIANT_LINE_LAYER', layer: 'CATALOG', occurrenceId },
        },
        outcome: 'DISCOUNT_CARDINALITY_CONFLICT',
      });
      if (result.outcome !== 'DISCOUNT_CARDINALITY_CONFLICT') {
        throw new Error('same-path duplicate evidence must not produce a ready winner');
      }
      expect(result.conflict.claimants).toHaveLength(2);
      expect(result.conflict.claimants[0]).toEqual(result.conflict.claimants[1]);
    }),
  );

  it.effect(
    'returns one typed 0..1 layer conflict without selecting a winner by ID, effect kind, or source order',
    () =>
      Effect.gen(function* rejectsCompetingFacts() {
        const competingFixed = lineCandidate({
          audience: { kind: 'CATALOG_PATH', selection },
          discountId: '20202020-2020-4202-8202-202020202020',
          effectKind: 'FIXED_MONETARY_AMOUNT',
          layer: 'CATALOG',
          level: '40',
          revisionId: '21212121-2121-4212-8212-212121212121',
        });
        const result = yield* composePricingDiscounts(requestFor([competingFixed, catalogCandidate]));

        expect(result).toMatchObject({
          conflict: {
            conflictKind: 'DISCOUNT_LAYER_CARDINALITY',
            path: { kind: 'VARIANT_LINE_LAYER', layer: 'CATALOG', occurrenceId },
          },
          outcome: 'DISCOUNT_CARDINALITY_CONFLICT',
        });
        if (result.outcome !== 'DISCOUNT_CARDINALITY_CONFLICT') {
          throw new Error('fixture must produce a cardinality conflict');
        }
        expect(result.conflict.claimants.map(({ definition }) => definition.discountId)).toEqual([
          competingFixed.definition.discountId,
          catalogCandidate.definition.discountId,
        ]);
        expect('lineContributions' in result).toBe(false);

        const competingGroup = lineCandidate({
          audience: { kind: 'PRICE_GROUP', priceGroupRef },
          discountId: '23232323-2323-4232-8232-232323232323',
          effectKind: 'FIXED_MONETARY_AMOUNT',
          layer: 'PRICE_GROUP_CONTRACTUAL',
          level: '15',
          revisionId: '24242424-2424-4242-8242-242424242424',
        });
        const competingCounterparty = lineCandidate({
          audience: { counterpartyRef, kind: 'COUNTERPARTY' },
          discountId: '25252525-2525-4252-8252-252525252525',
          effectKind: 'FIXED_MONETARY_AMOUNT',
          layer: 'COUNTERPARTY_CONTRACTUAL',
          level: '20',
          revisionId: '26262626-2626-4262-8262-262626262626',
        });
        const competingWholeDefinition = {
          ...wholeCandidate.definition,
          discountId: '27272727-2727-4272-8272-272727272727',
          revision: {
            ...wholeCandidate.definition.revision,
            revisionId: '28282828-2828-4282-8282-282828282828',
          },
        };
        const competingWhole = {
          ...wholeCandidate,
          applicability: { ...wholeCandidate.applicability, definition: competingWholeDefinition },
          definition: competingWholeDefinition,
        };
        for (const [candidates, expectedPath] of [
          [
            [groupCandidate, competingGroup],
            { kind: 'VARIANT_LINE_LAYER', layer: 'PRICE_GROUP_CONTRACTUAL', occurrenceId },
          ],
          [
            [counterpartyCandidate, competingCounterparty],
            { kind: 'VARIANT_LINE_LAYER', layer: 'COUNTERPARTY_CONTRACTUAL', occurrenceId },
          ],
          [[wholeCandidate, competingWhole], { kind: 'WHOLE_PURCHASE_LAYER', layer: 'COUNTERPARTY_WHOLE_PURCHASE' }],
        ] as const) {
          const layerConflict = yield* composePricingDiscounts(requestFor(candidates));
          expect(layerConflict).toMatchObject({
            conflict: { conflictKind: 'DISCOUNT_LAYER_CARDINALITY', path: expectedPath },
            outcome: 'DISCOUNT_CARDINALITY_CONFLICT',
          });
        }
      }),
  );

  it('keeps Revision invariants distinct from layer cardinality conflicts', () => {
    const revisionInvariant = Schema.decodeSync(PricingDiscountCurrentResolutionSchema, {
      onExcessProperty: 'error',
    })({
      claimants: [
        { revision: 1, revisionId: catalogCandidate.definition.revision.revisionId },
        { revision: 1, revisionId: '22222222-3333-4333-8333-222222222222' },
      ],
      identityKey: catalogCandidate.definition.identityKey,
      observedAt: operationTime,
      outcome: 'DISCOUNT_REVISION_INVARIANT_VIOLATION',
      reason: 'DUPLICATE_REVISION_NUMBER',
    });
    expect(revisionInvariant.outcome).toBe('DISCOUNT_REVISION_INVARIANT_VIOLATION');
    expect(() =>
      decodeCandidate({
        ...catalogCandidate,
        ...revisionInvariant,
      }),
    ).toThrow();
  });

  it('rejects altered audience, identity, or owner evidence hidden behind reused Discount and Revision IDs', () => {
    const request = requestFor([counterpartyCandidate]);
    const resultForCandidate = (candidate: PricingDiscountCompositionCandidate) => ({
      lineContributions: [
        {
          amount: { amount: '-30', currencyCode: 'CZK' },
          applicationCount: 'ONCE_PER_STABLE_LINE',
          basis: request.lineBases[0],
          candidate,
          contributionDirection: 'NON_POSITIVE_REDUCTION',
        },
      ],
      outcome: 'DISCOUNT_COMPOSITION_READY',
      request,
    });
    const alteredOwnerEvidence = {
      ...counterpartyCandidate,
      audienceBinding: {
        ...counterpartyCandidate.audienceBinding,
        evidence: {
          ...counterpartyCandidate.audienceBinding.evidence,
          ownerRevision: 'party-registry:counterparty:replayed',
        },
      },
    };
    expect(() => decodeResult(resultForCandidate(decodeCandidate(alteredOwnerEvidence)))).toThrow();

    const otherCounterpartyRef = {
      ...counterpartyRef,
      resourceId: '29292929-2929-4292-8292-292929292929',
    };
    const alteredIdentityKey = {
      ...counterpartyCandidate.definition.identityKey,
      audience: { counterpartyRef: otherCounterpartyRef, kind: 'COUNTERPARTY' as const },
    };
    const alteredIdentity = {
      ...counterpartyCandidate,
      audienceBinding: {
        ...counterpartyCandidate.audienceBinding,
        evidence: {
          ...counterpartyCandidate.audienceBinding.evidence,
          audience: alteredIdentityKey.audience,
        },
        identityKey: alteredIdentityKey,
      },
      definition: { ...counterpartyCandidate.definition, identityKey: alteredIdentityKey },
    };
    expect(() => decodeResult(resultForCandidate(decodeCandidate(alteredIdentity)))).toThrow();
  });

  it('rejects whole-purchase proof replay across another exact Decision, occurrence set, or eligible basis', () => {
    const request = requestFor([wholeCandidate]);
    expect(request.wholePurchaseBasis).toEqual(wholeCandidate.applicability.basis);

    expect(() =>
      decodeRequest({
        ...request,
        wholePurchaseBasis: { ...wholeCandidate.applicability.basis, eligibleAmount: '821' },
      }),
    ).toThrow();

    const replayedOccurrenceId = 'pricing-line:issue-772-replayed';
    expect(() =>
      decodeRequest({
        ...request,
        decision: decisionFor('1', 'CZK', [replayedOccurrenceId]),
        lineBases: [{ ...request.lineBases[0], occurrenceId: replayedOccurrenceId }],
      }),
    ).toThrow();
  });

  it.effect(
    'preserves original occurrences, Discount revisions, and owner evidence without replacing Group by Counterparty',
    () =>
      Effect.gen(function* preservesEvidence() {
        const request = requestFor([groupCandidate, counterpartyCandidate]);
        const result = yield* composePricingDiscounts(request);
        if (result.outcome !== 'DISCOUNT_COMPOSITION_READY') {
          throw new Error('fixture must compose without a cardinality conflict');
        }

        expect(result.request.decision.lines).toEqual(request.decision.lines);
        expect(result.lineContributions.map(({ basis }) => basis.occurrenceId)).toEqual([occurrenceId, occurrenceId]);
        expect(result.lineContributions.map(({ candidate }) => candidate)).toEqual([
          request.candidates[0],
          request.candidates[1],
        ]);
        expect(result.lineContributions.map(({ candidate }) => candidate.layer)).toEqual([
          'PRICE_GROUP_CONTRACTUAL',
          'COUNTERPARTY_CONTRACTUAL',
        ]);
      }),
  );

  it.effect('rejects Storefront/FX inputs and cannot activate generalized EUR facts from Launch CZK support', () =>
    Effect.gen(function* preservesCurrencyBoundary() {
      expect(
        (yield* Schema.decodeEffect(PricingDiscountIdentityKeySchema, { onExcessProperty: 'error' })({
          ...catalogCandidate.definition.identityKey,
          currencyCode: 'EUR',
        })).currencyCode,
      ).toBe('EUR');

      expect(() => decodeRequest({ ...requestFor([catalogCandidate]), storefrontId: 'prague-shop' })).toThrow();
      expect(() => decodeRequest({ ...requestFor([catalogCandidate]), exchangeRate: '25' })).toThrow();

      const request = requestFor([catalogCandidate]);
      // SAFETY: This intentionally violates the decoded request currency invariant to exercise the runtime fail-closed guard.
      const unsupportedEurRequest = {
        ...request,
        decision: { ...request.decision, currencyCode: 'EUR' },
      } as typeof request;
      const rejected = yield* Effect.flip(composePricingDiscounts(unsupportedEurRequest));
      expect(rejected).toBeInstanceOf(PricingDiscountCompositionRejected);
      expect(rejected).toMatchObject({ code: 'COMPOSITION_REQUEST_INVALID' });
    }),
  );
});
