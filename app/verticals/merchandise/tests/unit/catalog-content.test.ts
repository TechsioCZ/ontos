import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Reactivity } from 'effect/reactivity';
import { merchandiseRelations } from '../../src/database/schema.ts';
import {
  categoryRowOf,
  EMPTY_CATALOG_HEAD,
  loadWorkingSet,
  persistChange,
} from '../../src/services/merchandise-store.ts';
import { evolveMerchandiseState, workingSetRequestOf } from '../../src/services/persistence.service.ts';
import { Context, DateTime, Effect, Layer, Option, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  MerchandiseCommandSchema,
  MerchandiseLifecycleConflict,
  MerchandiseNotFound,
} from '../../shared/actions/apply-command.ts';
import { MerchandiseStateSchema } from '../../shared/apis/records.ts';
import {
  CatalogCategoryIdSchema,
  CatalogCategorySchema,
  ProductSchema,
} from '../../shared/domain/merchandise-model.ts';
import {
  assignCategory,
  assignCategoryMemberships,
  categoryPathOf,
  contentChangeOf,
  createCategoryCommand,
  updateCategoryCommand,
  withContentHistory,
} from '../../src/services/catalog-content.ts';
import { TEST_RATES, TEST_TAX } from '../support/tax-fixtures.ts';

const actor = { principalId: '20000000-0000-4000-8000-000000000002', tenantId: '20000000-0000-4000-8000-000000000001' };
const now = DateTime.makeUnsafe('2026-10-20T10:00:00.000Z');
const input = { actor, now, resourceId: 'resource-1', tax: TEST_TAX };
const at = '2026-10-19T08:00:00.000Z';

const rootCategory = Schema.decodeUnknownSync(CatalogCategorySchema)({
  description: '',
  hasChildren: true,
  heading: 'Šrouby',
  id: 'r',
  imageAlt: '',
  imageSrc: '',
  longDescription: '',
  name: 'Šrouby',
  parentId: null,
  position: 1,
  slug: 'srouby',
});
const childCategory = Schema.decodeUnknownSync(CatalogCategorySchema)({
  description: '',
  hasChildren: false,
  heading: 'Metrické',
  id: 'c',
  imageAlt: '',
  imageSrc: '',
  longDescription: '',
  name: 'Metrické',
  parentId: 'r',
  position: 2,
  slug: 'metricke',
});
const categories = [rootCategory, childCategory];
const categoryId = Schema.decodeSync(CatalogCategoryIdSchema);

const rawP1 = {
  active: true,
  category: 'Metrické',
  categoryId: 'c',
  createdAt: at,
  currentPriceMinor: 100,
  id: 'p1',
  lowStockThreshold: 0,
  name: 'Šroub',
  priceHistory: [],
  sku: 'S1',
  taxClassificationCode: 'cz.vat.standard',
  unit: 'ks',
  updatedAt: at,
};
const p1 = Schema.decodeUnknownSync(ProductSchema)(rawP1);

const state = MerchandiseStateSchema.make({
  categories,
  movements: [],
  orders: [],
  products: [p1],
});

it('categoryPathOf starts at the id and walks up to the root', () => {
  expect(categoryPathOf(categories, categoryId('c'))).toEqual(['c', 'r']);
});

it('contentChangeOf lists changed content fields with Czech labels', () => {
  const change = contentChangeOf(p1, { ...p1, isAction: true, name: 'Šroub M8' }, input);
  expect(change?.fields).toEqual(['Název', 'Akce']);
  expect(change?.before).toContain('Název: Šroub');
  expect(change?.after).toContain('Akce: ano');
});

it('contentChangeOf ignores non-content changes', () => {
  expect(contentChangeOf(p1, { ...p1, updatedAt: now }, input)).toBeUndefined();
});

it('withContentHistory keeps at most 50 entries', () => {
  const history = Array.from({ length: 50 }, (_, index) => ({
    actor,
    after: `Název: ${index + 1}`,
    at: now,
    before: `Název: ${index}`,
    fields: ['Název'],
  }));
  const before = { ...p1, contentHistory: history };
  const result = withContentHistory(before, { ...before, name: 'Nový šroub' }, input);
  expect(result.contentHistory?.length).toBe(50);
  expect(result.contentHistory?.at(-1)?.after).toBe('Název: Nový šroub');
  expect(result.contentHistory?.[0]?.before).toBe('Název: 1');
});

