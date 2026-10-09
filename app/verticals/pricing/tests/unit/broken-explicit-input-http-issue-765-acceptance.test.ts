import { PricingExplicitInputEvaluationResultSchema } from '@app/pricing-contracts/domain/broken-explicit-input';
import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  ExactPriceResolutionIndeterminateResponseSchema,
  ExactPriceResolutionInternalProblemSchema,
  ExactPriceResolutionReadyResponseSchema,
  ExactPriceResolutionRequestSchema,
  ExactPriceResolutionResponseSchema,
} from '../../shared/apis/exact-price-resolution.ts';
import { toExactPriceResolutionResponse } from '../../src/api/exact-price-resolution.read.ts';

const context = {
  effectiveAt: '2026-09-27T12:00:00.000Z',
  requestedCurrencyCode: 'CZK',
  tenantId: '11111111-1111-4111-8111-111111111111',
} as const;

const decodeRequest = Schema.decodeUnknownSync(ExactPriceResolutionRequestSchema, {
  onExcessProperty: 'error',
});
const decodeResponse = Schema.decodeUnknownSync(ExactPriceResolutionResponseSchema, {
  onExcessProperty: 'error',
});
const decodeEvaluationResult = Schema.decodeUnknownSync(PricingExplicitInputEvaluationResultSchema, {
  onExcessProperty: 'error',
});

const { tenantId } = context;
const catalogRef = (resourceId: string, resourceType: string, ownerTenantId = tenantId) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId: ownerTenantId,
});
const productRef = catalogRef('22222222-2222-4222-8222-222222222222', 'commerce.catalog.product');
const variantRef = catalogRef('33333333-3333-4333-8333-333333333333', 'commerce.catalog.variant');
const packageRef = catalogRef('44444444-4444-4444-8444-444444444444', 'commerce.catalog.package-definition');
const configurationRef = catalogRef(
  '55555555-5555-4555-8555-555555555555',
  'commerce.catalog.configuration-definition',
);
const setRef = catalogRef('66666666-6666-4666-8666-666666666666', 'commerce.catalog.set-composition');
const unitRef = catalogRef('77777777-7777-4777-8777-777777777777', 'commerce.catalog.product-unit');
const selection = {
  configuration: {
    choices: [{ choiceKey: 'finish', value: 'blue' }],
    definition: { resourceRef: configurationRef, revision: 4 },
    productRef,
    variantRef,
  },
  packageOption: {
    contentRevision: { resourceRef: packageRef, revision: 5 },
    optionRef: packageRef,
  },
  productRef,
  setComposition: { resourceRef: setRef, revision: 6 },
  variantRef,
} as const;
const commercialScope = {
  channelId: 'B2C',
  marketId: 'CZ',
  sellingLegalEntityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
} as const;
const unitBasis = { quantity: '1', unitRef } as const;
const exactKey = {
  catalogSelection: selection,
  commercialScope,
  currencyCode: 'CZK',
  priceGroupSelector: { kind: 'NO_GROUP' },
  unitBasis,
} as const;
const exactContext = decodeRequest({ ...context, exactKey });
const supportRootRef = {
  moduleId: 'commerce.pricing',
  resourceId: '88888888-8888-4888-8888-888888888888',
  resourceType: 'commerce.pricing.currency-support',
  tenantId,
} as const;
const supportRevisionRef = {
  moduleId: 'commerce.pricing',
  resourceId: '99999999-9999-4999-8999-999999999999',
  resourceType: 'commerce.pricing.currency-support-revision',
  supportRootId: supportRootRef.resourceId,
  tenantId,
} as const;
const verificationRef = 'commerce.pricing.currency-support-proof:765-http-acceptance';
const observedAt = '2026-09-27T12:00:00.050Z';
const currencySupport = {
  completenessEvidence: {
    observedAt,
    ownerRevision: supportRevisionRef.resourceId,
    scope: {
      kind: 'EXACT_PREDICATE',
      predicateRef: `commerce.pricing.current-supported-currencies:${tenantId}`,
    },
  },
  currentnessEvidence: {
    evaluatedAt: context.effectiveAt,
    evaluationMode: 'HISTORICAL_AS_OF',
    observedAt,
    scheduleRevision: 7,
    supportRevisionRef,
    supportRootRef,
  },
  effectiveAt: context.effectiveAt,
  effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
  factProofs: [{ factRef: supportRootRef.resourceId, factRevisionRef: supportRevisionRef.resourceId, verificationRef }],
  generation: 7,
  observedAt,
  outcome: 'SUPPORTED_CURRENCIES_CURRENT',
  pricingRevision: 'pricing-currency-support:7',
  scheduleRevision: 7,
  supportedCurrencies: ['CZK'],
  supportRevisionRef,
  supportRootRef,
  tenantId,
  verificationRef,
} as const;
const readyInternal = decodeEvaluationResult({
  _tag: 'READY',
  exactResolutionInput: {
    currencySupport,
    resolutionInput: {
      _tag: 'GUEST',
      basis: {
        catalogSelection: selection,
        commercialScope,
        currencyCode: 'CZK',
        unitBasis,
      },
      effectiveAt: context.effectiveAt,
    },
  },
});

