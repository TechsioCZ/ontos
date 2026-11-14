import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { CatalogCategorySchema, ProductSchema } from '../../shared/domain/merchandise-model.ts';
import {
  BootstrapBatchSchema,
  PLAYGROUND_COMPANY,
  PLAYGROUND_TENANT,
  PlaygroundBootstrapRejected,
} from '../../shared/domain/playground-catalog-bootstrap.ts';
import { productRowsOf } from '../../src/services/merchandise-store.ts';
import { bootstrapStateForBatch } from '../../src/services/playground-catalog-bootstrap.ts';
import { stockLevelsOf } from '../../src/services/stock-levels.ts';
import { TEST_RATES } from '../support/tax-fixtures.ts';

const sourceAt = '2026-10-01T08:00:00.000Z';
const at = DateTime.makeUnsafe('2026-11-02T10:00:00.000Z');
const scope = { legalEntityId: PLAYGROUND_COMPANY, tenantId: PLAYGROUND_TENANT };
const simple = {
  active: true,
  category: 'Fasteners',
  categoryId: 'fasteners',
  createdAt: sourceAt,
  currentPriceMinor: 120,
  id: 'simple-product',
  lowStockThreshold: 2,
  name: 'Washer',
  priceHistory: [],
  sku: 'WASHER',
  taxClassificationCode: 'cz.vat.standard',
  unit: 'ks',
  updatedAt: sourceAt,
} satisfies typeof ProductSchema.Encoded;
const variantProduct = {
  ...simple,
  id: 'variant-product',
  name: 'Bolt',
  sku: 'BOLT',
  variants: [
    { active: true, attributes: 'M6', id: 'variant-m6', name: 'M6', priceMinor: 200, sku: 'BOLT-M6' },
    { active: true, attributes: 'M8', id: 'variant-m8', name: 'M8', priceMinor: 350, sku: 'BOLT-M8' },
    { active: true, attributes: 'M10', id: 'variant-m10', name: 'M10', priceMinor: 500, sku: 'BOLT-M10' },
  ],
} satisfies typeof ProductSchema.Encoded;
const batch = Schema.decodeUnknownSync(BootstrapBatchSchema)({
  categories: [
    {
      description: '',
      hasChildren: false,
      heading: '',
      id: 'fasteners',
      imageAlt: '',
      imageSrc: '',
      longDescription: '',
      name: 'Fasteners',
      parentId: null,
      position: 0,
      slug: 'fasteners',
    },
  ],
  products: [
    { product: simple, stock: [{ quantity: 7.5 }] },
    {
      product: variantProduct,
      stock: [
        { quantity: 3, variantId: 'variant-m6' },
        { quantity: 8, variantId: 'variant-m8' },
        { quantity: 0, variantId: 'variant-m10' },
      ],
    },
  ],
});

it.effect('projects simple and variant opening balances into native product and variant rows', () =>
  Effect.gen(function* nativeOpeningStock() {
    const state = yield* bootstrapStateForBatch(batch, 4, 'bootstrap-invocation', at);
    expect(state.products.every(Schema.is(ProductSchema))).toBe(true);
    const levels = state.products.map((product) => stockLevelsOf(state.movements, product.id));
    expect(levels.map(({ total, variants }) => ({ total, variants: [...variants] }))).toEqual([
      { total: 7.5, variants: [] },
      {
        total: 11,
        variants: [
          ['variant-m6', 3],
          ['variant-m8', 8],
          ['variant-m10', 0],
        ],
      },
    ]);
    const rows = yield* Effect.all(
      state.products.map((product) =>
        productRowsOf(scope, product, stockLevelsOf(state.movements, product.id), TEST_RATES, {}),
      ),
    );
    expect(rows).toMatchObject([
      {
        row: { ...scope, id: simple.id, stockOnHand: 7.5, stockValueMinor: 900 },
        variants: [],
      },
      {
        row: { ...scope, id: variantProduct.id, stockOnHand: 11, stockValueMinor: 3400 },
        variants: [
          { ...scope, productId: variantProduct.id, stockOnHand: 3, variantId: 'variant-m6' },
          { ...scope, productId: variantProduct.id, stockOnHand: 8, variantId: 'variant-m8' },
          { ...scope, productId: variantProduct.id, stockOnHand: 0, variantId: 'variant-m10' },
        ],
      },
    ]);
    expect(rows.map(({ variants }) => variants.length)).toEqual([0, 3]);
  }),
);

it.effect('keeps native identities scoped by tenant and company without rewriting product or variant IDs', () =>
  Effect.gen(function* scopedNativeRows() {
    const state = yield* bootstrapStateForBatch(batch, 4, 'bootstrap-invocation', at);
    const scopes = [
      scope,
      { ...scope, tenantId: '10000000-0000-4000-8000-000000000001' },
      { ...scope, legalEntityId: '20000000-0000-4000-8000-000000000002' },
    ];
    for (const storeScope of scopes) {
      const rows = yield* Effect.all(
        state.products.map((product) =>
          productRowsOf(storeScope, product, stockLevelsOf(state.movements, product.id), TEST_RATES, {}),
        ),
      );
      expect(rows.map(({ row }) => [row.tenantId, row.legalEntityId, row.id])).toEqual([
        [storeScope.tenantId, storeScope.legalEntityId, simple.id],
        [storeScope.tenantId, storeScope.legalEntityId, variantProduct.id],
      ]);
      expect(
        rows.flatMap(({ variants }) =>
          variants.map((row) => [row.tenantId, row.legalEntityId, row.productId, row.variantId]),
        ),
      ).toEqual([
        [storeScope.tenantId, storeScope.legalEntityId, variantProduct.id, 'variant-m6'],
        [storeScope.tenantId, storeScope.legalEntityId, variantProduct.id, 'variant-m8'],
        [storeScope.tenantId, storeScope.legalEntityId, variantProduct.id, 'variant-m10'],
      ]);
    }
  }),
);

