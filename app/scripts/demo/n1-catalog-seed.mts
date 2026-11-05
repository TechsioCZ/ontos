#!/usr/bin/env node
// Run from app with the existing ONTOS_DEMO_SEED_* target/auth variables.
// node scripts/demo/n1-catalog-seed.mts --dataset /path/catalog.json \
//   --image-origin https://your-storefront.example --limit 1 [--market-id UUID] [--apply]
// Categories are supported product labels, not a fabricated navigation tree. No stock or media writes.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { NodeServices } from '@effect/platform-node';
import { Config, Console, Effect, Exit, FileSystem, Layer, Match, Option, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { FetchHttpClient } from 'effect/http';

import {
  ApplyCommandResultSchema,
  MerchandiseCommandSchema,
} from '../../verticals/merchandise/shared/actions/apply-command.ts';
import { RecordsRequestSchema, RecordsResponseSchema } from '../../verticals/merchandise/shared/apis/records.ts';
import { connectSeedClient, DemoSeedError, validateSeedTarget } from './seed-client.mts';
import type { SeedClient } from './seed-client.mts';
import { seedCheckpointDirectory, seedWriteCheckpoint } from './seed-checkpoint.mts';
import { colourNameOf, productTitle } from './n1-presentation.mts';

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const ExternalId = Text.pipe(Schema.brand('N1SourceExternalId'));
const Price = Schema.Struct({
  amount: Schema.String.check(Schema.isPattern(/^\d+(?:\.\d{1,2})?$/u), Schema.isMaxLength(20)),
  currency: Schema.Literal('CZK'),
  taxBasis: Schema.Literal('PRE_TAX'),
});
const SourceVariant = Schema.Struct({
  externalId: ExternalId,
  name: Text,
  optionMeaning: Schema.Literal('SOURCE_CODE_SUFFIX'),
  optionValue: Text,
  price: Price,
  sku: Text,
  stockQuantity: Schema.Null,
});
export const N1DatasetSchema = Schema.Struct({
  format: Schema.Literal('n1-demo-dataset'),
  products: Schema.Array(
    Schema.Struct({
      brand: Text,
      demoCategory: Schema.Struct({
        audience: Text,
        kind: Text,
        origin: Schema.Literal('DERIVED_FROM_NAME_FOR_DEMO'),
      }),
      externalId: ExternalId,
      images: Schema.Array(Schema.Struct({ alt: Text, file: Text })).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(20),
      ),
      name: Text,
      price: Price,
      sku: Text,
      stockQuantity: Schema.Null,
      variants: Schema.Array(SourceVariant).check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(44)),
  version: Schema.Literal(1),
});
const Manifest = Schema.Struct({
  counts: Schema.Struct({ images: Schema.Int, products: Schema.Int, variants: Schema.Int }),
  format: Schema.Literal('n1-demo-dataset-manifest'),
  media: Schema.Array(
    Schema.Struct({
      relativePath: Text,
      sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
      sku: Text,
    }),
  ),
  version: Schema.Literal(1),
});
const Request = Schema.toEncoded(RecordsRequestSchema);
const Response = Schema.toEncoded(RecordsResponseSchema);
const CommandSchema = Schema.toEncoded(MerchandiseCommandSchema);
const Payload = Schema.Struct({ command: CommandSchema, expectedRevision: Schema.Int });
const Result = Schema.toEncoded(ApplyCommandResultSchema);
const Summary = Schema.Struct({
  applied: Schema.Boolean,
  categoryLabels: Schema.Array(Schema.String),
  created: Schema.Int,
  mapping: Schema.Array(
    Schema.Struct({
      externalId: Schema.toEncoded(ExternalId),
      productId: Schema.toEncoded(Schema.OptionFromNullOr(Schema.String.pipe(Schema.brand('N1ReturnedProductId')))),
      sku: Schema.String,
      variants: Schema.Array(
        Schema.Struct({
          externalId: Schema.toEncoded(ExternalId),
          sku: Schema.String,
          variantId: Schema.toEncoded(Schema.OptionFromNullOr(Schema.String.pipe(Schema.brand('N1ReturnedVariantId')))),
        }),
      ),
    }),
  ),
  offered: Schema.Int,
  products: Schema.Int,
  reused: Schema.Int,
  variants: Schema.Int,
});
type Catalog = typeof Response.Type;
type Product = Catalog['products'][number];
export type CreateProduct = Extract<typeof CommandSchema.Type, { readonly _tag: 'CreateProduct' }>;
type Client = Pick<SeedClient, 'call'>;
const audience = 'merchandise';
const actionPath = '/merchandise/actions/apply-command';
export class N1SeedError extends Schema.TaggedError<N1SeedError>()('N1SeedError', {
  reason: Schema.String,
}) {}
const fail = (reason: string) => new N1SeedError({ reason });
const skuKey = (sku: string) => sku.trim().toLowerCase();

/** No float multiplication, rounding, currency conversion or VAT removal: the workbook is already net CZK. */
export const czkNetMinor = (amount: string) =>
  Effect.gen(function* decimalMinor() {
    if (!/^\d+(?:\.\d{1,2})?$/u.test(amount) || amount.length > 20) {
      return yield* fail('Expected a non-negative CZK decimal with at most two fractional digits.');
    }
    const [whole = '0', fraction = ''] = amount.split('.');
    const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
    if (minor > BigInt(Number.MAX_SAFE_INTEGER)) {
      return yield* fail('CZK price exceeds the safe integer minor-unit range.');
    }
    return Number(minor);
  });

export const imageUrl = (origin: string, file: string) =>
  Effect.gen(function* hostedImage() {
    const url = yield* Schema.decodeUnknownEffect(Schema.URLFromString)(origin);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      !/^images\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:jpg|jpeg|png|webp)$/u.test(file)
    ) {
      return yield* fail('Images require an HTTPS origin and a plain images/<basename> dataset path.');
    }
    return `${url.origin}/demo/n1/${path.posix.basename(file)}`;
  });

