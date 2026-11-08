import { Effect, Exit, FileSystem, Match, Schema } from 'effect';
import { HttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';

import {
  ApplyCommandPayloadSchema,
  ManageMarketsPayloadSchema,
} from '../../verticals/merchandise/shared/actions/apply-command.ts';
import { ProductRecordSchema, RecordsRequestSchema } from '../../verticals/merchandise/shared/apis/records.ts';
import {
  czkNetMinor,
  existingN1Product,
  imageUrl,
  mapN1Dataset,
  N1DatasetSchema,
  seedN1Catalog,
  validateN1Product,
} from './n1-catalog-seed.mts';
import type { CreateProduct } from './n1-catalog-seed.mts';
import { DemoSeedError } from './seed-client.mts';
import type { SeedClient } from './seed-client.mts';
import { seedWriteCheckpoint } from './seed-checkpoint.mts';

const origin = 'https://n1.example.test';
const productName = 'Pánská bunda Spyder Vyper Jacket';
const instant = '2026-11-03T12:00:00.000Z';
const marketId = 'c36d7f38-ed18-4a37-b083-3d7cd82d2da1';
const price = { amount: '8780.25', currency: 'CZK', taxBasis: 'PRE_TAX' };
const source = (sku = '38SA073510-BLK') => ({
  brand: 'Spyder',
  demoCategory: { audience: 'Pánské', kind: 'Bundy', origin: 'DERIVED_FROM_NAME_FOR_DEMO' },
  externalId: `n1-export:product:${sku}`,
  images: [{ alt: productName, file: `images/${sku.toLowerCase()}.jpg` }],
  name: productName,
  price,
  sku,
  // These are source foreign keys, deliberately not OntOS identity.
  sourcePublicProductId: 'product-36710',
  stockQuantity: null,
  variants: ['L', 'M'].map((optionValue) => ({
    externalId: `n1-export:variant:${sku}-${optionValue}`,
    id: `source-foreign-key-${optionValue}`,
    name: productName,
    optionMeaning: 'SOURCE_CODE_SUFFIX',
    optionValue,
    price,
    sku: `${sku}-${optionValue}`,
    stockQuantity: null,
  })),
});
const dataset = (...products: ReturnType<typeof source>[]) => ({
  format: 'n1-demo-dataset',
  products,
  version: 1,
});
const mapPrepared = (input: ReturnType<typeof dataset>, imageOrigin: string, limit: number) =>
  Schema.decodeUnknownEffect(N1DatasetSchema)(input).pipe(
    Effect.flatMap((parsed) => mapN1Dataset(parsed, imageOrigin, limit)),
  );
const commands = (limit = 1) => mapPrepared(dataset(source(), source('SECOND')), origin, limit);
const ProductRecord = Schema.toEncoded(ProductRecordSchema);
type Product = typeof ProductRecord.Type;
const record = (command: CreateProduct, id = 'server-product-1') =>
  Schema.decodeUnknownEffect(ProductRecord)({
    ...command,
    createdAt: instant,
    currentPriceMinor: command.priceMinor,
    id,
    lowStock: false,
    priceHistory: [],
    stockOnHand: 0,
    stockValueMinor: 0,
    updatedAt: instant,
    variants: command.variants?.map((variant, index) => ({ ...variant, id: `${id}-variant-${index + 1}` })),
  });
const firstCommand = Effect.gen(function* commandFixture() {
  const [first] = yield* commands();
  if (first === undefined) {
    return yield* new DemoSeedError({ reason: 'Missing test command' });
  }
  return first;
});
const fails = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.exit,
    Effect.map((exit) => expect(Exit.isFailure(exit)).toBe(true)),
  );
const noNetwork = HttpClient.make(() => Effect.die('Unexpected network call in catalog test'));
const withoutNetwork = <A, E, R>(effect: Effect.Effect<A, E, R | HttpClient.HttpClient>) =>
  effect.pipe(Effect.provideService(HttpClient.HttpClient, noNetwork));

const memoryFileSystem = () => {
  const files = new Map<string, string>();
  const fs = FileSystem.makeNoop({
    exists: (file) => Effect.succeed(files.has(file)),
    makeDirectory: () => Effect.void,
    readFileString: (file) => Effect.succeed(files.get(file) ?? ''),
    writeFileString: (file, value) =>
      Effect.sync(() => {
        files.set(file, value);
      }),
  });
  return { files, fs };
};

