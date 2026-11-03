#!/usr/bin/env node
/**
 * Public HTTPS only. --mode plan freezes the old AKROS source before it is renamed.
 * --mode apply|verify requires the exact --fingerprint printed by plan and never rereads the source.
 * Files contain catalog/image data, not credentials. Keep the plan and native write checkpoints for recovery.
 * Tenant provisioning, credentials, grants and the storefront service switch belong to the parent operator.
 */
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Config, Console, Effect, FileSystem, Layer, Path, Schema } from 'effect';
import type { Types } from 'effect';
import { Command, Flag } from 'effect/cli';
import { FetchHttpClient } from 'effect/http';

import {
  AssociateStorefrontPayloadSchema,
  CreateMarketPayloadSchema,
  CreateMarketResultSchema,
  StorefrontAssociationResultSchema,
} from '../../verticals/commerce-market-catalog/shared/action-contracts.ts';
import {
  ApplyCommandPayloadSchema,
  ApplyCommandResultSchema,
} from '../../verticals/merchandise/shared/actions/apply-command.ts';
import {
  RegisterStorefrontApplicationPayloadSchema,
  RegisterStorefrontApplicationResultSchema,
} from '../../verticals/storefront-registry/shared/actions/register-storefront-application.ts';
import {
  AkrosPlaygroundCopyError,
  akrosCopyDestination,
  akrosCopySource,
  akrosPlaygroundAccounts,
  akrosPlaygroundStorefrontAppId,
  BootstrapCopyCatalogSchema,
  bootstrapCopyCatalog,
  canonicalCopyJson,
  captureCopySnapshot,
  CopyPlanSchema,
  copyAssociationId,
  copyDigest,
  copyMarketId,
  copyPlanFromSnapshot,
  copyScopeFromSnapshot,
  productCopyFields,
  readCopyApplications,
  readCopyCatalog,
  readCopyMedia,
  readCopyOffers,
  readCopyProducts,
  readCopyRecords,
  sameCopyValue,
  snapshotStats,
  sortCopyValues,
  validateCopyPlan,
} from './akros-playground-copy.mts';
import type { CopyPlan, CopyProduct, CopySnapshot } from './akros-playground-copy.mts';
import { connectSeedClient, validateSeedTarget } from './seed-client.mts';
import type { SeedClient } from './seed-client.mts';
import { seedWriteCheckpoint } from './seed-checkpoint.mts';
import { bootstrapFrozenCatalog } from './akros-playground-bootstrap.mts';

type CopyClient = Pick<SeedClient, 'call'>;

const reason = 'Copy approved frozen AKROS catalog into its isolated playground';
const Payload = Schema.toEncoded(ApplyCommandPayloadSchema);
const Result = Schema.toEncoded(ApplyCommandResultSchema);
const marketAudience = 'commerce-market-catalog';
const registryAudience = 'storefront-registry';
const seller = {
  moduleId: 'core.identity',
  resourceId: akrosCopyDestination.legalEntityId,
  resourceType: 'core.identity.legal-entity',
  tenantId: akrosCopyDestination.tenantId,
} as const;
const marketRef = (resourceId: string) => ({
  moduleId: 'commerce.market-catalog' as const,
  resourceId,
  resourceType: 'commerce.market-catalog.market' as const,
  tenantId: akrosCopyDestination.tenantId,
});
const sourceMarkets = (snapshot: CopySnapshot) =>
  snapshot.catalog.markets.filter(
    (market) =>
      market.sellingLegalEntityRef.resourceId === akrosCopySource.legalEntityId && market.lifecycle !== 'RETIRED',
  );
const sourceCopyOffers = (snapshot: CopySnapshot) => {
  const included = new Set(copyScopeFromSnapshot(snapshot).marketIds);
  return snapshot.marketOffers.filter(({ settings }) => included.has(settings.marketId));
};
const sourceApplications = (snapshot: CopySnapshot) =>
  snapshot.storefront.applications.filter(
    (application) => application.storefrontAppId === akrosPlaygroundStorefrontAppId,
  );