it.effect('assignCategory moves the product to an existing category', () =>
  Effect.gen(function* catalogContentCase1() {
    const moved = yield* assignCategory(p1, 'r', categories);
    expect(moved.categoryId).toBe('r');
    expect(moved.categoryPathIds).toEqual(['r']);
    expect(moved.category).toBe('Šrouby');
  }),
);

it.effect('assignCategory fails with a lifecycle conflict for an unknown category', () =>
  Effect.gen(function* catalogContentCase2() {
    const error = yield* Effect.flip(assignCategory(p1, 'missing', categories));
    expect(Schema.is(MerchandiseLifecycleConflict)(error)).toBe(true);
  }),
);

it.effect('updateCategoryCommand updates the category, records history and renames products', () =>
  Effect.gen(function* catalogContentCase3() {
    const change = yield* updateCategoryCommand(
      state,
      { _tag: 'UpdateCategory', id: categoryId('c'), patch: { name: 'Metrické šrouby', position: 5 } },
      input,
    );
    const updated = change.state.categories?.find((category) => category.id === 'c');
    expect(updated?.name).toBe('Metrické šrouby');
    expect(updated?.position).toBe(5);
    expect(updated?.history?.length).toBe(1);
    expect(updated?.history?.[0]?.fields).toEqual(['Název', 'Pořadí']);
    expect(change.state.products[0]?.category).toBe('Metrické šrouby');
    expect(change.entityIds).toEqual(['c']);
  }),
);

it.effect('updateCategoryCommand returns the state unchanged when nothing differs', () =>
  Effect.gen(function* catalogContentCase4() {
    const change = yield* updateCategoryCommand(
      state,
      { _tag: 'UpdateCategory', id: categoryId('c'), patch: { name: 'Metrické', position: 2 } },
      input,
    );
    expect(change.state).toBe(state);
  }),
);

it.effect('updateCategoryCommand fails with not found for an unknown category', () =>
  Effect.gen(function* catalogContentCase5() {
    const error = yield* Effect.flip(
      updateCategoryCommand(state, { _tag: 'UpdateCategory', id: categoryId('missing'), patch: { name: 'X' } }, input),
    );
    expect(Schema.is(MerchandiseNotFound)(error)).toBe(true);
  }),
);

it.effect('createCategoryCommand adds a child, publishes it, and marks the parent as having children', () =>
  Effect.gen(function* catalogContentCreateCase1() {
    const created = yield* createCategoryCommand(state, {
      _tag: 'CreateCategory',
      id: categoryId('new'),
      name: 'Pánské',
      parentId: Option.some(categoryId('r')),
      slug: 'panske',
    });
    const category = created.state.categories?.find((entry) => entry.id === 'new');
    expect(Option.getOrNull(category?.parentId ?? Option.none())).toBe('r');
    expect(category?.published).toBe(true);
    expect(category?.heading).toBe('Pánské');
    expect(category?.hasChildren).toBe(false);
    expect(created.state.categories?.find((entry) => entry.id === 'r')?.hasChildren).toBe(true);
    // The root already has children, so only the new category changes.
    expect(created.entityIds).toEqual(['new']);
  }),
);

it.effect('createCategoryCommand adds a root category that is not published when asked', () =>
  Effect.gen(function* catalogContentCreateCase2() {
    const created = yield* createCategoryCommand(state, {
      _tag: 'CreateCategory',
      id: categoryId('root2'),
      name: 'Ostatní',
      parentId: Option.none(),
      published: false,
      slug: 'ostatni',
    });
    const category = created.state.categories?.find((entry) => entry.id === 'root2');
    expect(category?.published).toBe(false);
    expect(Option.isNone(category?.parentId ?? Option.some('?'))).toBe(true);
    expect(created.entityIds).toEqual(['root2']);
  }),
);

it.effect('createCategoryCommand refuses an existing identifier and an unknown parent', () =>
  Effect.gen(function* catalogContentCreateCase3() {
    const existing = yield* Effect.flip(
      createCategoryCommand(state, {
        _tag: 'CreateCategory',
        id: categoryId('r'),
        name: 'X',
        parentId: Option.none(),
        slug: 'x',
      }),
    );
    expect(Schema.is(MerchandiseLifecycleConflict)(existing)).toBe(true);
    const orphan = yield* Effect.flip(
      createCategoryCommand(state, {
        _tag: 'CreateCategory',
        id: categoryId('y'),
        name: 'Y',
        parentId: Option.some(categoryId('missing')),
        slug: 'y',
      }),
    );
    expect(Schema.is(MerchandiseNotFound)(orphan)).toBe(true);
  }),
);

