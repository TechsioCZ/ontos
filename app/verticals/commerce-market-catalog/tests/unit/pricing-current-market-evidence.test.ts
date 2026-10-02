import type { OperationalScope } from '@app/core-runtime';
import { ReadPermissionDenied, TrustedPrincipalContextSchema } from '@app/core-runtime';
import { DateTime, Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PricingCurrentMarketEvidenceRequestSchema,
  PricingCurrentMarketEvidenceResponseSchema,
} from '../../shared/apis/pricing-current-market-evidence.ts';
import { EffectivePeriodSchema, MarketDefinitionSchema } from '../../shared/market-contracts.ts';
import { handlePricingCurrentMarketEvidence } from '../../src/api/pricing-current-market-evidence.read.ts';
import type {
  PricingCurrentMarketEvidencePersistence,
  PricingCurrentMarketSnapshot,
} from '../../src/persistence/pricing-current-market-evidence-persistence.ts';
import {
  PricingCurrentMarketEvidencePersistenceUnavailable,
  pricingCurrentMarketEvidencePersistenceForScope,
} from '../../src/persistence/pricing-current-market-evidence-persistence.ts';
import { readPricingCurrentMarketEvidence } from '../../src/services/pricing-current-market-evidence.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const sellerId = '22222222-2222-4222-8222-222222222222';
const marketId = '33333333-3333-4333-8333-333333333333';
const definitionId = '44444444-4444-4444-8444-444444444444';
const lifecycleId = '55555555-5555-4555-8555-555555555555';
const operationTime = '2026-09-28T12:00:00.000Z';
const observedAt = '2026-09-28T12:00:00.300Z';
const boundary = '2026-10-01T00:00:00.000Z';

const request = Schema.decodeUnknownSync(PricingCurrentMarketEvidenceRequestSchema)({
  commercialScope: {
    channel: 'B2C',
    marketRef: {
      moduleId: 'commerce.market-catalog',
      resourceId: marketId,
      resourceType: 'commerce.market-catalog.market',
      tenantId,
    },
    sellingLegalEntityRef: {
      moduleId: 'core.identity',
      resourceId: sellerId,
      resourceType: 'core.identity.legal-entity',
      tenantId,
    },
  },
  effectiveAt: operationTime,
  requestedAt: operationTime,
});

const market = Schema.decodeUnknownSync(MarketDefinitionSchema)({
  channels: ['B2C', 'B2B'],
  definitionRevisionRef: {
    moduleId: 'commerce.market-catalog',
    resourceId: definitionId,
    resourceType: 'commerce.market-catalog.market-definition-revision',
    tenantId,
  },
  effectivePeriod: { startsAt: '2026-01-01T00:00:00.000Z' },
  jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }],
  lifecycle: 'ACTIVE',
  marketCode: 'CZ_MAIN',
  marketRef: request.commercialScope.marketRef,
  purpose: 'Czech commerce',
  revision: 4,
  sellingLegalEntityRef: request.commercialScope.sellingLegalEntityRef,
  supportedLocales: ['cs-CZ'],
});

const presentSnapshot: PricingCurrentMarketSnapshot = {
  definitionRevisionRef: definitionId,
  effectivePeriod: Schema.decodeUnknownSync(EffectivePeriodSchema)({
    endsAt: boundary,
    startsAt: '2026-01-01T00:00:00.000Z',
  }),
  generation: 9,
  lifecycleRevisionRef: lifecycleId,
  market,
  nextApplicabilityBoundary: Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)(boundary),
  observedAt: Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)(observedAt),
  state: 'PRESENT',
};

const trustedScope = { legalEntityId: sellerId, tenantId };
const persistence = (snapshot: PricingCurrentMarketSnapshot): PricingCurrentMarketEvidencePersistence => ({
  readCurrent: () => Effect.succeed(snapshot),
});

const operationalScope: OperationalScope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: '66666666-6666-4666-8666-666666666666',
    authContextRef: 'session:pricing-current-market-evidence',
    authMethod: 'session',
    legalEntityId: sellerId,
    principalId: '77777777-7777-4777-8777-777777777777',
    tenantId,
  }),
  correlationId: 'pricing-current-market-evidence-test',
};

