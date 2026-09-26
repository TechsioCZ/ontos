/* oxlint-disable anti-slop/no-conditional-empty-object-spread, anti-slop/no-unsafe-dictionary-type, effect-native/no-manual-tag-comparison -- Focused fixtures assert exact discriminated outcomes and sparse schema overrides; tracked in: #333; remove-when: fixture builders are generated from the quantity contract. */
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import {
  CurrentCommerceQuantityAssignmentSchema,
  CurrentCommerceQuantityPolicySetSchema,
} from '../../shared/domain/customer-commerce-policy-administration.ts';
import {
  CurrentCommerceQuantityCatalogLineSchema,
  unavailableCommerceQuantityCatalogPort,
} from '../../shared/domain/commerce-quantity-catalog-port.ts';
import { unavailableCommerceQuantityPolicyPort } from '../../shared/domain/commerce-quantity-policy-port.ts';
import {
  CommerceQuantityResolutionOutcomeSchema,
  CommerceQuantityResolutionRequestSchema,
  resolveCommerceQuantity,
} from '../../shared/domain/commerce-quantity-resolution.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const sellingLegalEntityId = '22222222-2222-4222-8222-222222222222';
const observedAt = '2026-09-21T10:00:00.000Z';
const profileRef = {
  moduleId: 'commerce.customer-context' as const,
  resourceId: 'retail-profile-1',
  resourceType: 'commerce.customer-context.retail-customer-profile' as const,
  tenantId,
};
const productRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '50000000-0000-4000-8000-000000000001',
  resourceType: 'commerce.catalog.product' as const,
  tenantId,
};
const variantRef = (resourceId: string) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType: 'commerce.catalog.variant' as const,
  tenantId,
});
const basis = {
  targetDivisibilityRevision: 7,
  targetRef: {
    moduleId: 'commerce.catalog' as const,
    resourceId: '50000000-0000-4000-8000-000000000002',
    resourceType: 'commerce.catalog.variant' as const,
    tenantId,
  },
  unitRef: {
    moduleId: 'commerce.catalog' as const,
    resourceId: '50000000-0000-4000-8000-000000000003',
    resourceType: 'commerce.catalog.product-unit' as const,
    tenantId,
  },
  unitRuleRevision: 9,
};
const completeness = (ownerRevision: string, nextApplicabilityBoundary?: string) => ({
  ...(nextApplicabilityBoundary === undefined ? {} : { nextApplicabilityBoundary }),
  observedAt,
  ownerRevision,
  scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: `${ownerRevision}:current` },
});

const request = Schema.decodeUnknownSync(CommerceQuantityResolutionRequestSchema)({
  at: observedAt,
  lines: [
    {
      lineId: 'line-1',
      requestedQuantity: '5',
      selection: {
        productRef,
        variantRef: variantRef('50000000-0000-4000-8000-000000000002'),
      },
    },
  ],
  purchasingContext: {
    channelId: 'web',
    commerceMarketId: 'cz',
    sellingLegalEntityId,
    storefrontId: 'main',
    tenantId,
  },
  subject: { kind: 'GUEST' },
});

const catalogLine = (overrides: Record<string, unknown> = {}) =>
  Schema.decodeUnknownSync(CurrentCommerceQuantityCatalogLineSchema)({
    lineId: 'line-1',
    selection: {
      basis,
      catalogSelection: request.lines[0]?.selection,
      completeness: completeness('catalog:12'),
      divisible: true,
      equivalentSelectionKey: 'selection-equivalence:1',
      hierarchyRevision: 'hierarchy:4',
      normalizedQuantity: '5',
      ownerRevision: 'selection:12',
      physicalMultiple: '1',
      requestedQuantity: '5',
      ...overrides,
    },
  });

const uuids = [
  '30000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000003',
  '30000000-0000-4000-8000-000000000004',
  '30000000-0000-4000-8000-000000000005',
] as const;
const assignmentIds = {
  broken: '40000000-0000-4000-8000-000000000002',
  primary: '40000000-0000-4000-8000-000000000001',
} as const;

