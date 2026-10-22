// The bundled AKROS baseline (src/services/akros-baseline.generated.ts) must match what `demo:seed:akros --reset`
// builds from the storefront feed. Regenerate with `node scripts/generate-akros-baseline.mts` when this fails.
import { gunzipSync } from 'node:zlib';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { akrosBaselineParts } from '../../scripts/akros-baseline-parts.ts';
import { buildAkrosEncoded } from '../../scripts/akros-catalog.mts';
import { loadAkrosBaselineParts } from '../../src/services/akros-baseline.generated.ts';
import { decodeAkrosBaselinePart } from '../../src/services/akros-demo-reset.ts';

const built = buildAkrosEncoded();

it('bundled baseline parts equal the seed baseline built from the storefront feed', () => {
  const expected = akrosBaselineParts(built).map((part) => JSON.stringify(part));
  const bundled = loadAkrosBaselineParts().map((part) => gunzipSync(Buffer.from(part, 'base64')).toString('utf-8'));
  expect(bundled.length).toBe(expected.length);
  expect(bundled.every((part, index) => part === expected[index])).toBe(true);
});

it('parts cover the whole baseline: every product once, every movement with its product', () => {
  const parts = akrosBaselineParts(built);
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
});

it.effect('every bundled part decodes through the runtime path (Web streams, no filesystem)', () =>
  Effect.gen(function* decodeAllParts() {
    let products = 0;
    for (const part of loadAkrosBaselineParts()) {
      products += (yield* decodeAkrosBaselinePart(part)).products.length;
    }
    expect(products).toBe(built.products.length);
  }),
);