/** Validate the entire input before selecting the first N products; do not skip existing products to fill N. */
export const mapN1Dataset = (dataset: typeof N1DatasetSchema.Type, origin: string, limit: number) =>
  Effect.gen(function* mapDataset() {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 44) {
      return yield* fail('--limit must be an integer between 1 and 44.');
    }
    if (dataset.products.reduce((sum, product) => sum + product.variants.length, 0) > 290) {
      return yield* fail('Dataset exceeds the reviewed 290-variant bound.');
    }
    const skus = new Set<string>();
    const externalIds = new Set<string>();
    const products: CreateProduct[] = [];
    for (const product of dataset.products) {
      for (const item of [product, ...product.variants]) {
        if (skus.has(skuKey(item.sku)) || externalIds.has(item.externalId)) {
          return yield* fail(`Dataset repeats a SKU or external ID: ${item.sku}.`);
        }
        skus.add(skuKey(item.sku));
        externalIds.add(item.externalId);
      }
      if (
        product.externalId !== `n1-export:product:${product.sku}` ||
        product.variants.some((variant) => variant.externalId !== `n1-export:variant:${variant.sku}`)
      ) {
        return yield* fail(`External ID does not match the prepared N1 SKU: ${product.sku}.`);
      }
      const images = yield* Effect.forEach((image: (typeof product.images)[number]) => imageUrl(origin, image.file))(
        product.images,
      );
      if (new Set(images).size !== images.length) {
        return yield* fail(`Duplicate gallery path: ${product.sku}.`);
      }
      const variants = yield* Effect.forEach((variant: (typeof product.variants)[number]) =>
        czkNetMinor(variant.price.amount).pipe(
          Effect.map((priceMinor) => ({
            active: true,
            // The variant shows its size only; the source's option wording never reaches the storefront.
            attributes: variant.optionValue,
            imageSrc: images[0],
            name: variant.optionValue,
            parameters: [{ label: 'Velikost', unit: '', value: variant.optionValue }],
            priceMinor,
            sku: variant.sku,
            sourceId: variant.externalId,
            unit: 'ks',
          })),
        ),
      )(product.variants);
      const command = yield* Schema.decodeUnknownEffect(CommandSchema)({
        _tag: 'CreateProduct',
        active: true,
        category: `${product.demoCategory.audience} › ${product.demoCategory.kind}`,
        imageAlt: product.images[0]?.alt,
        images,
        imageSrc: images[0],
        lowStockThreshold: 0,
        name: productTitle(product.name, product.sku),
        parameters: [
          { label: 'Značka', unit: '', value: product.brand },
          ...(colourNameOf(product.sku) === undefined
            ? []
            : [{ label: 'Barva', unit: '', value: colourNameOf(product.sku) }]),
        ],
        priceMinor: yield* czkNetMinor(product.price.amount),
        published: true,
        sku: product.sku,
        sourceProductId: product.externalId,
        stockTracked: false,
        unit: 'ks',
        variants,
        // Demo assumption, not a claim about tax data in the source export.
        vatRate: 21,
      });
      yield* Match.value(command).pipe(
        Match.tag('CreateProduct', (value) =>
          Effect.sync(() => {
            products.push(value);
          }),
        ),
        Match.orElse(() => fail('Expected the public CreateProduct command.')),
      );
    }
    return products.slice(0, limit);
  });

