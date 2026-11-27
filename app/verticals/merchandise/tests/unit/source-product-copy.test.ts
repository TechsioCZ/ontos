import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { MerchandiseCommandSchema, MerchandiseLifecycleConflict } from '../../shared/actions/apply-command.ts';
import type { MerchandiseState } from '../../shared/apis/records.ts';
import { evolveMerchandiseState } from '../../src/services/persistence.service.ts';
import { TEST_TAX } from '../support/tax-fixtures.ts';

const actor = {
  principalId: '20000000-0000-4000-8000-000000000002',
  tenantId: '20000000-0000-4000-8000-000000000001',
};
const originalTime = DateTime.makeUnsafe('2026-11-20T10:00:00Z');
const changedTime = DateTime.makeUnsafe('2026-11-21T10:00:00Z');
const newerTime = DateTime.makeUnsafe('2026-11-22T10:00:00Z');
const empty: MerchandiseState = { movements: [], orders: [], products: [] };
const source = {
  _tag: 'UpsertSourceProduct',
  catalogProductId: 'catalog-product-1',
  erpCode: 'ERP-1',
  lifecycle: 'ACTIVE',
  name: 'ERP product',
  sourceRecordId: 'product:erpId:ERP-1',
  sourceUpdatedAt: '2026-11-20T10:00:00Z',
  variants: [{ catalogVariantId: 'catalog-variant-1', priceNetMinor: 10_000, sku: 'ERP-V1', stockOnHand: 7 }],
} as const;
const apply = (
  state: MerchandiseState,
  command: typeof MerchandiseCommandSchema.Encoded,
  resourceId: string,
  now = originalTime,
) =>
  evolveMerchandiseState(state, Schema.decodeUnknownSync(MerchandiseCommandSchema)(command), {
    actor,
    now,
    resourceId,
    tax: TEST_TAX,
  });
const nativeProduct = {
  _tag: 'CreateProduct',
  active: true,
  category: 'Staff category',
  lowStockThreshold: 0,
  name: 'Staff title',
  priceMinor: 9000,
  sku: 'ERP-1',
  taxClassificationCode: 'cz.vat.standard',
  unit: 'ks',
} as const;

it.effect('creates the source product once and preserves the state on an identical later sweep', () =>
  Effect.gen(function* replaySourceProduct() {
    const created = yield* apply(empty, source, 'first');
    expect(created.sourceUpsert?.outcome).toBe('CREATED');
    const [product] = created.state.products;
    expect(product?.currentPriceMinor).toBe(10_000);
    expect(product?.published).toBe(true);
    expect(product?.catalogVariantId).toBe('catalog-variant-1');
    expect(created.state.movements.map(({ delta }) => delta)).toEqual([7]);
    const replay = yield* apply(created.state, source, 'replay', changedTime);
    expect(replay.sourceUpsert?.outcome).toBe('UNCHANGED');
    expect(replay.state).toBe(created.state);
  }),
);

it.effect('updates the source price and records only the difference in on-hand', () =>
  Effect.gen(function* changeSourceFigures() {
    const created = yield* apply(empty, source, 'first');
    const updated = yield* apply(
      created.state,
      {
        ...source,
        variants: [{ ...source.variants[0], priceNetMinor: 12_000, stockOnHand: 4 }],
      },
      'second',
      changedTime,
    );
    expect(updated.sourceUpsert?.outcome).toBe('UPDATED');
    expect(updated.state.products[0]?.currentPriceMinor).toBe(12_000);
    expect(updated.state.products[0]?.priceHistory).toHaveLength(2);
    expect(updated.state.movements.map(({ delta }) => delta)).toEqual([7, -3]);
  }),
);

it.effect('keeps source variant identities and replays a product with multiple variants without a write', () =>
  Effect.gen(function* replayVariants() {
    const command = {
      ...source,
      variants: [source.variants[0], { ...source.variants[0], catalogVariantId: 'catalog-variant-2', sku: 'ERP-V2' }],
    };
    const created = yield* apply(empty, command, 'first');
    expect(created.state.products[0]?.variants?.map(({ catalogVariantId }) => catalogVariantId)).toEqual([
      'catalog-variant-1',
      'catalog-variant-2',
    ]);
    const replay = yield* apply(created.state, command, 'replay', changedTime);
    expect(replay.sourceUpsert?.outcome).toBe('UNCHANGED');
    expect(replay.state).toBe(created.state);
  }),
);

it.effect('does not create a new product or stock movement without an accepted price', () =>
  Effect.gen(function* refuseUnpricedProduct() {
    const result = yield* apply(
      empty,
      {
        ...source,
        variants: [{ ...source.variants[0], priceNetMinor: null }],
      },
      'unpriced',
    );
    expect(result.sourceUpsert?.outcome).toBe('UNCHANGED');
    expect(result.state).toBe(empty);
  }),
);