const safeOrigin = (shellUrl: string) =>
  validateSeedTarget({ ...akrosCopySource, shellUrl }).pipe(
    Effect.flatMap((origin) =>
      origin.startsWith('https://') && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)
        ? Effect.succeed(origin)
        : Effect.fail(new AkrosPlaygroundCopyError({ reason: 'The copy requires a public HTTPS Shell origin.' })),
    ),
  );

const content = (fields: Effect.Success<ReturnType<typeof productCopyFields>>) => {
  const { images: _gallery, imageSrc: _main, variants, ...rest } = fields;
  return {
    ...rest,
    variants: variants?.map(({ priceHistory: _history, ...variant }) => variant),
  };
};

/** Product/category/variant IDs are safe only because the merchandise owner keys include Tenant + Legal Entity. */
const catalogDifferences = (snapshot: CopySnapshot, destination: readonly CopyProduct[]) =>
  Effect.gen(function* compareBootstrapCatalog() {
    const expected = yield* bootstrapCopyCatalog(snapshot);
    const differences: string[] = [];
    if (expected.products.length !== destination.length) {
      differences.push('product-count');
    }
    for (const { product } of expected.products) {
      const actual = destination.find(({ id }) => id === product.id);
      if (actual === undefined) {
        differences.push('missing-product');
        continue;
      }
      const source = snapshot.products.find(({ id }) => id === product.id);
      const left = yield* productCopyFields(product);
      const right = yield* productCopyFields(actual);
      if (
        !sameCopyValue(content(left), content(right)) ||
        !sameCopyValue(
          {
            active: product.active,
            category: product.category,
            lowStockThreshold: product.lowStockThreshold,
            name: product.name,
            price: product.currentPriceMinor,
            sku: product.sku,
            unit: product.unit,
            vatRate: product.vatRate,
          },
          {
            active: actual.active,
            category: actual.category,
            lowStockThreshold: actual.lowStockThreshold,
            name: actual.name,
            price: actual.currentPriceMinor,
            sku: actual.sku,
            unit: actual.unit,
            vatRate: actual.vatRate,
          },
        )
      ) {
        differences.push('product-content');
      }
      if (
        source?.stockOnHand !== actual.stockOnHand ||
        !sameCopyValue(
          source?.variantRecords?.map(({ id, stockOnHand }) => ({ id, stockOnHand })),
          actual.variantRecords?.map(({ id, stockOnHand }) => ({ id, stockOnHand })),
        )
      ) {
        differences.push('stock');
      }
    }
    return differences;
  });

/** Fail before any owner write if the separate approved empty-target bootstrap has not completed. */
export const checkCopyBootstrap = (client: CopyClient, snapshot: CopySnapshot) =>
  Effect.gen(function* checkGovernedCatalogBootstrap() {
    const { products } = yield* readCopyProducts(client);
    const differences = yield* catalogDifferences(snapshot, products);
    const tree = yield* readCopyRecords(client, { includeCategories: true, limit: 0, ordersLimit: 0, summary: true });
    if (
      tree.categories?.length !== snapshot.categories.length ||
      snapshot.categories.some((category) => tree.categories?.some(({ id }) => id === category.id) !== true)
    ) {
      differences.push('category-tree');
    }
    if (differences.length > 0) {
      return yield* new AkrosPlaygroundCopyError({
        reason: `Governed empty-target catalog bootstrap is required before copy writes (${[...new Set(differences)].join(', ')}).`,
      });
    }
    return yield* Effect.void;
  });

const writeCommand = (client: CopyClient, command: (typeof Payload.Type)['command']) =>
  readCopyRecords(client, { limit: 0, ordersLimit: 0, summary: true }).pipe(
    Effect.flatMap(({ revision }) =>
      client.call(
        'merchandise',
        '/merchandise/actions/apply-command',
        Payload,
        { command, expectedRevision: revision },
        Result,
        true,
      ),
    ),
  );
const compareMarket = (market: CopySnapshot['catalog']['markets'][number]) => ({
  channels: market.channels,
  effectivePeriod: market.effectivePeriod,
  jurisdictions: market.jurisdictions,
  lifecycle: market.lifecycle,
  marketCode: market.marketCode,
  purpose: market.purpose,
  supportedLocales: market.supportedLocales,
});

const appFields = ({
  allowedChannels,
  effectiveInterval,
  lifecycle,
}: CopySnapshot['storefront']['applications'][number]) => ({
  allowedChannels,
  effectiveInterval,
  lifecycle,
});