const fakeCatalog = (fs: FileSystem.FileSystem, initial: readonly Product[] = []) => {
  const state = {
    beforeCommitFailure: false,
    changeHeadOnRead: false,
    failAfterCommit: false,
    marketConfigured: true,
    offered: new Set<string>(),
    products: [...initial],
    revision: 0,
    writes: Array.of<{ key: string; payload: string }>(),
  };
  const checkpoint = seedWriteCheckpoint(fs, '/checkpoint');
  const create = (command: CreateProduct) =>
    Effect.gen(function* createFixture() {
      const product = yield* record(command, `server-product-${state.products.length + 1}`);
      state.products.push(product);
      state.revision += 1;
      return [product.id];
    });
  const offer = (productId: string) =>
    Effect.sync(() => {
      state.offered.add(productId);
      return Array.of<string>();
    });
  const client: Pick<SeedClient, 'call'> = {
    call: <P extends Schema.Top, R extends Schema.Top>(
      owner: string,
      route: string,
      payloadSchema: P,
      input: P['Type'],
      resultSchema: R,
      ...writeFlags: [write?: boolean]
    ) =>
      Effect.gen(function* fakeCall() {
        const [write] = writeFlags;
        if (write === true) {
          const payload = yield* Schema.encodeEffect(Schema.fromJsonString(payloadSchema))(input);
          const key = yield* checkpoint(owner, route, payload);
          state.writes.push({ key, payload });
          if (state.beforeCommitFailure) {
            return yield* new DemoSeedError({ reason: 'Synthetic failure before commit' });
          }
          const { command } = yield* Schema.decodeUnknownEffect(
            Schema.toEncoded(Schema.Union([ApplyCommandPayloadSchema, ManageMarketsPayloadSchema])),
          )(input);
          const ids = yield* Match.value(command).pipe(
            Match.tag('CreateProduct', create),
            Match.tag('SetProductMarketOffer', (value) => offer(value.productId)),
            Match.orElse(() => new DemoSeedError({ reason: 'Unexpected test command' })),
          );
          if (state.failAfterCommit) {
            return yield* new DemoSeedError({ reason: 'Synthetic lost response after commit' });
          }
          return yield* Schema.decodeUnknownEffect(resultSchema)({ entityIds: ids, revision: state.revision });
        }
        const { view } = yield* Schema.decodeUnknownEffect(Schema.toEncoded(RecordsRequestSchema))(input);
        if (state.changeHeadOnRead && view?.limit === 0 && view.markets !== true) {
          state.revision += 1;
        }
        const products =
          view?.productId === undefined
            ? state.products.slice(view?.offset ?? 0, (view?.offset ?? 0) + (view?.limit ?? 2))
            : state.products.filter((product) => product.id === view.productId);
        return yield* Schema.decodeUnknownEffect(resultSchema)({
          actorPrincipalRef: {
            principalId: '25bb5c6b-99de-4f3f-9c78-6363d45e798d',
            tenantId: '3ecde207-46b8-486f-a1af-e218d2d11374',
          },
          canWrite: true,
          indicators: {
            lowStockCount: 0,
            openOrderValueMinor: 0,
            orderCount: 0,
            productCount: state.products.length,
            stockValueMinor: 0,
          },
          markets: state.marketConfigured
            ? [
                {
                  currency: 'CZK',
                  exceptionCounts: { notOffered: 0, offered: state.offered.size },
                  exchangeRate: '1',
                  marketCode: 'N1-CZ',
                  marketId,
                  offerMode: 'SELECTED_PRODUCTS',
                  revision: 1,
                  roundingMinor: 1,
                  updatedAt: instant,
                },
              ]
            : [],
          movements: [],
          orders: [],
          productMarkets:
            view?.productId === undefined
              ? []
              : [
                  {
                    currency: 'CZK',
                    marketCode: 'N1-CZ',
                    marketId,
                    offered: state.offered.has(view.productId),
                  },
                ],
          products,
          revision: state.revision,
          totalProducts: state.products.length,
        });
      }),
  };
  return { client, state };
};
const options = { apply: true, directory: '/checkpoint' };

it.effect('converts decimal net CZK exactly and rejects rounding, other currencies and unsafe amounts', () =>
  Effect.gen(function* prices() {
    expect(yield* czkNetMinor('8780.25')).toBe(878_025);
    expect(yield* czkNetMinor('0.01')).toBe(1);
    expect(yield* czkNetMinor('0')).toBe(0);
    expect(yield* czkNetMinor('1.2')).toBe(120);
    for (const invalid of ['1.001', '-1', '1,25', '1e2', 'NaN', '90071992547409.92']) {
      yield* fails(czkNetMinor(invalid));
    }
    yield* fails(mapPrepared(dataset({ ...source(), price: { ...price, currency: 'EUR' } }), origin, 1));
  }),
);

