import { ReadHandlerNotFound } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CatalogMediaCurrentResponseSchema } from '../../shared/apis/catalog-media-current.ts';
import { CatalogMediaAssignmentSchema, selectCatalogMediaSet } from '../../shared/domain/catalog-media-assignment.ts';
import { readCatalogMediaCurrent } from '../../src/api/catalog-media-current.read.ts';
import type { CatalogMediaReads } from '../../src/persistence/catalog-media-reads.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const target = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.variant',
  tenantId,
} as const;
const assignment = Schema.decodeUnknownSync(CatalogMediaAssignmentSchema)({
  assignmentId: '33333333-3333-4333-8333-333333333333',
  assignmentRevision: 2,
  order: 1,
  purpose: 'DRAWING',
  resourceRef: {
    moduleId: 'documents.center',
    resourceId: '44444444-4444-4444-8444-444444444444',
    resourceType: 'documents.center.resource',
    tenantId,
  },
  target: {
    ...target,
    resourceId: '55555555-5555-4555-8555-555555555555',
    resourceType: 'commerce.catalog.product',
  },
});

describe('Catalog governed current media read', () => {
  it.effect('returns Catalog fallback metadata and explicitly unverified owner availability', () =>
    Effect.gen(function* testRead() {
      const services: CatalogMediaReads = {
        current: () =>
          Effect.succeed(
            Option.some({
              illustrativeFallback: true,
              main: assignment,
              ordered: [assignment],
              setRevision: 3,
              source: 'PRODUCT',
            }),
          ),
      };
      const result = yield* readCatalogMediaCurrent({ target }, tenantId, services);
      expect(result.source).toBe('PRODUCT');
      expect(result.illustrativeFallback).toBe(true);
      expect(Option.getOrThrow(result.main).assignment.purpose).toBe('DRAWING');
      expect(Option.getOrThrow(result.main).ownerAvailability).toBe('UNVERIFIED');
      expect(result.ordered).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain('https://');
      expect(() => Schema.encodeSync(CatalogMediaCurrentResponseSchema)(result)).not.toThrow();
    }),
  );

  it.effect('keeps no-assignment distinct from owner unavailability', () =>
    Effect.gen(function* testEmpty() {
      const services: CatalogMediaReads = {
        current: () =>
          Effect.succeed(
            Option.some({
              illustrativeFallback: false,
              main: selectCatalogMediaSet([], []).main,
              ordered: [],
              setRevision: 0,
              source: 'PRODUCT',
            }),
          ),
      };
      const result = yield* readCatalogMediaCurrent({ target }, tenantId, services);
      expect(result.ordered).toEqual([]);
      expect(Option.isNone(result.main)).toBe(true);
    }),
  );

  it.effect('does not query an out-of-tenant target', () =>
    Effect.gen(function* testTenant() {
      const services: CatalogMediaReads = { current: () => Effect.die('must not run') };
      const failure = yield* readCatalogMediaCurrent({ target }, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', services).pipe(
        Effect.flip,
      );
      expect(Schema.is(ReadHandlerNotFound)(failure)).toBe(true);
    }),
  );
});
