import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  CurrentSupportedCurrenciesRequestSchema,
  CurrentSupportedCurrenciesResponseSchema,
  PriceDefinitionSchema,
  SetSupportedCurrenciesV2PayloadSchema,
} from '../../src/index.ts';

const tenantId = '22222222-2222-4222-8222-222222222222';
const otherTenantId = '33333333-3333-4333-8333-333333333333';
const effectiveAt = '2026-09-27T10:00:00.000Z';
const observedAt = '2026-09-27T10:00:01.000Z';
const supportRootId = '99999999-9999-4999-8999-999999999999';
const supportRevision7 = '77777777-7777-4777-8777-777777777771';
const supportRevision8 = '88888888-8888-4888-8888-888888888881';
const supportRevision42 = '42424242-4242-4242-8242-424242424242';
const supportRootRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: supportRootId,
  resourceType: 'commerce.pricing.currency-support' as const,
  tenantId,
};
const supportRevisionRef = (resourceId: string) => ({
  moduleId: 'commerce.pricing' as const,
  resourceId,
  resourceType: 'commerce.pricing.currency-support-revision' as const,
  supportRootId,
  tenantId,
});

const decodeRequest = Schema.decodeUnknownSync(CurrentSupportedCurrenciesRequestSchema, {
  onExcessProperty: 'error',
});
const decodeResponse = Schema.decodeUnknownSync(CurrentSupportedCurrenciesResponseSchema, {
  onExcessProperty: 'error',
});

const catalogRef = (resourceId: string, resourceType: string) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId,
});

const eurPrice = {
  identityKey: {
    catalogSelection: {
      productRef: catalogRef('44444444-4444-4444-8444-444444444444', 'commerce.catalog.product'),
      variantRef: catalogRef('55555555-5555-4555-8555-555555555555', 'commerce.catalog.variant'),
    },
    commercialScope: {
      channelId: 'B2C',
      marketId: 'cz-launch',
      sellingLegalEntityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    },
    currencyCode: 'EUR',
    priceGroupSelector: { kind: 'NO_GROUP' as const },
    unitBasis: {
      quantity: '1',
      unitRef: catalogRef('66666666-6666-4666-8666-666666666666', 'commerce.catalog.product-unit'),
    },
  },
  priceRef: {
    moduleId: 'commerce.pricing' as const,
    resourceId: '77777777-7777-4777-8777-777777777777',
    resourceType: 'commerce.pricing.price' as const,
    tenantId,
  },
  revision: {
    effectiveFrom: effectiveAt,
    monetaryAmount: { amount: '12.50', currencyCode: 'EUR' },
    monetaryBoundary: 'PRE_TAX' as const,
    revision: 1,
    revisionId: '88888888-8888-4888-8888-888888888888',
  },
};

