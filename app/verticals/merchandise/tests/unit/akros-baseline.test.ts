// The bundled AKROS baseline (src/services/akros-baseline.generated.ts) must match what `demo:seed:akros --reset`
// builds from the storefront feed. Regenerate with `node scripts/generate-akros-baseline.mts` when this fails.
import { gunzipSync } from 'node:zlib';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { akrosBaselineParts } from '../../scripts/akros-baseline-parts.ts';
import { buildAkrosEncoded } from '../../scripts/akros-catalog.mts';
import { loadAkrosBaselineParts } from '../../src/services/akros-baseline.generated.ts';
import { computeProductRecords } from '../../src/services/stock-levels.ts';
import { MerchandiseStateSchema } from '../../shared/apis/records.ts';
import { decodeAkrosBaselinePart } from '../../src/services/akros-demo-reset.ts';

it.effect('bundled baseline parts equal the seed baseline built from the storefront feed', () =>
  Effect.gen(function* sameBundledBaseline() {
    const built = yield* buildAkrosEncoded();
    const expected = (yield* akrosBaselineParts(built)).map((part) => JSON.stringify(part));
    const bundled = loadAkrosBaselineParts().map((part) => gunzipSync(Buffer.from(part, 'base64')).toString('utf-8'));
    expect(bundled.length).toBe(expected.length);
    const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(MerchandiseStateSchema));
    const decodedBundled = yield* Effect.forEach(bundled, (part) => decode(part), { concurrency: 1 });
    const decodedExpected = yield* Effect.forEach(expected, (part) => decode(part), { concurrency: 1 });
    expect(decodedBundled).toEqual(decodedExpected);
    expect(bundled.every((part, index) => part === expected[index])).toBe(true);
  }),
);

it.effect('parts cover the whole baseline: every product once, every movement with its product', () =>
  Effect.gen(function* completeBaselineParts() {
    const built = yield* buildAkrosEncoded();
    const parts = yield* akrosBaselineParts(built);
    expect(parts.flatMap((part) => part.products.map((product) => product.id))).toEqual(
      built.products.map((product) => product.id),
    );
    expect(parts.reduce((sum, part) => sum + part.movements.length, 0)).toBe(built.movements.length);
    for (const part of parts.slice(1)) {
      const ids = new Set(part.products.map((product) => product.id));
      expect(part.movements.every((movement) => ids.has(movement.productId))).toBe(true);
      expect(part.orders).toHaveLength(0);
    }
    expect(parts[0]?.orders).toHaveLength(built.orders.length);
    expect(parts[0]?.categories).toHaveLength(built.categories?.length ?? 0);
  }),
);

it.effect('every bundled part decodes through the runtime path (Web streams, no filesystem)', () =>
  Effect.gen(function* decodeAllParts() {
    const built = yield* buildAkrosEncoded();
    const parts = yield* Effect.forEach(loadAkrosBaselineParts(), decodeAkrosBaselinePart, { concurrency: 1 });
    const products = parts.reduce((count, part) => count + part.products.length, 0);
    expect(products).toBe(built.products.length);
  }),
);

it.effect('catalogue-only products have no replenishment minimum, with only a handful of genuine shortages', () =>
  Effect.gen(function* catalogueStockMinimums() {
    const built = yield* buildAkrosEncoded();
    const records = computeProductRecords(yield* Schema.decodeEffect(MerchandiseStateSchema)(built));
    expect(records).toHaveLength(1289);
    expect(
      records
        .filter((record) => record.stockOnHand <= 0)
        .every((record) => record.lowStockThreshold === 0 && !record.lowStock),
    ).toBe(true);
    const shortages = records.filter((record) => record.lowStock);
    expect(shortages.length).toBeGreaterThan(0);
    expect(shortages.length).toBeLessThan(10);
  }),
);