const copyStorefrontAndMarkets = (client: CopyClient, snapshot: CopySnapshot) =>
  Effect.gen(function* copyGovernedMarketDefinitions() {
    const [application] = sourceApplications(snapshot);
    if (application === undefined || application.lifecycle !== 'ACTIVE' || sourceMarkets(snapshot).length !== 5) {
      return yield* new AkrosPlaygroundCopyError({
        reason: 'The frozen source must have its active storefront and five markets.',
      });
    }
    const currentApps = yield* readCopyApplications(client);
    const existing = currentApps.applications.find(
      ({ storefrontAppId }) => storefrontAppId === application.storefrontAppId,
    );
    if (existing === undefined) {
      yield* client.call(
        registryAudience,
        `/${registryAudience}/actions/register-storefront-application`,
        Schema.toEncoded(RegisterStorefrontApplicationPayloadSchema),
        { ...appFields(application), lifecycle: 'ACTIVE', reason, storefrontAppId: application.storefrontAppId },
        Schema.toEncoded(RegisterStorefrontApplicationResultSchema),
        true,
      );
    } else if (!sameCopyValue(appFields(application), appFields(existing))) {
      return yield* new AkrosPlaygroundCopyError({
        reason: 'Existing destination storefront differs from the approved snapshot.',
      });
    }
    let current = yield* readCopyCatalog(client);
    for (const source of sourceMarkets(snapshot)) {
      const marketId = copyMarketId(source.marketRef.resourceId);
      const present = current.markets.find(({ marketRef: ref }) => ref.resourceId === marketId);
      if (present === undefined) {
        if (source.lifecycle === 'RETIRED') {
          return yield* new AkrosPlaygroundCopyError({
            reason: 'Retired markets cannot be copied through CreateMarket.',
          });
        }
        yield* client.call(
          marketAudience,
          `/${marketAudience}/actions/create-market`,
          Schema.toEncoded(CreateMarketPayloadSchema),
          { ...compareMarket(source), lifecycle: source.lifecycle, marketId, reason, sellingLegalEntityRef: seller },
          Schema.toEncoded(CreateMarketResultSchema),
          true,
        );
      } else if (!sameCopyValue(compareMarket(source), compareMarket(present))) {
        return yield* new AkrosPlaygroundCopyError({
          reason: 'Existing destination market differs from the approved snapshot.',
        });
      }
    }
    current = yield* readCopyCatalog(client);
    for (const association of snapshot.catalog.associations.filter((entry) =>
      sourceMarkets(snapshot).some(({ marketRef: ref }) => ref.resourceId === entry.marketRef.resourceId),
    )) {
      if (association.storefrontRef.appId !== akrosPlaygroundStorefrontAppId) {
        return yield* new AkrosPlaygroundCopyError({
          reason: 'An unplanned storefront association is present in the source.',
        });
      }
      const marketId = copyMarketId(association.marketRef.resourceId);
      const destination = current.markets.find(({ marketRef: ref }) => ref.resourceId === marketId);
      const associationId = copyAssociationId(association.associationRef.resourceId);
      const present = current.associations.find(({ associationRef }) => associationRef.resourceId === associationId);
      if (present !== undefined) {
        if (
          present.marketRef.resourceId !== marketId ||
          present.channel !== association.channel ||
          present.storefrontRef.appId !== association.storefrontRef.appId ||
          !sameCopyValue(present.effectivePeriod, association.effectivePeriod)
        ) {
          return yield* new AkrosPlaygroundCopyError({
            reason: 'Existing destination association differs from the plan.',
          });
        }
        continue;
      }
      if (destination === undefined) {
        return yield* new AkrosPlaygroundCopyError({
          reason: 'A just-created market is not visible; rerun after containment completes.',
        });
      }
      yield* client.call(
        marketAudience,
        `/${marketAudience}/actions/associate-storefront`,
        Schema.toEncoded(AssociateStorefrontPayloadSchema),
        {
          associationId,
          channel: association.channel,
          effectivePeriod: association.effectivePeriod,
          expectedMarketDefinitionRevisionRef: destination.definitionRevisionRef,
          marketRef: marketRef(marketId),
          provenance: { kind: 'MIGRATION', reference: `akros-playground-copy:${copyDigest(snapshot)}` },
          reason,
          sellingLegalEntityRef: seller,
          storefrontRef: { appId: akrosPlaygroundStorefrontAppId, tenantId: akrosCopyDestination.tenantId },
        },
        Schema.toEncoded(StorefrontAssociationResultSchema),
        true,
      );
    }
    return yield* Effect.void;
  });

