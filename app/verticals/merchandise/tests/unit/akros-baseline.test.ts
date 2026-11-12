// The bundled demo-company baseline (src/services/akros-baseline.generated.ts) must match what `demo:seed:akros --reset`
// builds: the neutral ŠroubShop copy of the storefront feed. Regenerate with `node scripts/generate-akros-baseline.mts` when this fails.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { akrosBaselineParts } from '../../scripts/akros-baseline-parts.ts';
import { buildSroubshopEncoded } from '../../scripts/akros-catalog.mts';
import { AKROS_BASELINE_SOURCE_BYTES, renderAkrosBaselineModules } from '../../scripts/generate-akros-baseline.mts';
import { loadAkrosBaselineParts } from '../../src/services/akros-baseline.generated.ts';
import { computeProductRecords } from '../../src/services/stock-levels.ts';
import { MerchandiseStateSchema } from '../../shared/apis/records.ts';
import { decodeAkrosBaselinePart, keepLinkedPhotos, linkedPhotosOf } from '../../src/services/akros-demo-reset.ts';
import { TEST_RATES } from '../support/tax-fixtures.ts';

// A case that rebuilds the whole AKROS catalogue takes seconds on a shared CI runner.
const CATALOGUE_BUILD_TIMEOUT = 30_000;
const hash = (parts: readonly string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

it.effect(
  'bundled baseline parts equal the seed baseline built from the storefront feed',
  () =>
    Effect.gen(function* sameBundledBaseline() {
      const built = yield* buildSroubshopEncoded();
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
      // The demo reset must never bring the source brand back (texts, photo URLs, categories, orders).
      expect(bundled.some((part) => /akros/iu.test(part))).toBe(false);
    }),
  CATALOGUE_BUILD_TIMEOUT,
);

// gzip bytes differ between zlib builds (the header names the OS), so the parts' content is proven above by
// decompression and the sources are proven here by rendering the committed parts.
it.effect('every generated source matches the generator and stays within the source budget', () =>
  Effect.gen(function* generatedSources() {
    const modules = yield* renderAkrosBaselineModules(loadAkrosBaselineParts());
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

it.effect(
  'parts cover the whole baseline: every product once, every movement with its product',
  () =>
    Effect.gen(function* completeBaselineParts() {
      const built = yield* buildSroubshopEncoded();
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
  CATALOGUE_BUILD_TIMEOUT,
);

it.effect(
  'every bundled part decodes through the runtime path (Web streams, no filesystem)',
  () =>
    Effect.gen(function* decodeAllParts() {
      const built = yield* buildSroubshopEncoded();
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
  CATALOGUE_BUILD_TIMEOUT,
);

it.effect(
  'catalogue-only products have no replenishment minimum, with only a handful of genuine shortages',
  () =>
    Effect.gen(function* catalogueStockMinimums() {
      const built = yield* buildSroubshopEncoded();
      const records = computeProductRecords(yield* Schema.decodeEffect(MerchandiseStateSchema)(built), TEST_RATES, {});
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
  CATALOGUE_BUILD_TIMEOUT,
);

const uploaded = 'media:0b8f8f8e-2f4c-4d3a-9a51-6f1d2c3b4a5e';
const secondUpload = 'media:1c9f8f8e-2f4c-4d3a-9a51-6f1d2c3b4a5e';
const storefrontPhoto = (productId: string, reference: string) =>
  `/obrazky/${encodeURIComponent(productId)}/${reference.slice('media:'.length)}`;

it.effect(
  'the reset keeps photos already uploaded to Core Media and nothing else',
  () =>
    Effect.gen(function* keepUploadedPhotos() {
      const [head, part] = yield* Effect.forEach(loadAkrosBaselineParts().slice(0, 2), decodeAkrosBaselinePart);
      const headPart = yield* Effect.fromNullishOr(head);
      const productPart = yield* Effect.fromNullishOr(part);
      const product = yield* Effect.fromNullishOr(productPart.products[0]);
      const untouched = yield* Effect.fromNullishOr(productPart.products[1]);
      const category = yield* Effect.fromNullishOr(headPart.categories?.[0]);
      const other = yield* Effect.fromNullishOr(headPart.categories?.[1]);
      const variants = (product.variants ?? []).map((variant, index) => ({
        ...variant,
        imageSrc: index === 0 ? secondUpload : 'https://example.test/stale.jpg',
      }));
      const previous = { ...product, images: [uploaded, secondUpload, '/legacy.jpg'], imageSrc: uploaded, variants };
      const linked = linkedPhotosOf(
        [previous, { ...untouched, images: ['https://example.test/a.jpg'] }],
        [
          { ...category, imageSrc: storefrontPhoto(product.id, uploaded) },
          { ...other, imageSrc: storefrontPhoto('someone-else', uploaded) },
        ],
      );
      const { products } = keepLinkedPhotos(productPart, linked);
      const kept = products.find(({ id }) => id === product.id);
      expect(kept?.images).toEqual([uploaded, secondUpload]);
      expect(kept?.imageSrc).toBe(uploaded);
      expect(kept?.variants?.[0]?.imageSrc).toBe(secondUpload);
      expect(kept?.variants?.slice(1)).toEqual(product.variants?.slice(1));
      expect(products.find(({ id }) => id === untouched.id)).toEqual(untouched);
      const categories = keepLinkedPhotos(headPart, linked).categories ?? [];
      expect(categories.find(({ id }) => id === category.id)?.imageSrc).toBe(storefrontPhoto(product.id, uploaded));
      expect(categories.find(({ id }) => id === other.id)).toEqual(other);
    }),
  CATALOGUE_BUILD_TIMEOUT,
);
