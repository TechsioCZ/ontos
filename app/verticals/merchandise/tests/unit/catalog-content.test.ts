import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { MerchandiseLifecycleConflict, MerchandiseNotFound } from '../../shared/actions/apply-command.ts';
import { MerchandiseStateSchema } from '../../shared/apis/records.ts';
import { CatalogCategorySchema, ProductSchema } from '../../shared/domain/merchandise-model.ts';
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
  id: 'r',
  parentId: null,
  name: 'Šrouby',
  slug: 'srouby',
  heading: 'Šrouby',
  description: '',
  longDescription: '',
  position: 1,
  imageSrc: '',
  imageAlt: '',
  hasChildren: true,
});
const childCategory = Schema.decodeUnknownSync(CatalogCategorySchema)({
  id: 'c',
  parentId: 'r',
  name: 'Metrické',
  slug: 'metricke',
  heading: 'Metrické',
  description: '',
  longDescription: '',
  position: 2,
  imageSrc: '',
  imageAlt: '',
  hasChildren: false,
});
const categories = [rootCategory, childCategory];

const rawP1 = {
  id: 'p1',
  categoryId: 'c',
  category: 'Metrické',
  name: 'Šroub',
  sku: 'S1',
  active: true,
  unit: 'ks',
  vatRate: 21,
  currentPriceMinor: 100,
  lowStockThreshold: 0,
  createdAt: at,
  updatedAt: at,
  priceHistory: [],
};
const p1 = Schema.decodeUnknownSync(ProductSchema)(rawP1);

const state = Schema.decodeUnknownSync(MerchandiseStateSchema)({
  orders: [],
  movements: [],
  categories,
  products: [rawP1],
});

it('categoryPathOf starts at the id and walks up to the root', () => {
  expect(categoryPathOf(categories, 'c')).toEqual(['c', 'r']);
});

it('contentChangeOf lists changed content fields with Czech labels', () => {
  const change = contentChangeOf(p1, { ...p1, name: 'Šroub M8', isAction: true }, input);
  expect(change?.fields).toEqual(['Název', 'Akce']);
  expect(change?.before).toContain('Název: Šroub');
  expect(change?.after).toContain('Akce: ano');
});

it('contentChangeOf ignores non-content changes', () => {
  expect(contentChangeOf(p1, { ...p1, updatedAt: now }, input)).toBeUndefined();
});

it('withContentHistory keeps at most 50 entries', () => {
  const history = Array.from({ length: 50 }, (_, index) => ({
    at: now,
    actor,
    fields: ['Název'],
    before: `Název: ${index}`,
    after: `Název: ${index + 1}`,
  }));
  const before = { ...p1, contentHistory: history };
  const result = withContentHistory(before, { ...before, name: 'Nový šroub' }, input);
  expect(result.contentHistory?.length).toBe(50);
  expect(result.contentHistory?.at(-1)?.after).toBe('Název: Nový šroub');
  expect(result.contentHistory?.[0]?.before).toBe('Název: 1');
});

it.effect('assignCategory moves the product to an existing category', () =>
  Effect.gen(function* () {
    const moved = yield* assignCategory(p1, 'r', categories);
    expect(moved.categoryId).toBe('r');
    expect(moved.categoryPathIds).toEqual(['r']);
    expect(moved.category).toBe('Šrouby');
  }),
);

it.effect('assignCategory fails with a lifecycle conflict for an unknown category', () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(assignCategory(p1, 'missing', categories));
    expect(Schema.is(MerchandiseLifecycleConflict)(error)).toBe(true);
  }),
);

it.effect('updateCategoryCommand updates the category, records history and renames products', () =>
  Effect.gen(function* () {
    const change = yield* updateCategoryCommand(
      state,
      { _tag: 'UpdateCategory', id: 'c', patch: { name: 'Metrické šrouby', position: 5 } },
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
  Effect.gen(function* () {
    const change = yield* updateCategoryCommand(
      state,
      { _tag: 'UpdateCategory', id: 'c', patch: { name: 'Metrické', position: 2 } },
      input,
    );
    expect(change.state).toBe(state);
  }),
);

it.effect('updateCategoryCommand fails with not found for an unknown category', () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      updateCategoryCommand(state, { _tag: 'UpdateCategory', id: 'missing', patch: { name: 'X' } }, input),
    );
    expect(Schema.is(MerchandiseNotFound)(error)).toBe(true);
  }),
);