const settingsFields = (market: CopySnapshot['marketOffers'][number]['settings']) => ({
  currency: market.currency,
  exchangeRate: market.exchangeRate,
  marketCode: market.marketCode,
  offerMode: market.offerMode,
  roundingMinor: market.roundingMinor,
});
const copyOffers = (client: CopyClient, snapshot: CopySnapshot) =>
  Effect.gen(function* copyFrozenPriceListsAndOffers() {
    const current = yield* readCopyOffers(client);
    for (const { exceptions, settings } of sourceCopyOffers(snapshot)) {
      const marketId = copyMarketId(settings.marketId);
      const present = current.find((entry) => entry.settings.marketId === marketId);
      if (present === undefined) {
        yield* writeCommand(client, {
          _tag: 'ConfigureMarket',
          ...settingsFields(settings),
          expectedRevision: 0,
          marketId,
        });
      } else if (!sameCopyValue(settingsFields(settings), settingsFields(present.settings))) {
        return yield* new AkrosPlaygroundCopyError({
          reason: 'Existing destination price list differs from the plan.',
        });
      }
      if (
        present?.exceptions.some(
          (entry) =>
            !exceptions.some((source) => source.productId === entry.productId && source.offered === entry.offered),
        ) === true
      ) {
        return yield* new AkrosPlaygroundCopyError({
          reason: 'Destination has unexpected market exceptions; refusing to overwrite.',
        });
      }
      for (const offered of [false, true]) {
        const pending = exceptions.filter(
          (entry) =>
            entry.offered === offered &&
            present?.exceptions.some((copy) => copy.productId === entry.productId && copy.offered === offered) !== true,
        );
        for (let offset = 0; offset < pending.length; offset += 250) {
          yield* writeCommand(client, {
            _tag: 'SetMarketProductOffers',
            marketId,
            offered,
            productIds: pending.slice(offset, offset + 250).map(({ productId }) => productId),
          });
        }
      }
    }
    return yield* Effect.void;
  });

const uploadCopyImage = (client: CopyClient, productId: string, media: CopySnapshot['media'][number]) =>
  Effect.gen(function* uploadFrozenGalleryImage() {
    const filename = `${media.full.contentSha256}.${media.full.mimeType === 'image/jpeg' ? 'jpg' : media.full.mimeType.slice(6)}`;
    const image: Types.Mutable<
      Extract<(typeof Payload.Type)['command'], { readonly _tag: 'ChangeProductImages' }>['change'] & {
        readonly _tag: 'Upload';
      }
    >['image'] = { filename, full: { contentBase64: media.full.contentBase64 } };
    const preparedImage: Types.Mutable<typeof image> = image;
    if (media.thumbnail.contentSha256 !== media.full.contentSha256) {
      preparedImage.thumbnail = { contentBase64: media.thumbnail.contentBase64 };
    }
    const result = yield* writeCommand(client, {
      _tag: 'ChangeProductImages',
      change: {
        _tag: 'Upload',
        image: preparedImage,
      },
      id: productId,
    });
    if (result.image === undefined) {
      return yield* new AkrosPlaygroundCopyError({
        reason: 'An upload returned no destination media reference; rerun to reconcile.',
      });
    }
    return result.image;
  });

