import { PricingExplicitInputContextSchema } from '@app/pricing-contracts/domain/broken-explicit-input';
import type { PricingExplicitInputEvaluationResult } from '@app/pricing-contracts/domain/broken-explicit-input';
import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  ExactPriceResolutionIndeterminateResponseSchema,
  ExactPriceResolutionRequestSchema,
  ExactPriceResolutionResponseSchema,
} from '../../shared/apis/exact-price-resolution.ts';
import { exactPriceResolutionRead, toExactPriceResolutionResponse } from '../../src/api/exact-price-resolution.read.ts';

const decodeContext = Schema.decodeUnknownSync(PricingExplicitInputContextSchema, {
  onExcessProperty: 'error',
});
const decodeRequest = Schema.decodeUnknownSync(ExactPriceResolutionRequestSchema, {
  onExcessProperty: 'error',
});
const decodeResponse = Schema.decodeUnknownSync(ExactPriceResolutionResponseSchema, {
  onExcessProperty: 'error',
});

const context = decodeContext({
  effectiveAt: '2026-09-27T20:00:00.000Z',
  requestedCurrencyCode: 'CZK',
  tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
});

describe('exact Price resolution generated transport boundary', () => {
  it('classifies the canonical read behind one atomic Pricing diagnostic permission', () => {
    expect(exactPriceResolutionRead.descriptor).toMatchObject({
      entrypoint: {
        access: 'read',
        authorization: { kind: 'context_permission', permission: 'pricing.exact_price_resolution.read' },
      },
      legalEntityScope: 'required',
      permissionTarget: 'module',
    });
  });

  it('accepts only safe lookup context and rejects caller-supplied owner observations', () => {
    expect(decodeRequest(context)).toEqual(context);
    expect(() =>
      decodeRequest({
        ...context,
        currencySupport: { outcome: 'SUPPORTED_CURRENCIES_CURRENT' },
      }),
    ).toThrow();
  });

  it('keeps expected classifications in the typed success union while dropping private nested evidence', () => {
    const cases: readonly PricingExplicitInputEvaluationResult[] = [
      {
        _tag: 'KNOWN_INVALID',
        context,
        evidenceRefs: ['safe-evidence-ref'],
        outcome: 'PRICING_CONFIGURATION_ERROR',
        reason: 'UNSUPPORTED_CURRENCY',
        retryable: false,
        subject: 'CURRENCY_SUPPORT',
      },
      {
        _tag: 'CONFLICT',
        context,
        currentTruthRefs: ['current-truth-1', 'current-truth-2'],
        outcome: 'PRICING_CONFLICT',
        reason: 'COMPETING_CURRENT_EXACT_PRICES',
        retryable: false,
        subject: 'EXACT_PRICE',
      },
      {
        _tag: 'STALE',
        context,
        outcome: 'PRICING_STALE',
        reason: 'MATERIAL_INPUT_CHANGED',
        retryable: true,
        staleEvidence: {
          assessedAt: '2026-09-27T19:59:58.000Z',
          invalidatedAt: '2026-09-27T19:59:59.000Z',
          invalidatedRevision: 'private-revision',
        },
        subject: 'EXACT_PRICE',
      },
      {
        _tag: 'INDETERMINATE',
        context,
        inabilityEvidence: {
          attempts: 1,
          evidenceRefs: ['private-attempt-ref'],
          requiredOwners: ['PRICING_EXACT_PRICE'],
        },
        outcome: 'PRICING_INDETERMINATE',
        reason: 'EXACT_PRICE_STATE_UNVERIFIABLE',
        retryable: true,
        subject: 'EXACT_PRICE',
      },
      {
        _tag: 'NON_CANONICAL_ASSERTION_HELD',
        assessment: {
          outcome: 'PRICE_SOURCE_ASSERTION_UNRESOLVED_HELD',
          reason: 'AUTHORITATIVE_PRE_TAX_NORMALIZATION_MISSING',
          sourceAssertionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        },
        context,
        outcome: 'PRICING_INDETERMINATE',
        reason: 'AUTHORITATIVE_PRE_TAX_NORMALIZATION_MISSING',
        retryable: true,
        subject: 'SOURCE_ASSERTION',
      },
    ];

    for (const internal of cases) {
      const response = toExactPriceResolutionResponse(context, internal);
      expect(decodeResponse(response)).toEqual(response);
      expect(response).not.toHaveProperty('assessment');
      expect(response).not.toHaveProperty('currentTruthRefs');
      expect(response).not.toHaveProperty('evidenceRefs');
      expect(response).not.toHaveProperty('inabilityEvidence');
      expect(response).not.toHaveProperty('staleEvidence');
    }
  });

  it('fails closed on a mismatched internal context without exposing the mismatched result', () => {
    const mismatchedContext = decodeContext({
      ...context,
      tenantId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    });
    const result: PricingExplicitInputEvaluationResult = {
      _tag: 'KNOWN_INVALID',
      context: mismatchedContext,
      evidenceRefs: ['other-tenant-evidence'],
      outcome: 'PRICING_CONFIGURATION_ERROR',
      reason: 'INVALID_CANONICAL_CONFIGURATION',
      retryable: false,
      subject: 'EXACT_PRICE',
    };

    const response = toExactPriceResolutionResponse(context, result);
    expect(Schema.is(ExactPriceResolutionIndeterminateResponseSchema)(response)).toBe(true);
    expect(response).toMatchObject({
      context,
      outcome: 'PRICING_INDETERMINATE',
      reason: 'CURRENTNESS_UNVERIFIABLE',
      retryable: true,
      subject: 'EXACT_PRICE',
    });
  });

  it('rejects internal evidence if it is injected into a public response', () => {
    expect(() =>
      decodeResponse({
        _tag: 'CONFLICT',
        context,
        currentTruthRefs: ['private-truth-1', 'private-truth-2'],
        outcome: 'PRICING_CONFLICT',
        reason: 'COMPETING_CURRENT_EXACT_PRICES',
        retryable: false,
        subject: 'EXACT_PRICE',
      }),
    ).toThrow();
  });
});
