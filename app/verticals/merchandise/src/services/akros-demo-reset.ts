// The baseline feed is plain JSON files beside the server; the action runtime provides no Effect FileSystem/Config.
// @effect-diagnostics nodeBuiltinImport:off processEnv:off asyncFunction:off preferSchemaOverJson:off
// In-app reset of the AKROS demo company to the same predictable baseline `demo:seed:akros --reset` writes.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Effect, Schema } from 'effect';
import { buildAkrosEncodedFrom } from '../../scripts/akros-baseline.ts';
import type { AkrosSource } from '../../scripts/akros-baseline.ts';
import { MerchandiseStateSchema } from '../../shared/apis/records.ts';
import type { MerchandiseState } from '../../shared/apis/records.ts';
import { MerchandisePersistenceUnavailable } from '../../shared/errors/merchandise-persistence-unavailable.ts';

/** Same namespace as scripts/demo/fixture-ids.mts, so the reset recreates the seed's exact sample-order ids. */
const SALES_DEMO_NAMESPACE = '5a1e5d3e-0000-5000-8000-0000000d3e70';

/** RFC 9562 UUIDv5 (SHA-1) of `name` in `namespace`. */
const uuidV5 = (namespace: string, name: string): string => {
  const bytes = createHash('sha1')
    .update(Buffer.from(namespace.replaceAll('-', ''), 'hex'))
    .update(name, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const demoId = (namespace: string, key: string): string => uuidV5(SALES_DEMO_NAMESPACE, `${namespace}:${key}`);

/**
 * Kai Uwe's storefront feed the baseline is built from. The merchandise server runs from `verticals/merchandise`;
 * `AKROS_BASELINE_DIR` overrides the location.
 */
const baselineDirectory = () =>
  process.env['AKROS_BASELINE_DIR'] ?? resolve(process.cwd(), '../../akros-storefront/src/mock-storefront/generated');

const baselineUnavailable = (reason: string) =>
  new MerchandisePersistenceUnavailable({ code: 'merchandise_persistence_unavailable', reason });

const readJson = (file: string) =>
  Effect.tryPromise({
    catch: () => baselineUnavailable(`AKROS baseline file ${file} is not readable`),
    try: async () => JSON.parse(await readFile(resolve(baselineDirectory(), file), 'utf8')) as unknown,
  });

/** Builds the decoded baseline state: full catalog, initial stock receipts and the six sample orders. */
export const loadAkrosBaseline = Effect.fn('Merchandise.loadAkrosBaseline')(function* loadAkrosBaseline() {
  const catalog = (yield* readJson('catalog.generated.json')) as AkrosSource['catalog'];
  const categories = ((yield* readJson('categories.generated.json')) as { categories: AkrosSource['categories'] })
    .categories;
  const encoded = yield* Effect.try({
    catch: () => baselineUnavailable('AKROS baseline feed has an unexpected shape'),
    try: () => buildAkrosEncodedFrom({ catalog, categories }, demoId),
  });
  return yield* Schema.decodeEffect(MerchandiseStateSchema)(encoded).pipe(
    Effect.mapError(() => baselineUnavailable('AKROS baseline does not match the model')),
  );
}) satisfies () => Effect.Effect<MerchandiseState, MerchandisePersistenceUnavailable>;