/** Resolve uploaded images by bytes on every rerun, including a lost upload response. Never reuse foreign media IDs. */
const copyGallery = (client: CopyClient, snapshot: CopySnapshot) =>
  Effect.gen(function* copyFrozenGalleryBytes() {
    for (const source of snapshot.products) {
      const detail = yield* readCopyRecords(client, { ordersLimit: 0, productId: source.id });
      const [product] = detail.products;
      if (product === undefined) {
        return yield* new AkrosPlaygroundCopyError({
          reason: 'A destination product disappeared during gallery copy.',
        });
      }
      const candidates: { full: string; reference: string; thumbnail: string }[] = [];
      for (const reference of product.images ?? []) {
        if (reference.startsWith('media:')) {
          const full = yield* readCopyMedia(client, product.id, reference, 'full');
          const thumbnail = yield* readCopyMedia(client, product.id, reference, 'thumbnail');
          candidates.push({ full: full.contentSha256, reference, thumbnail: thumbnail.contentSha256 });
        }
      }
      const order: string[] = [];
      for (const reference of source.images ?? []) {
        if (!reference.startsWith('media:')) {
          order.push(reference);
          continue;
        }
        const media = snapshot.media.find((entry) => entry.reference === reference);
        if (media === undefined) {
          return yield* new AkrosPlaygroundCopyError({ reason: 'A frozen gallery image is missing its bytes.' });
        }
        const present = candidates.find(
          (candidate) =>
            candidate.full === media.full.contentSha256 &&
            candidate.thumbnail === media.thumbnail.contentSha256 &&
            !order.includes(candidate.reference),
        );
        const destinationReference =
          present === undefined ? yield* uploadCopyImage(client, source.id, media) : present.reference;
        order.push(destinationReference);
      }
      const refreshed = yield* readCopyRecords(client, { ordersLimit: 0, productId: source.id });
      const gallery = refreshed.products[0]?.images ?? [];
      if (gallery.some((reference) => !order.includes(reference)) || gallery.length !== order.length) {
        return yield* new AkrosPlaygroundCopyError({
          reason: 'Destination gallery has unexpected images; refusing to remove them.',
        });
      }
      if (!sameCopyValue(order, gallery) && order.length > 0) {
        yield* writeCommand(client, {
          _tag: 'ChangeProductImages',
          change: { _tag: 'Reorder', images: order },
          id: source.id,
        });
      }
    }
    return yield* Effect.void;
  });

const withoutHistory = (row: CopySnapshot['categories'][number] | undefined) => {
  if (row === undefined) {
    return null;
  }
  const { history: _history, ...categoryContent } = row;
  return categoryContent;
};

const galleryBytes = (snapshot: CopySnapshot, product: CopyProduct) =>
  (product.images ?? []).map((reference) => {
    const media = snapshot.media.find((entry) => entry.reference === reference);
    return media === undefined
      ? reference
      : { full: media.full.contentSha256, thumbnail: media.thumbnail.contentSha256 };
  });

const offers = (rows: CopySnapshot['marketOffers'], remap: boolean) =>
  sortCopyValues(
    rows.map(({ exceptions, settings }) => ({
      exceptions,
      marketId: remap ? copyMarketId(settings.marketId) : settings.marketId,
      settings: settingsFields(settings),
    })),
    (row) => row.marketId,
  );

const associationContent = (association: CopySnapshot['catalog']['associations'][number], remap: boolean) => ({
  channel: association.channel,
  effectivePeriod: association.effectivePeriod,
  id: remap ? copyAssociationId(association.associationRef.resourceId) : association.associationRef.resourceId,
  marketId: remap ? copyMarketId(association.marketRef.resourceId) : association.marketRef.resourceId,
  seller: remap ? seller : association.sellingLegalEntityRef,
  storefront: remap
    ? { appId: association.storefrontRef.appId, tenantId: akrosCopyDestination.tenantId }
    : association.storefrontRef,
});