it.effect(
  'maps source IDs as external identity, not record IDs, with honest options, net price and unknown stock',
  () =>
    Effect.gen(function* mapping() {
      const command = yield* firstCommand;
      expect(command.sourceProductId).toBe('n1-export:product:38SA073510-BLK');
      expect(command.priceMinor).toBe(878_025);
      expect(command.vatRate).toBe(21);
      expect(command.unit).toBe('ks');
      expect(command.stockTracked).toBe(false);
      expect(command.category).toBe('Pánské › Bundy');
      expect(command.categoryId).toBeUndefined();
      expect(command.sourceGroupId).toBeUndefined();
      expect('id' in command).toBe(false);
      expect('stockQuantity' in command).toBe(false);
      expect(command.images).toEqual([`${origin}/demo/n1/38sa073510-blk.jpg`]);
      const variant = command.variants?.[0];
      expect(variant?.sourceId).toBe('n1-export:variant:38SA073510-BLK-L');
      expect(variant?.id).toBeUndefined();
      expect(variant?.name).toBe('L');
      expect(variant?.attributes).toBe('L');
      expect(variant?.priceMinor).toBe(878_025);
      expect(variant === undefined || 'stockQuantity' in variant).toBe(false);
    }),
);

it.effect('preflights every selected existing record before creating anything', () =>
  Effect.gen(function* noPartialWriteOnConflict() {
    const { fs } = memoryFileSystem();
    const selected = yield* commands(2);
    const [, second] = selected;
    if (second === undefined) {
      return yield* new DemoSeedError({ reason: 'Missing second test command' });
    }
    const other = yield* record(second, 'server-existing-second');
    const { client, state } = fakeCatalog(fs, [{ ...other, name: 'Staff-edited product' }]);
    yield* fails(seedN1Catalog(client, selected, options).pipe(Effect.provideService(FileSystem.FileSystem, fs)));
    expect(state.writes).toHaveLength(0);
    expect(state.products).toHaveLength(1);
    return yield* Effect.void;
  }).pipe(withoutNetwork),
);

it.effect('requires HTTPS image origins and plain basenames, not source URLs, traversal or credentials', () =>
  Effect.gen(function* imageChecks() {
    expect(yield* imageUrl(`${origin}/`, 'images/A-1.jpg')).toBe(`${origin}/demo/n1/A-1.jpg`);
    for (const bad of [
      '../secret.jpg',
      'images/../secret.jpg',
      'images/nested/a.jpg',
      'https://source.test/a.jpg',
      'images/a.jpg?x=1',
    ]) {
      yield* fails(imageUrl(origin, bad));
    }
    for (const bad of ['http://localhost:3070', `${origin}/prefix`, 'https://user:password@n1.test', `${origin}?q=1`]) {
      yield* fails(imageUrl(bad, 'images/a.jpg'));
    }
  }),
);

it.effect('really bounds the first-product selection and rejects duplicate dataset identities', () =>
  Effect.gen(function* bounds() {
    expect((yield* commands(1)).map((command) => command.sku)).toEqual(['38SA073510-BLK']);
    expect((yield* commands(2)).length).toBe(2);
    yield* fails(commands(0));
    yield* fails(commands(1.5));
    yield* fails(commands(45));
    yield* fails(mapPrepared(dataset(source(), source()), origin, 1));
    yield* fails(mapPrepared(dataset({ ...source(), externalId: 'unrelated' }), origin, 1));
    yield* fails(
      Schema.decodeUnknownEffect(N1DatasetSchema)({
        ...dataset(source()),
        products: [{ ...source(), stockQuantity: 42 }],
      }),
    );
  }),
);

it.effect('reuses only the exact SKU/external-ID pair and rejects conflicting products or variant edits', () =>
  Effect.gen(function* identities() {
    const command = yield* firstCommand;
    const product = yield* record(command);
    expect((yield* existingN1Product([product], command))?.id).toBe(product.id);
    expect((yield* validateN1Product(product, command)).id).toBe(product.id);
    for (const collision of [
      { ...product, sourceProductId: 'other' },
      { ...product, sku: 'OTHER' },
    ]) {
      yield* fails(existingN1Product([collision], command));
    }
    yield* fails(existingN1Product([product, { ...product, id: 'duplicate' }], command));
    yield* fails(validateN1Product({ ...product, currentPriceMinor: 1 }, command));
    yield* fails(
      validateN1Product(
        {
          ...product,
          variants: product.variants?.map((variant) => ({ ...variant, sourceId: 'other' })),
        },
        command,
      ),
    );
    yield* fails(
      validateN1Product(
        {
          ...product,
          variants: product.variants?.map((variant) => ({ ...variant, id: 'repeated' })),
        },
        command,
      ),
    );
  }),
);