const validateManifest = (dataset: typeof N1DatasetSchema.Type, manifest: typeof Manifest.Type) =>
  Effect.gen(function* manifestAgreement() {
    const images = dataset.products.flatMap((product) =>
      product.images.map((image) => ({ file: image.file, sku: product.sku })),
    );
    if (
      manifest.counts.products !== dataset.products.length ||
      manifest.counts.variants !== dataset.products.reduce((sum, product) => sum + product.variants.length, 0) ||
      manifest.counts.images !== images.length ||
      manifest.media.length !== images.length ||
      images.some(
        (image) =>
          manifest.media.filter((media) => media.sku === image.sku && media.relativePath === image.file).length !== 1,
      )
    ) {
      return yield* fail('catalog.json and adjacent manifest.json disagree; no writes dispatched.');
    }
    return yield* Effect.void;
  });

/** Both identities must select exactly the same row. Matching only one is a collision, never an adoption. */
export const existingN1Product = (products: readonly Product[], command: CreateProduct) =>
  Effect.gen(function* identifyProduct() {
    const matches = products.filter(
      (product) => skuKey(product.sku) === skuKey(command.sku) || product.sourceProductId === command.sourceProductId,
    );
    const [product] = matches;
    if (matches.length === 0) {
      return product;
    }
    if (
      matches.length !== 1 ||
      product === undefined ||
      skuKey(product.sku) !== skuKey(command.sku) ||
      product.sourceProductId !== command.sourceProductId
    ) {
      return yield* fail(`SKU/external-ID collision for ${command.sku}; existing data was not changed.`);
    }
    return product;
  });

export const validateN1Product = (product: Product, command: CreateProduct) =>
  Effect.gen(function* validateProduct() {
    const { _tag, priceMinor, variants, ...fields } = command;
    void _tag;
    if (!isDeepStrictEqual(product, { ...product, ...fields, currentPriceMinor: priceMinor })) {
      return yield* fail(`Existing ${command.sku} differs in catalog content, identity or price; refusing overwrite.`);
    }
    const actualVariants = product.variants ?? [];
    if (actualVariants.length !== (variants ?? []).length) {
      return yield* fail(`Existing ${command.sku} has a different variant count.`);
    }
    const ids = new Set<string>();
    for (const expected of variants ?? []) {
      const matches = actualVariants.filter(
        (variant) => skuKey(variant.sku ?? '') === skuKey(expected.sku ?? '') || variant.sourceId === expected.sourceId,
      );
      const [actual] = matches;
      if (
        matches.length !== 1 ||
        actual?.id === undefined ||
        ids.has(actual.id) ||
        !isDeepStrictEqual(actual, { ...actual, ...expected })
      ) {
        return yield* fail(`Existing ${command.sku} has conflicting variant SKU, source ID, content or identity.`);
      }
      ids.add(actual.id);
    }
    return product;
  });

