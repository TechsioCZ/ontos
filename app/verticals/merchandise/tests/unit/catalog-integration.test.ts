import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { MerchandiseStateSchema } from '../../shared/apis/records.ts';
import { MerchandiseCommandSchema, MerchandiseLifecycleConflict } from '../../shared/actions/apply-command.ts';
import { evolveMerchandiseState } from '../../src/services/persistence.service.ts';

const actor = { principalId: '20000000-0000-4000-8000-000000000002', tenantId: '20000000-0000-4000-8000-000000000001' };
const at = '2026-10-19T08:00:00.000Z';
const now = DateTime.makeUnsafe('2026-10-20T10:00:00.000Z');
const baseState = {
  orders: [],
  movements: [],
  categories: [
    {
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
    },
    {
      id: 'c',
      parentId: 'r',
      name: 'Metrické',
      slug: 'metricke',
      heading: 'Metrické',
      description: '',
      longDescription: '',
      position: 1,
      imageSrc: '',
      imageAlt: '',
      hasChildren: false,
    },
  ],
  products: [
    {
      id: 'p1',
      name: 'Šroub',
      sku: 'S1',
      categoryId: 'r',
      categoryPathIds: ['r'],
      category: 'Šrouby',
      active: true,
      unit: 'ks',
      vatRate: 21,
      currentPriceMinor: 100,
      lowStockThreshold: 0,
      createdAt: at,
      updatedAt: at,
      priceHistory: [],
    },
  ],
};
const state = Schema.decodeUnknownSync(MerchandiseStateSchema)(baseState);
const command = (value: unknown) => Schema.decodeUnknownSync(MerchandiseCommandSchema)(value);
const input = { actor, now, resourceId: 'resource-1' };

it.effect('moves a product to a subcategory and records the content change', () =>
  Effect.gen(function* () {
    const change = yield* evolveMerchandiseState(
      state,
      command({
        _tag: 'UpdateProduct',
        id: 'p1',
        patch: { categoryId: 'c', name: 'Šroub M8', isAction: true },
      }),
      input,
    );
    const product = change.state.products[0]!;
    expect(product.categoryId).toBe('c');
    expect(product.categoryPathIds).toEqual(['c', 'r']);
    expect(product.category).toBe('Metrické');
    expect(product.contentHistory).toHaveLength(1);
    const fields = product.contentHistory?.[0]?.fields ?? [];
    expect(fields).toContain('Název');
    expect(fields).toContain('Kategorie');
    expect(fields).toContain('Akce');
  }),
);

it.effect('rejects a product move into an unknown category', () =>
  Effect.gen(function* () {
    const failure = yield* evolveMerchandiseState(
      state,
      command({ _tag: 'UpdateProduct', id: 'p1', patch: { categoryId: 'missing' } }),
      input,
    ).pipe(Effect.flip);
    expect(Schema.is(MerchandiseLifecycleConflict)(failure)).toBe(true);
  }),
);

it.effect('renames a category and carries the new name to its products', () =>
  Effect.gen(function* () {
    const moved = yield* evolveMerchandiseState(
      state,
      command({ _tag: 'UpdateProduct', id: 'p1', patch: { categoryId: 'c' } }),
      input,
    );
    const renamed = yield* evolveMerchandiseState(
      moved.state,
      command({ _tag: 'UpdateCategory', id: 'c', patch: { name: 'Metrické šrouby' } }),
      input,
    );
    expect(renamed.state.products[0]?.category).toBe('Metrické šrouby');
  }),
);
