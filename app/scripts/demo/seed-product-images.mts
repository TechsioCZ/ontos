#!/usr/bin/env node
// Product photos into Core Media through the native gallery command (`pnpm demo:seed:product-images`).
//   --company akros    moves the storefront-bundled AKROS photos (/akros/products/…) into Core Media, keeps their
//                      gallery position and drops the "image unavailable" placeholder reference.
//   --company kavarna  gives every Kavárna Doma seed product without a photo its photo (scripts/seed/kavarna-photos).
// Without --apply it only reports. Each upload is an audited ChangeProductImages Action of the signed-in person;
// running it again changes nothing, because migrated or photographed products are skipped.
import { NodeServices } from '@effect/platform-node';
import { Config, Console, Effect, Exit, FileSystem, Layer, Path, Redacted, Schema } from 'effect';
import type { Types } from 'effect';
import { Command, Flag } from 'effect/cli';
import { Base64 } from 'effect/encoding';
import { FetchHttpClient } from 'effect/http';

import { MerchandiseCommandSchema } from '../../verticals/merchandise/shared/actions/apply-command.ts';
import { akrosDemoLegalEntityId, demoTenantId, eshopDemoLegalEntityId } from './fixture-ids.mts';
import { connectSeedClient, DemoSeedError, validateSeedTarget } from './seed-client.mts';
import type { SeedClient } from './seed-client.mts';
import { seedCheckpointDirectory, seedWriteCheckpoint } from './seed-checkpoint.mts';

const PAGE = 250;
const AKROS_LOCAL_PREFIX = '/akros/products/';
const AKROS_PLACEHOLDER = '/akros/products/image-unavailable.svg';

const Query = Schema.Struct({
  view: Schema.Struct({
    limit: Schema.Int,
    offset: Schema.Int,
    ordersLimit: Schema.Int,
    productSort: Schema.Literal('sku'),
  }),
});
const Records = Schema.Struct({
  products: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      images: Schema.optionalKey(Schema.Array(Schema.String)),
      slug: Schema.optionalKey(Schema.String),
    }),
  ),
});
type SeedProduct = (typeof Records.Type)['products'][number];

const Payload = Schema.Struct({ command: Schema.toEncoded(MerchandiseCommandSchema), expectedRevision: Schema.Int });
const Result = Schema.Struct({ image: Schema.optionalKey(Schema.String), revision: Schema.Int });

const appRoot = new URL('../../', import.meta.url).pathname;

const allProducts = (client: SeedClient) =>
  Effect.gen(function* readAllProducts() {
    const products: SeedProduct[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = yield* client.call(
        'merchandise',
        '/reads/records',
        Query,
        { view: { limit: PAGE, offset, ordersLimit: 0, productSort: 'sku' } },
        Records,
      );
      products.push(...page.products);
      if (page.products.length < PAGE) {
        return products;
      }
    }
  });

type ImageChange = Extract<(typeof Payload.Type)['command'], { readonly _tag: 'ChangeProductImages' }>['change'];

const change = (client: SeedClient, id: string, imageChange: ImageChange) =>
  client.call(
    'merchandise',
    '/merchandise/actions/apply-command',
    Payload,
    { command: { _tag: 'ChangeProductImages', change: imageChange, id }, expectedRevision: 0 },
    Result,
    true,
  );

const uploadOf = (filename: string, full: Uint8Array, thumbnail: Uint8Array | undefined): ImageChange => {
  const image: Types.Mutable<Extract<ImageChange, { readonly _tag: 'Upload' }>['image']> = {
    filename,
    full: { contentBase64: Base64.encode(full) },
  };
  if (thumbnail !== undefined) {
    image.thumbnail = { contentBase64: Base64.encode(thumbnail) };
  }
  return { _tag: 'Upload', image };
};

const upload = (client: SeedClient, id: string, filename: string, full: Uint8Array, thumbnail?: Uint8Array) =>
  change(client, id, uploadOf(filename, full, thumbnail)).pipe(
    Effect.flatMap((result) =>
      result.image === undefined
        ? Effect.fail(new DemoSeedError({ reason: `Upload for ${id} returned no image` }))
        : Effect.succeed(result.image),
    ),
  );

