import { Effect, Option } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { readProductCategoryClassification } from '../../src/api/product-category-classification.read.ts';
import type { CategoryClassificationPersistence } from '../../src/persistence/category-classification-persistence.ts';
import { CategoryPersistenceUnavailable } from '../../src/persistence/category-persistence.ts';

const tenantId = '00000000-0000-4000-8000-000000000001';
const productId = '00000000-0000-4000-8000-000000000002';
const categoryId = '00000000-0000-4000-8000-000000000003';
const parentId = '00000000-0000-4000-8000-000000000004';
const productRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: productId,
  resourceType: 'commerce.catalog.product' as const,
  tenantId,
};
const input = { productRef };

describe('governed Category classification read', () => {
  it.effect('returns direct facts, explainable ancestors, and both current revisions', () =>
    Effect.gen(function* readAvailableClassificationCase() {
      const services: CategoryClassificationPersistence = {
        getClassification: () =>
          Effect.succeed(
            Option.some({
              ancestors: [
                {
                  ancestorRef: { resourceId: parentId, tenantId },
                  viaDirectCategories: [{ resourceId: categoryId, tenantId }],
                },
              ],
              categoryNames: [
                { categoryRef: { resourceId: categoryId, tenantId }, name: 'Wall shelves' },
                { categoryRef: { resourceId: parentId, tenantId }, name: 'Shelves' },
              ],
              directCategories: [{ resourceId: categoryId, tenantId }],
              revision: { assignments: 2, hierarchy: 5 },
              status: 'AVAILABLE',
            }),
          ),
      };
      const result = yield* readProductCategoryClassification(input, tenantId, services);
      expect(result.status).toBe('AVAILABLE');
      expect(result.directCategories).toEqual([
        {
          moduleId: 'commerce.catalog',
          resourceId: categoryId,
          resourceType: 'commerce.catalog.product-category',
          tenantId,
        },
      ]);
      expect(result.ancestors[0]?.viaDirectCategories).toEqual(result.directCategories);
      expect(result.categoryNames).toEqual([
        { categoryRef: result.directCategories[0], name: 'Wall shelves' },
        { categoryRef: result.ancestors[0]?.ancestorRef, name: 'Shelves' },
      ]);
      expect(result.revision).toEqual({ assignments: 2, hierarchy: 5 });
      expect('primaryCategory' in result).toBe(false);
    }),
  );

  it.effect('rejects a foreign Product before invoking the owner service', () =>
    Effect.gen(function* rejectForeignProductCase() {
      const services: CategoryClassificationPersistence = {
        getClassification: () => Effect.die('service must not be called'),
      };
      const foreignInput = { productRef: { ...productRef, tenantId: '00000000-0000-4000-8000-000000000099' } };
      const error = yield* readProductCategoryClassification(foreignInput, tenantId, services).pipe(Effect.flip);
      expect(error.code).toBe('read_handler_not_found');
    }),
  );

  it.effect('keeps missing Product and unavailable classification distinct from known empty', () =>
    Effect.gen(function* distinguishUnavailableCase() {
      const missing: CategoryClassificationPersistence = { getClassification: () => Effect.succeed(Option.none()) };
      const absent = yield* readProductCategoryClassification(input, tenantId, missing).pipe(Effect.flip);
      expect(absent.code).toBe('read_handler_not_found');
      const unavailable: CategoryClassificationPersistence = {
        getClassification: () =>
          Effect.fail(
            new CategoryPersistenceUnavailable({
              code: 'category_persistence_unavailable',
              reason: 'backend unavailable',
            }),
          ),
      };
      const failed = yield* readProductCategoryClassification(input, tenantId, unavailable).pipe(Effect.flip);
      expect(failed.code).toBe('read_handler_unavailable');
      const empty: CategoryClassificationPersistence = {
        getClassification: () =>
          Effect.succeed(
            Option.some({
              ancestors: [],
              categoryNames: [],
              directCategories: [],
              revision: { assignments: 0, hierarchy: 0 },
              status: 'AVAILABLE',
            }),
          ),
      };
      const knownEmpty = yield* readProductCategoryClassification(input, tenantId, empty);
      expect(knownEmpty.directCategories).toEqual([]);
      expect(knownEmpty.categoryNames).toEqual([]);
    }),
  );

  it.effect('fails closed on missing, extra, duplicate, or foreign Current names', () =>
    Effect.gen(function* rejectInconsistentNamesCase() {
      const direct = { resourceId: categoryId, tenantId };
      for (const categoryNames of [
        [],
        [
          { categoryRef: direct, name: 'Wall shelves' },
          { categoryRef: direct, name: 'Duplicate' },
        ],
        [{ categoryRef: { resourceId: parentId, tenantId }, name: 'Extra' }],
        [{ categoryRef: { ...direct, tenantId: '00000000-0000-4000-8000-000000000099' }, name: 'Foreign' }],
      ]) {
        const services: CategoryClassificationPersistence = {
          getClassification: () =>
            Effect.succeed(
              Option.some({
                ancestors: [],
                categoryNames,
                directCategories: [direct],
                revision: { assignments: 2, hierarchy: 5 },
                status: 'AVAILABLE',
              }),
            ),
        };
        const error = yield* readProductCategoryClassification(input, tenantId, services).pipe(Effect.flip);
        expect(error.code).toBe('read_handler_unavailable');
      }
    }),
  );
});
