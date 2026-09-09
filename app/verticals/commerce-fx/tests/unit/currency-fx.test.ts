import { expect, it } from 'effect-rstest';
import { DateTime, Effect, Match, Schema } from 'effect';
import { ReadPermissionDenied } from '../../../../packages/core-runtime/src/reads/read-permission-denied.ts';
import {
  CommercialFxConversionDomainConflictProblem,
  CommercialFxConversionDomainConflictProblemSchema,
  CommercialFxConversionDomainPolicyProblem,
  CommercialFxConversionDomainPolicyProblemSchema,
  CommercialFxConversionDomainUnavailableProblem,
  CommercialFxConversionDomainUnavailableProblemSchema,
  CommercialFxConversionResponseSchema,
} from '../../shared/apis/commercial-fx-conversion.ts';
import {
  CommercialFxDisclosurePolicy,
  makePurchaseLimitCommercialFxDisclosurePolicy,
  redactCommercialFxEvidence,
} from '../../shared/domain/commercial-fx-disclosure.ts';
import {
  COMMERCIAL_FX_ARITHMETIC_VERSION,
  ExactDecimalSchema,
  FxCurrencyCodeSchema,
  FxInconsistentRatePolicy,
  FxRateExpiredOrStale,
  FxRateUnavailable,
  FxRoundingRuleMissing,
  FxSourceNotConfigured,
  FxSourceResultIndeterminate,
  FxConversionRedactedSchema,
  commercialFxOutcome,
  convertCommercialFx,
  unconfiguredCommercialFxPorts,
} from '../../shared/domain/commercial-fx-conversion.ts';
import type {
  CommercialFxConversionRequest,
  CommercialFxPorts,
  FxConversionPolicy,
  FxRateQuote,
} from '../../shared/domain/commercial-fx-conversion.ts';
import {
  handleCommercialFxConversion,
  makeCommercialFxConversionServices,
} from '../../src/api/commercial-fx-conversion.read.ts';

const instant = (value: string) => DateTime.makeUnsafe(value);
const request = (
  source = 'CZK',
  target = 'EUR',
  amount = '100',
): CommercialFxConversionRequest => ({
  contextRevision: 'context-1',
  purchasingContext: {
    channelId: 'web',
    marketId: 'cz',
    sellingLegalEntityId: '40000000-0000-4000-8000-000000000001',
    storefrontId: 'akros-cz',
    tenantId: '20000000-0000-4000-8000-000000000001',
  },
  purpose: 'PURCHASE_LIMIT_COMPARISON',
  requestedAt: instant('2026-09-09T10:00:00Z'),
  sourceAmount: { amount, currencyCode: source },
  targetCurrencyCode: target,
});

const policy: FxConversionPolicy = {
  arithmeticVersion: COMMERCIAL_FX_ARITHMETIC_VERSION,
  inverseRatePermitted: true,
  maximumRateAgeSeconds: 7200,
  policyRevision: 'fx-policy-1',
  purpose: 'PURCHASE_LIMIT_COMPARISON',
  rateSourceId: 'cnb-commercial',
  roundingIncrement: '0.01',
  roundingMode: 'half-even',
  roundingRule: 'QUANTIZE_TO_INCREMENT',
  roundingRuleRevision: 'rounding-rule-1',
  targetMinorUnits: 2,
};

const disclosureScope = {
  authMethod: 'system' as const,
  legalEntityId: request().purchasingContext.sellingLegalEntityId,
  principalId: '50000000-0000-4000-8000-000000000001',
  tenantId: request().purchasingContext.tenantId,
  trustedStorefrontId: request().purchasingContext.storefrontId,
};

const quote = (overrides: Partial<FxRateQuote> = {}): FxRateQuote => ({
  direction: 'SOURCE_TO_TARGET',
  observedAt: instant('2026-09-09T09:00:00Z'),
  providerCorrelationRef: 'quote-1',
  rate: '0.04',
  rateSourceId: 'cnb-commercial',
  retrievedAt: instant('2026-09-09T09:01:00Z'),
  sourceCurrencyCode: 'CZK',
  targetCurrencyCode: 'EUR',
  validFrom: instant('2026-09-09T00:00:00Z'),
  validTo: instant('2026-09-10T00:00:00Z'),
  ...overrides,
});