const read = (client: Client, view: (typeof Request.Type)['view']) =>
  client.call(audience, '/reads/records', Request, { view }, Response);

/** A bounded complete identity scan catches external-ID collisions outside a SKU text-search result. */
const catalogIdentities = (client: Client) =>
  Effect.gen(function* identities() {
    const products: Product[] = [];
    let revision: number | undefined;
    for (let offset = 0; offset < 25_000; offset += 250) {
      const page = yield* read(client, { limit: 250, offset, ordersLimit: 0, productSort: 'sku', summary: true });
      if (revision !== undefined && page.revision !== revision) {
        return yield* fail('Catalog revision changed during the identity scan; rerun without concurrent writers.');
      }
      ({ revision } = page);
      products.push(...page.products);
      if (page.totalProducts === undefined) {
        return yield* fail('Staff records must return totalProducts so the identity scan can prove completeness.');
      }
      if (products.length === page.totalProducts) {
        return { products, revision: page.revision };
      }
      if (page.products.length === 0 || products.length > page.totalProducts) {
        return yield* fail('Catalog changed during the identity scan; rerun without concurrent catalog writers.');
      }
    }
    return yield* fail('Identity scan exceeded 25,000 rows; narrow the target company, not the identity checks.');
  });

/** Freeze revision and command before dispatch as well as checkpointing the exact public Action request. */
const apply = (client: Client, directory: string, key: string, payload: typeof Payload.Type) =>
  Effect.gen(function* applyIntent() {
    const fs = yield* FileSystem.FileSystem;
    const file = path.join(directory, 'n1-intents', `${createHash('sha256').update(key).digest('hex')}.json`);
    yield* fs.makeDirectory(path.dirname(file), { mode: 0o700, recursive: true });
    let frozen = payload;
    if (yield* fs.exists(file)) {
      frozen = yield* fs
        .readFileString(file)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Payload))));
      if (!isDeepStrictEqual(frozen.command, payload.command)) {
        return yield* fail('Saved N1 intent differs from this dataset/action; preserve the checkpoint and reconcile.');
      }
    } else {
      yield* fs.writeFileString(file, yield* Schema.encodeEffect(Schema.fromJsonString(Payload))(payload), {
        flag: 'wx',
        mode: 0o600,
      });
    }
    return yield* client.call(audience, actionPath, Payload, frozen, Result, true);
  });

export interface N1SeedOptions {
  readonly apply: boolean;
  readonly directory: string;
  readonly marketId?: string;
}

const inspectProduct = (client: Client, command: CreateProduct, id: string) =>
  Effect.gen(function* inspect() {
    const detail = yield* read(client, { ordersLimit: 0, productId: id });
    const found = yield* existingN1Product(detail.products, command);
    if (found === undefined || found.id !== id) {
      return yield* fail(`Cannot re-read the exact product identity for ${command.sku}.`);
    }
    return { detail, product: yield* validateN1Product(found, command) };
  });

const validateMarket = (client: Client, marketId: string) =>
  Effect.gen(function* marketPreflight() {
    yield* Schema.decodeUnknownEffect(Schema.String.check(Schema.isUUID()))(marketId);
    const markets = yield* read(client, { limit: 0, markets: true, ordersLimit: 0 });
    const configured = markets.markets?.find((market) => market.marketId === marketId);
    if (
      configured === undefined ||
      configured.currency !== 'CZK' ||
      configured.exchangeRate !== '1' ||
      configured.roundingMinor !== 1
    ) {
      return yield* fail('Parent must configure the passed market in merchandise with CZK, rate 1 and rounding 1.');
    }
    return yield* Effect.void;
  });

