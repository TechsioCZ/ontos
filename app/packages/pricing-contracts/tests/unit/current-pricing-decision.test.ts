import { Effect, Exit, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  CurrentPricingDecisionRequestSchema,
  CurrentPricingDecisionResponseSchema,
  projectCurrentPricingDecisionResponse,
} from '../../src/apis/current-pricing-decision.ts';
import type { CurrentPricingDecisionResponse } from '../../src/apis/current-pricing-decision.ts';
import {
  CurrentSupportedCurrenciesRequestSchema,
  PricingDecisionOutcomeKindSchema,
  executeCurrentPricingDecision,
  executeCurrentPricingDecisionWithAuthorization,
} from '../../src/index.ts';
import type { PricingDecisionOutcome } from '../../src/index.ts';
import { PricingCommercialTotalSafeProjectionSchema } from '../../src/domain/commercial-total.ts';

const tenantId = '22222222-2222-4222-8222-222222222222';
const otherTenantId = '11111111-1111-4111-8111-111111111111';
const productId = '33333333-3333-4333-8333-333333333333';
const variantId = '44444444-4444-4444-8444-444444444444';
const productUnitId = '55555555-5555-4555-8555-555555555555';

const catalogRef = (resourceId: string, resourceType: string) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId,
});

const productRef = catalogRef(productId, 'commerce.catalog.product');
const variantRef = catalogRef(variantId, 'commerce.catalog.variant');
const productUnitRef = catalogRef(productUnitId, 'commerce.catalog.product-unit');
const selection = { productRef, variantRef };

const guestSubject = {
  guestEvidenceRef: 'guest-evidence:41',
  guestSessionRef: 'guest-session:41',
  kind: 'GUEST' as const,
};

const retailSubject = (subjectTenantId: string) => ({
  authorizationSubject: { kind: 'RETAIL' as const },
  kind: 'PROFILE' as const,
  profileRef: {
    moduleId: 'commerce.customer-context' as const,
    resourceId: '77777777-7777-4777-8777-777777777777',
    resourceType: 'commerce.customer-context.retail-customer-profile' as const,
    tenantId: subjectTenantId,
  },
});

const decision = {
  commercialScope: {
    channelId: 'B2C',
    marketId: 'cz-launch',
    sellingLegalEntityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  },
  currencyCode: 'CZK',
  lines: [
    {
      catalog: {
        completeness: {
          observedAt: '2026-09-28T09:59:59.000Z',
          ownerRevision: 'catalog-quantity:17',
          scope: {
            kind: 'EXACT_PREDICATE' as const,
            predicateRef: 'catalog-quantity:exact-selection',
          },
        },
        divisible: false,
        equivalentSelectionKey: 'catalog-selection:exact',
        evidence: {
          assessedAt: '2026-09-28T09:59:59.000Z',
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
            attestationId: '99999999-9999-4999-8999-999999999999',
            observedAt: '2026-09-28T09:59:59.000Z',
            productRef,
            source: 'CATALOG_OWNER_CURRENT_READ' as const,
            variant: { resourceRef: variantRef, revision: 2 },
          },
          purpose: 'PRICING' as const,
          selection,
          status: 'VALID' as const,
        },
        hierarchyRevision: 'catalog-hierarchy:9',
        ownerRevision: 'catalog-quantity:17',
        quantity: {
          changed: false,
          notice: null,
          requested: '2',
          resulting: '2',
          rounding: 'HALF_UP' as const,
          status: 'VALID' as const,
          step: '1',
          targetId: variantId,
          tenantId,
          unitId: productUnitId,
          unitRuleRevision: 7,
        },
        quantityBasis: {
          targetDivisibilityRevision: 3,
          targetRef: variantRef,
          unitRef: productUnitRef,
          unitRuleRevision: 7,
        },
        selection,
        status: 'READY' as const,
        unitRef: productUnitRef,
      },
      occurrenceId: 'purchase-occurrence-1',
      pricingBasis: { quantity: '1', unitRef: productUnitRef },
    },
  ],
  monetaryBoundary: 'PRE_TAX' as const,
  operationTime: '2026-09-28T10:00:00.000Z',
  purchasingContext: {
    accessDecision: { decisionRef: 'access-decision:41', decisionRevision: 'access-decision-revision:41' },
    actor: {
      guestEvidenceRef: guestSubject.guestEvidenceRef,
      guestSessionRef: guestSubject.guestSessionRef,
      kind: 'GUEST' as const,
    },
    commercialSettingsDecision: {
      decisionRef: 'commercial-settings-decision:41',
      decisionRevision: 'commercial-settings-revision:41',
    },
    contextRef: 'commerce-purchasing-context:41',
    contextRevision: 'customer-context:41',
    currencyResolution: {
      currencyCode: 'CZK',
      resolutionRef: 'purchase-currency-resolution:41',
      resolutionRevision: 'purchase-currency-resolution-revision:41',
    },
    subject: guestSubject,
  },
  tenantId,
};