const ports = (rateQuote = quote()): CommercialFxPorts => ({
  context: {
    resolveCurrent: (claimed) =>
      Effect.succeed({
        contextRevision: claimed.contextRevision,
        observedAt: instant('2026-09-09T10:00:00Z'),
        purchasingContext: claimed.purchasingContext,
      }),
  },
  policy: { resolve: () => Effect.succeed(policy) },
  rate: { quote: () => Effect.succeed(rateQuote) },
});

it('accepts bounded exact decimals and uppercase three-letter currencies only', () => {
  for (const value of ['0', '0.01', '-1.5', '99999999999999999999999999999999999999']) {
    expect(Schema.is(ExactDecimalSchema)(value)).toBe(true);
  }
  for (const value of ['01', '+1', '1e2', '1.1234567890123456789']) {
    expect(Schema.is(ExactDecimalSchema)(value)).toBe(false);
  }
  expect(Schema.is(FxCurrencyCodeSchema)('CZK')).toBe(true);
  expect(Schema.is(FxCurrencyCodeSchema)('czk')).toBe(false);
});

it.effect('performs no policy or provider call for same-currency conversion', () =>
  Effect.gen(function* sameCurrencyFastPath() {
    let called = false;
    const guarded: CommercialFxPorts = {
      context: {
        resolveCurrent: (claimed) =>
          Effect.succeed({
            contextRevision: claimed.contextRevision,
            observedAt: instant('2026-09-09T10:00:00Z'),
            purchasingContext: claimed.purchasingContext,
          }),
      },
      policy: {
        resolve: () => {
          called = true;
          return Effect.fail(FxSourceNotConfigured.make({ reason: 'must not be called' }));
        },
      },
      rate: {
        quote: () => {
          called = true;
          return Effect.fail(
            FxRateUnavailable.make({
              reason: 'must not be called',
              retryable: true,
            }),
          );
        },
      },
    };
    const result = yield* convertCommercialFx(request('CZK', 'CZK'), guarded);
    const usedFastPath = Match.value(result).pipe(
      Match.tag('SAME_CURRENCY_NO_CONVERSION', () => true),
      Match.orElse(() => false),
    );
    expect(usedFastPath).toBe(true);
    expect(called).toBe(false);
  }),
);

it.effect('fails closed when Current trusted context is unavailable', () =>
  Effect.gen(function* unavailableTrustedContext() {
    const result = yield* commercialFxOutcome(request(), unconfiguredCommercialFxPorts);
    expect(Schema.is(FxSourceResultIndeterminate)(result)).toBe(true);
    expect(result).toMatchObject({ retryable: true });
  }),
);

it.effect('fails closed when no cross-currency policy or rate source is configured', () =>
  Effect.gen(function* unconfiguredCrossCurrencyPolicy() {
    const configuredContextOnly: CommercialFxPorts = {
      ...unconfiguredCommercialFxPorts,
      context: ports().context,
    };
    const result = yield* commercialFxOutcome(request(), configuredContextOnly);
    expect(Schema.is(FxSourceNotConfigured)(result)).toBe(true);
  }),
);

it.effect('uses exact multiplication and the configured half-even rounding once', () =>
  Effect.gen(function* exactConversion() {
    const result = yield* convertCommercialFx(request('CZK', 'EUR', '101'), ports());
    const wasResolved = Match.value(result).pipe(
      Match.tag('FX_CONVERSION_RESOLVED', (resolved) => {
        expect(resolved.resultAmount).toEqual({
          amount: '4.04',
          currencyCode: 'EUR',
        });
        expect(resolved).toMatchObject({
          arithmeticVersion: 'commercial-fx-arithmetic.v1',
          roundingIncrement: '0.01',
          roundingRule: 'QUANTIZE_TO_INCREMENT',
          roundingRuleRevision: 'rounding-rule-1',
        });
        expect(resolved).toMatchObject({
          normalizedRate: '0.04',
          purpose: 'PURCHASE_LIMIT_COMPARISON',
          quotedRate: '0.04',
        });
        return true;
      }),
      Match.orElse(() => false),
    );
    expect(wasResolved).toBe(true);
  }),
);

