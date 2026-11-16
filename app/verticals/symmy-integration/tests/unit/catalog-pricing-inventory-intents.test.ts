import { Effect, Exit, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { SymmyRouteContextResponseSchema } from '../../shared/apis/symmy-route-context.ts';
import { SymmyCatalogPricingInventoryIntentSchema } from '../../shared/domain/symmy-catalog-pricing-inventory-intents.ts';

const sourceCorrelation = {
  issuerId: 'internal-ebs',
  mappingRevision: 'internal-contract-1',
  recordId: 'product-14',
  recordNamespace: 'warehouse-catalog',
  routeScope: 'route-14',
};
const decode = Schema.decodeUnknownEffect(SymmyCatalogPricingInventoryIntentSchema, { onExcessProperty: 'error' });

describe('Symmy finite internal owner intent contracts', () => {
  it.effect('constructs the route contract and preserves distinct physical and logical source versions', () =>
    Effect.gen(function* test() {
      const tenantId = '10000000-0000-4000-8000-000000000001';
      const sourceRouteId = '10000000-0000-4000-8000-000000000002';
      const target = {
        moduleId: 'pricing.price-group-catalog',
        resourceId: '10000000-0000-4000-8000-000000000003',
        resourceType: 'pricing.price-group-catalog.price-group',
        tenantId,
      };
      const wire = {
        allowedOwnerOperations: [
          { entrypointKey: 'commerce.pricing.define-price', moduleId: 'commerce.pricing', schemaVersion: '2' },
        ],
        issuerId: 'internal-ebs',
        legalEntityId: '10000000-0000-4000-8000-000000000004',
        mappingVersion: 'physical-mapping-2',
        resolvedCode: 'list-A',
        routeId: '10000000-0000-4000-8000-000000000005',
        routeRevision: 'physical-route-2',
        selector: {
          kind: 'PRICE_GROUP',
          source: {
            entityKind: 'PRICE_GROUP',
            issuerId: 'internal-ebs',
            route: { integrationRouteId: sourceRouteId, tenantId },
            sourceNamespace: 'price-lists',
            sourceRecordId: 'list-A',
          },
          target,
        },
        sourceEntityKind: 'PRICE',
        sourceMappingVersion: 'logical-mapping-1',
        sourceNamespace: 'prices',
        sourceRouteId,
        sourceRouteRevision: 'logical-route-1',
        tenantId,
      };
      const parsed = yield* Schema.decodeUnknownEffect(SymmyRouteContextResponseSchema)(wire);
      const encoded = yield* Schema.encodeEffect(SymmyRouteContextResponseSchema)(parsed);
      expect(encoded).toEqual(wire);
    }),
  );
  it.effect('preserves explicit source Product and initial Variant identity without adding lifecycle defaults', () =>
    Effect.gen(function* test() {
      const result = yield* decode({
        _tag: 'CatalogCreateProduct',
        payload: {
          name: 'Internal fixture Product',
          sourceCorrelation: { ...sourceCorrelation, initialVariantRecordId: 'variant-explicit' },
        },
      });
      const isCatalogCreate = Schema.is(SymmyCatalogPricingInventoryIntentSchema.members[0]);
      expect(isCatalogCreate(result)).toBe(true);
      if (isCatalogCreate(result)) {
        expect(result.payload).toEqual({
          name: 'Internal fixture Product',
          sourceCorrelation: { ...sourceCorrelation, initialVariantRecordId: 'variant-explicit' },
        });
      }
    }),
  );

  it.effect(
    'rejects legacy published flags and first-array Variant selection rather than guessing an owner mapping',
    () =>
      Effect.gen(function* test() {
        const result = yield* Effect.exit(
          decode({
            _tag: 'CatalogCreateProduct',
            payload: { published: true, sourceCorrelation, variants: [{ sku: 'first' }] },
          }),
        );
        expect(Exit.isFailure(result)).toBe(true);
      }),
  );

  it.effect('requires the actual complete native Price key, monetary basis, authority, Unit and time', () =>
    Effect.gen(function* test() {
      const result = yield* Effect.exit(
        decode({ _tag: 'PriceDefine', payload: { amount: 120, currency: 'CZK', sourceCorrelation } }),
      );
      expect(Exit.isFailure(result)).toBe(true);
    }),
  );

  it.effect('rejects stock delta and replacement snapshot shorthand without a real owner assertion proposal', () =>
    Effect.gen(function* test() {
      const result = yield* Effect.exit(
        decode({ _tag: 'InventoryImport', payload: { quantity: 4, semantics: 'DELTA', sku: 'stock-1' } }),
      );
      expect(Exit.isFailure(result)).toBe(true);
    }),
  );

  it.effect('has no Tax or Assortment mutation intent', () =>
    Effect.gen(function* test() {
      const results = yield* Effect.all([
        Effect.exit(decode({ _tag: 'TaxImport', payload: { vat_rate: 21 } })),
        Effect.exit(decode({ _tag: 'AssortmentImport', payload: { published: true } })),
      ]);
      expect(results.every(Exit.isFailure)).toBe(true);
    }),
  );
});
