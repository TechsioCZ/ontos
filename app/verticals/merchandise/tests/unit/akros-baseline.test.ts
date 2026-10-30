// The bundled AKROS baseline (src/services/akros-baseline.generated.ts) must match what `demo:seed:akros --reset`
// builds from the storefront feed. Regenerate with `node scripts/generate-akros-baseline.mts` when this fails.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { akrosBaselineParts } from '../../scripts/akros-baseline-parts.ts';
import { buildAkrosEncoded } from '../../scripts/akros-catalog.mts';
import { AKROS_BASELINE_SOURCE_BYTES, renderAkrosBaselineModules } from '../../scripts/generate-akros-baseline.mts';
import { loadAkrosBaselineParts } from '../../src/services/akros-baseline.generated.ts';
import { computeProductRecords } from '../../src/services/stock-levels.ts';
import { MerchandiseStateSchema } from '../../shared/apis/records.ts';
import { decodeAkrosBaselinePart } from '../../src/services/akros-demo-reset.ts';

const hash = (parts: readonly string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

it.effect('bundled baseline parts equal the seed baseline built from the storefront feed', () =>
  Effect.gen(function* sameBundledBaseline() {
    const built = yield* buildAkrosEncoded();
    const parts = yield* akrosBaselineParts(built);
    const expected = parts.map((part) => JSON.stringify(part));
    const nativeJson = yield* Effect.forEach(
      parts,
      (part) => Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(part),
      { concurrency: 1 },
    );
    expect(nativeJson).toEqual(expected);
    const bundled = loadAkrosBaselineParts().map((part) => gunzipSync(Buffer.from(part, 'base64')).toString('utf-8'));
    expect(bundled.length).toBe(expected.length);
    const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(MerchandiseStateSchema));
    const decodedBundled = yield* Effect.forEach(bundled, (part) => decode(part), { concurrency: 1 });
    const decodedExpected = yield* Effect.forEach(expected, (part) => decode(part), { concurrency: 1 });
    expect(decodedBundled).toEqual(decodedExpected);
    expect(bundled.every((part, index) => part === expected[index])).toBe(true);
    expect(hash(bundled)).toBe(hash(expected));
  }),
);

it.effect('every generated source matches the generator and stays within the source budget', () =>
  Effect.gen(function* generatedSources() {
    const built = yield* buildAkrosEncoded();
    const parts = yield* akrosBaselineParts(built);
    const encoded = parts.map((part) => gzipSync(JSON.stringify(part), { level: 9 }).toString('base64'));
    expect(loadAkrosBaselineParts()).toEqual(encoded);
    const modules = yield* renderAkrosBaselineModules(encoded);
    expect(modules.size).toBeGreaterThan(2);
    for (const [name, expected] of modules) {
      const source = readFileSync(new URL(`../../src/services/${name}`, import.meta.url), 'utf-8');
      expect(source).toBe(expected);
      expect(Buffer.byteLength(source)).toBeLessThanOrEqual(AKROS_BASELINE_SOURCE_BYTES);
    }
  }),
);

it.effect('source chunking keeps whole insert parts and their order as the baseline grows', () =>
  Effect.gen(function* growingBaseline() {
    const encoded = ['A'.repeat(450_000), 'B'.repeat(450_000), 'C'.repeat(450_000)];
    const modules = yield* renderAkrosBaselineModules(encoded);
    const chunks = [...modules].filter(([name]) => name !== 'akros-baseline.generated.ts');
    expect(chunks).toHaveLength(3);
    for (const [index, [name, source]] of chunks.entries()) {
      expect(name).toBe(`akros-baseline-chunk-${index}.generated.ts`);
      expect(Buffer.byteLength(source)).toBeLessThanOrEqual(AKROS_BASELINE_SOURCE_BYTES);
      expect(source).toContain(`  '${encoded[index]}',`);
      expect(modules.get('akros-baseline.generated.ts')).toContain(`...loadAkrosBaselineChunk${index}()`);
    }
  }),
);

it.effect('the generator rejects an oversized insert part instead of emitting unanalysable source', () =>
  Effect.gen(function* oversizedPart() {
    const error = yield* renderAkrosBaselineModules(['A'.repeat(AKROS_BASELINE_SOURCE_BYTES)]).pipe(Effect.flip);
    expect(error.reason).toContain('An AKROS insert part exceeds the generated source limit');
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
    const expected = yield* akrosBaselineParts(built);
    let products = 0;
    for (const [index, part] of loadAkrosBaselineParts().entries()) {
      const state = yield* decodeAkrosBaselinePart(part);
      const expectedState = yield* Schema.decodeUnknownEffect(MerchandiseStateSchema)(expected[index]);
      expect(state).toEqual(expectedState);
      expect(
        state.products.every((product) => DateTime.isUtc(product.createdAt) && DateTime.isUtc(product.updatedAt)),
      ).toBe(true);
      products += state.products.length;
    }
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
