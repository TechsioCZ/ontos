import { expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import { AssortmentOwnerResourceRefSchema } from '../../shared/domain/decision-contracts.ts';
import {
  AssortmentBoundaryResolutionInputSchema,
  resolveAssortmentBoundary,
} from '../../shared/domain/boundary-resolution.ts';

const tenantId = '018f8b4e-35a2-7b51-8d56-91a4f37d6a11';
const otherTenantId = '018f8b4e-35a2-7b51-8d56-91a4f37d6a22';
const operationTime = '2026-09-22T10:00:00.000Z';

const ref = (moduleId: string, resourceType: string, resourceId: string, nextTenantId = tenantId) =>
  Schema.decodeUnknownSync(AssortmentOwnerResourceRefSchema)({
    moduleId,
    resourceId,
    resourceType,
    tenantId: nextTenantId,
  });

const productRef = ref('catalog.owner', 'catalog.product', 'product-1');
const categoryRef = (resourceId: string) => ref('catalog.owner', 'catalog.category', resourceId);
const profileRef = ref('commerce.customer-context', 'commerce.customer-context.retail-customer-profile', 'profile-1');
const subject = { kind: 'RETAIL_CUSTOMER_PROFILE' as const, profileRef };
interface ContextFixture {
  channelRef: ReturnType<typeof ref>;
  commerceMarketRef?: ReturnType<typeof ref>;
  operationTime: string;
  sellingLegalEntityRef: ReturnType<typeof ref>;
  storefrontRef?: ReturnType<typeof ref>;
  tenantId: string;
}
interface CommercialScopeFixture {
  channelRef: ReturnType<typeof ref>;
  commerceMarketRef?: ReturnType<typeof ref>;
  sellingLegalEntityRef: ReturnType<typeof ref>;
  storefrontRef?: ReturnType<typeof ref>;
}
const context: ContextFixture = {
  channelRef: ref('commerce.channel', 'commerce.channel', 'web'),
  operationTime,
  sellingLegalEntityRef: ref('commerce.legal-entity', 'commerce.legal-entity', 'sle-1'),
  tenantId,
};
const completeness = {
  predicate: 'all current applicable Closed Boundaries for the exact subject and scope',
  proof: {
    evidenceRef: ref('commerce.assortment', 'commerce.assortment.collection-proof', 'proof-1'),
    ownerModuleId: 'commerce.assortment',
  },
  scope: 'commerce.assortment.closed-assortment-boundary',
  state: 'COMPLETE' as const,
};
interface BoundaryCompletenessFixture {
  evidence: typeof completeness;
  scope: {
    commercialScope: CommercialScopeFixture;
    decisionPurpose: 'PURCHASE' | 'VISIBILITY';
    kind: 'APPLICABLE_CLOSED_BOUNDARIES';
    operationTime: string;
    subject: typeof subject;
    tenantId: string;
  };
}
const boundaryCompleteness: BoundaryCompletenessFixture = {
  evidence: completeness,
  scope: {
    commercialScope: {
      channelRef: context.channelRef,
      sellingLegalEntityRef: context.sellingLegalEntityRef,
    },
    decisionPurpose: 'VISIBILITY',
    kind: 'APPLICABLE_CLOSED_BOUNDARIES',
    operationTime,
    subject,
    tenantId,
  },
};
const categoryCompleteness = {
  predicate: 'all current classifications and ancestry for the exact product',
  proof: {
    evidenceRef: ref('catalog.owner', 'catalog.category-classification-proof', 'category-proof-1'),
    ownerModuleId: 'catalog.owner',
  },
  scope: 'catalog.category-classification',
  state: 'COMPLETE' as const,
};
const categoryClassification = (
  classifications: readonly ReturnType<typeof categoryRef>[],
  state: 'COMPLETE' | 'STALE' | 'UNVERIFIABLE' = 'COMPLETE',
) => ({
  ancestries: [],
  classifications,
  completeness: { ...categoryCompleteness, state },
  currentness: [],
  productRef,
});

type BoundaryFixtureOverrides = Partial<{
  admissionSet: readonly unknown[];
  boundaryRef: ReturnType<typeof ref>;
  commercialScope: {
    channelRef: ReturnType<typeof ref>;
    commerceMarketRef?: ReturnType<typeof ref>;
    sellingLegalEntityRef: ReturnType<typeof ref>;
    storefrontRef?: ReturnType<typeof ref>;
  };
  decisionPurpose: 'PURCHASE' | 'VISIBILITY';
  effectiveFrom: string;
  effectiveTo: string;
  subject: typeof subject;
}>;

const boundary = (overrides: BoundaryFixtureOverrides = {}) => ({
  admissionSet: [{ kind: 'PRODUCT', productRef }],
  boundaryRef: ref('commerce.assortment', 'commerce.assortment.closed-assortment-boundary', 'boundary-default'),
  commercialScope: {
    channelRef: context.channelRef,
    sellingLegalEntityRef: context.sellingLegalEntityRef,
  },
  decisionPurpose: 'VISIBILITY',
  effectiveFrom: '2026-09-01T00:00:00.000Z',
  subject,
  ...overrides,
});

type InputOverrides = Partial<{
  categoryClassification: unknown;
  completeness: Omit<BoundaryCompletenessFixture, 'evidence'> & {
    evidence: Omit<typeof completeness, 'state'> & { state: 'COMPLETE' | 'STALE' | 'UNVERIFIABLE' };
  };
  decisionPurpose: 'PURCHASE' | 'VISIBILITY';
  subject: typeof subject;
  target: unknown;
  trustedContext: typeof context & {
    commerceMarketRef?: ReturnType<typeof ref>;
    storefrontRef?: ReturnType<typeof ref>;
  };
}>;

const input = (boundaries: readonly unknown[], overrides: InputOverrides = {}) =>
  (() => {
    const decisionPurpose = overrides.decisionPurpose ?? 'VISIBILITY';
    const trustedContext = overrides.trustedContext ?? context;
    const commercialScopeForContext: CommercialScopeFixture = {
      channelRef: trustedContext.channelRef,
      sellingLegalEntityRef: trustedContext.sellingLegalEntityRef,
    };
    if (trustedContext.commerceMarketRef !== undefined) {
      commercialScopeForContext.commerceMarketRef = trustedContext.commerceMarketRef;
    }
    if (trustedContext.storefrontRef !== undefined) {
      commercialScopeForContext.storefrontRef = trustedContext.storefrontRef;
    }
    const completenessForContext = overrides.completeness ?? {
      ...boundaryCompleteness,
      scope: {
        ...boundaryCompleteness.scope,
        commercialScope: commercialScopeForContext,
        decisionPurpose,
        operationTime: trustedContext.operationTime,
      },
    };
    return Schema.decodeUnknownSync(AssortmentBoundaryResolutionInputSchema)({
      boundaries,
      completeness: completenessForContext,
      decisionPurpose,
      subject,
      target: { kind: 'PRODUCT', productRef },
      tenantId,
      trustedContext,
      ...overrides,
    });
  })();

it('returns an authoritative no-Boundary path only with complete evidence', () => {
  expect(resolveAssortmentBoundary(input([]))).toMatchObject({ kind: 'NO_APPLICABLE_BOUNDARY' });
  expect(
    resolveAssortmentBoundary(
      input([], {
        completeness: { ...boundaryCompleteness, evidence: { ...completeness, state: 'UNVERIFIABLE' } },
      }),
    ),
  ).toEqual({
    kind: 'INDETERMINATE',
    reason: 'BOUNDARY_SET_INCOMPLETE',
  });
});

it('selects one strictly narrower Market scope and evaluates its complete Admission Set', () => {
  const market = ref('commerce.market', 'commerce.market', 'cz');
  const broad = boundary({ admissionSet: [] });
  const narrow = boundary({
    admissionSet: [{ kind: 'PRODUCT', productRef }],
    boundaryRef: ref('commerce.assortment', 'commerce.assortment.closed-assortment-boundary', 'narrow'),
    commercialScope: { ...broad.commercialScope, commerceMarketRef: market },
  });
  const result = resolveAssortmentBoundary(
    input([broad, narrow], { trustedContext: { ...context, commerceMarketRef: market } }),
  );
  expect(result).toMatchObject({ admitted: true, kind: 'UNIQUE_MAXIMAL_BOUNDARY' });
  if (result.kind === 'UNIQUE_MAXIMAL_BOUNDARY') {
    expect(result.boundary.boundaryRef.resourceId).toBe('narrow');
  }
});

it('returns exclusion for an admitted aggregate whose complete set does not cover the target', () => {
  const result = resolveAssortmentBoundary(input([boundary({ admissionSet: [] })]));
  expect(result).toMatchObject({ admitted: false, kind: 'UNIQUE_MAXIMAL_BOUNDARY' });
});

it('fails closed for equal and incomparable maximal scopes without technical tie-breaking', () => {
  const market = ref('commerce.market', 'commerce.market', 'cz');
  const storefront = ref('commerce.storefront', 'commerce.storefront', 'shop');
  const marketBoundary = boundary({
    boundaryRef: ref('commerce.assortment', 'commerce.assortment.closed-assortment-boundary', 'market'),
    commercialScope: {
      channelRef: context.channelRef,
      commerceMarketRef: market,
      sellingLegalEntityRef: context.sellingLegalEntityRef,
    },
  });
  const storefrontBoundary = boundary({
    boundaryRef: ref('commerce.assortment', 'commerce.assortment.closed-assortment-boundary', 'storefront'),
    commercialScope: {
      channelRef: context.channelRef,
      sellingLegalEntityRef: context.sellingLegalEntityRef,
      storefrontRef: storefront,
    },
  });
  const trustedContext = { ...context, commerceMarketRef: market, storefrontRef: storefront };
  const first = resolveAssortmentBoundary(input([marketBoundary, storefrontBoundary], { trustedContext }));
  const second = resolveAssortmentBoundary(input([storefrontBoundary, marketBoundary], { trustedContext }));
  expect(first).toMatchObject({ kind: 'BOUNDARY_CONFIGURATION_CONFLICT' });
  expect(second).toMatchObject({ kind: 'BOUNDARY_CONFIGURATION_CONFLICT' });
  if (first.kind === 'BOUNDARY_CONFIGURATION_CONFLICT' && second.kind === 'BOUNDARY_CONFIGURATION_CONFLICT') {
    expect(new Set(first.boundaries.map((item) => item.boundaryRef.resourceId))).toEqual(
      new Set(second.boundaries.map((item) => item.boundaryRef.resourceId)),
    );
  }

  const equalA = boundary({
    boundaryRef: ref('commerce.assortment', 'commerce.assortment.closed-assortment-boundary', 'equal-a'),
  });
  const equalB = boundary({
    boundaryRef: ref('commerce.assortment', 'commerce.assortment.closed-assortment-boundary', 'equal-b'),
  });
  expect(resolveAssortmentBoundary(input([equalA, equalB]))).toMatchObject({ kind: 'BOUNDARY_CONFIGURATION_CONFLICT' });
});

it('keeps purpose and target granularity separate and supports exact purchase admission', () => {
  const variantRef = ref('catalog.owner', 'catalog.variant', 'variant-1');
  const purchaseBoundary = boundary({
    admissionSet: [{ kind: 'VARIANT', variantRef }],
    boundaryRef: ref('commerce.assortment', 'commerce.assortment.closed-assortment-boundary', 'purchase'),
    decisionPurpose: 'PURCHASE',
  });
  const purchaseResult = resolveAssortmentBoundary(
    input([purchaseBoundary], {
      decisionPurpose: 'PURCHASE',
      target: {
        kind: 'CATALOG_SELECTION',
        selection: {
          configuration: { kind: 'NONE' },
          productRef,
          variantKind: 'ATOMIC',
          variantRef,
        },
      },
    }),
  );
  expect(purchaseResult).toMatchObject({ admitted: true, kind: 'UNIQUE_MAXIMAL_BOUNDARY' });
  expect(resolveAssortmentBoundary(input([purchaseBoundary], { decisionPurpose: 'PURCHASE' }))).toEqual({
    kind: 'INDETERMINATE',
    reason: 'PURPOSE_TARGET_MISMATCH',
  });
});

it('rejects cross-tenant input before evaluating Boundary state', () => {
  const foreignBoundary = boundary({
    boundaryRef: ref('commerce.assortment', 'commerce.assortment.closed-assortment-boundary', 'foreign', otherTenantId),
  });
  expect(resolveAssortmentBoundary(input([foreignBoundary]))).toEqual({
    kind: 'INDETERMINATE',
    reason: 'CROSS_TENANT_INPUT',
  });
});

it('uses complete Category classification input for Category admission', () => {
  const category = categoryRef('category-1');
  const categoryBoundary = boundary({ admissionSet: [{ categoryRef: category, kind: 'CATEGORY' }] });
  const result = resolveAssortmentBoundary(
    input([categoryBoundary], { categoryClassification: categoryClassification([category]) }),
  );
  expect(result).toMatchObject({ admitted: true, kind: 'UNIQUE_MAXIMAL_BOUNDARY' });
});

it('does not require Category evidence for expired or other-subject Category Boundaries', () => {
  const category = categoryRef('category-irrelevant');
  const expired = boundary({
    admissionSet: [{ categoryRef: category, kind: 'CATEGORY' }],
    effectiveTo: operationTime,
  });
  const otherSubject = {
    kind: 'RETAIL_CUSTOMER_PROFILE' as const,
    profileRef: ref('commerce.customer-context', 'commerce.customer-context.retail-customer-profile', 'profile-2'),
  };
  const otherSubjectBoundary = boundary({
    admissionSet: [{ categoryRef: category, kind: 'CATEGORY' }],
    subject: otherSubject,
  });
  expect(resolveAssortmentBoundary(input([expired]))).toMatchObject({ kind: 'NO_APPLICABLE_BOUNDARY' });
  expect(resolveAssortmentBoundary(input([otherSubjectBoundary]))).toMatchObject({ kind: 'NO_APPLICABLE_BOUNDARY' });
});

it('requires complete Category evidence for both positive and negative admission claims', () => {
  const category = categoryRef('category-1');
  const categoryBoundary = boundary({ admissionSet: [{ categoryRef: category, kind: 'CATEGORY' }] });
  expect(resolveAssortmentBoundary(input([categoryBoundary]))).toEqual({
    kind: 'INDETERMINATE',
    reason: 'CATEGORY_SET_INCOMPLETE',
  });

  const completeNegative = resolveAssortmentBoundary(
    input([categoryBoundary], { categoryClassification: categoryClassification([]) }),
  );
  expect(completeNegative).toMatchObject({ admitted: false, kind: 'UNIQUE_MAXIMAL_BOUNDARY' });

  expect(
    resolveAssortmentBoundary(
      input([categoryBoundary], { categoryClassification: categoryClassification([], 'UNVERIFIABLE') }),
    ),
  ).toEqual({ kind: 'INDETERMINATE', reason: 'CATEGORY_SET_INCOMPLETE' });
});

it('rejects a generic or mismatched Boundary completeness proof and checks proof tenant coherence', () => {
  expect(
    resolveAssortmentBoundary(
      input([], {
        completeness: {
          ...boundaryCompleteness,
          scope: { ...boundaryCompleteness.scope, decisionPurpose: 'PURCHASE' },
        },
      }),
    ),
  ).toEqual({ kind: 'INDETERMINATE', reason: 'BOUNDARY_SET_INCOMPLETE' });

  expect(
    resolveAssortmentBoundary(
      input([], {
        completeness: {
          ...boundaryCompleteness,
          evidence: {
            ...completeness,
            proof: {
              ...completeness.proof,
              evidenceRef: ref('commerce.assortment', 'commerce.assortment.collection-proof', 'foreign', otherTenantId),
            },
          },
        },
      }),
    ),
  ).toEqual({ kind: 'INDETERMINATE', reason: 'BOUNDARY_SET_INCOMPLETE' });
});

it('uses trusted Commerce operation time as the only lifecycle authority', () => {
  expect(
    resolveAssortmentBoundary(
      input([], {
        completeness: boundaryCompleteness,
        trustedContext: { ...context, operationTime: '2026-09-22T10:00:01.000Z' },
      }),
    ),
  ).toEqual({ kind: 'INDETERMINATE', reason: 'BOUNDARY_SET_INCOMPLETE' });
});

it('reports a maximal Boundary conflict before attempting Category admission', () => {
  const category = categoryRef('category-conflict');
  const first = boundary({
    admissionSet: [{ categoryRef: category, kind: 'CATEGORY' }],
    boundaryRef: ref('commerce.assortment', 'commerce.assortment.closed-assortment-boundary', 'category-conflict-a'),
  });
  const second = boundary({
    admissionSet: [{ categoryRef: category, kind: 'CATEGORY' }],
    boundaryRef: ref('commerce.assortment', 'commerce.assortment.closed-assortment-boundary', 'category-conflict-b'),
  });
  expect(resolveAssortmentBoundary(input([first, second]))).toMatchObject({
    kind: 'BOUNDARY_CONFIGURATION_CONFLICT',
  });
});
