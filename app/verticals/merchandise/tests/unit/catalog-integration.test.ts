import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { MerchandiseStateSchema } from '../../shared/apis/records.ts';
import { MerchandiseCommandSchema, MerchandiseLifecycleConflict } from '../../shared/actions/apply-command.ts';
import { evolveMerchandiseState } from '../../src/services/persistence.service.ts';

const actor = { principalId: '20000000-0000-4000-8000-000000000002', tenantId: '20000000-0000-4000-8000-000000000001' };
const at = '2026-10-19T08:00:00.000Z';
const now = DateTime.makeUnsafe('2026-10-20T10:00:00.000Z');
const baseState = {
  categories: [
    {
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
    },
    {
      description: '',
      hasChildren: false,
      heading: 'Metrické',
      id: 'c',
      imageAlt: '',
      imageSrc: '',
      longDescription: '',
      name: 'Metrické',
      parentId: 'r',
      position: 1,
      slug: 'metricke',
    },
  ],
  movements: [],
  orders: [],
  products: [
    {
      active: true,
      category: 'Šrouby',
      categoryId: 'r',
      categoryPathIds: ['r'],
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
    },
  ],
};
const state = Schema.decodeUnknownSync(MerchandiseStateSchema)(baseState);
const command = Schema.decodeUnknownSync(MerchandiseCommandSchema);
const input = { actor, now, resourceId: 'resource-1' };

it.effect('moves a product to a subcategory and records the content change', () =>
  Effect.gen(function* merchandiseScenario1() {
    const change = yield* evolveMerchandiseState(
      state,
      command({
        _tag: 'UpdateProduct',
        id: 'p1',
        patch: { categoryId: 'c', isAction: true, name: 'Šroub M8' },
      }),
      input,
    );
    const [product] = change.state.products;
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
  Effect.gen(function* merchandiseScenario2() {
    const failure = yield* evolveMerchandiseState(
      state,
      command({ _tag: 'UpdateProduct', id: 'p1', patch: { categoryId: 'missing' } }),
      input,
    ).pipe(Effect.flip);
    expect(Schema.is(MerchandiseLifecycleConflict)(failure)).toBe(true);
  }),
);

it.effect('renames a category and carries the new name to its products', () =>
  Effect.gen(function* merchandiseScenario3() {
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

const membershipState = Schema.decodeUnknownSync(MerchandiseStateSchema)({
  ...baseState,
  categories: [
    ...baseState.categories,
    {
      description: '',
      hasChildren: false,
      heading: 'Sport',
      id: 'other',
      imageAlt: '',
      imageSrc: '',
      longDescription: '',
      name: 'Sport',
      parentId: null,
      position: 2,
      slug: 'sport',
    },
  ],
});

it.effect('same-primary secondary edits derive paths, preserve on a move, and remove explicitly', () =>
  Effect.gen(function* categoryMembershipEdits() {
    const added = yield* evolveMerchandiseState(
      membershipState,
      command({
        _tag: 'UpdateProduct',
        id: 'p1',
        patch: { additionalCategoryIds: ['other', 'r', 'other'], categoryId: 'r', categoryPathIds: ['forged'] },
      }),
      input,
    );
    expect(added.state.products[0]?.categoryId).toBe('r');
    expect(added.state.products[0]?.categoryPathIds).toEqual(['r', 'other']);
    expect(added.state.products[0]?.additionalCategoryIds).toEqual(['other']);
    expect(added.state.products[0]?.contentHistory?.at(-1)?.fields).toContain('Další kategorie');
    const unchanged = yield* evolveMerchandiseState(
      added.state,
      command({ _tag: 'UpdateProduct', id: 'p1', patch: { active: false } }),
      input,
    );
    expect(unchanged.state.products[0]?.additionalCategoryIds).toEqual(['other']);
    expect(unchanged.state.products[0]?.categoryPathIds).toEqual(['r', 'other']);
    expect(unchanged.state.products[0]?.contentHistory).toEqual(added.state.products[0]?.contentHistory);
    const moved = yield* evolveMerchandiseState(
      added.state,
      command({
        _tag: 'UpdateProduct',
        id: 'p1',
        patch: { categoryId: 'c' },
      }),
      input,
    );
    expect(moved.state.products[0]?.categoryPathIds).toEqual(['c', 'r', 'other']);
    const removed = yield* evolveMerchandiseState(
      moved.state,
      command({
        _tag: 'UpdateProduct',
        id: 'p1',
        patch: { additionalCategoryIds: [] },
      }),
      input,
    );
    expect(removed.state.products[0]?.categoryId).toBe('c');
    expect(removed.state.products[0]?.categoryPathIds).toEqual(['c', 'r']);
    expect(removed.state.products[0]?.additionalCategoryIds).toEqual([]);
    expect(removed.state.products[0]?.contentHistory?.at(-1)?.fields).toContain('Další kategorie');
  }),
);

it.effect('legacy CreateProduct retains its trusted category fields without adding memberships', () =>
  Effect.gen(function* legacyCreateCategoryCompatibility() {
    const created = yield* evolveMerchandiseState(
      state,
      command({
        _tag: 'CreateProduct',
        active: true,
        category: 'Trusted display',
        categoryId: 'trusted-id',
        categoryPathIds: ['trusted-id', 'trusted-root'],
        lowStockThreshold: 0,
        name: 'Trusted',
        priceMinor: 100,
        sku: 'TRUSTED',
        unit: 'ks',
        vatRate: 21,
      }),
      input,
    );
    const product = created.state.products.at(-1);
    expect(product?.category).toBe('Trusted display');
    expect(product?.categoryId).toBe('trusted-id');
    expect(product?.categoryPathIds).toEqual(['trusted-id', 'trusted-root']);
    expect(product?.additionalCategoryIds).toBeUndefined();
  }),
);

it.effect('opt-in CreateProduct derives paths and rejects an unproved primary', () =>
  Effect.gen(function* createCategoryMemberships() {
    const fields = {
      _tag: 'CreateProduct',
      active: true,
      additionalCategoryIds: ['other'],
      category: 'Client display',
      categoryPathIds: ['forged'],
      lowStockThreshold: 0,
      name: 'New',
      priceMinor: 100,
      sku: 'NEW',
      unit: 'ks',
      vatRate: 21,
    };
    const created = yield* evolveMerchandiseState(membershipState, command({ ...fields, categoryId: 'c' }), input);
    const product = created.state.products.at(-1);
    expect(product?.category).toBe('Metrické');
    expect(product?.categoryPathIds).toEqual(['c', 'r', 'other']);
    const missing = yield* Effect.flip(evolveMerchandiseState(membershipState, command(fields), input));
    expect(Schema.is(MerchandiseLifecycleConflict)(missing)).toBe(true);
    const unknown = yield* Effect.flip(
      evolveMerchandiseState(membershipState, command({ ...fields, categoryId: 'missing' }), input),
    );
    expect(Schema.is(MerchandiseLifecycleConflict)(unknown)).toBe(true);
  }),
);