it.effect('derives primary-first union and deduplicates direct additional categories', () =>
  Effect.gen(function* categoryMembershipUnion() {
    const other = { ...rootCategory, id: categoryId('other'), name: 'Sport', slug: 'sport' };
    const updated = yield* assignCategoryMemberships(
      p1,
      'c',
      [other.id, categoryId('c'), other.id],
      [...categories, other],
    );
    expect(updated.categoryId).toBe('c');
    expect(updated.category).toBe('Metrické');
    expect(updated.additionalCategoryIds).toEqual(['other']);
    expect(updated.categoryPathIds).toEqual(['c', 'r', 'other']);
    expect(contentChangeOf(p1, updated, input)?.fields).toEqual(['Další kategorie']);
    const repeated = yield* assignCategoryMemberships(
      updated,
      'c',
      [categoryId('c'), other.id, other.id],
      [...categories, other],
    );
    expect(contentChangeOf(updated, repeated, input)).toBeUndefined();
    const moved = yield* assignCategory(updated, 'r', [...categories, other]);
    expect(moved.additionalCategoryIds).toEqual(['other']);
    expect(moved.categoryPathIds).toEqual(['r', 'other']);
    const promoted = yield* assignCategory(updated, 'other', [...categories, other]);
    expect(promoted.additionalCategoryIds).toEqual([]);
    expect(promoted.categoryPathIds).toEqual(['other']);
  }),
);

it.effect('membership derivation rejects unknown direct ids, missing ancestors and cycles', () =>
  Effect.gen(function* invalidCategoryMemberships() {
    const unknown = yield* Effect.flip(assignCategoryMemberships(p1, 'c', [categoryId('missing')], categories));
    expect(Schema.is(MerchandiseLifecycleConflict)(unknown)).toBe(true);
    const missingAncestor = yield* Effect.flip(assignCategoryMemberships(p1, 'c', [], [childCategory]));
    expect(Schema.is(MerchandiseLifecycleConflict)(missingAncestor)).toBe(true);
    const cycle = { ...childCategory, parentId: Option.some(childCategory.id) };
    const cyclic = yield* Effect.flip(assignCategoryMemberships(p1, 'c', [], [cycle]));
    expect(Schema.is(MerchandiseLifecycleConflict)(cyclic)).toBe(true);
  }),
);

it.effect('CreateProduct derives primary category ancestry without additional category ids', () =>
  Effect.gen(function* primaryCategoryOnCreation() {
    const command = Schema.decodeUnknownSync(MerchandiseCommandSchema)({
      _tag: 'CreateProduct',
      active: true,
      category: 'Untrusted label',
      categoryId: 'c',
      categoryPathIds: ['wrong-path'],
      lowStockThreshold: 0,
      name: 'Category product',
      priceMinor: 100,
      sku: 'CATEGORY-PRODUCT',
      taxClassificationCode: 'cz.vat.standard',
      unit: 'ks',
    });
    if (!Predicate.isTagged(command, 'CreateProduct')) {
      return yield* Effect.die('Expected a product creation command');
    }
    expect(workingSetRequestOf(command, 'category-product').categoryIds).toEqual(['c']);
    const created = yield* evolveMerchandiseState(state, command, { ...input, resourceId: 'category-product' });
    expect(created.state.products.at(-1)).toMatchObject({
      category: 'Metrické',
      categoryId: 'c',
      categoryPathIds: ['c', 'r'],
    });
    const incomplete = { ...state, categories: [childCategory] };
    const refused = yield* evolveMerchandiseState(incomplete, command, { ...input, resourceId: 'orphan-product' }).pipe(
      Effect.flip,
    );
    expect(Schema.is(MerchandiseLifecycleConflict)(refused)).toBe(true);
  }),
);

it.effect('rejects a category slug already used elsewhere in the company, including unpublished categories', () =>
  Effect.gen(function* categorySlugCollision() {
    const create = {
      _tag: 'CreateCategory',
      id: categoryId('new-slug'),
      name: 'New category',
      parentId: Option.none(),
      slug: 'srouby',
    } as const;
    expect(workingSetRequestOf(create, 'create-slug').categorySlug).toBe('srouby');
    const refused = yield* createCategoryCommand(state, create).pipe(Effect.flip);
    expect(Schema.is(MerchandiseLifecycleConflict)(refused)).toBe(true);
    const hidden = { ...state, categories: categories.map((category) => ({ ...category, published: false })) };
    const hiddenRefusal = yield* createCategoryCommand(hidden, create).pipe(Effect.flip);
    expect(Schema.is(MerchandiseLifecycleConflict)(hiddenRefusal)).toBe(true);
    const accepted = yield* createCategoryCommand(state, { ...create, slug: 'new-unique-slug' });
    expect(accepted.state.categories?.at(-1)?.slug).toBe('new-unique-slug');
  }),
);