/** AKROS: bundled storefront photos become Core Media Assets in the same gallery position. */
const migrateAkros = (client: SeedClient, apply: boolean) =>
  Effect.gen(function* migrateAkrosPhotos() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const products = (yield* allProducts(client)).filter((product) =>
      (product.images ?? []).some((image) => image.startsWith(AKROS_LOCAL_PREFIX)),
    );
    yield* Console.log(`${products.length} AKROS products reference bundled storefront photos.`);
    for (const product of apply ? products : []) {
      const order: string[] = [];
      for (const image of product.images ?? []) {
        if (image === AKROS_PLACEHOLDER) {
          yield* change(client, product.id, { _tag: 'Remove', image });
        } else if (image.startsWith(AKROS_LOCAL_PREFIX)) {
          const bytes = yield* fs.readFile(path.join(appRoot, 'akros-storefront/public', image));
          order.push(yield* upload(client, product.id, path.basename(image), bytes));
          yield* change(client, product.id, { _tag: 'Remove', image });
        } else {
          order.push(image);
        }
      }
      if (order.length > 1) {
        yield* change(client, product.id, { _tag: 'Reorder', images: order });
      }
    }
    yield* Console.log(apply ? `Migrated ${products.length} products.` : 'Dry run; pass --apply to migrate.');
  });

/** Kavárna Doma: one prepared photo (full + thumbnail) per seed product that has none yet. */
const photographKavarna = (client: SeedClient, apply: boolean) =>
  Effect.gen(function* photographKavarnaProducts() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(appRoot, 'verticals/merchandise/scripts/seed/kavarna-photos');
    const products = (yield* allProducts(client)).filter(
      (product) => product.slug !== undefined && (product.images ?? []).length === 0,
    );
    let photographed = 0;
    for (const product of products) {
      const full = path.join(directory, `${product.slug}.jpg`);
      if (!(yield* fs.exists(full))) {
        continue;
      }
      photographed += 1;
      if (apply) {
        const thumbnail = path.join(directory, `${product.slug}.thumb.jpg`);
        yield* upload(
          client,
          product.id,
          `${product.slug}.jpg`,
          yield* fs.readFile(full),
          (yield* fs.exists(thumbnail)) ? yield* fs.readFile(thumbnail) : undefined,
        );
      }
    }
    yield* Console.log(`${apply ? 'Photographed' : 'Would photograph'} ${photographed} Kavárna products.`);
  });

if (import.meta.main) {
  const cli = Command.make(
    'seed-product-images',
    {
      apply: Flag.Boolean('apply').pipe(Flag.withDefault(false)),
      company: Flag.Literals('company', ['akros', 'kavarna']),
    },
    ({ apply, company }) =>
      Effect.gen(function* main() {
        const target = {
          legalEntityId: company === 'akros' ? akrosDemoLegalEntityId : eshopDemoLegalEntityId,
          shellUrl: yield* Config.String('ONTOS_DEMO_SEED_URL').pipe(Config.withDefault('http://localhost:3020')),
          tenantId: demoTenantId,
        };
        const origin = yield* validateSeedTarget(target);
        const fs = yield* FileSystem.FileSystem;
        const root = yield* Config.String('ONTOS_DEMO_SEED_CHECKPOINT_DIR').pipe(
          Config.withDefault('.scratch/demo-seed'),
        );
        const checkpoint = seedWriteCheckpoint(fs, seedCheckpointDirectory({ ...target, shellUrl: origin }, root));
        const password = yield* Config.Redacted('ONTOS_DEMO_SEED_PASSWORD').pipe(
          Config.withDefault(Redacted.make('password1234')),
        );
        const email = company === 'akros' ? 'eshop@akros.demo' : 'eshop@kavarna.demo';
        const client = yield* connectSeedClient(target, email, password, checkpoint);
        yield* company === 'akros' ? migrateAkros(client, apply) : photographKavarna(client, apply);
      }),
  );
  const exit = await Effect.runPromiseExit(
    Command.run(cli, { version: '1.0.0' }).pipe(
      Effect.tapError((failure) => Console.error(`Product image seed stopped (${failure._tag}).`)),
      Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    ),
  );
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
