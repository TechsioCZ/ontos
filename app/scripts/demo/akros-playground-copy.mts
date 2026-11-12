import { createHash } from 'node:crypto';

import {
  Array as List,
  Console,
  DateTime,
  Effect,
  FileSystem,
  Order,
  Predicate,
  Result,
  Schedule,
  Schema,
} from 'effect';

import {
  CurrentMarketCatalogRequestSchema,
  CurrentMarketCatalogResponseSchema,
} from '../../verticals/commerce-market-catalog/shared/apis/current-market-catalog.ts';
import { MediaRequestSchema, MediaResponseSchema } from '../../verticals/merchandise/shared/apis/media.ts';
import {
  MarketExceptionItemSchema,
  RecordsRequestSchema,
  RecordsResponseSchema,
} from '../../verticals/merchandise/shared/apis/records.ts';
import { MarketIdSchema, MarketSettingsSchema } from '../../verticals/merchandise/shared/domain/market-offers.ts';
import {
  CatalogCategorySchema,
  ProductMetadataSchema,
  ProductRecordSchema,
  ProductSchema,
  ProductIdReferenceSchema,
  VariantIdReferenceSchema,
} from '../../verticals/merchandise/shared/domain/merchandise-model.ts';
import {
  StorefrontApplicationsRequestSchema,
  StorefrontApplicationsResponseSchema,
} from '../../verticals/storefront-registry/shared/apis/storefront-applications.ts';
import { akrosDemoLegalEntityId, demoId, demoTenantId } from './fixture-ids.mts';
import { HttpClientError } from 'effect/http';

import type { SeedClient } from './seed-client.mts';
import { DemoSeedError, SeedLegalEntityId, SeedTenantId } from './seed-client.mts';

type CopyReader = Pick<SeedClient, 'call'>;
const akrosPlaygroundTenantId = demoId('tenant', 'akros-playground');
const akrosPlaygroundLegalEntityId = demoId('legal-entity', 'akros-playground');
export const akrosPlaygroundAccounts = {
  admin: 'admin@akros.playground',
  eshop: 'eshop@akros.playground',
  expedition: 'expedice@akros.playground',
} as const;
export const akrosPlaygroundStorefrontAppId = 'akros-storefront';
export const akrosCopySource = { legalEntityId: akrosDemoLegalEntityId, tenantId: demoTenantId };
export const akrosCopyDestination = {
  legalEntityId: akrosPlaygroundLegalEntityId,
  tenantId: akrosPlaygroundTenantId,
};

export class AkrosPlaygroundCopyError extends Schema.TaggedError<AkrosPlaygroundCopyError>()(
  'AkrosPlaygroundCopyError',
  { reason: Schema.String },
) {}

export const RecordsRequest = Schema.toEncoded(RecordsRequestSchema);
export const RecordsResponse = Schema.toEncoded(RecordsResponseSchema);
export const MarketCatalogRequest = Schema.toEncoded(CurrentMarketCatalogRequestSchema);
export const MarketCatalogResponse = Schema.toEncoded(CurrentMarketCatalogResponseSchema);
export const ApplicationsRequest = Schema.toEncoded(StorefrontApplicationsRequestSchema);
export const ApplicationsResponse = Schema.toEncoded(StorefrontApplicationsResponseSchema);
const MediaRequest = Schema.toEncoded(MediaRequestSchema);
const MediaResponse = Schema.toEncoded(MediaResponseSchema);
const ProductRecord = Schema.toEncoded(ProductRecordSchema);
const Category = Schema.toEncoded(CatalogCategorySchema);
const Settings = Schema.toEncoded(MarketSettingsSchema);
const Exception = Schema.toEncoded(MarketExceptionItemSchema);
const Target = Schema.Struct({ legalEntityId: SeedLegalEntityId, tenantId: SeedTenantId });
export const CopyMediaSchema = Schema.Struct({
  full: MediaResponse,
  reference: Schema.String,
  thumbnail: MediaResponse,
});
export const CopySnapshotSchema = Schema.Struct({
  capturedAt: Schema.toEncoded(Schema.DateTimeUtcFromString),
  catalog: MarketCatalogResponse,
  categories: Schema.Array(Category),
  featuredProductIds: Schema.Array(Schema.toEncoded(ProductIdReferenceSchema)),
  marketOffers: Schema.Array(Schema.Struct({ exceptions: Schema.Array(Exception), settings: Settings })),
  media: Schema.Array(CopyMediaSchema),
  origin: Schema.String,
  products: Schema.Array(ProductRecord),
  revision: Schema.Int,
  source: Target,
  storefront: ApplicationsResponse,
});
export type CopySnapshot = typeof CopySnapshotSchema.Type;
export type CopyProduct = (typeof CopySnapshotSchema.Type)['products'][number];