it.effect('a category-only working set already renames all stored primary-category labels transactionally', () =>
  Effect.scoped(
    Effect.gen(function* persistedCategoryRename() {
      const statements: { readonly sql: string; readonly params: readonly unknown[] }[] = [];
      const services = yield* Layer.build(
        scriptedPgClientLayer(
          Effect.succeed(
            testSqlConnection((sql, params) => {
              statements.push({ params, sql });
              if (sql.startsWith('select')) {
                return Effect.succeed([{ outcome: 'unrecorded' }]);
              }
              return Effect.succeed(sql.includes('returning') ? [{ revision: 1 }] : []);
            }),
          ),
        ).pipe(Layer.provide(Reactivity.layer)),
      );
      const db = yield* makeWithDefaults({ relations: merchandiseRelations }).pipe(
        Effect.provideService(PgClient.PgClient, Context.get(services, PgClient.PgClient)),
      );
      const scope = { tenantId: actor.tenantId, legalEntityId: '30000000-0000-4000-8000-000000000001' };
      const categoryOnly = { ...state, products: [] };
      const change = yield* updateCategoryCommand(
        categoryOnly,
        {
          _tag: 'UpdateCategory',
          id: categoryId('c'),
          patch: { name: 'Renamed without loading products' },
        },
        input,
      );
      yield* db.transaction((transaction) =>
        persistChange(
          transaction,
          scope,
          {
            revision: 0,
            state: categoryOnly,
            stock: new Map(),
          },
          change.state,
          now,
          TEST_RATES,
          {},
        ),
      );
      const productUpdates = statements.filter(({ sql }) => sql.startsWith('update "demo_merchandise"."products"'));
      expect(productUpdates).toHaveLength(1);
      expect(productUpdates[0]?.sql).toContain('jsonb_set(jsonb_set(');
      expect(productUpdates[0]?.sql).toContain('"category_id"');
      expect(productUpdates[0]?.params).toEqual(
        expect.arrayContaining([scope.tenantId, scope.legalEntityId, 'c', 'Renamed without loading products']),
      );
      return yield* Effect.void;
    }),
  ),
);

it.effect('loads a scoped slug collision even when its category id is absent from the create request', () =>
  Effect.scoped(
    Effect.gen(function* scopedCategoryCollisionRead() {
      const scope = { tenantId: actor.tenantId, legalEntityId: '30000000-0000-4000-8000-000000000001' };
      const stored = yield* categoryRowOf(scope, rootCategory);
      const services = yield* Layer.build(
        scriptedPgClientLayer(
          Effect.succeed(
            testSqlConnection((sql, params) => {
              expect(params).toEqual(expect.arrayContaining([scope.tenantId, scope.legalEntityId]));
              if (sql.includes('"slug" =')) {
                expect(params).toContain(rootCategory.slug);
                return Effect.succeed([{ id: rootCategory.id }]);
              }
              return Effect.succeed(params.includes(rootCategory.id) ? [{ ...stored, ordinal: 1 }] : []);
            }),
          ),
        ).pipe(Layer.provide(Reactivity.layer)),
      );
      const db = yield* makeWithDefaults({ relations: merchandiseRelations }).pipe(
        Effect.provideService(PgClient.PgClient, Context.get(services, PgClient.PgClient)),
      );
      const command = {
        _tag: 'CreateCategory',
        id: categoryId('new-collision-id'),
        name: 'Different category',
        parentId: Option.none(),
        slug: rootCategory.slug,
      } as const;
      const working = yield* loadWorkingSet(
        db,
        scope,
        EMPTY_CATALOG_HEAD,
        workingSetRequestOf(command, 'scoped-category'),
      );
      expect(working.state.categories?.map((category) => category.id)).toEqual([rootCategory.id]);
      const refused = yield* createCategoryCommand(working.state, command).pipe(Effect.flip);
      expect(Schema.is(MerchandiseLifecycleConflict)(refused)).toBe(true);
      return yield* Effect.void;
    }),
  ),
);