describe('Pricing Current Market evidence owner boundary', () => {
  it.effect('issues exact present evidence and verifies the retained receipt through a later fence', () =>
    Effect.gen(function* presentAndReplay() {
      const initial = yield* readPricingCurrentMarketEvidence(persistence(presentSnapshot), request, trustedScope);

      expect(initial.outcome).toBe('PRICING_MARKET_SOURCE_PRESENT');
      if (initial.outcome !== 'PRICING_MARKET_SOURCE_PRESENT') {
        return;
      }
      expect(initial.market.marketRef.resourceId).toBe(marketId);
      expect(initial.receipt.state).toBe('PRESENT');
      expect(initial.receipt.currentFacts[0]?.factRevisionRef).toContain(definitionId);
      expect(initial.receipt.authority.predicateRef).toContain(`${sellerId}:B2C:${marketId}`);

      const replayRequest: typeof request = {
        ...request,
        retainedReceipt: initial.receipt,
        verifyThrough: Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)(observedAt),
      };
      const replay = yield* readPricingCurrentMarketEvidence(
        persistence({
          ...presentSnapshot,
          observedAt: Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)('2026-09-28T12:00:00.600Z'),
        }),
        replayRequest,
        trustedScope,
      );
      expect(replay.outcome).toBe('PRICING_MARKET_SOURCE_PRESENT');
      if (replay.outcome === 'PRICING_MARKET_SOURCE_PRESENT' && replay.verifiedThrough !== undefined) {
        expect(DateTime.formatIso(replay.verifiedThrough)).toBe(observedAt);
        expect(DateTime.formatIso(replay.receipt.authority.observedAt)).toBe('2026-09-28T12:00:00.600Z');
      }
    }),
  );

  it.effect('returns typed changed and absent outcomes without accepting caller assertions as authority', () =>
    Effect.gen(function* changedAndAbsent() {
      const initial = yield* readPricingCurrentMarketEvidence(persistence(presentSnapshot), request, trustedScope);
      if (initial.outcome !== 'PRICING_MARKET_SOURCE_PRESENT') {
        return;
      }
      const changedRequest: typeof request = {
        ...request,
        retainedReceipt: {
          ...initial.receipt,
          authority: { ...initial.receipt.authority, generation: 8 },
        },
      };
      const changed = yield* readPricingCurrentMarketEvidence(
        persistence(presentSnapshot),
        changedRequest,
        trustedScope,
      );
      expect(changed.outcome).toBe('PRICING_MARKET_SOURCE_CHANGED');

      const absent = yield* readPricingCurrentMarketEvidence(
        persistence({
          generation: 9,
          nextApplicabilityBoundary: presentSnapshot.nextApplicabilityBoundary,
          observedAt: presentSnapshot.observedAt,
          state: 'ABSENT',
        }),
        request,
        trustedScope,
      );
      expect(absent.outcome).toBe('PRICING_MARKET_SOURCE_ABSENT');
      if (absent.outcome === 'PRICING_MARKET_SOURCE_ABSENT') {
        expect(absent.receipt.currentFacts).toEqual([]);
      }
    }),
  );

  it.effect('preserves typed missing, unverifiable, and unavailable outcomes', () =>
    Effect.gen(function* typedFailures() {
      const missing = yield* readPricingCurrentMarketEvidence(
        persistence({
          generation: 0,
          observedAt: presentSnapshot.observedAt,
          reason: 'generation missing',
          state: 'MISSING',
        }),
        request,
        trustedScope,
      );
      expect(missing.outcome).toBe('PRICING_MARKET_SOURCE_MISSING');

      const initial = yield* readPricingCurrentMarketEvidence(persistence(presentSnapshot), request, trustedScope);
      if (initial.outcome !== 'PRICING_MARKET_SOURCE_PRESENT') {
        return;
      }
      const futureFenceRequest: typeof request = {
        ...request,
        retainedReceipt: initial.receipt,
        verifyThrough: Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)('2026-09-28T12:00:01.000Z'),
      };
      const unverifiable = yield* readPricingCurrentMarketEvidence(
        persistence(presentSnapshot),
        futureFenceRequest,
        trustedScope,
      );
      expect(unverifiable.outcome).toBe('PRICING_MARKET_SOURCE_UNVERIFIABLE');

      const unavailable = yield* readPricingCurrentMarketEvidence(
        {
          readCurrent: () =>
            Effect.fail(
              new PricingCurrentMarketEvidencePersistenceUnavailable({
                reason: 'database unavailable',
              }),
            ),
        },
        request,
        trustedScope,
      );
      expect(unavailable.outcome).toBe('PRICING_MARKET_SOURCE_UNAVAILABLE');
    }),
  );

  it.effect('rejects a request outside the trusted Tenant or Legal Entity before owner persistence', () =>
    Effect.gen(function* trustedScopeMismatch() {
      const foreignRequest: typeof request = {
        ...request,
        commercialScope: {
          ...request.commercialScope,
          sellingLegalEntityRef: {
            ...request.commercialScope.sellingLegalEntityRef,
            resourceId: '88888888-8888-4888-8888-888888888888',
          },
        },
      };
      const error = yield* handlePricingCurrentMarketEvidence(foreignRequest, {
        readKey: 'commerce.market-catalog.api.pricing-current-market-evidence',
        scope: operationalScope,
        services: persistence(presentSnapshot),
      }).pipe(Effect.flip);
      expect(Schema.is(ReadPermissionDenied)(error)).toBe(true);
    }),
  );

  it.effect('invokes only the governed exact owner routine and decodes its typed snapshot', () =>
    Effect.gen(function* governedPersistence() {
      let routineKey = '';
      let input: unknown;
      const transaction = {
        invoke: (
          { routineKey: invokedRoutineKey }: { readonly routineKey: string },
          [routineInput]: readonly [unknown],
        ) => {
          routineKey = invokedRoutineKey;
          input = routineInput;
          return Effect.succeed([{ payload: presentSnapshot }]);
        },
      };
      const ownerPersistence = yield* pricingCurrentMarketEvidencePersistenceForScope(
        // @ts-expect-error The focused fixture supplies only the governed routine invoker exercised here.
        transaction,
        operationalScope,
      );
      const snapshot = yield* ownerPersistence.readCurrent(request);
      expect(routineKey).toBe('pricing-current-market-evidence.read-current');
      expect(input).toEqual({ channel: 'B2C', effectiveAt: operationTime, marketId });
      expect(snapshot.state).toBe('PRESENT');
      expect(() => Schema.decodeUnknownSync(PricingCurrentMarketEvidenceResponseSchema)({})).toThrow();
    }),
  );
});