it.effect('quantizes once to the explicit rounding increment and rejects incompatible rules', () =>
  Effect.gen(function* explicitRoundingIncrement() {
    const incrementPolicy = { ...policy, roundingIncrement: '0.05' };
    const resolved = yield* convertCommercialFx(request('CZK', 'EUR', '100.75'), {
      ...ports(quote()),
      policy: { resolve: () => Effect.succeed(incrementPolicy) },
    });
    expect(resolved.resultAmount).toEqual({
      amount: '4.05',
      currencyCode: 'EUR',
    });

    const invalid = yield* commercialFxOutcome(request(), {
      ...ports(),
      policy: {
        resolve: () => Effect.succeed({ ...policy, roundingIncrement: '0.001' }),
      },
    });
    expect(Schema.is(FxRoundingRuleMissing)(invalid)).toBe(true);
  }),
);

it.effect(
  'redacts quote evidence by default and discloses it only on an explicit trusted allow',
  () =>
    Effect.gen(function* commercialFxDisclosureGate() {
      const redactedServices = yield* makeCommercialFxConversionServices(
        ports(),
        disclosureScope,
      ).pipe(Effect.provideService(CommercialFxDisclosurePolicy, redactCommercialFxEvidence));
      const redacted = yield* redactedServices.convert(request());
      expect(Schema.is(FxConversionRedactedSchema)(redacted)).toBe(true);
      expect('quotedRate' in redacted).toBe(false);
      expect('rateSourceId' in redacted).toBe(false);
      expect('providerCorrelationRef' in redacted).toBe(false);

      const exactPolicy = makePurchaseLimitCommercialFxDisclosurePolicy({
        authMethod: 'system',
        legalEntityId: disclosureScope.legalEntityId,
        principalId: disclosureScope.principalId,
        tenantId: disclosureScope.tenantId,
        trustedStorefrontId: disclosureScope.trustedStorefrontId,
      });
      const exactServices = yield* makeCommercialFxConversionServices(
        ports(),
        disclosureScope,
      ).pipe(Effect.provideService(CommercialFxDisclosurePolicy, exactPolicy));
      const exact = yield* exactServices.convert(request());
      expect(Schema.is(FxConversionRedactedSchema)(exact)).toBe(false);
      expect(exact).toMatchObject({
        providerCorrelationRef: 'quote-1',
        quotedRate: '0.04',
        rateSourceId: 'cnb-commercial',
      });

      const apiKeyPolicy = makePurchaseLimitCommercialFxDisclosurePolicy({
        authMethod: 'api_key',
        legalEntityId: disclosureScope.legalEntityId,
        principalId: disclosureScope.principalId,
        tenantId: disclosureScope.tenantId,
        trustedStorefrontId: disclosureScope.trustedStorefrontId,
      });
      const apiKeyServices = yield* makeCommercialFxConversionServices(ports(), {
        ...disclosureScope,
        authMethod: 'api_key',
      }).pipe(Effect.provideService(CommercialFxDisclosurePolicy, apiKeyPolicy));
      const apiKeyExact = yield* apiKeyServices.convert(request());
      expect(Schema.is(FxConversionRedactedSchema)(apiKeyExact)).toBe(false);

      const wrongPrincipalServices = yield* makeCommercialFxConversionServices(ports(), {
        ...disclosureScope,
        principalId: '50000000-0000-4000-8000-000000000099',
      }).pipe(Effect.provideService(CommercialFxDisclosurePolicy, exactPolicy));
      const wrongPrincipal = yield* wrongPrincipalServices.convert(request());
      expect(Schema.is(FxConversionRedactedSchema)(wrongPrincipal)).toBe(true);

      const publicPurposeServices = yield* makeCommercialFxConversionServices(
        {
          ...ports(),
          policy: {
            resolve: () => Effect.succeed({ ...policy, purpose: 'DISPLAY' }),
          },
        },
        disclosureScope,
      ).pipe(Effect.provideService(CommercialFxDisclosurePolicy, exactPolicy));
      const publicPurpose = yield* publicPurposeServices.convert({
        ...request(),
        purpose: 'DISPLAY',
      });
      expect(Schema.is(FxConversionRedactedSchema)(publicPurpose)).toBe(true);
    }),
);