const ensureProduct = (client: Client, command: CreateProduct, options: N1SeedOptions) =>
  Effect.gen(function* createMissingProduct() {
    // Re-read both identities before dispatch, then use the authoritative head revision.
    let identities = yield* catalogIdentities(client);
    let product = yield* existingN1Product(identities.products, command);
    if (product !== undefined || !options.apply) {
      return { created: false, product };
    }
    const head = yield* read(client, { limit: 0, ordersLimit: 0 });
    if (head.revision !== identities.revision) {
      return yield* fail(
        'Catalog changed after the identity scan; no new invocation was dispatched. Rerun after other writers finish.',
      );
    }
    const result = yield* apply(client, options.directory, `create:${command.sourceProductId}`, {
      command,
      expectedRevision: head.revision,
    });
    identities = yield* catalogIdentities(client);
    product = yield* existingN1Product(identities.products, command);
    if (product === undefined || result.entityIds.length !== 1 || result.entityIds[0] !== product.id) {
      return yield* fail(`Create ${command.sku} did not resolve to the returned product identity; stop and reconcile.`);
    }
    return { created: true, product };
  });

const ensureOffer = (client: Client, detail: Catalog, product: Product, options: N1SeedOptions) =>
  Effect.gen(function* offerProduct() {
    if (
      options.marketId === undefined ||
      !options.apply ||
      detail.productMarkets?.some((market) => market.marketId === options.marketId && market.offered) === true
    ) {
      return 0;
    }
    // A fresh company must commit and verify CreateProduct before market configuration is required.
    yield* validateMarket(client, options.marketId);
    yield* apply(client, options.directory, `offer:${options.marketId}:${product.id}`, {
      command: {
        _tag: 'SetProductMarketOffer',
        marketId: options.marketId,
        offered: true,
        productId: product.id,
      },
      expectedRevision: detail.revision,
    });
    const after = yield* read(client, { ordersLimit: 0, productId: product.id });
    if (after.productMarkets?.some((market) => market.marketId === options.marketId && market.offered) !== true) {
      return yield* fail(`Market offer was not visible for returned product ${product.id}.`);
    }
    return 1;
  });

/** Selection is already bounded. A rerun validates it, then fills missing products without changing staff edits. */
export const seedN1Catalog = (client: Client, commands: readonly CreateProduct[], options: N1SeedOptions) =>
  Effect.gen(function* seedCatalog() {
    const identities = yield* catalogIdentities(client);
    // Preflight every selected existing row before the first business write.
    for (const command of commands) {
      const existing = yield* existingN1Product(identities.products, command);
      if (existing !== undefined) {
        yield* inspectProduct(client, command, existing.id);
      }
    }
    if (options.marketId !== undefined) {
      yield* Schema.decodeUnknownEffect(Schema.String.check(Schema.isUUID()))(options.marketId);
    }
    const mapping: {
      externalId: string;
      productId: string | null;
      sku: string;
      variants: { externalId: string; sku: string; variantId: string | null }[];
    }[] = [];
    let created = 0;
    let reused = 0;
    let offered = 0;
    for (const command of commands) {
      const ensured = yield* ensureProduct(client, command, options);
      let { product } = ensured;
      created += ensured.created ? 1 : 0;
      if (product !== undefined) {
        const inspected = yield* inspectProduct(client, command, product.id);
        ({ product } = inspected);
        reused += ensured.created ? 0 : 1;
        offered += yield* ensureOffer(client, inspected.detail, product, options);
      }
      mapping.push({
        externalId: command.sourceProductId ?? '',
        productId: product?.id ?? null,
        sku: command.sku,
        variants: (command.variants ?? []).map((variant) => ({
          externalId: variant.sourceId ?? '',
          sku: variant.sku ?? '',
          variantId: product?.variants?.find((actual) => actual.sourceId === variant.sourceId)?.id ?? null,
        })),
      });
    }
    return {
      applied: options.apply,
      categoryLabels: [...new Set(commands.map((command) => command.category))],
      created,
      mapping,
      offered,
      products: commands.length,
      reused,
      variants: commands.reduce((sum, command) => sum + (command.variants?.length ?? 0), 0),
    };
  });

