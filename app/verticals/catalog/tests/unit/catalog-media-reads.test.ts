import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  catalogMediaAssignments,
  catalogMediaAssignmentSets,
  products,
  productVariants,
} from '../../src/database/schema.ts';
import { catalogMediaReadsForScope } from '../../src/persistence/catalog-media-reads.ts';

const tenantId = '00000000-0000-4000-8000-000000000001';
const productId = '00000000-0000-4000-8000-000000000002';
const variantId = '00000000-0000-4000-8000-000000000003';
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:media-reads-test:run:1',
    authMethod: 'system',
    principalId: '00000000-0000-4000-8000-000000000004',
    tenantId,
  }),
  correlationId: 'media-reads-test',
};
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: productId,
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const variantRef = {
  moduleId: 'commerce.catalog',
  resourceId: variantId,
  resourceType: 'commerce.catalog.variant',
  tenantId,
} as const;
const productSet = {
  assignmentSetId: '00000000-0000-4000-8000-000000000010',
  currentRevision: 4,
  productId,
  tenantId,
  variantId: null,
};
const variantSet = {
  ...productSet,
  assignmentSetId: '00000000-0000-4000-8000-000000000011',
  currentRevision: 3,
  variantId,
};
const media = (assignmentId: string, assignmentSetId: string, position: number, purpose = 'technical drawing') => ({
  assignmentId,
  assignmentSetId,
  currentRevision: 1,
  ownerModuleId: 'documents.center',
  ownerResourceId: assignmentId,
  ownerResourceType: 'documents.center.resource',
  ownerTenantId: tenantId,
  position,
  purpose,
  resourceKind: 'MEDIA',
  state: 'ACTIVE',
  tenantId,
});
const first = media('00000000-0000-4000-8000-000000000020', productSet.assignmentSetId, 1);
const second = media('00000000-0000-4000-8000-000000000021', productSet.assignmentSetId, 2, 'photo');
const own = media('00000000-0000-4000-8000-000000000022', variantSet.assignmentSetId, 1, 'detail');

const serviceWith = (
  sets: (readonly (typeof productSet | typeof variantSet)[])[],
  assignments: (readonly ReturnType<typeof media>[])[],
) => {
  const queried: unknown[] = [];
  const transaction = {
    select: () => ({
      from: (
        table:
          | typeof products
          | typeof productVariants
          | typeof catalogMediaAssignmentSets
          | typeof catalogMediaAssignments,
      ) => {
        queried.push(table);
        return {
          where: () => {
            if (table === products) {
              return Effect.succeed([{ productId }]);
            }
            if (table === productVariants) {
              return Effect.succeed([{ productId }]);
            }
            if (table === catalogMediaAssignmentSets) {
              return Effect.succeed(sets.shift() ?? []);
            }
            if (table === catalogMediaAssignments) {
              return Effect.succeed(assignments.shift() ?? []);
            }
            return Effect.succeed([]);
          },
        };
      },
    }),
  };
  // @ts-expect-error Mock exposes only the exercised Drizzle chains.
  return { queried, service: catalogMediaReadsForScope(transaction, scope) };
};

describe('Catalog private media reads', () => {
  it.effect('returns the first ordered medium as main with the exact Product set revision', () =>
    Effect.gen(function* mainMedia() {
      const { service } = serviceWith([[productSet]], [[second, first]]);
      const result = Option.getOrThrow(yield* service.current(productRef));
      expect(result.main?.assignmentId).toBe(first.assignmentId);
      expect(result.ordered.map((item) => item.assignmentId)).toEqual([first.assignmentId, second.assignmentId]);
      expect(result.setRevision).toBe(4);
      expect(result.source).toBe('PRODUCT');
      expect(result.illustrativeFallback).toBe(false);
    }),
  );

  it.effect('uses an active Variant set in place of Product and falls back after its last assignment is removed', () =>
    Effect.gen(function* variantFallback() {
      const ownResult = Option.getOrThrow(
        yield* serviceWith([[productSet], [variantSet]], [[first], [own]]).service.current(variantRef),
      );
      expect(ownResult.ordered.map((item) => item.assignmentId)).toEqual([own.assignmentId]);
      expect(ownResult.setRevision).toBe(3);
      expect(ownResult.source).toBe('VARIANT');
      const fallback = Option.getOrThrow(
        yield* serviceWith([[productSet], [variantSet]], [[first], [{ ...own, state: 'REMOVED' }]]).service.current(
          variantRef,
        ),
      );
      expect(fallback.main?.assignmentId).toBe(first.assignmentId);
      expect(fallback.source).toBe('PRODUCT');
      expect(fallback.illustrativeFallback).toBe(true);
      expect(fallback.setRevision).toBe(4);
    }),
  );

  it.effect('fails closed on ambiguous sets, corrupt ordering, and foreign Tenant targets before querying', () =>
    Effect.gen(function* corruptRows() {
      const ambiguous = yield* serviceWith([[productSet, productSet]], [])
        .service.current(productRef)
        .pipe(Effect.catchTag('CatalogPersistenceUnavailable', () => Effect.succeed('unavailable' as const)));
      expect(ambiguous).toBe('unavailable');
      const corrupt = yield* serviceWith([[productSet]], [[{ ...first, position: 2 }]])
        .service.current(productRef)
        .pipe(Effect.catchTag('CatalogPersistenceUnavailable', () => Effect.succeed('unavailable' as const)));
      expect(corrupt).toBe('unavailable');
      const { queried, service } = serviceWith([], []);
      const foreign = yield* service
        .current({ ...productRef, tenantId: variantId })
        .pipe(Effect.catchTag('CatalogPersistenceUnavailable', () => Effect.succeed('unavailable' as const)));
      expect(foreign).toBe('unavailable');
      expect(queried).toEqual([]);
    }),
  );
});