it.effect('derives an inverse quote only when policy explicitly permits it', () =>
  Effect.gen(function* inverseConversion() {
    const inverseQuote = quote({ direction: 'TARGET_TO_SOURCE', rate: '25' });
    const result = yield* convertCommercialFx(request(), ports(inverseQuote));
    const wasResolved = Match.value(result).pipe(
      Match.tag('FX_CONVERSION_RESOLVED', (resolved) => {
        expect(resolved.resultAmount).toEqual({
          amount: '4',
          currencyCode: 'EUR',
        });
        expect(resolved.normalizedRate).toBe('0.04');
        expect(resolved.quotedRate).toBe('25');
        return true;
      }),
      Match.orElse(() => false),
    );
    expect(wasResolved).toBe(true);

    const guardedPorts: CommercialFxPorts = {
      context: ports(inverseQuote).context,
      policy: {
        resolve: () => Effect.succeed({ ...policy, inverseRatePermitted: false }),
      },
      rate: { quote: () => Effect.succeed(inverseQuote) },
    };
    const rejected = yield* commercialFxOutcome(request(), guardedPorts);
    expect(Schema.is(FxInconsistentRatePolicy)(rejected)).toBe(true);
  }),
);

it.effect('rejects an expired rate as a typed failure', () =>
  Effect.gen(function* expiredRate() {
    const failure = yield* convertCommercialFx(
      request(),
      ports(quote({ validTo: instant('2026-09-09T10:00:00Z') })),
    ).pipe(Effect.flip);
    expect(Schema.is(FxRateExpiredOrStale)(failure)).toBe(true);
  }),
);

it.effect('rejects a rate older than the purpose-specific freshness policy', () =>
  Effect.gen(function* staleByPolicyAge() {
    const guardedPorts: CommercialFxPorts = {
      ...ports(),
      policy: {
        resolve: () => Effect.succeed({ ...policy, maximumRateAgeSeconds: 3599 }),
      },
    };
    const failure = yield* convertCommercialFx(request(), guardedPorts).pipe(Effect.flip);
    expect(Schema.is(FxRateExpiredOrStale)(failure)).toBe(true);
  }),
);

it.effect('rejects quote source and pair mismatches as indeterminate', () =>
  Effect.gen(function* mismatchedQuoteEvidence() {
    const wrongSource = yield* commercialFxOutcome(
      request(),
      ports(quote({ rateSourceId: 'unexpected-source' })),
    );
    expect(Schema.is(FxSourceResultIndeterminate)(wrongSource)).toBe(true);
    expect(wrongSource).toMatchObject({ retryable: true });

    const wrongPair = yield* commercialFxOutcome(
      request(),
      ports(quote({ targetCurrencyCode: 'USD' })),
    );
    expect(Schema.is(FxSourceResultIndeterminate)(wrongPair)).toBe(true);
  }),
);

it.effect('schema-validates every public FX source response before using it', () =>
  Effect.gen(function* invalidPublicSourceResults() {
    const malformedContextPorts = {
      ...ports(),
      context: {
        resolveCurrent: () =>
          Effect.succeed({
            contextRevision: '',
            observedAt: 'not-an-instant',
            purchasingContext: request().purchasingContext,
          }),
      },
    };
    const malformedContext = yield* commercialFxOutcome(
      request(),
      // @ts-expect-error -- This intentionally simulates a malformed response from an untrusted port implementation.
      malformedContextPorts,
    );
    expect(Schema.is(FxSourceResultIndeterminate)(malformedContext)).toBe(true);

    const malformedPolicyPorts = {
      ...ports(),
      policy: {
        resolve: () => Effect.succeed({ ...policy, maximumRateAgeSeconds: -1 }),
      },
    };
    const malformedPolicy = yield* commercialFxOutcome(request(), malformedPolicyPorts);
    expect(Schema.is(FxSourceResultIndeterminate)(malformedPolicy)).toBe(true);

    const malformedQuotePorts = {
      ...ports(),
      rate: {
        quote: () => Effect.succeed({ ...quote(), rate: 'NaN' }),
      },
    };
    const malformedQuote = yield* commercialFxOutcome(request(), malformedQuotePorts);
    expect(Schema.is(FxSourceResultIndeterminate)(malformedQuote)).toBe(true);
  }),
);

it.effect('rejects a caller context that differs from the Current trusted context', () =>
  Effect.gen(function* mismatchedTrustedContext() {
    const guardedPorts: CommercialFxPorts = {
      ...ports(),
      context: {
        resolveCurrent: (claimed) =>
          Effect.succeed({
            contextRevision: 'context-2',
            observedAt: instant('2026-09-09T10:00:00Z'),
            purchasingContext: {
              ...claimed.purchasingContext,
              storefrontId: 'other-storefront',
            },
          }),
      },
    };
    const result = yield* commercialFxOutcome(request(), guardedPorts);
    expect(Schema.is(FxSourceResultIndeterminate)(result)).toBe(true);
  }),
);

