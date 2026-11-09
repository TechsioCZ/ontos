import {
  CurrentMarketCatalogRequestSchema,
  CurrentMarketCatalogResponseSchema,
} from '@app/commerce-market-catalog/api/client';
import {
  CurrentSupportedCurrenciesRequestSchema,
  CurrentSupportedCurrenciesSuccessSchema,
} from '@app/pricing-contracts/current-supported-currencies';
import { Crypto, DateTime, Effect, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';

import { SymmyInternalRegionsProjectionSchema } from '../../api/symmy/regions-projection-contract.ts';
import {
  projectSymmyRegions,
  SymmyRegionsProjectionConfigurationSchema,
  SymmyRegionsProjectionError,
  SymmyRegionsProjectionScopeSchema,
} from '../../api/symmy/regions-projection.ts';
import type { AcquireSymmyRegionOwnerAssertion } from '../../api/symmy/regions-projection.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const marketId = '33333333-3333-4333-8333-333333333333';
const revisionId = '44444444-4444-4444-8444-444444444444';
const supportRootId = '55555555-5555-4555-8555-555555555555';
const supportRevisionId = '66666666-6666-4666-8666-666666666666';
const compositionRevision = 'a'.repeat(64);
const scope = Schema.decodeUnknownSync(SymmyRegionsProjectionScopeSchema)({
  issuerId: 'internal-source-a',
  legalEntityId,
  route: { integrationRouteId: 'internal-route-a', tenantId },
  sourceNamespace: 'fixture-cz',
});
const marketRef = {
  moduleId: 'commerce.market-catalog',
  resourceId: marketId,
  resourceType: 'commerce.market-catalog.market',
  tenantId,
} as const;
const configuration = Schema.decodeUnknownSync(SymmyRegionsProjectionConfigurationSchema)({
  routes: [
    {
      ...scope,
      regions: [
        { currencyCode: 'CZK', marketRef, sourceRegionId: 'source-region-b' },
        { currencyCode: 'CZK', marketRef, sourceRegionId: 'source-region-a' },
      ],
    },
    {
      ...scope,
      issuerId: 'internal-source-b',
      regions: [{ currencyCode: 'CZK', marketRef, sourceRegionId: 'foreign-source-region' }],
    },
  ],
  schemaVersion: 1,
});

const ModeSchema = Schema.Literals([
  'current',
  'currency_absent',
  'currency_unavailable',
  'foreign_tenant',
  'market_missing',
  'regional',
  'forbidden',
]);
type Mode = typeof ModeSchema.Type;

const marketResponse = (at: string, mode: Mode) =>
  Schema.encodeSync(CurrentMarketCatalogResponseSchema)(
    Schema.decodeUnknownSync(CurrentMarketCatalogResponseSchema)({
      associations: [],
      completenessEvidence: {
        observedAt: at,
        ownerRevision: 'current-market-catalog:r7',
        scope: { kind: 'EXACT_PREDICATE', predicateRef: `markets:${tenantId}:${legalEntityId}` },
      },
      markets:
        mode === 'market_missing'
          ? []
          : [
              {
                channels: ['B2C'],
                definitionRevisionRef: {
                  moduleId: 'commerce.market-catalog',
                  resourceId: revisionId,
                  resourceType: 'commerce.market-catalog.market-definition-revision',
                  tenantId,
                },
                effectivePeriod: { startsAt: at },
                jurisdictions: [{ code: 'CZ', kind: mode === 'regional' ? 'REGION' : 'COUNTRY' }],
                lifecycle: 'ACTIVE',
                marketCode: 'CZ_NATIVE',
                marketRef,
                purpose: 'Explicit native Market purpose; never used as a display name.',
                revision: 7,
                sellingLegalEntityRef: {
                  moduleId: 'core.identity',
                  resourceId: legalEntityId,
                  resourceType: 'core.identity.legal-entity',
                  tenantId,
                },
                supportedLocales: ['cs-CZ'],
              },
            ],
      observedAt: at,
    }),
  );

const currencyResponse = (effectiveAt: string, mode: Mode) => {
  const currentTenant = mode === 'foreign_tenant' ? '77777777-7777-4777-8777-777777777777' : tenantId;
  const supportRootRef = {
    moduleId: 'commerce.pricing',
    resourceId: supportRootId,
    resourceType: 'commerce.pricing.currency-support',
    tenantId: currentTenant,
  };
  const supportRevisionRef = {
    moduleId: 'commerce.pricing',
    resourceId: supportRevisionId,
    resourceType: 'commerce.pricing.currency-support-revision',
    supportRootId,
    tenantId: currentTenant,
  };
  const verificationRef = 'internal-currency-proof:r1';
  return Schema.encodeSync(CurrentSupportedCurrenciesSuccessSchema)(
    Schema.decodeUnknownSync(CurrentSupportedCurrenciesSuccessSchema)({
      completenessEvidence: {
        observedAt: effectiveAt,
        ownerRevision: supportRevisionId,
        scope: { kind: 'EXACT_PREDICATE', predicateRef: `currencies:${currentTenant}` },
      },
      currentnessEvidence: {
        evaluatedAt: effectiveAt,
        evaluationMode: 'CURRENT_WITH_REVALIDATION',
        observedAt: effectiveAt,
        revalidatedAt: effectiveAt,
        scheduleRevision: 1,
        supportRevisionRef,
        supportRootRef,
      },
      effectiveAt,
      effectivePeriod: { effectiveFrom: effectiveAt, effectiveTo: null },
      factProofs: [{ factRef: supportRootId, factRevisionRef: supportRevisionId, verificationRef }],
      generation: 1,
      observedAt: effectiveAt,
      outcome: 'SUPPORTED_CURRENCIES_CURRENT',
      pricingRevision: 'pricing-r1',
      scheduleRevision: 1,
      supportedCurrencies: mode === 'currency_absent' ? ['EUR'] : ['CZK', 'EUR'],
      supportRevisionRef,
      supportRootRef,
      tenantId: currentTenant,
      verificationRef,
    }),
  );
};

const fixture = (mode: Mode = 'current') => {
  const requests: Request[] = [];
  const acquisitions: Parameters<AcquireSymmyRegionOwnerAssertion>[0][] = [];
  let randomSequence = 0;
  const crypto = Crypto.make({
    digest: () => Effect.succeed(new Uint8Array()),
    randomBytes: (size) => {
      randomSequence += 1;
      return new Uint8Array(size).fill(randomSequence);
    },
  });
  const acquire: AcquireSymmyRegionOwnerAssertion = (target) => {
    acquisitions.push(target);
    return Effect.succeed({
      apiBaseUrl: `https://owner.example.test/${target.audience}-api`,
      assertion: Redacted.make(`internal-owner-assertion-${acquisitions.length}`),
      compositionRevision,
    });
  };
  const fakeFetch: typeof fetch = (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const at = '1970-01-01T00:00:00.000Z';
    if (new URL(request.url).pathname.endsWith('/reads/current-market-catalog')) {
      return Promise.resolve(
        mode === 'forbidden'
          ? Response.json(
              {
                _tag: 'CurrentMarketCatalogForbiddenProblem',
                detail: 'The owner refuses this operation.',
                status: 403,
                title: 'Forbidden',
                type: 'https://ontos.dev/problems/market-forbidden',
              },
              { headers: { 'content-type': 'application/problem+json' }, status: 403 },
            )
          : Response.json(marketResponse(at, mode)),
      );
    }
    return Promise.resolve(
      mode === 'currency_unavailable'
        ? Response.json({
            code: 'currency_support_unavailable',
            outcome: 'SUPPORTED_CURRENCIES_UNAVAILABLE',
            reason: 'Unavailable',
            retryable: true,
          })
        : Response.json(currencyResponse(at, mode)),
    );
  };
  return { acquire, acquisitions, crypto, fakeFetch, requests };
};

const runProjection = (current: ReturnType<typeof fixture>, selected = configuration) =>
  TestClock.setTime(0).pipe(
    Effect.andThen(
      projectSymmyRegions(
        { compositionRevision, configuration: selected, page: { limit: 1, offset: 0 }, scope },
        current.acquire,
      ),
    ),
    Effect.provideService(Crypto.Crypto, current.crypto),
    Effect.provideService(FetchHttpClient.Fetch, current.fakeFetch),
  );

describe('Symmy internal CZ region projection', () => {
  it.effect('uses fresh public owner assertions and stable issuer-scoped source identities with truthful paging', () =>
    Effect.gen(function* stableRegionProjection() {
      const current = fixture();
      const result = yield* runProjection(current);
      expect(Schema.is(Schema.toType(SymmyInternalRegionsProjectionSchema))(result)).toBe(true);
      expect(result.count).toBe(2);
      expect(result.regions).toEqual([
        { country_codes: ['CZ'], currency_code: 'CZK', id: 'source-region-a', market_code: 'CZ_NATIVE', marketRef },
      ]);
      expect(result.unsupported_fields).toContain('payment_providers');
      expect(result.regions[0]).not.toHaveProperty('name');
      expect(result.regions[0]).not.toHaveProperty('tax_rate');
      const first = yield* Effect.fromNullishOr(current.requests[0]).pipe(Effect.orDie);
      const marketPayload = Schema.decodeUnknownSync(CurrentMarketCatalogRequestSchema)(
        yield* Effect.promise(() => first.clone().json()),
      );
      expect(DateTime.formatIso(marketPayload.at)).toBe('1970-01-01T00:00:00.000Z');
      const second = yield* Effect.fromNullishOr(current.requests[1]).pipe(Effect.orDie);
      const currencyPayload = Schema.decodeUnknownSync(CurrentSupportedCurrenciesRequestSchema)(
        yield* Effect.promise(() => second.clone().json()),
      );
      expect(currencyPayload).toEqual({ effectiveAt: '1970-01-01T00:00:00.000Z', tenantId });
      expect(current.acquisitions).toEqual([
        { audience: 'commerce-market-catalog', legalEntityId },
        { audience: 'pricing' },
      ]);
      expect(current.requests.map((request) => request.headers.get('authorization'))).toEqual([
        'Bearer internal-owner-assertion-1',
        'Bearer internal-owner-assertion-2',
      ]);
      expect(
        current.requests.every(
          (request) => request.headers.get('x-ontos-composition-revision') === compositionRevision,
        ),
      ).toBe(true);
      const next = yield* projectSymmyRegions(
        { compositionRevision, configuration, page: { limit: 1, offset: 1 }, scope },
        current.acquire,
      ).pipe(
        Effect.provideService(Crypto.Crypto, current.crypto),
        Effect.provideService(FetchHttpClient.Fetch, current.fakeFetch),
      );
      expect(next.count).toBe(2);
      expect(next.regions.map(({ id }) => id)).toEqual(['source-region-b']);
      expect(current.acquisitions).toHaveLength(4);
      expect(new Set(current.requests.map((request) => request.headers.get('x-correlation-id'))).size).toBe(4);
    }),
  );

  for (const [mode, reason] of [
    ['currency_absent', 'currency_absent'],
    ['currency_unavailable', 'owner_unavailable'],
    ['foreign_tenant', 'owner_unavailable'],
    ['market_missing', 'market_missing'],
    ['regional', 'unsupported_jurisdiction'],
    ['forbidden', 'owner_forbidden'],
  ] as const) {
    it.effect(`preserves ${mode} without inventing a Region or an empty success`, () =>
      Effect.gen(function* regionNegativeProof() {
        const current = fixture(mode);
        const error = yield* runProjection(current).pipe(Effect.flip);
        expect(error).toBeInstanceOf(SymmyRegionsProjectionError);
        expect(error).toMatchObject({ reason });
      }),
    );
  }

  it.effect('rejects foreign route configuration and ambiguous exact mappings before any owner call', () =>
    Effect.gen(function* routeConfigurationProof() {
      const current = fixture();
      const configured = yield* Effect.fromNullishOr(configuration.routes[0]).pipe(Effect.orDie);
      const foreign = Schema.decodeUnknownSync(SymmyRegionsProjectionConfigurationSchema)({
        routes: [{ ...configured, issuerId: 'internal-source-b' }],
        schemaVersion: 1,
      });
      const missing = yield* runProjection(current, foreign).pipe(Effect.flip);
      expect(missing).toMatchObject({ reason: 'source_scope_mismatch' });
      const ambiguous = yield* runProjection(current, { routes: [configured, configured], schemaVersion: 1 }).pipe(
        Effect.flip,
      );
      expect(ambiguous).toMatchObject({ reason: 'source_scope_mismatch' });
      expect(current.acquisitions).toHaveLength(0);
      expect(current.requests).toHaveLength(0);
    }),
  );

  it.effect('rejects cross-Tenant configured Market references before acquiring any credentials', () =>
    Effect.gen(function* foreignMarketConfiguration() {
      const current = fixture();
      const invalid = {
        ...configuration,
        routes: configuration.routes.map((configured) => ({
          ...configured,
          regions: configured.regions.map((region) => ({
            ...region,
            marketRef: { ...region.marketRef, tenantId: '77777777-7777-4777-8777-777777777777' },
          })),
        })),
      };
      const error = yield* runProjection(current, invalid).pipe(Effect.flip);
      expect(error).toMatchObject({ reason: 'configuration_invalid' });
      expect(current.acquisitions).toHaveLength(0);
      expect(current.requests).toHaveLength(0);
    }),
  );

  it.effect('refuses a fresh assertion from a different release before forwarding it to an owner', () =>
    Effect.gen(function* releaseBoundRegions() {
      const current = fixture();
      const acquire: AcquireSymmyRegionOwnerAssertion = (target) =>
        current
          .acquire(target)
          .pipe(Effect.map((credential) => ({ ...credential, compositionRevision: 'b'.repeat(64) })));
      const error = yield* projectSymmyRegions(
        { compositionRevision, configuration, page: { limit: 1, offset: 0 }, scope },
        acquire,
      ).pipe(
        Effect.flip,
        Effect.provideService(Crypto.Crypto, current.crypto),
        Effect.provideService(FetchHttpClient.Fetch, current.fakeFetch),
      );
      expect(error).toMatchObject({ reason: 'owner_unavailable' });
      expect(current.acquisitions).toHaveLength(1);
      expect(current.requests).toHaveLength(0);
    }),
  );
});
