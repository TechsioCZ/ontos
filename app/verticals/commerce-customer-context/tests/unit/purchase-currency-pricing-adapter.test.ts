import {
  CurrentSupportedCurrenciesResponseSchema,
  CurrentSupportedCurrenciesSuccessSchema,
  CurrentSupportedCurrenciesV2CompatibilitySuccessSchema,
} from '@app/pricing-contracts';
import type { GatewayDelegationRequest } from '@app/shared-contracts/gateway-context-server';
import { layer as nodeCryptoLayer } from '@effect/platform-node/NodeCrypto';
import { Effect, Redacted, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { PurchaseCurrencyDependencyUnavailable } from '../../shared/domain/purchase-currency-dependency.ts';
import { purchaseCurrencyPricingPortFromEnvironment } from '../../src/integrations/purchase-currency-pricing.ts';
import {
  fakeDelegatedAcquire,
  issuedDelegatedContext,
  originatorSubject,
} from '../support/delegated-gateway-acquisition.fixture.ts';

const tenantId = '20000000-0000-4000-8000-000000000001';
const effectiveAt = '2026-09-22T09:59:59.000Z';
const observedAt = '2026-09-22T10:00:00.000Z';
const supportRootId = '30000000-0000-4000-8000-000000000001';
const supportRevisionId = '31000000-0000-4000-8000-000000000001';
const verificationRef = `commerce.pricing.currency-support-proof:${supportRevisionId}`;
const issued = issuedDelegatedContext({ compositionRevision: 'a'.repeat(64), token: 'pricing-owner-issued' });
const acquisitions: GatewayDelegationRequest[] = [];
const acquire = fakeDelegatedAcquire(issued, acquisitions);
const subject = originatorSubject('a'.repeat(64), tenantId);
const currentResponse = Schema.decodeSync(CurrentSupportedCurrenciesSuccessSchema)({
  completenessEvidence: {
    nextApplicabilityBoundary: '2026-10-01T00:00:00.000Z',
    observedAt,
    ownerRevision: supportRevisionId,
    scope: { kind: 'EXACT_PREDICATE', predicateRef: `commerce.pricing.current-supported-currencies:${tenantId}` },
  },
  currentnessEvidence: {
    evaluatedAt: observedAt,
    evaluationMode: 'CURRENT_WITH_REVALIDATION',
    observedAt,
    revalidatedAt: observedAt,
    scheduleRevision: 7,
    supportRevisionRef: {
      moduleId: 'commerce.pricing',
      resourceId: supportRevisionId,
      resourceType: 'commerce.pricing.currency-support-revision',
      supportRootId,
      tenantId,
    },
    supportRootRef: {
      moduleId: 'commerce.pricing',
      resourceId: supportRootId,
      resourceType: 'commerce.pricing.currency-support',
      tenantId,
    },
  },
  effectiveAt,
  effectivePeriod: {
    effectiveFrom: '2026-09-01T00:00:00.000Z',
    effectiveTo: '2026-10-01T00:00:00.000Z',
  },
  factProofs: [{ factRef: supportRootId, factRevisionRef: supportRevisionId, verificationRef }],
  generation: 3,
  nextApplicabilityBoundary: '2026-10-01T00:00:00.000Z',
  observedAt,
  outcome: 'SUPPORTED_CURRENCIES_CURRENT',
  pricingRevision: 'pricing:73',
  scheduleRevision: 7,
  supportedCurrencies: ['CZK', 'EUR'],
  supportRevisionRef: {
    moduleId: 'commerce.pricing',
    resourceId: supportRevisionId,
    resourceType: 'commerce.pricing.currency-support-revision',
    supportRootId,
    tenantId,
  },
  supportRootRef: {
    moduleId: 'commerce.pricing',
    resourceId: supportRootId,
    resourceType: 'commerce.pricing.currency-support',
    tenantId,
  },
  tenantId,
  verificationRef,
});

const { outcome: _ownerOutcome, ...currentSupportEvidence } = currentResponse;

describe('Purchase Currency Pricing production adapter', () => {
  it.effect('sends only Tenant and effective time and preserves the complete owner proof', () =>
    Effect.gen(function* exactOwnerRequest() {
      const calls: unknown[] = [];
      const port = yield* purchaseCurrencyPricingPortFromEnvironment(
        {
          requestCorrelation: 'pricing-test',
          subject,
        },
        (payload, credential, correlation, options) => {
          calls.push({ correlation, credential: Redacted.value(credential), options, payload });
          return Effect.succeed(currentResponse);
        },
        acquire,
      );
      const result = yield* port.resolveCurrent({
        effectiveAt,
        tenantId,
      });

      expect(calls).toEqual([
        {
          correlation: 'pricing-test',
          credential: 'Bearer pricing-owner-issued',
          options: { baseUrl: new URL('https://shell.example.test/owner-api'), compositionRevision: 'a'.repeat(64) },
          payload: { effectiveAt, tenantId },
        },
      ]);
      expect(acquisitions).toEqual([
        {
          audience: 'pricing',
          callingAppId: 'commerce-customer-context',
          legalEntityScope: 'tenant',
          requestCorrelation: 'pricing-test',
          subject,
        },
      ]);
      expect(result).toEqual(currentSupportEvidence);
      expect(result.currentnessEvidence.evaluatedAt).not.toBe(result.effectiveAt);
      expect(result.observedAt).not.toBe(result.effectiveAt);
    }).pipe(Effect.provide(nodeCryptoLayer)),
  );

  it.effect('maps every non-current owner outcome to the typed Pricing dependency failure', () =>
    Effect.gen(function* typedOwnerFailures() {
      for (const [outcome, code] of [
        ['SUPPORTED_CURRENCIES_INVALID', 'pricing_currency_support_invalid'],
        ['SUPPORTED_CURRENCIES_STALE', 'pricing_currency_support_stale'],
        ['SUPPORTED_CURRENCIES_UNAVAILABLE', 'pricing_currency_support_unavailable'],
        ['SUPPORTED_CURRENCIES_UNVERIFIABLE', 'pricing_currency_support_unverifiable'],
      ] as const) {
        const response = Schema.decodeUnknownSync(CurrentSupportedCurrenciesResponseSchema)(
          outcome === 'SUPPORTED_CURRENCIES_STALE'
            ? {
                code: 'pricing-stale',
                observedAt,
                outcome,
                pricingRevision: 'pricing:72',
                reason: `${outcome} owner result`,
                retryable: true,
              }
            : {
                code: 'pricing-not-current',
                outcome,
                reason: `${outcome} owner result`,
                retryable: outcome === 'SUPPORTED_CURRENCIES_UNAVAILABLE',
              },
        );
        const port = yield* purchaseCurrencyPricingPortFromEnvironment(
          {
            requestCorrelation: 'pricing-test',
            subject,
          },
          () => Effect.succeed(response),
          acquire,
        );
        const failure = yield* port
          .resolveCurrent({
            effectiveAt,
            tenantId,
          })
          .pipe(Effect.flip);
        expect(Schema.is(PurchaseCurrencyDependencyUnavailable)(failure)).toBe(true);
        expect(failure).toMatchObject({ code, retryable: true });
      }
    }).pipe(Effect.provide(nodeCryptoLayer)),
  );

  it.effect('fails typed when a malformed Current response claims an empty support set', () =>
    Effect.gen(function* malformedCurrentSupport() {
      const port = yield* purchaseCurrencyPricingPortFromEnvironment(
        {
          requestCorrelation: 'pricing-test',
          subject,
        },
        () => Effect.succeed({ ...currentResponse, supportedCurrencies: [] }),
        acquire,
      );
      const failure = yield* port.resolveCurrent({ effectiveAt, tenantId }).pipe(Effect.flip);

      expect(Schema.is(PurchaseCurrencyDependencyUnavailable)(failure)).toBe(true);
      expect(failure).toMatchObject({ code: 'pricing_currency_support_unverifiable', retryable: true });
    }).pipe(Effect.provide(nodeCryptoLayer)),
  );

  it.effect('fails closed when the read-only v2 compatibility success lacks canonical owner evidence', () => {
    const compatibilityResponse = Schema.decodeUnknownSync(CurrentSupportedCurrenciesV2CompatibilitySuccessSchema)({
      completenessEvidence: {
        ...currentResponse.completenessEvidence,
        ownerRevision: currentResponse.pricingRevision,
      },
      effectiveAt: currentResponse.effectiveAt,
      nextApplicabilityBoundary: currentResponse.nextApplicabilityBoundary,
      observedAt: currentResponse.observedAt,
      outcome: currentResponse.outcome,
      pricingRevision: currentResponse.pricingRevision,
      supportedCurrencies: currentResponse.supportedCurrencies,
    });
    return Effect.gen(function* compatibilityCannotAuthorizePurchase() {
      const port = yield* purchaseCurrencyPricingPortFromEnvironment(
        {
          requestCorrelation: 'pricing-test',
          subject,
        },
        () => Effect.succeed(compatibilityResponse),
        acquire,
      );
      const failure = yield* port.resolveCurrent({ effectiveAt, tenantId }).pipe(Effect.flip);

      expect(Schema.is(PurchaseCurrencyDependencyUnavailable)(failure)).toBe(true);
      expect(failure).toMatchObject({ code: 'pricing_currency_support_unverifiable', retryable: true });
    }).pipe(Effect.provide(nodeCryptoLayer));
  });
});
