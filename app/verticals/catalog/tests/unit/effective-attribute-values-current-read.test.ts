import { ReadHandlerNotFound, ReadHandlerUnavailable } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  EffectiveAttributeValuesCurrentRequestSchema,
  EffectiveAttributeValuesCurrentResponseSchema,
} from '../../shared/apis/effective-attribute-values-current.ts';
import { readEffectiveAttributeValuesCurrent } from '../../src/api/effective-attribute-values-current.read.ts';
import type { EffectiveAttributeValueReads } from '../../src/persistence/effective-attribute-value-reads.ts';
import { CatalogPersistenceUnavailable } from '../../src/persistence/errors.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const request = Schema.decodeUnknownSync(EffectiveAttributeValuesCurrentRequestSchema)({
  attributeDefinitionRef: {
    moduleId: 'commerce.catalog',
    resourceId: '22222222-2222-4222-8222-222222222222',
    resourceType: 'commerce.catalog.attribute-definition',
    tenantId,
  },
  productRef: {
    moduleId: 'commerce.catalog',
    resourceId: '33333333-3333-4333-8333-333333333333',
    resourceType: 'commerce.catalog.product',
    tenantId,
  },
  variantRef: {
    moduleId: 'commerce.catalog',
    resourceId: '44444444-4444-4444-8444-444444444444',
    resourceType: 'commerce.catalog.variant',
    tenantId,
  },
});

const servicesWith = (
  resolveVariant: EffectiveAttributeValueReads['resolveVariant'],
): EffectiveAttributeValueReads => ({
  readDefinitionCurrent: () => Effect.die('unused'),
  readProductTypeValidity: () => Effect.die('unused'),
  resolveVariant,
});

describe('Catalog governed effective attribute value read', () => {
  it.effect('returns an inherited value with exact Product provenance and revision', () =>
    Effect.gen(function* testInherited() {
      const result = yield* readEffectiveAttributeValuesCurrent(
        request,
        tenantId,
        servicesWith(() =>
          Effect.succeed({
            productRevision: 4,
            source: { level: 'PRODUCT', productRef: request.productRef, revision: 4 },
            status: 'CURRENT',
            values: [{ kind: 'TEXT', text: 'Steel' }],
          }),
        ),
      );
      expect(result.evidence.resultCount).toBe(1);
      expect(result.result).toMatchObject({ source: { level: 'PRODUCT', revision: 4 }, values: [{ text: 'Steel' }] });
      expect(() => Schema.encodeSync(EffectiveAttributeValuesCurrentResponseSchema)(result.result)).not.toThrow();
    }),
  );

  it.effect('preserves an explicit Variant override and its revision', () =>
    Effect.gen(function* testOverride() {
      const result = yield* readEffectiveAttributeValuesCurrent(
        request,
        tenantId,
        servicesWith(() =>
          Effect.succeed({
            productRevision: 5,
            source: { level: 'VARIANT', productRef: request.productRef, revision: 2, variantRef: request.variantRef },
            status: 'CURRENT',
            values: [{ kind: 'SPECIAL', state: 'UNKNOWN' }],
            variantRevision: 2,
          }),
        ),
      );
      expect(result.result).toMatchObject({
        source: { level: 'VARIANT', revision: 2 },
        values: [{ state: 'UNKNOWN' }],
      });
      expect(() => Schema.encodeSync(EffectiveAttributeValuesCurrentResponseSchema)(result.result)).not.toThrow();
    }),
  );

  it.effect('preserves verified absence without fabricating source or value', () =>
    Effect.gen(function* testAbsent() {
      const result = yield* readEffectiveAttributeValuesCurrent(
        request,
        tenantId,
        servicesWith(() => Effect.succeed({ status: 'CURRENT', values: [] })),
      );
      expect(result).toEqual({ evidence: { resultCount: 0 }, result: { status: 'CURRENT', values: [] } });
    }),
  );

  it.effect('does not query a foreign Tenant', () =>
    Effect.gen(function* testTenant() {
      const failure = yield* readEffectiveAttributeValuesCurrent(
        request,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        servicesWith(() => Effect.die('must not run')),
      ).pipe(Effect.flip);
      expect(Schema.is(ReadHandlerNotFound)(failure)).toBe(true);
    }),
  );

  it.effect('returns resolver invalidity as a typed non-current result', () =>
    Effect.gen(function* testInvalid() {
      const result = yield* readEffectiveAttributeValuesCurrent(
        request,
        tenantId,
        servicesWith(() =>
          Effect.succeed({ reasons: ['Current Product Type basis is malformed'], status: 'INVALID_AUTHORITY' }),
        ),
      );
      expect(result.result.status).toBe('INVALID_AUTHORITY');
      expect(result.evidence.resultCount).toBe(0);
      expect(() => Schema.encodeSync(EffectiveAttributeValuesCurrentResponseSchema)(result.result)).not.toThrow();
    }),
  );

  it.effect('maps owner persistence failure to typed unavailability', () =>
    Effect.gen(function* testFailure() {
      const failure = yield* readEffectiveAttributeValuesCurrent(
        request,
        tenantId,
        servicesWith(() =>
          Effect.fail(
            new CatalogPersistenceUnavailable({
              code: 'catalog_persistence_unavailable',
              reason: 'database unavailable',
            }),
          ),
        ),
      ).pipe(Effect.flip);
      expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
    }),
  );
});
