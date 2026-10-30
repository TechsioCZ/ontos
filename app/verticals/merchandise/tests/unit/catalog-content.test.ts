import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { MerchandiseLifecycleConflict, MerchandiseNotFound } from '../../shared/actions/apply-command.ts';
import { MerchandiseStateSchema } from '../../shared/apis/records.ts';
import {
  CatalogCategoryIdSchema,
  CatalogCategorySchema,
  ProductSchema,
} from '../../shared/domain/merchandise-model.ts';
import {
  assignCategory,
  categoryPathOf,
  contentChangeOf,
  updateCategoryCommand,
  withContentHistory,
} from '../../src/services/catalog-content.ts';

const actor = { principalId: '20000000-0000-4000-8000-000000000002', tenantId: '20000000-0000-4000-8000-000000000001' };
const now = DateTime.makeUnsafe('2026-10-20T10:00:00.000Z');
const input = { actor, now, resourceId: 'resource-1' };
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
  unit: 'ks',
  updatedAt: at,
  vatRate: 21,
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