const rule = (
  policyRevisionId: string,
  input: {
    readonly constraintMode?: 'NON_RELAXABLE_CONSTRAINT' | 'REPLACEABLE_ENVELOPE';
    readonly envelope?:
      | { readonly kind: 'NO_COMMERCIAL_QUANTITY_RESTRICTION' }
      | {
          readonly kind: 'BOUNDED';
          readonly maximum: null | string;
          readonly minimum: null | string;
          readonly multiple: null | string;
        };
    readonly scopeKind?: 'CHANNEL_SELLER' | 'MARKET_CHANNEL_SELLER' | 'STOREFRONT_MARKET_CHANNEL_SELLER';
    readonly selector?:
      | { readonly kind: 'ALL' }
      | { readonly kind: 'PRODUCT'; readonly productRef: typeof productRef }
      | { readonly kind: 'VARIANT'; readonly variantRef: ReturnType<typeof variantRef> };
  } = {},
) => {
  const scopeKind = input.scopeKind ?? 'MARKET_CHANNEL_SELLER';
  return {
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
    policyRevisionId,
    scope: {
      channelId: 'web',
      ...(scopeKind === 'CHANNEL_SELLER' ? {} : { commerceMarketId: 'cz' }),
      kind: scopeKind,
      sellingLegalEntityId,
      ...(scopeKind === 'STOREFRONT_MARKET_CHANNEL_SELLER' ? { storefrontId: 'main' } : {}),
    },
    value: {
      basis,
      constraintMode: input.constraintMode ?? 'REPLACEABLE_ENVELOPE',
      envelope: input.envelope ?? { kind: 'NO_COMMERCIAL_QUANTITY_RESTRICTION' },
      kind: 'COMMERCE_QUANTITY_RULE',
      selector: input.selector ?? { kind: 'ALL' },
    },
  };
};

const assignment = (assignmentId: string, policyRevisionId: string) =>
  Schema.decodeUnknownSync(CurrentCommerceQuantityAssignmentSchema)({
    assignmentId,
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
    profile: { kind: 'RETAIL', profileRef },
    ruleRevisionRef: {
      moduleId: 'commerce.customer-context',
      resourceId: policyRevisionId,
      resourceType: 'commerce.customer-context.commerce-quantity-rule',
      tenantId,
    },
    sellingLegalEntityId,
  });

const policy = (candidates: readonly unknown[], assignments: readonly unknown[] = []) =>
  Schema.decodeUnknownSync(CurrentCommerceQuantityPolicySetSchema)({
    assignmentSet: { assignments, completeness: completeness('assignments:3') },
    ruleSet: { candidates, completeness: completeness('rules:9') },
  });

const resolve = (
  candidates: readonly unknown[],
  options: {
    readonly assignments?: readonly unknown[];
    readonly catalogLines?: readonly ReturnType<typeof catalogLine>[];
    readonly resolutionRequest?: typeof request;
  } = {},
) =>
  resolveCommerceQuantity({
    catalogLines: options.catalogLines ?? [catalogLine()],
    policy: policy(candidates, options.assignments),
    request: options.resolutionRequest ?? request,
  });