describe('Issue #765 exact Price governed-read public contract', () => {
  it('accepts only caller-safe context and rejects caller-injected trusted owner evidence', () => {
    expect(decodeRequest(context)).toEqual(context);

    for (const injected of [
      { currencySupport: { supportedCurrencies: ['EUR'] } },
      { exactResolutionInput: { currencySupport: { supportedCurrencies: ['EUR'] } } },
      { priceGroupResolutionInput: { _tag: 'OWNER_NONE' } },
      { sourceAssessment: { outcome: 'PRICE_SOURCE_ASSERTION_CANONICAL_ACCEPTED' } },
      { trustedOwnerEvidence: { currentTruthRefs: ['attacker:1'] } },
    ]) {
      expect(() => decodeRequest({ ...context, ...injected })).toThrow();
    }
  });

  it('publishes READY only as sanitized verification and never leaks owner observations', () => {
    const ready = decodeResponse({
      _tag: 'READY',
      context,
      outcome: 'INPUTS_VERIFIED',
      retryable: false,
    });
    expect(Schema.is(ExactPriceResolutionReadyResponseSchema)(ready)).toBe(true);
    expect(ready).toMatchObject({ context, outcome: 'INPUTS_VERIFIED', retryable: false });

    for (const leaked of [
      { exactResolutionInput: { trusted: true } },
      { currencySupport: { supportedCurrencies: ['CZK'] } },
      { ownerResolution: { resolution: { _tag: 'NONE' } } },
      { provenance: { sourceRecord: { sourceRecordRef: 'secret' } } },
      { cause: { message: 'database diagnostics' } },
    ]) {
      expect(() =>
        decodeResponse({
          _tag: 'READY',
          context,
          outcome: 'INPUTS_VERIFIED',
          retryable: false,
          ...leaked,
        }),
      ).toThrow();
    }
  });

  it('keeps every expected semantic state in the successful response union instead of a 500 problem', () => {
    const expectedStates = [
      {
        _tag: 'KNOWN_INVALID',
        context,
        outcome: 'PRICING_CONFIGURATION_ERROR',
        reason: 'BROKEN_PRICE_GROUP_ASSIGNMENT',
        retryable: false,
        subject: 'PRICE_GROUP_ASSIGNMENT',
      },
      {
        _tag: 'CONFLICT',
        context,
        outcome: 'PRICING_CONFLICT',
        reason: 'COMPETING_CURRENT_EXACT_PRICES',
        retryable: false,
        subject: 'EXACT_PRICE',
      },
      {
        _tag: 'STALE',
        context,
        outcome: 'PRICING_STALE',
        reason: 'PROOF_STALE',
        retryable: true,
        subject: 'EXACT_PRICE',
      },
      {
        _tag: 'INDETERMINATE',
        context,
        outcome: 'PRICING_INDETERMINATE',
        reason: 'EXACT_PRICE_STATE_UNVERIFIABLE',
        retryable: true,
        subject: 'EXACT_PRICE',
      },
      {
        _tag: 'NON_CANONICAL_ASSERTION_HELD',
        context,
        outcome: 'PRICING_INDETERMINATE',
        reason: 'AUTHORITATIVE_PRE_TAX_NORMALIZATION_MISSING',
        retryable: true,
        subject: 'SOURCE_ASSERTION',
      },
      {
        _tag: 'LEGITIMATE_GROUP_ABSENCE',
        context,
        continuation: 'TRY_EXACT_NO_GROUP_PRICE',
      },
      {
        _tag: 'LEGITIMATE_EXACT_PATH_ABSENCE',
        context,
        outcome: 'NO_APPLICABLE_PRICE',
        retryable: false,
      },
    ] as const;

    for (const state of expectedStates) {
      const decoded = decodeResponse(state);
      expect(decoded).toEqual(state);
      expect(Schema.is(ExactPriceResolutionInternalProblemSchema)(decoded)).toBe(false);
      expect(decoded).not.toHaveProperty('cause');
      expect(decoded).not.toHaveProperty('stack');
      expect(decoded).not.toHaveProperty('currentTruthRefs');
      expect(decoded).not.toHaveProperty('evidenceRefs');
    }
  });

  it('rejects nested diagnostic, provenance, evidence, and winner injection on every public outcome', () => {
    const safe = {
      _tag: 'INDETERMINATE',
      context,
      outcome: 'PRICING_INDETERMINATE',
      reason: 'REQUIRED_FEE_STATE_UNVERIFIABLE',
      retryable: true,
      subject: 'COMMERCIAL_FEE',
    } as const;

    for (const injected of [
      { cause: { cause: { message: 'driver secret' } } },
      { inabilityEvidence: { evidenceRefs: ['owner-private:1'], requiredOwners: ['PRICING_COMMERCIAL_FEE'] } },
      { provenance: { ownerModuleId: 'private.owner', sourceRecord: { raw: 'secret' } } },
      { selectedFallback: { amount: '0', currencyCode: 'CZK' } },
      { currentTruthRefs: ['owner-private:1', 'owner-private:2'] },
    ]) {
      expect(() => decodeResponse({ ...safe, ...injected })).toThrow();
    }
  });

  it('fails READY closed when any public identity or exact-key axis differs from trusted input', () => {
    const otherProductRef = catalogRef('10101010-1010-4010-8010-101010101010', 'commerce.catalog.product');
    const otherVariantRef = catalogRef('20202020-2020-4020-8020-202020202020', 'commerce.catalog.variant');
    const otherPackageRef = catalogRef('30303030-3030-4030-8030-303030303030', 'commerce.catalog.package-definition');
    const otherUnitRef = catalogRef('40404040-4040-4040-8040-404040404040', 'commerce.catalog.product-unit');
    const otherConfigurationRef = catalogRef(
      '50505050-5050-4050-8050-505050505050',
      'commerce.catalog.configuration-definition',
    );
    const otherSetRef = catalogRef('60606060-6060-4060-8060-606060606060', 'commerce.catalog.set-composition');
    const priceGroupRef = {
      moduleId: 'pricing.price-group-catalog',
      resourceId: '70707070-7070-4070-8070-707070707070',
      resourceType: 'pricing.price-group-catalog.price-group',
      tenantId,
    } as const;
    const mismatchedRequests = [
      decodeRequest({ ...exactContext, tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
      decodeRequest({ ...exactContext, effectiveAt: '2026-09-27T12:00:01.000Z' }),
      decodeRequest({ ...context, requestedCurrencyCode: 'EUR' }),
      decodeRequest({
        ...exactContext,
        exactKey: { ...exactKey, currencyCode: 'EUR' },
        requestedCurrencyCode: 'EUR',
      }),
      decodeRequest({
        ...exactContext,
        exactKey: {
          ...exactKey,
          commercialScope: { ...commercialScope, sellingLegalEntityId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
        },
      }),
      decodeRequest({
        ...exactContext,
        exactKey: { ...exactKey, commercialScope: { ...commercialScope, channelId: 'B2B' } },
      }),
      decodeRequest({
        ...exactContext,
        exactKey: { ...exactKey, commercialScope: { ...commercialScope, marketId: 'SK' } },
      }),
      decodeRequest({
        ...exactContext,
        exactKey: {
          ...exactKey,
          catalogSelection: {
            ...selection,
            configuration: { ...selection.configuration, productRef: otherProductRef },
            productRef: otherProductRef,
          },
        },
      }),
      decodeRequest({
        ...exactContext,
        exactKey: {
          ...exactKey,
          catalogSelection: {
            ...selection,
            configuration: {
              ...selection.configuration,
              definition: { resourceRef: otherConfigurationRef, revision: 4 },
            },
          },
        },
      }),
      decodeRequest({
        ...exactContext,
        exactKey: {
          ...exactKey,
          catalogSelection: {
            ...selection,
            configuration: {
              ...selection.configuration,
              definition: { ...selection.configuration.definition, revision: 5 },
            },
          },
        },
      }),
      decodeRequest({
        ...exactContext,
        exactKey: {
          ...exactKey,
          catalogSelection: {
            ...selection,
            packageOption: {
              ...selection.packageOption,
              contentRevision: { ...selection.packageOption.contentRevision, revision: 6 },
            },
          },
        },
      }),
      decodeRequest({
        ...exactContext,
        exactKey: {
          ...exactKey,
          catalogSelection: {
            ...selection,
            configuration: { ...selection.configuration, variantRef: otherVariantRef },
            variantRef: otherVariantRef,
          },
        },
      }),
      decodeRequest({
        ...exactContext,
        exactKey: {
          ...exactKey,
          catalogSelection: {
            ...selection,
            packageOption: {
              contentRevision: { resourceRef: otherPackageRef, revision: 5 },
              optionRef: otherPackageRef,
            },
          },
        },
      }),
      decodeRequest({
        ...exactContext,
        exactKey: {
          ...exactKey,
          catalogSelection: {
            ...selection,
            configuration: {
              ...selection.configuration,
              choices: [{ choiceKey: 'finish', value: 'red' }],
            },
          },
        },
      }),
      decodeRequest({
        ...exactContext,
        exactKey: {
          ...exactKey,
          catalogSelection: {
            ...selection,
            setComposition: { ...selection.setComposition, revision: 7 },
          },
        },
      }),
      decodeRequest({
        ...exactContext,
        exactKey: {
          ...exactKey,
          catalogSelection: {
            ...selection,
            setComposition: { resourceRef: otherSetRef, revision: 6 },
          },
        },
      }),
      decodeRequest({
        ...exactContext,
        exactKey: { ...exactKey, unitBasis: { ...unitBasis, unitRef: otherUnitRef } },
      }),
      decodeRequest({
        ...exactContext,
        exactKey: { ...exactKey, unitBasis: { ...unitBasis, quantity: '2' } },
      }),
      decodeRequest({
        ...exactContext,
        exactKey: { ...exactKey, priceGroupSelector: { kind: 'PRICE_GROUP', priceGroupRef } },
      }),
    ];

    for (const mismatchedRequest of mismatchedRequests) {
      const response = toExactPriceResolutionResponse(mismatchedRequest, readyInternal);
      expect(Schema.is(ExactPriceResolutionIndeterminateResponseSchema)(response)).toBe(true);
      expect(response).toMatchObject({
        context: mismatchedRequest,
        outcome: 'PRICING_INDETERMINATE',
        reason: 'CURRENTNESS_UNVERIFIABLE',
        retryable: true,
        subject: 'EXACT_PRICE',
      });
      expect(response).not.toHaveProperty('exactResolutionInput');
      expect(response).not.toHaveProperty('currencySupport');
    }
  });

  it('rejects a request currency that differs from its exact key currency', () => {
    expect(() =>
      decodeRequest({
        ...exactContext,
        exactKey: { ...exactKey, currencyCode: 'EUR' },
        requestedCurrencyCode: 'CZK',
      }),
    ).toThrow();
  });

  it('publishes only bounded READY for an exact match', () => {
    const response = toExactPriceResolutionResponse(exactContext, readyInternal);
    expect(Schema.is(ExactPriceResolutionReadyResponseSchema)(response)).toBe(true);
    expect(response).toMatchObject({ context: exactContext, outcome: 'INPUTS_VERIFIED', retryable: false });
    expect(Object.keys(response).toSorted()).toEqual(['_tag', 'context', 'outcome', 'retryable']);
    expect(response).not.toHaveProperty('exactResolutionInput');
    expect(response).not.toHaveProperty('currencySupport');
    expect(response).not.toHaveProperty('resolutionInput');
  });
});