const configuration = Config.all({
  email: Config.String('ONTOS_DEMO_SEED_EMAIL'),
  legalEntityId: Config.String('ONTOS_DEMO_SEED_LEGAL_ENTITY_ID'),
  password: Config.Redacted('ONTOS_DEMO_SEED_PASSWORD'),
  shellUrl: Config.String('ONTOS_DEMO_SEED_URL'),
  tenantId: Config.String('ONTOS_DEMO_SEED_TENANT_ID'),
});
const reportFailure = <E extends { readonly _tag: string }>(error: E) => {
  if (Schema.is(N1SeedError)(error)) {
    return Console.error(error.reason);
  }
  if (Schema.is(DemoSeedError)(error)) {
    const [status = ''] = /HTTP \d{3}/u.exec(error.reason) ?? [];
    return Console.error(
      `Governed seed request/checkpoint failed ${status}. Preserve the checkpoint; no automatic retry. Credentials and response bodies are not logged.`,
    );
  }
  return Console.error(
    `N1 seed stopped (${error._tag}). Check dataset, manifest and environment configuration. No credentials or response bodies are logged.`,
  );
};
const cli = Command.make(
  'n1-catalog-seed',
  {
    apply: Flag.Boolean('apply').pipe(Flag.withDefault(false)),
    dataset: Flag.String('dataset'),
    imageOrigin: Flag.String('image-origin'),
    limit: Flag.Int('limit').pipe(Flag.withDefault(1)),
    marketId: Flag.String('market-id').pipe(Flag.optional),
  },
  ({ apply: shouldApply, dataset: datasetPath, imageOrigin, limit, marketId }) =>
    Effect.gen(function* runN1Seed() {
      const fs = yield* FileSystem.FileSystem;
      const dataset = yield* fs
        .readFileString(datasetPath)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(N1DatasetSchema))));
      const manifest = yield* fs
        .readFileString(path.join(path.dirname(datasetPath), 'manifest.json'))
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))));
      yield* validateManifest(dataset, manifest);
      const commands = yield* mapN1Dataset(dataset, imageOrigin, limit);
      const { email, password, ...configured } = yield* configuration;
      const origin = yield* validateSeedTarget(configured);
      if (
        origin !== 'https://ontos-stage.web-revolution.cz' ||
        configured.tenantId !== 'cfcd7ae8-90b9-4c49-927c-b5d66224a618' ||
        configured.legalEntityId !== 'd7ad363a-ddb0-46c6-bb11-8d9362281297'
      ) {
        return yield* fail('N1 importer requires the approved stage origin and newly provisioned N1 tenant/company.');
      }
      const target = { ...configured, shellUrl: origin };
      const root = yield* Config.String('ONTOS_DEMO_SEED_CHECKPOINT_DIR').pipe(
        Config.withDefault('.scratch/demo-seed'),
      );
      const directory = seedCheckpointDirectory(target, root);
      const options: N1SeedOptions = Option.match(marketId, {
        onNone: () => ({ apply: shouldApply, directory }),
        onSome: (id) => ({ apply: shouldApply, directory, marketId: id }),
      });
      const result = yield* Effect.acquireUseRelease(
        connectSeedClient(target, email, password, seedWriteCheckpoint(fs, directory)),
        (client) => seedN1Catalog(client, commands, options),
        (session) => session.signOut,
      );
      yield* Console.log(yield* Schema.encodeEffect(Schema.fromJsonString(Summary))(result));
      if (!shouldApply) {
        yield* Console.log('Dry run. No catalog writes. Use --apply with the same dataset, limit and target.');
      }
      return yield* Effect.void;
    }).pipe(Effect.scoped, Effect.tapError(reportFailure)),
);

if (import.meta.main) {
  const runtime = Layer.effectDiscard(Command.run(cli, { version: '1.0.0' })).pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  );
  const result = await Effect.runPromiseExit(Effect.scoped(Layer.build(runtime)));
  process.exitCode = Exit.isFailure(result) ? 1 : 0;
}