const verifyCopy = (client: CopyClient, plan: CopyPlan, checkpointRoot?: string) =>
  Effect.gen(function* verifyFrozenCopy() {
    const destination = yield* captureCopySnapshot(client, plan.snapshot.origin, akrosCopyDestination, checkpointRoot);
    const differences = yield* catalogDifferences(plan.snapshot, destination.products);
    if (
      differences.length > 0 ||
      !sameCopyValue(plan.snapshot.categories.map(withoutHistory), destination.categories.map(withoutHistory)) ||
      !sameCopyValue(plan.snapshot.featuredProductIds, destination.featuredProductIds) ||
      !sameCopyValue(
        plan.snapshot.products.map(({ id }) => id),
        destination.products.map(({ id }) => id),
      )
    ) {
      return yield* new AkrosPlaygroundCopyError({
        reason: 'Destination catalog, categories, stock or homepage selection differs from the frozen source.',
      });
    }
    const expectedMarkets = sourceMarkets(plan.snapshot);
    const destinationMarkets = destination.catalog.markets.filter(
      (market) => market.sellingLegalEntityRef.resourceId === akrosCopyDestination.legalEntityId,
    );
    if (
      destinationMarkets.length !== expectedMarkets.length ||
      expectedMarkets.some(
        (source) =>
          !destinationMarkets.some(
            (actual) =>
              actual.marketRef.resourceId === copyMarketId(source.marketRef.resourceId) &&
              sameCopyValue(compareMarket(actual), compareMarket(source)),
          ),
      )
    ) {
      return yield* new AkrosPlaygroundCopyError({
        reason: 'Destination market definitions differ from the frozen source.',
      });
    }
    if (!sameCopyValue(offers(sourceCopyOffers(plan.snapshot), true), offers(destination.marketOffers, false))) {
      return yield* new AkrosPlaygroundCopyError({
        reason: 'Destination offers or price lists differ from the frozen source.',
      });
    }
    const expectedAssociations = plan.snapshot.catalog.associations
      .filter((entry) => plan.copyScope.marketIds.includes(entry.marketRef.resourceId))
      .map((entry) => associationContent(entry, true));
    const actualAssociations = destination.catalog.associations
      .filter((entry) => entry.sellingLegalEntityRef.resourceId === akrosCopyDestination.legalEntityId)
      .map((entry) => associationContent(entry, false));
    if (
      !sameCopyValue(
        sortCopyValues(expectedAssociations, ({ id }) => id),
        sortCopyValues(actualAssociations, ({ id }) => id),
      ) ||
      !sameCopyValue(sourceApplications(plan.snapshot).map(appFields), sourceApplications(destination).map(appFields))
    ) {
      return yield* new AkrosPlaygroundCopyError({
        reason: 'Destination storefront registration or market associations differ from the frozen source.',
      });
    }
    for (const source of plan.snapshot.products) {
      const actual = destination.products.find(({ id }) => id === source.id);
      if (
        actual === undefined ||
        !sameCopyValue(galleryBytes(plan.snapshot, source), galleryBytes(destination, actual))
      ) {
        return yield* new AkrosPlaygroundCopyError({
          reason: 'Destination image order or image bytes differ from the frozen source.',
        });
      }
    }
    return snapshotStats(destination);
  });

const applyCopyAfterBootstrap = (client: CopyClient, plan: CopyPlan, checkpointRoot?: string) =>
  Effect.gen(function* applyApprovedFrozenCopy() {
    if (plan.copyScope.marketIds.length !== 5 || sourceCopyOffers(plan.snapshot).length !== 5) {
      return yield* new AkrosPlaygroundCopyError({
        reason: 'The approved copy must contain exactly five non-retired markets with their price-list settings.',
      });
    }
    yield* checkCopyBootstrap(client, plan.snapshot);
    yield* copyGallery(client, plan.snapshot);
    yield* copyStorefrontAndMarkets(client, plan.snapshot);
    yield* copyOffers(client, plan.snapshot);
    return yield* verifyCopy(client, plan, checkpointRoot);
  });