it.effect(
  'dry run has no writes or checkpoint; apply creates one selected product and rereads server IDs; rerun is a no-op',
  () =>
    Effect.gen(function* idempotence() {
      const { files, fs } = memoryFileSystem();
      const { client, state } = fakeCatalog(fs);
      const selected = yield* commands(1);
      const dry = yield* seedN1Catalog(client, selected, { ...options, apply: false }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      );
      expect(dry.products).toBe(1);
      expect(dry.mapping[0]?.productId).toBeNull();
      expect(state.writes).toHaveLength(0);
      expect(files.size).toBe(0);
      const applied = yield* seedN1Catalog(client, selected, options).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      );
      expect(applied.created).toBe(1);
      expect(applied.products).toBe(1);
      expect(applied.variants).toBe(2);
      expect(applied.mapping[0]?.productId).toBe('server-product-1');
      expect(applied.mapping[0]?.variants.map((variant) => variant.variantId)).toEqual([
        'server-product-1-variant-1',
        'server-product-1-variant-2',
      ]);
      const again = yield* seedN1Catalog(client, selected, options).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      );
      expect(again.created).toBe(0);
      expect(again.reused).toBe(1);
      expect(again.mapping).toEqual(applied.mapping);
      expect(state.writes).toHaveLength(1);
    }).pipe(withoutNetwork),
);

it.effect('preserves the exact pending revision/payload and Action key across an interrupted request', () =>
  Effect.gen(function* checkpointReplay() {
    const { fs } = memoryFileSystem();
    const { client, state } = fakeCatalog(fs);
    const selected = yield* commands();
    state.beforeCommitFailure = true;
    yield* fails(seedN1Catalog(client, selected, options).pipe(Effect.provideService(FileSystem.FileSystem, fs)));
    state.revision = 7;
    yield* fails(seedN1Catalog(client, selected, options).pipe(Effect.provideService(FileSystem.FileSystem, fs)));
    expect(state.writes).toHaveLength(2);
    expect(state.writes[1]).toEqual(state.writes[0]);
    const changed = selected.map((command) => ({ ...command, name: 'Changed input' }));
    yield* fails(seedN1Catalog(client, changed, options).pipe(Effect.provideService(FileSystem.FileSystem, fs)));
    expect(state.writes).toHaveLength(2);
  }).pipe(withoutNetwork),
);

it.effect('recovers a committed product after a lost response without creating another product', () =>
  Effect.gen(function* committedRecovery() {
    const { fs } = memoryFileSystem();
    const { client, state } = fakeCatalog(fs);
    const selected = yield* commands();
    state.failAfterCommit = true;
    yield* fails(seedN1Catalog(client, selected, options).pipe(Effect.provideService(FileSystem.FileSystem, fs)));
    state.failAfterCommit = false;
    const result = yield* seedN1Catalog(client, selected, options).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
    );
    expect(result.reused).toBe(1);
    expect(state.products).toHaveLength(1);
    expect(state.writes).toHaveLength(1);
  }).pipe(withoutNetwork),
);

it.effect('stops before writing if another catalog writer changes the scanned revision', () =>
  Effect.gen(function* concurrentWriter() {
    const { files, fs } = memoryFileSystem();
    const { client, state } = fakeCatalog(fs);
    state.changeHeadOnRead = true;
    yield* fails(
      seedN1Catalog(client, yield* commands(), options).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
    );
    expect(state.writes).toHaveLength(0);
    expect(files.size).toBe(0);
  }).pipe(withoutNetwork),
);

it.effect('adds only the selected product offer to a passed configured market and does not repeat it', () =>
  Effect.gen(function* offers() {
    const { fs } = memoryFileSystem();
    const { client, state } = fakeCatalog(fs);
    const selected = yield* commands();
    const configured = { ...options, marketId };
    state.marketConfigured = false;
    yield* fails(seedN1Catalog(client, selected, configured).pipe(Effect.provideService(FileSystem.FileSystem, fs)));
    // Missing market configuration cannot block CreateProduct from initializing the catalog head.
    expect(state.writes).toHaveLength(1);
    expect(state.products).toHaveLength(1);
    expect(state.offered.size).toBe(0);
    state.marketConfigured = true;
    const result = yield* seedN1Catalog(client, selected, configured).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
    );
    expect(result.offered).toBe(1);
    expect(state.writes).toHaveLength(2);
    expect(state.offered.size).toBe(1);
    yield* seedN1Catalog(client, selected, configured).pipe(Effect.provideService(FileSystem.FileSystem, fs));
    expect(state.writes).toHaveLength(2);
  }).pipe(withoutNetwork),
);