describe('Tenant Currency Support acceptance contract', () => {
  it('uses only trusted Tenant and evaluation time as the capability request identity', () => {
    const request = { effectiveAt, tenantId };
    expect(decodeRequest(request)).toEqual(request);

    for (const purchasePartition of [
      { cartId: 'cart-1' },
      { channelId: 'B2C' },
      { marketId: 'market-cz' },
      { sellingLegalEntityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      { storefrontId: 'storefront-cz' },
      { subject: { kind: 'GUEST' } },
      { contextRevision: 'purchase-context:9' },
    ]) {
      expect(() => decodeRequest({ ...request, ...purchasePartition })).toThrow();
    }

    expect(decodeRequest({ effectiveAt, tenantId: otherTenantId })).toEqual({
      effectiveAt,
      tenantId: otherTenantId,
    });
  });

  it('keeps generalized EUR-aware wire and Price contracts without making EUR a Launch default', () => {
    const verificationRef = `commerce.pricing.currency-support-proof:${supportRevision42}`;
    const generalizedResponse = {
      completenessEvidence: {
        observedAt,
        ownerRevision: supportRevision42,
        scope: {
          kind: 'EXACT_PREDICATE' as const,
          predicateRef: `commerce.pricing.current-supported-currencies:${tenantId}`,
        },
      },
      currentnessEvidence: {
        evaluatedAt: effectiveAt,
        evaluationMode: 'HISTORICAL_AS_OF' as const,
        observedAt,
        scheduleRevision: 42,
        supportRevisionRef: supportRevisionRef(supportRevision42),
        supportRootRef,
      },
      effectiveAt,
      effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
      factProofs: [{ factRef: supportRootId, factRevisionRef: supportRevision42, verificationRef }],
      generation: 42,
      observedAt,
      outcome: 'SUPPORTED_CURRENCIES_CURRENT' as const,
      pricingRevision: 'pricing-currency-support:42',
      scheduleRevision: 42,
      supportedCurrencies: ['CZK', 'EUR'],
      supportRevisionRef: supportRevisionRef(supportRevision42),
      supportRootRef,
      tenantId,
      verificationRef,
    };

    expect(decodeResponse(generalizedResponse)).toEqual(generalizedResponse);
    expect(Schema.decodeUnknownSync(PriceDefinitionSchema)(eurPrice)).toEqual(eurPrice);
  });

  it('requires exact missing, conflict, and unverifiable evidence instead of fabricating CZK success', () => {
    for (const failure of [
      {
        code: 'pricing_currency_support_missing',
        outcome: 'SUPPORTED_CURRENCIES_UNAVAILABLE',
        reason: 'No Tenant Currency Support revision applies at the requested instant',
        retryable: true,
      },
      {
        code: 'pricing_currency_support_conflict',
        outcome: 'SUPPORTED_CURRENCIES_UNVERIFIABLE',
        reason: 'Competing Tenant Currency Support revisions apply at the requested instant',
        retryable: false,
      },
    ] as const) {
      expect(decodeResponse(failure)).toEqual(failure);
      expect(() => decodeResponse({ ...failure, supportedCurrencies: ['CZK'] })).toThrow();
    }
  });

  it('requires expected-before semantics even for a no-op and preserves finite/open interval ends', () => {
    const finiteCurrent = {
      effectivePeriod: {
        effectiveFrom: '2026-09-01T00:00:00.000Z',
        effectiveTo: '2026-10-01T00:00:00.000Z',
      },
      generation: 7,
      supportedCurrencies: ['CZK'],
      supportRevisionRef: supportRevisionRef(supportRevision7),
    };
    const openCurrent = {
      ...finiteCurrent,
      effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
    };
    const expectedState = {
      current: openCurrent,
      future: [],
      observedAt,
      scheduleRevision: 7,
      state: 'PRESENT' as const,
      supportRootRef,
    };
    const openNoOp = {
      expectedState,
      intendedEffectivePeriod: { effectiveFrom: effectiveAt, effectiveTo: null },
      intent: 'VALUE_ONLY_CURRENT' as const,
      reason: 'Reassert the exact Launch support set',
      schemaVersion: '2' as const,
      supportedCurrencies: ['CZK'],
    };

    expect(Schema.decodeSync(SetSupportedCurrenciesV2PayloadSchema)(openNoOp)).toEqual(openNoOp);
    expect(() => {
      const { expectedState: _expectedState, ...withoutExpectedBefore } = openNoOp;
      return Schema.decodeUnknownSync(SetSupportedCurrenciesV2PayloadSchema)(withoutExpectedBefore);
    }).toThrow();
    expect(() =>
      Schema.decodeSync(SetSupportedCurrenciesV2PayloadSchema)({
        ...openNoOp,
        expectedState: { ...expectedState, current: finiteCurrent },
        intendedEffectivePeriod: { effectiveFrom: effectiveAt, effectiveTo: null },
      }),
    ).toThrow();
  });

  it('binds acknowledgement to the exact retained future schedule and rejects stale presentation', () => {
    const current = {
      effectivePeriod: {
        effectiveFrom: '2026-09-01T00:00:00.000Z',
        effectiveTo: '2026-10-01T00:00:00.000Z',
      },
      generation: 7,
      supportedCurrencies: ['CZK'],
      supportRevisionRef: supportRevisionRef(supportRevision7),
    };
    const future = {
      effectivePeriod: { effectiveFrom: '2026-11-01T00:00:00.000Z', effectiveTo: null },
      generation: 8,
      supportedCurrencies: ['CZK'],
      supportRevisionRef: supportRevisionRef(supportRevision8),
    };
    const expectedState = {
      current,
      future: [future],
      observedAt,
      scheduleRevision: 9,
      state: 'PRESENT' as const,
      supportRootRef,
    };
    const intendedEffectivePeriod = {
      effectiveFrom: effectiveAt,
      effectiveTo: current.effectivePeriod.effectiveTo,
    };
    const acknowledgement = {
      actingPrincipalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      expectedScheduleRevision: expectedState.scheduleRevision,
      fingerprint: 'a'.repeat(64),
      intendedEffectivePeriod,
      intendedSupportedCurrencies: ['CZK'],
      presentedFuture: expectedState.future,
      supportRootRef,
      targetEffectivePeriod: current.effectivePeriod,
      targetRevisionRef: current.supportRevisionRef,
    };
    const payload = {
      acknowledgement,
      expectedState,
      intendedEffectivePeriod,
      intent: 'VALUE_ONLY_CURRENT' as const,
      reason: 'Preserve the finite end, following gap, and future revision',
      schemaVersion: '2' as const,
      supportedCurrencies: ['CZK'],
    };

    expect(Schema.decodeSync(SetSupportedCurrenciesV2PayloadSchema)(payload)).toEqual(payload);
    expect(payload.expectedState.current.effectivePeriod.effectiveTo).toBe('2026-10-01T00:00:00.000Z');
    expect(payload.expectedState.future[0]?.effectivePeriod.effectiveFrom).toBe('2026-11-01T00:00:00.000Z');
    expect(() =>
      Schema.decodeSync(SetSupportedCurrenciesV2PayloadSchema)({
        ...payload,
        expectedState: { ...expectedState, scheduleRevision: 10 },
      }),
    ).toThrow();
    const { acknowledgement: _acknowledgement, ...withoutAcknowledgement } = payload;
    expect(Schema.decodeSync(SetSupportedCurrenciesV2PayloadSchema)(withoutAcknowledgement)).toEqual(
      withoutAcknowledgement,
    );
    expect(() => {
      const withoutFuture = {
        ...payload,
        expectedState: { ...expectedState, future: [] },
      };
      return Schema.decodeSync(SetSupportedCurrenciesV2PayloadSchema)(withoutFuture);
    }).toThrow();
  });
});