const main = (mode: 'plan' | 'bootstrap' | 'apply' | 'verify', file: string, fingerprint: string) =>
  Effect.gen(function* runAkrosPlaygroundCopy() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const origin = yield* safeOrigin(yield* Config.String('ONTOS_DEMO_SEED_URL'));
    if (mode === 'plan') {
      if (yield* fs.exists(file)) {
        return yield* new AkrosPlaygroundCopyError({
          reason: 'Plan file already exists; keep the frozen snapshot or choose another path.',
        });
      }
      const password = yield* Config.Redacted('ONTOS_AKROS_SOURCE_PASSWORD');
      const client = yield* Effect.acquireRelease(
        connectSeedClient({ ...akrosCopySource, shellUrl: origin }, 'eshop@akros.demo', password),
        (session) => session.signOut.pipe(Effect.ignore),
      );
      const snapshot = yield* captureCopySnapshot(client, origin, akrosCopySource, `${file}.capture`);
      const plan = copyPlanFromSnapshot(snapshot);
      yield* validateCopyPlan(plan, plan.fingerprint);
      yield* fs.makeDirectory(path.dirname(path.resolve(file)), { mode: 0o700, recursive: true });
      yield* fs.writeFileString(file, yield* Schema.encodeEffect(Schema.fromJsonString(CopyPlanSchema))(plan), {
        flag: 'wx',
        mode: 0o600,
      });
      // Emit the exact proposed bootstrap body separately; the parent owns approval and its Action boundary.
      const bootstrap = yield* bootstrapCopyCatalog(snapshot);
      yield* fs.writeFileString(
        `${file}.bootstrap.json`,
        yield* Schema.encodeEffect(Schema.fromJsonString(BootstrapCopyCatalogSchema))(bootstrap),
        { flag: 'wx', mode: 0o600 },
      );
      return yield* Console.log(
        canonicalCopyJson({ fingerprint: plan.fingerprint, mode, stats: snapshotStats(snapshot) }),
      );
    }
    const plan = yield* fs
      .readFileString(file)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(CopyPlanSchema))));
    yield* validateCopyPlan(plan, fingerprint);
    if (plan.snapshot.origin !== origin) {
      return yield* new AkrosPlaygroundCopyError({ reason: 'The configured origin does not match the approved plan.' });
    }
    const password = yield* Config.Redacted('ONTOS_AKROS_DESTINATION_PASSWORD');
    const checkpoint = seedWriteCheckpoint(fs, `${file}.checkpoints`);
    const client = yield* Effect.acquireRelease(
      connectSeedClient(
        { ...akrosCopyDestination, shellUrl: origin },
        akrosPlaygroundAccounts.admin,
        password,
        mode === 'bootstrap' ? undefined : checkpoint,
      ),
      (session) => session.signOut.pipe(Effect.ignore),
    );
    const execute = () => {
      // Separate apply/verify caches keep the explicit verify a fresh observation. Each cache is
      // further namespaced by origin + tenant + company + catalog revision inside captureCopySnapshot.
      const captureCheckpoint = `${file}.destination-${mode}.capture`;
      if (mode === 'bootstrap') {
        return bootstrapFrozenCatalog(client, plan);
      }
      if (mode === 'apply') {
        return applyCopyAfterBootstrap(client, plan, captureCheckpoint);
      }
      return verifyCopy(client, plan, captureCheckpoint);
    };
    const stats = yield* execute();
    return yield* Console.log(canonicalCopyJson({ fingerprint, mode, stats }));
  }).pipe(Effect.scoped);

if (import.meta.main) {
  const cli = Command.make(
    'seed-akros-playground',
    {
      file: Flag.String('file'),
      fingerprint: Flag.String('fingerprint').pipe(Flag.withDefault('')),
      mode: Flag.Literals('mode', ['plan', 'bootstrap', 'apply', 'verify']).pipe(Flag.withDefault('plan')),
    },
    ({ file, fingerprint, mode }) =>
      main(mode, file, fingerprint).pipe(
        Effect.tapErrorTag('DemoSeedError', (failure) => {
          const status = /^(?<path>\/[^: ]+): HTTP (?<status>\d{3})/u.exec(failure.reason);
          return Console.error(
            status === null
              ? 'The governed request or selected scope was rejected.'
              : `Governed request failed: ${status.groups?.path}; HTTP ${status.groups?.status}.`,
          );
        }),
        Effect.tapErrorTag('HttpClientError', (failure) =>
          Console.error(
            `HTTPS failure: ${failure.reason._tag}; path ${new URL(failure.request.url).pathname}; status ${failure.response?.status ?? 'none'}.`,
          ),
        ),
        Effect.tapError((failure) =>
          Console.error(
            Schema.is(AkrosPlaygroundCopyError)(failure)
              ? failure.reason
              : `AKROS copy stopped (${failure._tag}); credentials and response bodies are not logged.`,
          ),
        ),
        Effect.tapDefect(() => Console.error('Unexpected copy defect; checkpoints retained and raw details withheld.')),
      ),
  );
  NodeRuntime.runMain(
    Command.run(cli, { version: '1.0.0' }).pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    ),
    { disableErrorReporting: true },
  );
}