export const CopyPlanContentSchema = Schema.Struct({
  copyScope: Schema.Struct({
    excludedRetiredMarketIds: Schema.Array(Schema.toEncoded(MarketIdSchema)),
    marketIds: Schema.Array(Schema.toEncoded(MarketIdSchema)),
    preserveTenantScopedCatalogIds: Schema.Literal(true),
  }),
  destination: Target,
  snapshot: CopySnapshotSchema,
  version: Schema.Literal(1),
});
export const CopyPlanSchema = Schema.Struct({
  ...CopyPlanContentSchema.fields,
  fingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});
export type CopyPlan = typeof CopyPlanSchema.Type;

/** Object key order does not affect the approval fingerprint; array order remains significant. */
const jsonValueEncoder = Schema.encodeUnknownResult(Schema.fromJsonString(Schema.Any));
const encodeJsonValue = <Value,>(value: Value) => Result.getOrThrow(jsonValueEncoder(value));
export const sortCopyValues = <Value,>(values: readonly Value[], key: (value: Value) => string) =>
  List.sort(values, Order.mapInput(Order.String, key));
export const canonicalCopyJson = <Value,>(value: Value): string => {
  if (value === undefined) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalCopyJson).join(',')}]`;
  }
  if (Predicate.isObject(value)) {
    return `{${sortCopyValues(
      Object.entries(value).filter(([, entry]) => entry !== undefined),
      ([key]) => key,
    )
      .map(([key, entry]) => `${encodeJsonValue(key)}:${canonicalCopyJson(entry)}`)
      .join(',')}}`;
  }
  return encodeJsonValue(value) ?? 'null';
};
export const copyDigest = <Value,>(value: Value) => createHash('sha256').update(canonicalCopyJson(value)).digest('hex');
export const copyMediaDigest = (contentBase64: string) =>
  createHash('sha256').update(Buffer.from(contentBase64, 'base64')).digest('hex');
export const sameCopyValue = <Left, Right>(left: Left, right: Right) => copyDigest(left) === copyDigest(right);
export const copyScopeFromSnapshot = (snapshot: CopySnapshot) => {
  const markets = snapshot.catalog.markets.filter(
    (market) => market.sellingLegalEntityRef.resourceId === snapshot.source.legalEntityId,
  );
  return {
    excludedRetiredMarketIds: sortCopyValues(
      markets.filter(({ lifecycle }) => lifecycle === 'RETIRED').map(({ marketRef }) => marketRef.resourceId),
      (id) => id,
    ),
    marketIds: sortCopyValues(
      markets.filter(({ lifecycle }) => lifecycle !== 'RETIRED').map(({ marketRef }) => marketRef.resourceId),
      (id) => id,
    ),
    preserveTenantScopedCatalogIds: true as const,
  };
};
export const copyPlanFromSnapshot = (snapshot: CopySnapshot): CopyPlan => {
  const content = {
    copyScope: copyScopeFromSnapshot(snapshot),
    destination: akrosCopyDestination,
    snapshot,
    version: 1,
  } as const;
  return { ...content, fingerprint: copyDigest(content) };
};
export const validateCopyPlan = (plan: CopyPlan, approvedFingerprint: string) =>
  Effect.gen(function* validateFrozenCopyPlan() {
    const { fingerprint, ...content } = plan;
    if (
      fingerprint !== approvedFingerprint ||
      fingerprint !== copyDigest(content) ||
      !sameCopyValue(plan.copyScope, copyScopeFromSnapshot(plan.snapshot)) ||
      !sameCopyValue(plan.destination, akrosCopyDestination) ||
      !sameCopyValue(plan.snapshot.source, akrosCopySource)
    ) {
      return yield* new AkrosPlaygroundCopyError({ reason: 'Plan, target or approved fingerprint does not match.' });
    }
    for (const media of plan.snapshot.media) {
      if (
        copyMediaDigest(media.full.contentBase64) !== media.full.contentSha256 ||
        copyMediaDigest(media.thumbnail.contentBase64) !== media.thumbnail.contentSha256
      ) {
        return yield* new AkrosPlaygroundCopyError({ reason: 'A frozen image does not match its content digest.' });
      }
    }
    return yield* Effect.void;
  });

/** Only reads are retried; each attempt obtains a fresh single-use gateway assertion. */
const retryCopyRead = <A, E extends { readonly _tag: string }, R>(operation: Effect.Effect<A, E, R>) =>
  operation.pipe(
    Effect.retry({
      schedule: Schedule.spaced('1 second'),
      times: 3,
      while: HttpClientError.isHttpClientError,
    }),
  );
export const readCopyRecords = (client: CopyReader, view: (typeof RecordsRequest.Type)['view']) =>
  retryCopyRead(client.call('merchandise', '/reads/records', RecordsRequest, { view }, RecordsResponse));
const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
export const readCopyCatalog = (client: CopyReader) =>
  nowIso.pipe(
    Effect.flatMap((at) =>
      retryCopyRead(
        client.call(
          'commerce-market-catalog',
          '/reads/current-market-catalog',
          MarketCatalogRequest,
          { at },
          MarketCatalogResponse,
        ),
      ),
    ),
  );
export const readCopyApplications = (client: CopyReader) =>
  nowIso.pipe(
    Effect.flatMap((at) =>
      retryCopyRead(
        client.call(
          'storefront-registry',
          '/reads/storefront-applications',
          ApplicationsRequest,
          { at },
          ApplicationsResponse,
        ),
      ),
    ),
  );
export const readCopyMedia = (client: CopyReader, productId: string, image: string, rendition: 'full' | 'thumbnail') =>
  retryCopyRead(
    client.call('merchandise', '/reads/media', MediaRequest, { image, productId, rendition }, MediaResponse),
  );

/** Every page and detail is a separate governed read. No unbounded catalog request or order export. */
export const readCopyProducts = (client: CopyReader, expectedRevision?: number, recordsReader = readCopyRecords) =>
  Effect.gen(function* readCompleteCopyProducts() {
    const initial = yield* recordsReader(client, { limit: 0, ordersLimit: 0, summary: true });
    const revision = expectedRevision ?? initial.revision;
    const total = initial.totalProducts;
    if (total === undefined || initial.revision !== revision) {
      return yield* new AkrosPlaygroundCopyError({ reason: 'Catalog changed or omitted its total during capture.' });
    }
    const products: CopyProduct[] = [];
    const seen = new Set<string>();
    for (let offset = 0; offset < total; offset += 250) {
      // Preserve source ordinal order, not name/SKU order.
      const page = yield* recordsReader(client, { limit: 250, offset, ordersLimit: 0, summary: true });
      if (page.revision !== revision || page.totalProducts !== total || page.products.length === 0) {
        return yield* new AkrosPlaygroundCopyError({ reason: 'Catalog paging changed during capture.' });
      }
      for (const row of page.products) {
        if (seen.has(row.id)) {
          return yield* new AkrosPlaygroundCopyError({ reason: 'Catalog paging returned a duplicate product.' });
        }
        seen.add(row.id);
        const detail = yield* recordsReader(client, { ordersLimit: 0, productId: row.id });
        const [product] = detail.products;
        if (detail.revision !== revision || product?.id !== row.id || detail.products.length !== 1) {
          return yield* new AkrosPlaygroundCopyError({ reason: 'Catalog detail changed during capture.' });
        }
        products.push(product);
      }
    }
    if (products.length !== total) {
      return yield* new AkrosPlaygroundCopyError({ reason: 'Catalog capture is incomplete.' });
    }
    return { products, revision };
  });

export const readCopyOffers = (client: CopyReader) =>
  Effect.gen(function* readCompleteMarketOffers() {
    const head = yield* readCopyRecords(client, { limit: 0, markets: true, ordersLimit: 0, summary: true });
    if (head.markets === undefined) {
      return yield* new AkrosPlaygroundCopyError({ reason: 'Market settings are missing from the staff read.' });
    }
    return yield* Effect.forEach(
      head.markets,
      Effect.fn('AkrosCopy.marketExceptions')(function* readOneMarketExceptions(settings: typeof Settings.Type) {
        const exceptions: (typeof Exception.Type)[] = [];
        const total = settings.exceptionCounts.offered + settings.exceptionCounts.notOffered;
        for (let offset = 0; offset < total; offset += 250) {
          const page = yield* readCopyRecords(client, {
            limit: 0,
            marketExceptions: { limit: 250, marketId: settings.marketId, offset },
            ordersLimit: 0,
            summary: true,
          });
          if (page.marketExceptions?.total !== total || page.marketExceptions.items.length === 0) {
            return yield* new AkrosPlaygroundCopyError({ reason: 'Market exception paging changed during capture.' });
          }
          exceptions.push(...page.marketExceptions.items);
        }
        if (exceptions.length !== total || new Set(exceptions.map(({ productId }) => productId)).size !== total) {
          return yield* new AkrosPlaygroundCopyError({ reason: 'Market exception capture is incomplete.' });
        }
        return { exceptions, settings };
      }),
      { concurrency: 1 },
    );
  });

const catalogVersion = (catalog: typeof MarketCatalogResponse.Type) => ({
  associations: catalog.associations,
  markets: catalog.markets,
  ownerRevision: catalog.completenessEvidence.ownerRevision,
});
const applicationVersion = (apps: typeof ApplicationsResponse.Type) => apps.applications;

const copyCheckpointIo = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
  operation.pipe(
    Effect.mapError(
      () =>
        new DemoSeedError({
          reason: 'Source capture checkpoint I/O failed; existing source checkpoints were retained.',
        }),
    ),
  );
export const cachedCopyRead = <S extends Schema.Top, E, R>(
  fs: FileSystem.FileSystem,
  directory: string,
  key: string,
  schema: S,
  operation: Effect.Effect<S['Type'], E, R>,
) =>
  Effect.gen(function* readOrCaptureSourceDetail() {
    const file = `${directory}/${copyDigest(key)}.json`;
    if (yield* copyCheckpointIo(fs.exists(file))) {
      return yield* copyCheckpointIo(fs.readFileString(file)).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
      );
    }
    const value = yield* operation;
    yield* copyCheckpointIo(fs.makeDirectory(directory, { mode: 0o700, recursive: true }));
    yield* copyCheckpointIo(
      fs.writeFileString(file, yield* Schema.encodeEffect(Schema.fromJsonString(schema))(value), {
        flag: 'wx',
        mode: 0o600,
      }),
    );
    return value;
  });

const checkpointRecordDetail = (
  response: typeof RecordsResponse.Type,
  categoryId: CopySnapshot['categories'][number]['id'] | undefined,
) => {
  if (categoryId === undefined) {
    return { ...response, movements: [] };
  }
  // A detail response repeats the entire navigation tree. Checkpoint only this category's content.
  return {
    ...response,
    categories: response.categories?.filter(({ id }) => id === categoryId) ?? [],
    movements: [],
  };
};

export const captureCopySnapshot = (
  client: CopyReader,
  origin: string,
  source: Readonly<{ legalEntityId: string; tenantId: string }> = akrosCopySource,
  checkpointRoot?: string,
) =>
  Effect.gen(function* captureFrozenAkrosSource() {
    const capturedAt = yield* nowIso;
    const catalog = yield* readCopyCatalog(client);
    const storefront = yield* readCopyApplications(client);
    const marketOffers = yield* readCopyOffers(client);
    const head = yield* readCopyRecords(client, { includeCategories: true, limit: 0, ordersLimit: 0, summary: true });
    if (head.categories === undefined) {
      return yield* new AkrosPlaygroundCopyError({ reason: 'Source category tree was not returned.' });
    }
    const fs = checkpointRoot === undefined ? undefined : yield* FileSystem.FileSystem;
    const directory = `${checkpointRoot}/${copyDigest({ origin, revision: head.revision, source })}`;
    const recordsReader: typeof readCopyRecords = (owner, view) => {
      const operation = readCopyRecords(owner, view).pipe(
        Effect.map((response) => checkpointRecordDetail(response, view?.categoryId)),
      );
      if (fs === undefined || (view?.categoryId === undefined && view?.productId === undefined)) {
        return operation;
      }
      return cachedCopyRead(fs, directory, canonicalCopyJson(view), RecordsResponse, operation);
    };
    yield* Console.log(`AKROS capture: ${head.categories.length} category details to read.`);
    let completedCategories = 0;
    const categories = yield* Effect.forEach(
      head.categories,
      Effect.fn('AkrosCopy.categoryDetail')(function* categoryDetail(
        category: NonNullable<typeof head.categories>[number],
      ) {
        const detail = yield* recordsReader(client, {
          categoryId: category.id,
          includeCategories: true,
          limit: 0,
          ordersLimit: 0,
          summary: true,
        });
        if (detail.revision !== head.revision) {
          return yield* new AkrosPlaygroundCopyError({ reason: 'Category tree changed during capture.' });
        }
        const value = yield* Schema.decodeUnknownEffect(Category)(
          detail.categories?.find(({ id }) => id === category.id),
        );
        completedCategories += 1;
        if (completedCategories % 100 === 0) {
          yield* Console.log(
            `AKROS capture: ${completedCategories}/${head.categories?.length ?? 0} categories checkpointed.`,
          );
        }
        return value;
      }),
      { concurrency: 2 },
    );
    yield* Console.log(`AKROS capture: category details complete; reading all product details.`);
    const { products, revision } = yield* readCopyProducts(client, head.revision, recordsReader);
    yield* Console.log(`AKROS capture: ${products.length} product details complete; reading image bytes.`);
    const featured = yield* readCopyRecords(client, {
      storefront: true,
      storefrontCatalog: { featured: true, fields: 'card', includeCategories: false, pageSize: 1 },
    });
    const media: (typeof CopyMediaSchema.Type)[] = [];
    const seen = new Set<string>();
    for (const product of products) {
      for (const reference of product.images ?? []) {
        if (!reference.startsWith('media:') || seen.has(reference)) {
          continue;
        }
        const fullRead = readCopyMedia(client, product.id, reference, 'full');
        const thumbRead = readCopyMedia(client, product.id, reference, 'thumbnail');
        const full = yield* fs === undefined
          ? fullRead
          : cachedCopyRead(fs, directory, `${reference}:full`, MediaResponse, fullRead);
        const thumbnail = yield* fs === undefined
          ? thumbRead
          : cachedCopyRead(fs, directory, `${reference}:thumbnail`, MediaResponse, thumbRead);
        if (
          copyMediaDigest(full.contentBase64) !== full.contentSha256 ||
          copyMediaDigest(thumbnail.contentBase64) !== thumbnail.contentSha256
        ) {
          return yield* new AkrosPlaygroundCopyError({ reason: 'Source media bytes failed their owner digest.' });
        }
        seen.add(reference);
        media.push({ full, reference, thumbnail });
      }
    }
    const after = yield* readCopyRecords(client, { limit: 0, ordersLimit: 0, summary: true });
    if (
      after.revision !== revision ||
      featured.revision !== revision ||
      !sameCopyValue(marketOffers, yield* readCopyOffers(client)) ||
      !sameCopyValue(catalogVersion(catalog), catalogVersion(yield* readCopyCatalog(client))) ||
      !sameCopyValue(applicationVersion(storefront), applicationVersion(yield* readCopyApplications(client)))
    ) {
      return yield* new AkrosPlaygroundCopyError({ reason: 'Source changed during capture; discard this attempt.' });
    }
    return yield* Schema.decodeUnknownEffect(CopySnapshotSchema)({
      capturedAt,
      catalog,
      categories,
      featuredProductIds: featured.homepageFeaturedProductIds ?? [],
      marketOffers,
      media,
      origin,
      products,
      revision,
      source,
      storefront,
    });
  });

/** The empty-target bootstrap preserves only identities whose owner keys include Tenant and Legal Entity. */
export const BootstrapCopyCatalogSchema = Schema.Struct({
  categories: Schema.Array(Category),
  homepageFeaturedProductIds: Schema.Array(Schema.toEncoded(ProductIdReferenceSchema)),
  products: Schema.Array(
    Schema.Struct({
      product: Schema.toEncoded(ProductSchema),
      stock: Schema.Array(
        Schema.Struct({
          quantity: Schema.Finite,
          variantId: Schema.optionalKey(Schema.toEncoded(VariantIdReferenceSchema)),
        }),
      ),
    }),
  ),
});
const metadataSchema = Schema.toEncoded(ProductMetadataSchema);
/** The copyable catalog content of a product document or a staff product record (both carry its metadata). */
export const productCopyFields = (product: typeof metadataSchema.Type) =>
  Schema.decodeUnknownEffect(metadataSchema)(product);
export const copyStock = (product: CopyProduct) =>
  (product.variantRecords ?? []).length === 0
    ? [{ quantity: product.stockOnHand }]
    : (product.variantRecords ?? []).map((variant) => ({ quantity: variant.stockOnHand, variantId: variant.id }));

export const bootstrapCopyCatalog = (snapshot: CopySnapshot) =>
  Effect.gen(function* prepareEmptyTargetBootstrap() {
    const products = yield* Effect.forEach(
      snapshot.products,
      Effect.fn('AkrosCopy.bootstrapProduct')(function* prepareBootstrapProduct(source: CopyProduct) {
        const fields = yield* productCopyFields(source);
        // Foreign audit actors and Core Media links must never be imported into the new Tenant.
        const images = (source.images ?? []).filter((image) => !image.startsWith('media:'));
        const input = {
          ...fields,
          active: source.active,
          category: source.category,
          createdAt: snapshot.capturedAt,
          currentPriceMinor: source.currentPriceMinor,
          id: source.id,
          images,
          imageSrc: source.imageSrc?.startsWith('media:') === true ? '' : source.imageSrc,
          lowStockThreshold: source.lowStockThreshold,
          name: source.name,
          priceHistory: [{ effectiveFrom: snapshot.capturedAt, priceMinor: source.currentPriceMinor }],
          sku: source.sku,
          taxClassificationCode: source.taxClassificationCode,
          unit: source.unit,
          updatedAt: snapshot.capturedAt,
          variants: source.variants?.map(({ priceHistory: _history, ...variant }) => variant),
        };
        const product = yield* Schema.decodeUnknownEffect(Schema.toEncoded(ProductSchema))(
          Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
        );
        const stock = copyStock(source);
        if (stock.reduce((sum, row) => sum + row.quantity, 0) !== source.stockOnHand) {
          return yield* new AkrosPlaygroundCopyError({ reason: 'Variant stock does not reconcile to product stock.' });
        }
        return { product, stock };
      }),
      { concurrency: 1 },
    );
    return yield* Schema.decodeUnknownEffect(BootstrapCopyCatalogSchema)({
      categories: snapshot.categories.map(({ history: _history, ...category }) => category),
      homepageFeaturedProductIds: snapshot.featuredProductIds,
      products,
    });
  });

export const copyMarketId = (sourceId: string) => demoId('akros-playground.market', sourceId);
export const copyAssociationId = (sourceId: string) => demoId('akros-playground.association', sourceId);
export const snapshotStats = (snapshot: CopySnapshot) => ({
  categories: snapshot.categories.length,
  copyMarkets: copyScopeFromSnapshot(snapshot).marketIds.length,
  featured: snapshot.featuredProductIds.length,
  marketExceptions: snapshot.marketOffers.reduce((sum, market) => sum + market.exceptions.length, 0),
  markets: snapshot.catalog.markets.filter(
    (market) => market.sellingLegalEntityRef.resourceId === snapshot.source.legalEntityId,
  ).length,
  mediaAssets: snapshot.media.length,
  products: snapshot.products.length,
  retiredMarketsExcluded: copyScopeFromSnapshot(snapshot).excludedRetiredMarketIds.length,
  variants: snapshot.products.reduce((sum, product) => sum + (product.variants?.length ?? 0), 0),
});
