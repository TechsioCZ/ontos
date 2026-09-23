import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { getActionServiceFactory } from '../../../../packages/core-runtime/src/actions/definition.ts';

import {
  CartOpenSelectionPopulationEvidenceSchema,
  CartOpenSelectionPopulationService,
  CartOpenSelectionPopulationUnavailable,
  cartOpenSelectionPopulationFromEnvironment,
  readCartOpenSelectionPopulation,
} from '../../shared/domain/catalog-open-selection-population.ts';
import { CatalogSelectionSchema } from '../../shared/domain/catalog-selection-evidence.ts';
import { setProductAttributeValuesAction } from '../../src/actions/set-product-attribute-values.action.ts';
import { catalogOpenSelectionImpactForScope } from '../../src/persistence/catalog-open-selection-impact.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:open-selection-test:run:1',
    authMethod: 'system',
    principalId: '22222222-2222-4222-8222-222222222222',
    tenantId,
  }),
  correlationId: 'open-selection-test',
};
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const variantRef = {
  moduleId: 'commerce.catalog',
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.variant',
  tenantId,
} as const;
const selection = Schema.decodeUnknownSync(CatalogSelectionSchema)({ productRef, variantRef });
const foreignTenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const foreignSelection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  productRef: { ...productRef, tenantId: foreignTenantId },
  variantRef: { ...variantRef, tenantId: foreignTenantId },
});
const decodePopulation = Schema.decodeUnknownSync(CartOpenSelectionPopulationEvidenceSchema);
const population = (selections: readonly { readonly selection: typeof selection; readonly selectionId: string }[]) => ({
  read: () =>
    Effect.succeed(
      decodePopulation({
        complete: true,
        observedAt: '2026-09-18T12:00:00.000Z',
        revisionToken: 'cart-population-1',
        selections,
        tenantId,
      }),
    ),
});
const untouchedTransaction = {
  select: () => {
    throw new Error('must not infer population from private rows');
  },
};

describe('Catalog open-selection impact', () => {
  it.effect('resolves the exact deployment-provided Cart port and preserves an absent binding', () =>
    Effect.gen(function* deploymentBinding() {
      const port = population([]);
      expect(yield* cartOpenSelectionPopulationFromEnvironment).toBeUndefined();
      expect(
        yield* cartOpenSelectionPopulationFromEnvironment.pipe(
          Effect.provideService(CartOpenSelectionPopulationService, port),
        ),
      ).toBe(port);
    }),
  );

  it.effect('fails closed without a durable complete population source', () =>
    Effect.gen(function* rejectUnprovenPopulation() {
      // @ts-expect-error The deliberately unused transaction has no full Drizzle methods.
      const service = catalogOpenSelectionImpactForScope(untouchedTransaction, scope);
      const result = yield* Effect.flip(service.assess(productRef));
      expect(result.code).toBe('catalog_open_selection_impact_unavailable');
    }),
  );

  it.effect('proceeds when the injected Cart owner population is complete and references no open selection', () =>
    Effect.gen(function* provenClear() {
      // @ts-expect-error The deliberately unused transaction is never read for a clear population.
      const service = catalogOpenSelectionImpactForScope(untouchedTransaction, scope, population([]));
      const result = yield* service.assess(productRef);
      expect(result).toBeUndefined();
    }),
  );

  it.effect('injects the public Cart service into an affected Attribute Action factory', () =>
    Effect.gen(function* actionFactoryBinding() {
      const port = population([]);
      const services = yield* getActionServiceFactory(setProductAttributeValuesAction)(
        // @ts-expect-error The impact check over an empty population never reads Catalog persistence.
        untouchedTransaction,
        scope,
      ).pipe(Effect.provideService(CartOpenSelectionPopulationService, port));
      expect(yield* services.assessOpenSelectionImpact(productRef)).toBeUndefined();
    }),
  );

  it.effect('rejects a Cart population attested for another Tenant', () =>
    Effect.gen(function* wrongTenantPopulation() {
      const service = catalogOpenSelectionImpactForScope(
        // @ts-expect-error The transaction is never reached when the owner attestation is foreign.
        untouchedTransaction,
        scope,
        {
          read: ({ tenantId: requestedTenantId }) =>
            Effect.succeed({
              complete: true,
              observedAt: '2026-09-18T12:00:00.000Z',
              revisionToken: `cart-population-for-${requestedTenantId}`,
              selections: [],
              tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            }),
        },
      );
      const failure = yield* service.assess(productRef).pipe(Effect.flip);
      expect(failure.reason).toContain('different Tenant');
    }),
  );

  it.effect('rejects a complete population containing a Selection from another Tenant', () =>
    Effect.gen(function* foreignInnerSelection() {
      const failure = yield* readCartOpenSelectionPopulation(
        {
          read: () =>
            Effect.succeed({
              complete: true,
              observedAt: '2026-09-18T12:00:00.000Z',
              revisionToken: 'cart-population-with-foreign-selection',
              selections: [{ selection: foreignSelection, selectionId: 'foreign-selection' }],
              tenantId,
            }),
        },
        tenantId,
      ).pipe(Effect.flip);
      expect(failure.reason).toContain('invalid open-selection population attestation');
    }),
  );

  it.effect('rejects a complete population containing duplicate Selection identities', () =>
    Effect.gen(function* duplicateSelectionIds() {
      const failure = yield* readCartOpenSelectionPopulation(
        {
          read: () =>
            Effect.succeed({
              complete: true,
              observedAt: '2026-09-18T12:00:00.000Z',
              revisionToken: 'cart-population-with-duplicates',
              selections: [
                { selection, selectionId: 'duplicate-selection' },
                { selection, selectionId: 'duplicate-selection' },
              ],
              tenantId,
            }),
        },
        tenantId,
      ).pipe(Effect.flip);
      expect(failure.reason).toContain('invalid open-selection population attestation');
    }),
  );

  it.effect('blocks an impact write when an open selection references the Product', () =>
    Effect.gen(function* referencedProduct() {
      const service = catalogOpenSelectionImpactForScope(
        // @ts-expect-error The transaction is reached only through the injected Catalog evidence reader.
        untouchedTransaction,
        scope,
        population([{ selection, selectionId: 'cart-selection-1' }]),
        () => Effect.succeed({ evidence: { kind: 'NOT_FOUND', requested: selection } }),
      );
      const result = yield* Effect.flip(service.assess(productRef));
      expect(result.code).toBe('catalog_open_selection_impact_unavailable');
      expect(result.reason).toContain('open Catalog selection');
    }),
  );

  it.effect('fails closed when the injected Cart owner read is unavailable', () =>
    Effect.gen(function* ownerUnavailable() {
      const service = catalogOpenSelectionImpactForScope(
        // @ts-expect-error The transaction is never reached when the owner read fails.
        untouchedTransaction,
        scope,
        {
          read: () =>
            Effect.fail(
              new CartOpenSelectionPopulationUnavailable({
                code: 'cart_open_selection_population_unavailable',
                reason: 'Cart is unavailable',
              }),
            ),
        },
      );
      const result = yield* Effect.flip(service.assess(productRef));
      expect(result.code).toBe('catalog_open_selection_impact_unavailable');
    }),
  );
});