it.effect('uses trusted server time and rejects future provider timestamps', () =>
  Effect.gen(function* futureProviderEvidence() {
    const result = yield* commercialFxOutcome(
      { ...request(), requestedAt: instant('2020-01-01T00:00:00Z') },
      ports(quote({ observedAt: instant('2026-09-09T10:00:01Z') })),
    );
    expect(Schema.is(FxRateExpiredOrStale)(result)).toBe(true);
  }),
);

it.effect('returns a typed failure when the converted result exceeds supported precision', () =>
  Effect.gen(function* overflowingConversion() {
    const result = yield* commercialFxOutcome(
      request('CZK', 'EUR', '99999999999999999999999999999999999999'),
      ports(quote({ rate: '10' })),
    );
    expect(Schema.is(FxInconsistentRatePolicy)(result)).toBe(true);
  }),
);

it.effect('keeps FX failures out of HTTP success and exposes typed reason codes', () =>
  Effect.gen(function* typedFxHttpContract() {
    const success = yield* convertCommercialFx(request('CZK', 'CZK'), ports());
    const failure = yield* commercialFxOutcome(
      request(),
      ports(quote({ validTo: instant('2026-09-09T10:00:00Z') })),
    );
    expect(Schema.is(CommercialFxConversionResponseSchema)(success)).toBe(true);
    expect(Schema.is(CommercialFxConversionResponseSchema)(failure)).toBe(false);
    expect(
      Schema.is(CommercialFxConversionDomainPolicyProblemSchema)(
        new CommercialFxConversionDomainPolicyProblem({
          detail: 'The currency pair is not supported.',
          reasonCode: 'UNSUPPORTED_CURRENCY_PAIR',
          status: 422,
          title: 'FX conversion ineligible',
          type: 'https://ontos.dev/problems/commercial-fx-ineligible',
        }),
      ),
    ).toBe(true);
    expect(
      Schema.is(CommercialFxConversionDomainConflictProblemSchema)(
        new CommercialFxConversionDomainConflictProblem({
          detail: 'The Current rate policy conflicts.',
          reasonCode: 'INCONSISTENT_RATE_POLICY',
          status: 409,
          title: 'FX conversion conflict',
          type: 'https://ontos.dev/problems/commercial-fx-conflict',
        }),
      ),
    ).toBe(true);
    expect(
      Schema.is(CommercialFxConversionDomainUnavailableProblemSchema)(
        new CommercialFxConversionDomainUnavailableProblem({
          detail: 'The Current rate is stale.',
          reasonCode: 'RATE_EXPIRED_OR_STALE',
          retryable: true,
          status: 503,
          title: 'FX conversion unavailable',
          type: 'https://ontos.dev/problems/commercial-fx-unavailable',
        }),
      ),
    ).toBe(true);
  }),
);

it.effect('keeps FX source failures in the governed Read error channel', () =>
  Effect.gen(function* governedFxFailureChannel() {
    const services = yield* makeCommercialFxConversionServices(
      unconfiguredCommercialFxPorts,
      disclosureScope,
    ).pipe(Effect.provideService(CommercialFxDisclosurePolicy, redactCommercialFxEvidence));
    const failure = yield* services.convert(request()).pipe(Effect.flip);
    expect(Schema.is(FxSourceResultIndeterminate)(failure)).toBe(true);
  }),
);

it.effect('rejects a caller-selected Storefront before invoking FX conversion', () =>
  Effect.gen(function* rejectedFxStorefrontClaim() {
    let invoked = false;
    const failure = yield* handleCommercialFxConversion(request(), {
      readKey: 'commerce.fx.api.commercial-fx-conversion',
      scope: {
        authMethod: 'system',
        correlationId: 'fx-storefront-isolation',
        legalEntityId: request().purchasingContext.sellingLegalEntityId,
        principalId: '50000000-0000-4000-8000-000000000001',
        tenantId: request().purchasingContext.tenantId,
        trustedStorefrontId: 'another-storefront',
      },
      services: {
        convert: () => {
          invoked = true;
          return Effect.die('must not convert an untrusted Storefront request');
        },
      },
    }).pipe(Effect.flip);
    expect(Schema.is(ReadPermissionDenied)(failure)).toBe(true);
    expect(invoked).toBe(false);
  }),
);