it.effect('treats either sign of a zero variant price as an unchanged source value', () =>
  Effect.gen(function* replayZeroPrice() {
    const zeroVariant = {
      ...source.variants[0],
      catalogVariantId: 'catalog-variant-2',
      priceNetMinor: 0,
      sku: 'ERP-V2',
    };
    const created = yield* apply(empty, { ...source, variants: [source.variants[0], zeroVariant] }, 'first');
    const replay = yield* apply(
      created.state,
      {
        ...source,
        variants: [source.variants[0], { ...zeroVariant, priceNetMinor: -0 }],
      },
      'replay',
      changedTime,
    );
    expect(replay.sourceUpsert?.outcome).toBe('UNCHANGED');
    expect(replay.state).toBe(created.state);
  }),
);

it.effect('links the SKU holder while preserving its staff title and category', () =>
  Effect.gen(function* linkNativeProduct() {
    const native = yield* apply(empty, nativeProduct, 'native');
    const linked = yield* apply(native.state, source, 'link');
    expect(linked.state.products).toHaveLength(1);
    const [product] = linked.state.products;
    expect(product?.id).toBe('native');
    expect(product?.name).toBe(nativeProduct.name);
    expect(product?.category).toBe(nativeProduct.category);
    expect(product?.currentPriceMinor).toBe(10_000);
    expect(product?.importedVia).toBe('symmy');
    expect(product?.catalogVariantId).toBe('catalog-variant-1');
    expect(linked.state.movements.map(({ delta }) => delta)).toEqual([7]);
  }),
);

it.effect('retires the imported row and restores it when the source becomes active again', () =>
  Effect.gen(function* restoreImportedProduct() {
    const created = yield* apply(empty, source, 'first');
    const retired = yield* apply(created.state, { ...source, lifecycle: 'RETIRED' }, 'retire', changedTime);
    expect(retired.state.products[0]?.active).toBe(false);
    expect(retired.state.products[0]?.demoArchive).toBeDefined();
    const restored = yield* apply(retired.state, source, 'restore', newerTime);
    expect(restored.state.products[0]?.active).toBe(true);
    expect(restored.state.products[0]?.demoArchive).toBeUndefined();
    expect(restored.state.movements).toHaveLength(1);
  }),
);

it.effect('a retired source unlinks a native SKU holder without archiving its shop row', () =>
  Effect.gen(function* retireLinkedProduct() {
    const native = yield* apply(empty, nativeProduct, 'native');
    const linked = yield* apply(native.state, source, 'link');
    const retired = yield* apply(linked.state, { ...source, lifecycle: 'RETIRED' }, 'retire', changedTime);
    const [product] = retired.state.products;
    expect(product?.active).toBe(true);
    expect(product?.demoArchive).toBeUndefined();
    expect(product?.importedVia).toBeUndefined();
    expect(product?.catalogProductId).toBeUndefined();
    expect(product?.name).toBe(nativeProduct.name);
  }),
);

it.effect('honors a staff unlink until the source product has changed after it', () =>
  Effect.gen(function* respectStaffUnlink() {
    const native = yield* apply(empty, nativeProduct, 'native');
    const linked = yield* apply(native.state, source, 'link');
    const unlinked = yield* apply(
      linked.state,
      { _tag: 'SetSymmyLink', action: 'UNLINK', id: 'native' },
      'unlink',
      changedTime,
    );
    const refused = yield* apply(unlinked.state, source, 'older-source', newerTime);
    expect(refused.sourceUpsert?.reason).toBe('UNLINKED_BY_STAFF');
    expect(refused.state).toBe(unlinked.state);
    const relinked = yield* apply(
      refused.state,
      { ...source, sourceUpdatedAt: '2026-11-22T10:00:00Z' },
      'new-source',
      newerTime,
    );
    expect(relinked.state.products[0]?.importedVia).toBe('symmy');
    expect(relinked.state.products[0]?.symmyLinkRefusedAt).toBeUndefined();
  }),
);

it.effect('refuses staff unlinking of a row created by the source import', () =>
  Effect.gen(function* keepImportedIdentity() {
    const created = yield* apply(empty, source, 'first');
    const failure = yield* apply(
      created.state,
      {
        _tag: 'SetSymmyLink',
        action: 'UNLINK',
        id: 'symmy-catalog-product-1',
      },
      'unlink',
    ).pipe(Effect.flip);
    expect(Schema.is(MerchandiseLifecycleConflict)(failure)).toBe(true);
  }),
);
