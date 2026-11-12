import { ReadHandlerNotFound, ReadHandlerUnavailable } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { PriceGroupSourcePricesRequestSchema } from '../../shared/apis/price-group-source-prices.ts';
import { priceGroupSourcePricesPersistenceForScope } from '../../src/persistence/price-group-source-prices-persistence.ts';

const tenantId = 'a5400000-0000-4000-8000-000000000001';
const scope = {
  authMethod: 'system' as const,
  correlationId: 'internal-c14-group-price-read',
  legalEntityId: 'a5400000-0000-4000-8000-000000000002',
  principalId: 'a5400000-0000-4000-8000-000000000003',
  tenantId,
};
const request = {
  limit: 1,
  offset: 0,
  priceGroupRef: {
    moduleId: 'pricing.price-group-catalog' as const,
    resourceId: 'a5400000-0000-4000-8000-000000000004',
    resourceType: 'pricing.price-group-catalog.price-group' as const,
    tenantId,
  },
  sourceSystem: { ownerModuleId: 'external.internal-fixture', sourceSystemRef: 'explicit-issuer-and-route' },
};

describe('C14 group source Price read boundary', () => {
  it('requires an actual native sourceSystem and bounded explicit paging', () => {
    expect(Schema.is(PriceGroupSourcePricesRequestSchema)(request)).toBe(true);
    const { sourceSystem, ...unqualified } = request;
    expect(sourceSystem.sourceSystemRef).toBe('explicit-issuer-and-route');
    expect(Schema.is(PriceGroupSourcePricesRequestSchema)(unqualified)).toBe(false);
    expect(Schema.is(PriceGroupSourcePricesRequestSchema)({ ...request, limit: 0 })).toBe(false);
    expect(Schema.is(PriceGroupSourcePricesRequestSchema)({ ...request, offset: 2_147_483_648 })).toBe(false);
  });

  it.effect('rejects foreign Tenant before resolving private Price storage', () =>
    Effect.gen(function* exactTenant() {
      let invoked = false;
      const services = yield* priceGroupSourcePricesPersistenceForScope(
        {
          invoke: () => {
            invoked = true;
            return Effect.succeed([]);
          },
        },
        scope,
      );
      const failure = yield* services
        .list({
          ...request,
          priceGroupRef: { ...request.priceGroupRef, tenantId: 'a5400000-0000-4000-8000-000000000099' },
        })
        .pipe(Effect.flip);
      expect(failure).toBeInstanceOf(ReadHandlerNotFound);
      expect(invoked).toBe(false);
    }),
  );

  it.effect('keeps unavailable owner evidence distinct from a proven empty source query', () =>
    Effect.gen(function* unavailableIsNotEmpty() {
      const missing = yield* priceGroupSourcePricesPersistenceForScope({ invoke: () => Effect.succeed([]) }, scope);
      expect(yield* missing.list(request).pipe(Effect.flip)).toBeInstanceOf(ReadHandlerUnavailable);
      const empty = { count: 0, limit: 1, offset: 0, prices: [] };
      const services = yield* priceGroupSourcePricesPersistenceForScope(
        { invoke: () => Effect.succeed([{ payload: empty }]) },
        scope,
      );
      expect(yield* services.list(request)).toEqual(empty);
      const malformed = yield* priceGroupSourcePricesPersistenceForScope(
        { invoke: () => Effect.succeed([{ payload: { unavailable: true } }]) },
        scope,
      );
      expect(yield* malformed.list(request).pipe(Effect.flip)).toBeInstanceOf(ReadHandlerUnavailable);
    }),
  );
});