describe('Commerce Quantity resolution', () => {
  it('selects Catalog specificity before a concrete-profile ALL assignment', () => {
    const productRule = rule(uuids[0], { selector: { kind: 'PRODUCT', productRef } });
    const assignedAll = rule(uuids[1]);
    const profileRequest = Schema.decodeUnknownSync(CommerceQuantityResolutionRequestSchema)({
      ...request,
      subject: { kind: 'RETAIL', profileRef },
    });
    const outcome = resolve([productRule, assignedAll], {
      assignments: [assignment(assignmentIds.primary, uuids[1])],
      resolutionRequest: profileRequest,
    });

    expect(outcome._tag).toBe('COMMERCE_QUANTITY_PERMITTED');
    if (outcome._tag === 'COMMERCE_QUANTITY_PERMITTED') {
      expect(outcome.lines[0]?.winningRuleRevisionId).toBe(uuids[0]);
    }
  });

  it('selects a same-specificity profile exception before a shared envelope and before commercial scope', () => {
    const assignedProduct = rule(uuids[0], {
      scopeKind: 'CHANNEL_SELLER',
      selector: { kind: 'PRODUCT', productRef },
    });
    const sharedProduct = rule(uuids[1], {
      scopeKind: 'STOREFRONT_MARKET_CHANNEL_SELLER',
      selector: { kind: 'PRODUCT', productRef },
    });
    const profileRequest = Schema.decodeUnknownSync(CommerceQuantityResolutionRequestSchema)({
      ...request,
      subject: { kind: 'RETAIL', profileRef },
    });
    const outcome = resolve([sharedProduct, assignedProduct], {
      assignments: [assignment(assignmentIds.primary, uuids[0])],
      resolutionRequest: profileRequest,
    });

    expect(outcome._tag).toBe('COMMERCE_QUANTITY_PERMITTED');
    if (outcome._tag === 'COMMERCE_QUANTITY_PERMITTED') {
      expect(outcome.lines[0]?.winningRuleRevisionId).toBe(uuids[0]);
    }
  });

  it('reports a same-rank replacement conflict instead of merging envelopes', () => {
    const outcome = resolve([
      rule(uuids[0], { selector: { kind: 'PRODUCT', productRef } }),
      rule(uuids[1], { selector: { kind: 'PRODUCT', productRef } }),
    ]);
    expect(outcome).toMatchObject({
      _tag: 'INCONSISTENT_COMMERCE_QUANTITY_POLICY',
      ruleRevisionIds: [uuids[0], uuids[1]],
    });
  });

  it('fails a profile on an assignment whose immutable rule revision is absent', () => {
    const profileRequest = Schema.decodeUnknownSync(CommerceQuantityResolutionRequestSchema)({
      ...request,
      subject: { kind: 'RETAIL', profileRef },
    });
    const outcome = resolve([rule(uuids[0])], {
      assignments: [assignment(assignmentIds.broken, uuids[1])],
      resolutionRequest: profileRequest,
    });
    expect(outcome).toMatchObject({
      _tag: 'BROKEN_COMMERCE_QUANTITY_ASSIGNMENT',
      assignmentId: assignmentIds.broken,
      ruleRevisionId: uuids[1],
    });
  });

  it('keeps assigned rules out of Guest resolution', () => {
    const assignedOnly = rule(uuids[0], {
      envelope: { kind: 'BOUNDED', maximum: null, minimum: '10', multiple: null },
      selector: { kind: 'PRODUCT', productRef },
    });
    const shared = rule(uuids[1], { selector: { kind: 'PRODUCT', productRef } });
    const outcome = resolve([assignedOnly, shared], {
      assignments: [assignment(assignmentIds.primary, uuids[0])],
    });
    expect(outcome._tag).toBe('COMMERCE_QUANTITY_PERMITTED');
    if (outcome._tag === 'COMMERCE_QUANTITY_PERMITTED') {
      expect(outcome.lines[0]?.winningRuleRevisionId).toBe(uuids[1]);
    }
  });

  it('applies the whole winning envelope and every non-relaxable constraint conjunctively', () => {
    const outcome = resolve([
      rule(uuids[0], {
        envelope: { kind: 'BOUNDED', maximum: '20', minimum: '1', multiple: '5' },
        selector: { kind: 'PRODUCT', productRef },
      }),
      rule(uuids[1], {
        constraintMode: 'NON_RELAXABLE_CONSTRAINT',
        envelope: { kind: 'BOUNDED', maximum: '8', minimum: null, multiple: null },
        selector: { kind: 'PRODUCT', productRef },
      }),
    ]);
    expect(outcome._tag).toBe('COMMERCE_QUANTITY_PERMITTED');

    const multipleSeven = resolve(
      [
        rule(uuids[0], {
          envelope: { kind: 'BOUNDED', maximum: '20', minimum: '1', multiple: '5' },
          selector: { kind: 'PRODUCT', productRef },
        }),
      ],
      {
        catalogLines: [catalogLine({ normalizedQuantity: '7', requestedQuantity: '7' })],
        resolutionRequest: Schema.decodeUnknownSync(CommerceQuantityResolutionRequestSchema)({
          ...request,
          lines: [{ ...request.lines[0], requestedQuantity: '7' }],
        }),
      },
    );
    expect(multipleSeven).toMatchObject({ _tag: 'COMMERCE_QUANTITY_REJECTED', limit: '5', reason: 'NOT_MULTIPLE' });
  });

  it('aggregates split rows only for the exact equivalent Catalog Selection', () => {
    const minimumTen = rule(uuids[0], {
      envelope: { kind: 'BOUNDED', maximum: null, minimum: '10', multiple: null },
      selector: { kind: 'PRODUCT', productRef },
    });
    const secondRequestLine = {
      lineId: 'line-2',
      requestedQuantity: '4',
      selection: request.lines[0]?.selection,
    };
    const twoLineRequest = Schema.decodeUnknownSync(CommerceQuantityResolutionRequestSchema)({
      ...request,
      lines: [{ ...request.lines[0], requestedQuantity: '4' }, secondRequestLine],
    });
    const outcome = resolve([minimumTen], {
      catalogLines: [
        catalogLine({ normalizedQuantity: '4', requestedQuantity: '4' }),
        Schema.decodeUnknownSync(CurrentCommerceQuantityCatalogLineSchema)({
          lineId: 'line-2',
          selection: {
            ...catalogLine({ normalizedQuantity: '4', requestedQuantity: '4' }).selection,
          },
        }),
      ],
      resolutionRequest: twoLineRequest,
    });
    expect(outcome).toMatchObject({
      _tag: 'COMMERCE_QUANTITY_REJECTED',
      actualQuantity: '8',
      reason: 'BELOW_MINIMUM',
    });
  });

  it('does not pool different Variants, configurations, or set constituents', () => {
    const firstVariant = variantRef('50000000-0000-4000-8000-000000000004');
    const secondVariant = variantRef('50000000-0000-4000-8000-000000000005');
    const variantOneRule = rule(uuids[0], {
      envelope: { kind: 'BOUNDED', maximum: null, minimum: '5', multiple: null },
      selector: { kind: 'VARIANT', variantRef: firstVariant },
    });
    const variantTwoRule = rule(uuids[1], {
      envelope: { kind: 'BOUNDED', maximum: null, minimum: '5', multiple: null },
      selector: { kind: 'VARIANT', variantRef: secondVariant },
    });
    const secondRequestLine = {
      lineId: 'line-2',
      requestedQuantity: '4',
      selection: { productRef, variantRef: secondVariant },
    };
    const twoLineRequest = Schema.decodeUnknownSync(CommerceQuantityResolutionRequestSchema)({
      ...request,
      lines: [
        { ...request.lines[0], requestedQuantity: '4', selection: { productRef, variantRef: firstVariant } },
        secondRequestLine,
      ],
    });
    const outcome = resolve([variantOneRule, variantTwoRule], {
      catalogLines: [
        catalogLine({
          catalogSelection: { productRef, variantRef: firstVariant },
          equivalentSelectionKey: 'variant-1:configuration-1',
          normalizedQuantity: '4',
          requestedQuantity: '4',
        }),
        Schema.decodeUnknownSync(CurrentCommerceQuantityCatalogLineSchema)({
          lineId: 'line-2',
          selection: {
            ...catalogLine({
              catalogSelection: { productRef, variantRef: secondVariant },
              equivalentSelectionKey: 'variant-2:configuration-2',
              normalizedQuantity: '4',
              requestedQuantity: '4',
            }).selection,
          },
        }),
      ],
      resolutionRequest: twoLineRequest,
    });
    expect(outcome).toMatchObject({ _tag: 'COMMERCE_QUANTITY_REJECTED', actualQuantity: '4', reason: 'BELOW_MINIMUM' });
  });

  it('rejects normalization changes instead of silently rounding requested Quantity', () => {
    const outcome = resolve([rule(uuids[0])], {
      catalogLines: [catalogLine({ normalizedQuantity: '10', requestedQuantity: '7' })],
      resolutionRequest: Schema.decodeUnknownSync(CommerceQuantityResolutionRequestSchema)({
        ...request,
        lines: [{ ...request.lines[0], requestedQuantity: '7' }],
      }),
    });
    expect(outcome).toMatchObject({
      _tag: 'COMMERCE_QUANTITY_REJECTED',
      actualQuantity: '7',
      limit: '10',
      reason: 'NORMALIZATION_REQUIRED',
    });
  });

  it('fails closed on stale Catalog or incomplete policy evidence', () => {
    const staleCatalog = resolve([rule(uuids[0])], {
      catalogLines: [
        catalogLine({
          completeness: {
            ...completeness('catalog:old'),
            nextApplicabilityBoundary: '2026-09-21T09:00:00.000Z',
            observedAt: '2026-09-21T08:00:00.000Z',
          },
        }),
      ],
    });
    expect(staleCatalog).toEqual({
      _tag: 'COMMERCE_QUANTITY_POLICY_UNVERIFIABLE',
      reason: 'CATALOG_EVIDENCE_STALE',
    });

    const stalePolicy = resolveCommerceQuantity({
      catalogLines: [catalogLine()],
      policy: Schema.decodeUnknownSync(CurrentCommerceQuantityPolicySetSchema)({
        assignmentSet: {
          assignments: [],
          completeness: {
            ...completeness('assignments:old'),
            nextApplicabilityBoundary: '2026-09-21T09:00:00.000Z',
            observedAt: '2026-09-21T08:00:00.000Z',
          },
        },
        ruleSet: { candidates: [rule(uuids[0])], completeness: completeness('rules:9') },
      }),
      request,
    });
    expect(stalePolicy).toEqual({
      _tag: 'COMMERCE_QUANTITY_POLICY_UNVERIFIABLE',
      reason: 'POLICY_EVIDENCE_STALE',
    });
  });

  it('retains a complete accepted decision snapshot without Current-rule recomputation', () => {
    const accepted = resolve([rule(uuids[0], { selector: { kind: 'PRODUCT', productRef } })]);
    expect(Schema.is(CommerceQuantityResolutionOutcomeSchema)(accepted)).toBe(true);
    const changedCurrent = resolve([
      rule(uuids[1], {
        envelope: { kind: 'BOUNDED', maximum: '1', minimum: null, multiple: null },
        selector: { kind: 'PRODUCT', productRef },
      }),
    ]);
    expect(changedCurrent._tag).toBe('COMMERCE_QUANTITY_REJECTED');
    expect(accepted._tag).toBe('COMMERCE_QUANTITY_PERMITTED');
    if (accepted._tag === 'COMMERCE_QUANTITY_PERMITTED') {
      expect(accepted.lines[0]?.winningRuleRevisionId).toBe(uuids[0]);
      expect(accepted.lines[0]?.catalogOwnerRevision).toBe('selection:12');
      expect(accepted.ruleCompleteness.ownerRevision).toBe('rules:9');
    }
  });

  it.effect('keeps production fail-closed while Catalog and policy owner adapters are unavailable', () =>
    Effect.gen(function* failClosed() {
      const catalogFailure = yield* unavailableCommerceQuantityCatalogPort()
        .resolveCurrentSelections({ lines: request.lines, observedAt, tenantId })
        .pipe(Effect.flip);
      const policyFailure = yield* unavailableCommerceQuantityPolicyPort().readCurrent(observedAt).pipe(Effect.flip);
      expect(catalogFailure._tag).toBe('CommerceQuantityCatalogUnavailable');
      expect(policyFailure._tag).toBe('CommerceQuantityPolicyUnavailable');
    }),
  );

  it('rejects caller-authored monetary quantity and unsupported selector fields at schema boundaries', () => {
    expect(() =>
      // The governed read runtime decodes read input closed (core-runtime `reads/runtime.ts`).
      Schema.decodeUnknownSync(CommerceQuantityResolutionRequestSchema, { onExcessProperty: 'error' })({
        ...request,
        lines: [{ ...request.lines[0], monetaryAmount: '100.00' }],
      }),
    ).toThrow();
  });
});