const decodeRequest = Schema.decodeUnknownSync(CurrentPricingDecisionRequestSchema, {
  onExcessProperty: 'error',
});
const decodeResponse = Schema.decodeUnknownSync(CurrentPricingDecisionResponseSchema, {
  onExcessProperty: 'error',
});

const responseBase = {
  candidate: { occurrenceIds: ['purchase-occurrence-1'] },
  projectionVersion: 'CURRENT_PRICING_DECISION_CUSTOMER_V1' as const,
};

const resolvedResponse = {
  ...responseBase,
  outcome: 'PRICE_RESOLVED' as const,
  result: {
    currencyCode: 'CZK',
    lines: [
      {
        occurrenceId: 'purchase-occurrence-1',
        publishedPreTaxAmount: { amount: '19.99', currencyCode: 'CZK' },
      },
    ],
    monetaryBoundary: 'PRE_TAX' as const,
    total: { amount: '19.99', currencyCode: 'CZK' },
    totalMethod: 'EXACT_SUM_OF_ROUNDED_LINES' as const,
  },
  retryable: false as const,
};

describe('Pricing Current Decision public contract', () => {
  it('accepts one exact closed whole-candidate request and keeps the support read separate', () => {
    const request = { decision, subject: guestSubject };
    expect(decodeRequest(request)).toEqual(request);
    expect(CurrentPricingDecisionRequestSchema).not.toBe(CurrentSupportedCurrenciesRequestSchema);
    expect(() => decodeRequest({ ...request, storefrontId: 'storefront-web' })).toThrow();
    expect(() => decodeRequest({ subject: guestSubject, tenantId })).toThrow();
  });

  it('requires Tenant coherence for owner-qualified profile subjects', () => {
    const profile = retailSubject(tenantId);
    const profileDecision = {
      ...decision,
      purchasingContext: {
        ...decision.purchasingContext,
        actor: { kind: 'PRINCIPAL' as const, principalId: 'principal:41' },
        subject: profile,
      },
    };
    expect(decodeRequest({ decision: profileDecision, subject: profile }).subject.kind).toBe('PROFILE');
    expect(() => decodeRequest({ decision: profileDecision, subject: retailSubject(otherTenantId) })).toThrow();
    expect(() => decodeRequest({ decision, subject: profile })).toThrow();
  });

  it('keeps the wire contract currency-generalized without treating that as Launch activation', () => {
    expect(
      decodeRequest({
        decision: {
          ...decision,
          currencyCode: 'EUR',
          purchasingContext: {
            ...decision.purchasingContext,
            currencyResolution: { ...decision.purchasingContext.currencyResolution, currencyCode: 'EUR' },
          },
        },
        subject: guestSubject,
      }).decision.currencyCode,
    ).toBe('EUR');
  });

  it('publishes a versioned customer allowlist with all six semantic outcomes', () => {
    expect(decodeResponse(resolvedResponse)).toEqual(resolvedResponse);
    const outcomes = [
      { outcome: 'NO_APPLICABLE_PRICE', retryable: false },
      { outcome: 'PRICING_CONFIGURATION_ERROR', retryable: false },
      { outcome: 'PRICING_CONFLICT', retryable: false },
      { outcome: 'PRICING_STALE', retryable: true },
      { outcome: 'PRICING_INDETERMINATE', retryable: true },
    ] as const;
    for (const outcome of outcomes) {
      expect(decodeResponse({ ...responseBase, ...outcome }).outcome).toBe(outcome.outcome);
    }
    const outcomeKinds = [resolvedResponse.outcome, ...outcomes.map(({ outcome }) => outcome)];
    expect(outcomeKinds.map((kind) => Schema.decodeSync(PricingDecisionOutcomeKindSchema)(kind))).toEqual(outcomeKinds);
  });

  it('requires the customer result to preserve every occurrence exactly once in candidate order', () => {
    const secondLine = {
      occurrenceId: 'purchase-occurrence-2',
      publishedPreTaxAmount: { amount: '10', currencyCode: 'CZK' },
    } as const;
    const wholeCandidate = {
      ...resolvedResponse,
      candidate: { occurrenceIds: ['purchase-occurrence-1', 'purchase-occurrence-2'] },
      result: {
        ...resolvedResponse.result,
        lines: [...resolvedResponse.result.lines, secondLine],
        total: { amount: '29.99', currencyCode: 'CZK' },
      },
    } as const;

    expect(decodeResponse(wholeCandidate)).toEqual(wholeCandidate);
    expect(() =>
      decodeResponse({
        ...wholeCandidate,
        result: { ...wholeCandidate.result, lines: wholeCandidate.result.lines.toReversed() },
      }),
    ).toThrow();
    expect(() =>
      decodeResponse({
        ...wholeCandidate,
        candidate: { occurrenceIds: ['purchase-occurrence-1', 'purchase-occurrence-1'] },
      }),
    ).toThrow();
  });

  it('projects PRICE_RESOLVED exclusively from the canonical customer-safe commercial total', () => {
    const canonical = Schema.decodeSync(PricingCommercialTotalSafeProjectionSchema)({
      candidateRef: 'private-candidate:41',
      currencyCode: 'CZK',
      lines: [
        {
          occurrenceId: 'purchase-occurrence-1',
          publishedLineValue: { amount: '19.99', currencyCode: 'CZK' },
        },
      ],
      monetaryBoundary: 'PRE_TAX',
      pricingNetCommercialTotal: { amount: '19.99', currencyCode: 'CZK' },
    });

    const projected = projectCurrentPricingDecisionResponse(canonical);

    expect(projected).toEqual(resolvedResponse);
    expect(JSON.stringify(projected)).not.toContain(canonical.candidateRef);
  });

  it('projects an internal failure without leaking its candidate ref, evidence, or diagnostics', () => {
    const internal = {
      candidate: { candidateRef: 'candidate:41', occurrenceIds: ['purchase-occurrence-1'] },
      inabilityEvidence: {
        attempts: 2,
        requiredOwnerRefs: ['currency-support:17', 'catalog-quantity:17'],
      },
      outcome: 'PRICING_INDETERMINATE',
      reasonCode: 'CURRENTNESS_UNVERIFIABLE',
      retryable: true,
    } as const satisfies PricingDecisionOutcome;
    const projected = projectCurrentPricingDecisionResponse(internal);
    expect(projected).toEqual({
      ...responseBase,
      outcome: 'PRICING_INDETERMINATE',
      retryable: true,
    } satisfies CurrentPricingDecisionResponse);
    expect(JSON.stringify(projected)).not.toMatch(
      /candidate:41|currency-support:17|catalog-quantity:17|CURRENTNESS_UNVERIFIABLE/u,
    );
  });

  it('rejects internal owner evidence, lookup keys, revisions, and private diagnostics at every depth', () => {
    for (const privateTopLevel of [
      { decision },
      { proof: { exactPredicateRef: 'private:predicate' } },
      { lookups: [] },
      { currentTruthRefs: ['revision:a', 'revision:b'] },
      { reasonCode: 'CURRENTNESS_UNVERIFIABLE' },
      { staleEvidence: { invalidatedRevision: 'private:revision' } },
      { inabilityEvidence: { attempts: 2, requiredOwnerRefs: ['private:owner'] } },
      { diagnostics: { source: 'private' } },
    ]) {
      expect(() => decodeResponse({ ...resolvedResponse, ...privateTopLevel })).toThrow();
    }
    expect(() =>
      decodeResponse({
        ...resolvedResponse,
        candidate: { ...resolvedResponse.candidate, candidateRef: 'private:candidate' },
      }),
    ).toThrow();
    for (const privateLineField of [
      { completenessEvidence: { ownerRevision: 'private:revision' } },
      { exactPredicateRef: 'private:predicate' },
      { lookup: { priceRevision: 'private:revision' } },
      { preRoundedPreTaxAmount: { amount: '19.994', currencyCode: 'CZK' } },
      { sourceRevision: 'private:revision' },
      { unitPrice: { amount: '9.997', currencyCode: 'CZK' } },
    ]) {
      const [line] = resolvedResponse.result.lines;
      expect(() =>
        decodeResponse({
          ...resolvedResponse,
          result: {
            ...resolvedResponse.result,
            lines: [{ ...line, ...privateLineField }],
          },
        }),
      ).toThrow();
    }
  });

  it('keeps the customer projection currency-generalized while the runtime Launch gate remains CZK-only', () => {
    const eur = {
      ...resolvedResponse,
      result: {
        ...resolvedResponse.result,
        currencyCode: 'EUR',
        lines: [
          {
            ...resolvedResponse.result.lines[0],
            publishedPreTaxAmount: { amount: '19.99', currencyCode: 'EUR' },
          },
        ],
        total: { amount: '19.99', currencyCode: 'EUR' },
      },
    };
    expect(decodeResponse(eur)).toMatchObject({
      outcome: 'PRICE_RESOLVED',
      result: { currencyCode: 'EUR' },
    });
  });

  it.effect('strictly encodes before the governed client can invoke HTTP', () =>
    Effect.gen(function* verifyStrictClientEncoding() {
      const validRequest = decodeRequest({ decision, subject: guestSubject });
      const invalid = {
        ...validRequest,
        decision: { ...validRequest.decision, operationTime: 'not-an-instant' },
      };
      const exit = yield* Effect.exit(
        executeCurrentPricingDecisionWithAuthorization(invalid, 'credential', 'correlation'),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(executeCurrentPricingDecision).toBeTypeOf('function');
    }),
  );
});