it.effect('makes opening movement IDs deterministic per invocation, batch and item without collisions', () =>
  Effect.gen(function* openingMovementIdentity() {
    const first = yield* bootstrapStateForBatch(batch, 4, 'bootstrap-invocation', at);
    const retry = yield* bootstrapStateForBatch(batch, 4, 'bootstrap-invocation', at);
    expect(retry).toEqual(first);
    const laterRetry = yield* bootstrapStateForBatch(
      batch,
      4,
      'bootstrap-invocation',
      DateTime.makeUnsafe('2026-11-02T11:00:00.000Z'),
    );
    const nextBatch = yield* bootstrapStateForBatch(batch, 5, 'bootstrap-invocation', at);
    const nextInvocation = yield* bootstrapStateForBatch(batch, 4, 'another-invocation', at);
    const ids = first.movements.map(({ id }) => id);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    expect(laterRetry.movements.map(({ id }) => id)).toEqual(ids);
    const allIds = [first, nextBatch, nextInvocation].flatMap((state) => state.movements.map(({ id }) => id));
    expect(new Set(allIds).size).toBe(12);
    expect(
      first.movements.map(({ delta, productId, variantId }) => ({ delta, productId, variantId: variantId ?? null })),
    ).toEqual([
      { delta: 7.5, productId: simple.id, variantId: null },
      { delta: 3, productId: variantProduct.id, variantId: 'variant-m6' },
      { delta: 8, productId: variantProduct.id, variantId: 'variant-m8' },
      { delta: 0, productId: variantProduct.id, variantId: 'variant-m10' },
    ]);
  }),
);

it.effect('adds only current opening movements, not source audit actors, history or orders', () =>
  Effect.gen(function* noImportedAudit() {
    const state = yield* bootstrapStateForBatch(batch, 4, 'bootstrap-invocation', at);
    expect(state.orders).toEqual([]);
    expect(state.products).toEqual([
      Schema.decodeUnknownSync(ProductSchema)(simple),
      Schema.decodeUnknownSync(ProductSchema)(variantProduct),
    ]);
    expect(state.categories).toEqual(
      batch.categories.map((category) => Schema.decodeUnknownSync(CatalogCategorySchema)(category)),
    );
    for (const product of state.products) {
      expect(product.contentHistory).toBeUndefined();
      expect(product.priceHistory).toEqual([]);
      expect(product.demoArchive).toBeUndefined();
      for (const variant of product.variants ?? []) {
        expect(variant.priceHistory).toBeUndefined();
      }
    }
    for (const category of state.categories ?? []) {
      expect(category.history).toBeUndefined();
    }
    for (const movement of state.movements) {
      const expected = {
        at,
        delta: movement.delta,
        id: movement.id,
        note: 'Opening balance from approved frozen AKROS source',
        productId: movement.productId,
        reason: 'ADJUSTMENT',
      };
      expect(movement).toEqual(
        movement.variantId === undefined ? expected : { ...expected, variantId: movement.variantId },
      );
    }
    const rows = yield* Effect.all(
      state.products.map((product) =>
        productRowsOf(scope, product, stockLevelsOf(state.movements, product.id), TEST_RATES, {}),
      ),
    );
    for (const { row, variants } of rows) {
      expect(row.document).not.toHaveProperty('contentHistory');
      expect(row.document).not.toHaveProperty('demoArchive');
      expect(row.document).toHaveProperty('priceHistory', []);
      for (const variant of variants) {
        expect(variant.document).not.toHaveProperty('priceHistory');
      }
    }
  }),
);

it.effect('rejects malformed native products and opening movements as typed bootstrap failures', () =>
  Effect.gen(function* malformedNativeModel() {
    const malformedProducts = {
      ...batch,
      products: batch.products.map((entry) => ({
        ...entry,
        product: { ...entry.product, createdAt: 'not-a-date' },
      })),
    };
    const malformedMovements = {
      ...batch,
      products: batch.products.map((entry) => ({
        ...entry,
        stock: [{ quantity: 1, variantId: '' }],
      })),
    };
    for (const malformed of [malformedProducts, malformedMovements]) {
      const error = yield* bootstrapStateForBatch(malformed, 4, 'bootstrap-invocation', at).pipe(Effect.flip);
      expect(Schema.is(PlaygroundBootstrapRejected)(error)).toBe(true);
      expect(error).toMatchObject({
        code: 'playground_bootstrap_rejected',
        reason: 'Bootstrap data does not match the merchandise model',
      });
    }
  }),
);

it.effect('normalizes native product and variant stock columns with the same precision as the ledger', () =>
  Effect.gen(function* nativeStockPrecision() {
    const product = Schema.decodeUnknownSync(ProductSchema)(variantProduct);
    const projected = yield* productRowsOf(
      scope,
      product,
      {
        total: 0.3 - 0.1,
        variants: new Map([['variant-m6', 0.3 - 0.1]]),
      },
      TEST_RATES,
      {},
    );
    expect(projected.row.stockOnHand).toBe(0.2);
    expect(projected.variants[0]?.stockOnHand).toBe(0.2);
    return yield* Effect.void;
  }),
);
