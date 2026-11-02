#!/usr/bin/env node
// Governed, fixed-demo-scope catalog migration: plan (frozen snapshot + photo bytes) → apply → verify.
// No SQL, no generated source edits; plan and verify never dispatch writes. Every run stops starting new records
// after TIME_BUDGET_MS so one `run-remote.sh` call stays below its 300 s limit; rerun to continue.
import { NodeServices } from '@effect/platform-node';
import { detectImageMimeType } from '@app/core-runtime/media/image-contract';
import { Clock, Config, Console, Effect, Exit, FileSystem, Layer, Option, Schema } from 'effect';
import type { Types } from 'effect';
import { Command, Flag } from 'effect/cli';
import { Base64 } from 'effect/encoding';
import { FetchHttpClient, HttpClient } from 'effect/http';
import { MerchandiseCommandSchema } from '../../verticals/merchandise/shared/actions/apply-command.ts';
import { RecordsRequestSchema, RecordsResponseSchema } from '../../verticals/merchandise/shared/apis/records.ts';
import { MediaRequestSchema, MediaResponseSchema } from '../../verticals/merchandise/shared/apis/media.ts';
import type { AkrosEncodedState } from '../../verticals/merchandise/scripts/akros-baseline.ts';
import { buildAkrosEncoded } from '../../verticals/merchandise/scripts/akros-catalog.mts';
import {
  isBrandedCatalogImage,
  isMarketingCatalogImage,
  isSourceCatalogImage,
  isSourcePlaceholder,
} from '../../verticals/merchandise/scripts/akros-pseudonym.ts';
import { akrosDemoLegalEntityId, demoTenantId } from './fixture-ids.mts';
import { connectSeedClient, DemoSeedError } from './seed-client.mts';
import type { SeedClient } from './seed-client.mts';
import { seedCheckpointDirectory, seedWriteCheckpoint } from './seed-checkpoint.mts';
import {
  Category,
  Product,
  bytesDigest,
  catalogHasBrand,
  categoryHasBrand,
  categoryRepresentatives,
  categoryTextPatch,
  digest,
  displayContent,
  galleryConsistent,
  productPhotoPlan,
  productTextPatch,
  protectedProduct,
  textChanges,
  variantHasBrand,
} from './pseudonymize-akros-catalog-policy.mts';
import type { CatalogCategory, CatalogProduct } from './pseudonymize-akros-catalog-policy.mts';

const TIME_BUDGET_MS = 200_000;
const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
/** Staff app origin → the storefront that publicly serves `/obrazky/<product>/<asset>` for that deployment. */
const PUBLIC_STOREFRONT = new Map([
  ['http://localhost:3020', 'http://localhost:3070'],
  ['https://ontos-stage.web-revolution.cz', 'https://ontos-stage-shop.web-revolution.cz'],
]);

const Request = Schema.toEncoded(RecordsRequestSchema);
const Response = Schema.toEncoded(RecordsResponseSchema);
const Payload = Schema.Struct({ command: Schema.toEncoded(MerchandiseCommandSchema), expectedRevision: Schema.Int });
const Result = Schema.Struct({ image: Schema.optionalKey(Schema.String), revision: Schema.Int });
const MediaRequest = Schema.toEncoded(MediaRequestSchema);
const MediaResponse = Schema.toEncoded(MediaResponseSchema);
const Image = Schema.Struct({ bytes: Schema.Int, hash: Schema.String, source: Schema.String });
const Manifest = Schema.Struct({
  categories: Schema.Array(Schema.String),
  cursor: Schema.Int,
  origin: Schema.String,
  products: Schema.Array(Schema.String),
  revision: Schema.Int,
  version: Schema.Literal(2),
});
const ProductEntry = Schema.Struct({
  before: Product,
  images: Schema.Array(Image),
  marketing: Schema.Array(Schema.String),
  /** Source photo that replaces this product's marketing artwork; empty when dropped. */
  marketingReplacement: Schema.String,
  photos: Product,
  unavailable: Schema.Array(Schema.String),
});
type PlannedProduct = typeof ProductEntry.Type;
const CategoryEntry = Schema.Struct({ before: Category });
type PlannedCategory = typeof CategoryEntry.Type;
const UploadState = Schema.Struct({ mapping: Schema.Record(Schema.String, Schema.String) });
const Approval = Schema.Struct({ fingerprint: Schema.String, manifest: Manifest });
const Cursor = Schema.Struct({ cursor: Schema.Int });
const Summary = Schema.Struct({
  auditHistory: Schema.String,
  brandedGraphics: Schema.Array(
    Schema.Struct({ product: Schema.String, replacement: Schema.String, source: Schema.String }),
  ),
  brandedImages: Schema.String,
  categories: Schema.Int,
  categoriesToChange: Schema.Int,
  categoriesWithImageBefore: Schema.Int,
  categoryCleared: Schema.Int,
  categoryRepresentative: Schema.Int,
  categoryRule: Schema.String,
  estimatedApplyBatches: Schema.Int,
  estimatedApplyMinutes: Schema.Int,
  fingerprint: Schema.String,
  imagesToUpload: Schema.Int,
  overflowGroups: Schema.Array(
    Schema.Struct({
      fallback: Schema.Int,
      id: Schema.String,
      kept: Schema.Int,
      name: Schema.String,
      variantsUsingFallback: Schema.Int,
    }),
  ),
  products: Schema.Int,
  productsToChange: Schema.Int,
  productTextChanges: Schema.Int,
  totalBytes: Schema.Int,
  unavailableImages: Schema.Array(Schema.Struct({ product: Schema.String, source: Schema.String })),
  uniqueDownloadBytes: Schema.Int,
  uniqueDownloads: Schema.Int,
  variants: Schema.Int,
  variantsToChange: Schema.Int,
});

const fail = (reason: string) => new DemoSeedError({ reason });
const readRecords = (client: SeedClient, view: (typeof Request.Type)['view']) =>
  client.call('merchandise', '/reads/records', Request, { view }, Response);
const jsonRead = <S extends Schema.Top>(file: string, schema: S) =>
  Effect.gen(function* readJson() {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs
      .readFileString(file)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))));
  });
const jsonWrite = <S extends Schema.Top>(file: string, schema: S, value: S['Type']) =>
  Effect.gen(function* writeJson() {
    const fs = yield* FileSystem.FileSystem;
    const content = yield* Schema.encodeEffect(Schema.fromJsonString(schema))(value);
    yield* fs.writeFileString(`${file}.next`, content, { mode: 0o600 });
    return yield* fs.rename(`${file}.next`, file);
  });
const markDone = (file: string, content: string) =>
  Effect.gen(function* markRecordDone() {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.writeFileString(file, content, { mode: 0o600 });
  });
const productFile = (root: string, id: string) => `${root}/products/${digest(id)}.json`;
const categoryFile = (root: string, id: string) => `${root}/categories/${digest(id)}.json`;
const imageFile = (root: string, source: string) => `${root}/images/${digest(source)}.bin`;
const unavailableFile = (root: string, source: string) => `${root}/images/${digest(source)}.unavailable`;
const productDone = (root: string, id: string) => `${root}/done/${digest(id)}`;
const categoryDone = (root: string, id: string) => `${root}/done/category-${digest(id)}`;
const uploadJournal = (root: string, id: string) => `${root}/uploads/${digest(id)}.json`;
const mediaPath = (productId: string, reference: string) =>
  `/obrazky/${encodeURIComponent(productId)}/${encodeURIComponent(reference.slice('media:'.length))}`;
const deliverable = (product: CatalogProduct) => product.active && product.published !== false;
const keptPhotos = (entry: PlannedProduct) => productPhotoPlan(entry.photos, new Set(entry.unavailable)).kept;

/** Starts the per-run deadline; `expired` is true once no further record should be started in this run. */
const deadline = Effect.gen(function* startDeadline() {
  const start = yield* Clock.currentTimeMillis;
  return { expired: Clock.currentTimeMillis.pipe(Effect.map((now) => now - start > TIME_BUDGET_MS)) };
});
const readProduct = (client: SeedClient, id: string) =>
  Effect.gen(function* readOneProduct() {
    const page = yield* readRecords(client, { ordersLimit: 0, productId: id });
    const product = yield* Schema.decodeUnknownEffect(Product)(page.products.find((candidate) => candidate.id === id));
    return { product, revision: page.revision };
  });
const readCategory = (client: SeedClient, id: string) =>
  Effect.gen(function* readOneCategory() {
    const page = yield* readRecords(client, {
      categoryId: id,
      includeCategories: true,
      limit: 0,
      ordersLimit: 0,
      summary: true,
    });
    const category = yield* Schema.decodeUnknownEffect(Category)(
      page.categories?.find((candidate) => candidate.id === id),
    );
    return { category, revision: page.revision };
  });
const command = (client: SeedClient, value: (typeof Payload.Type)['command'], expectedRevision: number) =>
  client.call(
    'merchandise',
    '/merchandise/actions/apply-command',
    Payload,
    { command: value, expectedRevision },
    Result,
    true,
  );
/** Gallery changes re-validate against the current gallery, never against a revision. */
const galleryChange = (
  client: SeedClient,
  id: string,
  change: Extract<(typeof Payload.Type)['command'], { _tag: 'ChangeProductImages' }>['change'],
) => command(client, { _tag: 'ChangeProductImages', change, id }, 0);
const publicImage = (publicOrigin: string, path: string) =>
  Effect.gen(function* fetchPublicImage() {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.get(`${publicOrigin}${path}`).pipe(Effect.timeout('20 seconds'));
    return response.status === 200 && (response.headers['content-type'] ?? '').startsWith('image/');
  });

/**
 * Freezes one fixed-source photo. Credentials are never sent and redirects never followed. A photo the source no
 * longer serves as an accepted image (non-200, unknown type, over the Core limit) is recorded as unavailable and
 * dropped; transport failures stop the batch so a rerun retries them.
 */
const freezeImage = (root: string, source: string) =>
  Effect.gen(function* freezeCatalogImage() {
    const fs = yield* FileSystem.FileSystem;
    const file = imageFile(root, source);
    if (yield* fs.exists(unavailableFile(root, source))) {
      return Option.none<typeof Image.Type>();
    }
    if (!(yield* fs.exists(file))) {
      if (!isSourceCatalogImage(source)) {
        return yield* fail('Unsupported branded image URL; operator review required.');
      }
      const http = yield* HttpClient.HttpClient;
      const response = yield* http.get(source).pipe(Effect.timeout('20 seconds'));
      const fetched = response.status === 200 ? new Uint8Array(yield* response.arrayBuffer) : new Uint8Array();
      if (fetched.length === 0 || fetched.length > UPLOAD_MAX_BYTES || detectImageMimeType(fetched) === undefined) {
        yield* markDone(unavailableFile(root, source), String(response.status));
        return Option.none<typeof Image.Type>();
      }
      yield* fs.writeFile(file, fetched, { mode: 0o600 });
    }
    const bytes = yield* fs.readFile(file);
    return Option.some({ bytes: bytes.length, hash: bytesDigest(bytes), source });
  });
/** Freezes every kept source photo; an unavailable one frees its slot for the next photo in order. */
const freezeKept = (root: string, entry: Omit<PlannedProduct, 'images'>) =>
  Effect.gen(function* freezeKeptPhotos() {
    const unavailable = new Set(entry.unavailable);
    const frozen = new Map<string, typeof Image.Type>();
    const pendingPhotos = () =>
      productPhotoPlan(entry.photos, unavailable).kept.filter(
        (source) => isBrandedCatalogImage(source) && !frozen.has(source),
      );
    let pending = pendingPhotos();
    while (pending.length > 0) {
      for (const source of pending) {
        const image = yield* freezeImage(root, source);
        if (Option.isSome(image)) {
          frozen.set(source, image.value);
        } else {
          unavailable.add(source);
        }
      }
      pending = pendingPhotos();
    }
    const images = productPhotoPlan(entry.photos, unavailable).kept.flatMap((source) => {
      const image = frozen.get(source);
      return image === undefined ? [] : [image];
    });
    return { ...entry, images, unavailable: [...unavailable] };
  });

const startPlan = (client: SeedClient, origin: string, root: string) =>
  Effect.gen(function* startCatalogPlan() {
    const fs = yield* FileSystem.FileSystem;
    const file = `${root}/manifest.json`;
    if (yield* fs.exists(file)) {
      const manifest = yield* jsonRead(file, Manifest);
      if (manifest.origin !== origin) {
        return yield* fail('Checkpoint belongs to a different server origin.');
      }
      return manifest;
    }
    const first = yield* readRecords(client, { includeCategories: true, limit: 0, ordersLimit: 0, summary: true });
    if (first.totalProducts === undefined || first.categories === undefined) {
      return yield* fail('Incomplete catalog inventory.');
    }
    const products: string[] = [];
    for (let offset = 0; offset < first.totalProducts; offset += 250) {
      const page = yield* readRecords(client, { limit: 250, offset, ordersLimit: 0, summary: true });
      if (
        page.revision !== first.revision ||
        page.totalProducts !== first.totalProducts ||
        page.products.length === 0
      ) {
        return yield* fail('Catalog changed during inventory; rerun the plan.');
      }
      products.push(...page.products.map(({ id }) => id));
    }
    if (products.length !== first.totalProducts || new Set(products).size !== products.length) {
      return yield* fail('Incomplete or duplicate catalog inventory.');
    }
    const manifest = {
      categories: first.categories.map(({ id }) => id),
      cursor: 0,
      origin,
      products,
      revision: first.revision,
      version: 2,
    } as const;
    yield* jsonWrite(file, Manifest, manifest);
    return manifest;
  });
/** Fresh neutral seeds have no photos; `--seed-images` takes them from the checked-in source for the same ids. */
const seedPhotoSource = (before: CatalogProduct, source: CatalogProduct): CatalogProduct => {
  const photos: Types.Mutable<CatalogProduct> = {
    ...before,
    images: source.images ?? [],
    imageSrc: source.imageSrc ?? '',
  };
  if (before.variants !== undefined) {
    photos.variants = before.variants.map((variant) => ({
      ...variant,
      imageSrc: source.variants?.find(({ id }) => id === variant.id)?.imageSrc ?? source.imageSrc ?? '',
    }));
  }
  return photos;
};
const planProduct = (
  client: SeedClient,
  root: string,
  id: string,
  sourceProducts: AkrosEncodedState['products'] | undefined,
) =>
  Effect.gen(function* planCatalogProduct() {
    const { product: before } = yield* readProduct(client, id);
    if (/akros/iu.test(before.slug ?? '')) {
      return yield* fail('Branded product slug needs explicit owner URL migration.');
    }
    let photos = before;
    const source = sourceProducts?.find((candidate) => candidate.id === id);
    if (source !== undefined && (before.images ?? []).length === 0 && (before.imageSrc ?? '') === '') {
      photos = seedPhotoSource(before, yield* Schema.decodeUnknownEffect(Product)({ ...before, ...source }));
    }
    const everyPhoto = [
      ...(photos.images ?? []),
      photos.imageSrc ?? '',
      ...(photos.variants ?? []).map(({ imageSrc }) => imageSrc ?? ''),
    ];
    const marketing = [...new Set(everyPhoto.filter(isMarketingCatalogImage))];
    const entry = yield* freezeKept(root, { before, marketing, marketingReplacement: '', photos, unavailable: [] });
    return yield* jsonWrite(productFile(root, id), ProductEntry, entry);
  });
const planCategory = (client: SeedClient, root: string, id: string) =>
  Effect.gen(function* planCatalogCategory() {
    const { category: before } = yield* readCategory(client, id);
    if (/akros/iu.test(before.slug)) {
      return yield* fail('Branded category slug is immutable; owner URL migration required.');
    }
    return yield* jsonWrite(categoryFile(root, id), CategoryEntry, { before });
  });
/** Per-record snapshots; apply re-validates each record against its own snapshot, so concurrent orders are harmless. */
const planBatch = (client: SeedClient, origin: string, root: string, seedImages: boolean) =>
  Effect.gen(function* planCatalogBatch() {
    const manifest = yield* startPlan(client, origin, root);
    const sourceProducts = seedImages ? (yield* buildAkrosEncoded()).products : undefined;
    const total = manifest.products.length + manifest.categories.length;
    const { expired } = yield* deadline;
    let { cursor } = manifest;
    while (cursor < total && !(yield* expired)) {
      const productId = manifest.products[cursor];
      const categoryId = manifest.categories[cursor - manifest.products.length];
      if (productId !== undefined) {
        yield* planProduct(client, root, productId, sourceProducts);
      } else if (categoryId === undefined) {
        return yield* fail('Missing inventory entry.');
      } else {
        yield* planCategory(client, root, categoryId);
      }
      cursor += 1;
      yield* jsonWrite(`${root}/manifest.json`, Manifest, { ...manifest, cursor });
    }
    yield* Console.log(`PLAN ${cursor}/${total}; complete=${cursor === total}`);
    return cursor === total;
  });

const loadPlan = (root: string) =>
  Effect.gen(function* loadFrozenPlan() {
    const manifest = yield* jsonRead(`${root}/manifest.json`, Manifest);
    if (manifest.cursor !== manifest.products.length + manifest.categories.length) {
      return yield* fail('Plan is incomplete. Continue plan batches.');
    }
    const products: PlannedProduct[] = [];
    for (const id of manifest.products) {
      products.push(yield* jsonRead(productFile(root, id), ProductEntry));
    }
    const categories: PlannedCategory[] = [];
    for (const id of manifest.categories) {
      categories.push(yield* jsonRead(categoryFile(root, id), CategoryEntry));
    }
    return { categories, manifest, products };
  });
const representativesOf = (
  products: readonly PlannedProduct[],
  categories: readonly PlannedCategory[],
  candidate: (entry: PlannedProduct) => boolean,
) => {
  const usable = new Set(products.filter(candidate).map(({ before }) => before.id));
  return categoryRepresentatives(
    products.map(({ before }) => before),
    categories.map(({ before }) => before),
    (product) => deliverable(product) && usable.has(product.id),
  );
};
const hasPhoto = (entry: PlannedProduct) => keptPhotos(entry).length > 0;
/** Marketing artwork is replaced by the category representative's first photo (uploaded to this product) or dropped. */
const resolveMarketingPhotos = (root: string) =>
  Effect.gen(function* resolveBrandedMarketing() {
    const plan = yield* loadPlan(root);
    const byId = new Map(plan.products.map((entry) => [entry.before.id, entry]));
    const reps = representativesOf(
      plan.products,
      plan.categories,
      (entry) => entry.marketing.length === 0 && hasPhoto(entry),
    );
    for (const entry of plan.products.filter(({ marketing }) => marketing.length > 0)) {
      const representative = entry.before.categoryId === undefined ? undefined : reps.get(entry.before.categoryId);
      const source = representative === undefined ? undefined : byId.get(representative.id);
      const replacement = source === undefined ? '' : (keptPhotos(source)[0] ?? '');
      const replace = (image: string | undefined) =>
        isMarketingCatalogImage(image ?? '') ? replacement : (image ?? '');
      const photos: Types.Mutable<CatalogProduct> = {
        ...entry.photos,
        images: (entry.photos.images ?? []).map(replace).filter((image) => image !== ''),
        imageSrc: replace(entry.photos.imageSrc),
      };
      if (entry.photos.variants !== undefined) {
        photos.variants = entry.photos.variants.map((variant) => ({ ...variant, imageSrc: replace(variant.imageSrc) }));
      }
      const resolved = yield* freezeKept(root, { ...entry, marketingReplacement: replacement, photos });
      yield* jsonWrite(productFile(root, entry.before.id), ProductEntry, resolved);
    }
  });
const summarizePlan = (root: string) =>
  Effect.gen(function* summarizeCatalogPlan() {
    const plan = yield* loadPlan(root);
    const reps = representativesOf(plan.products, plan.categories, hasPhoto);
    const fingerprint = digest(plan);
    const allImages = plan.products.flatMap(({ images }) => images);
    const unique = new Map(allImages.map((image) => [image.source, image]));
    const changed = plan.products.filter(({ before, images }) => catalogHasBrand(before) || images.length > 0);
    const representative = plan.categories.filter(({ before }) => reps.get(before.id) !== undefined).length;
    // Rough cost per governed call on stage: ~1.5 s per upload, ~3 s per changed product, ~2 s per category.
    const estimatedSeconds = allImages.length * 1.5 + changed.length * 3 + plan.categories.length * 2;
    const summary = {
      auditHistory: 'Retained unchanged for audit integrity; this plan scrubs current catalog presentation only.',
      brandedGraphics: plan.products.flatMap(({ before, marketing, marketingReplacement }) =>
        marketing.map((source) => ({
          product: before.name,
          replacement: marketingReplacement === '' ? 'dropped' : marketingReplacement,
          source,
        })),
      ),
      brandedImages:
        'Marketing artwork (source file name contains banner/sekce) is never uploaded. Spot check of 12 product/category photos and both FVE banners: no visible source brand on the photos; the banners are marketing artwork. Sampling, not exhaustive.',
      categories: plan.categories.length,
      categoriesToChange: plan.categories.filter(({ before }) => categoryHasBrand(before)).length,
      categoriesWithImageBefore: plan.categories.filter(({ before }) => before.imageSrc !== '').length,
      categoryCleared: plan.categories.length - representative,
      categoryRepresentative: representative,
      categoryRule:
        'first active published product with a photo of the category itself (catalog order), otherwise of its descendants by category position; cleared without one or without an anonymous image response',
      estimatedApplyBatches: Math.ceil(estimatedSeconds / (TIME_BUDGET_MS / 1000)),
      estimatedApplyMinutes: Math.ceil(estimatedSeconds / 60),
      fingerprint,
      imagesToUpload: allImages.length,
      overflowGroups: plan.products
        .map((entry) => ({ entry, photos: productPhotoPlan(entry.photos, new Set(entry.unavailable)) }))
        .filter(({ photos }) => photos.fallback > 0)
        .map(({ entry, photos }) => ({
          fallback: photos.fallback,
          id: entry.before.id,
          kept: photos.kept.length,
          name: entry.before.name,
          variantsUsingFallback: (entry.photos.variants ?? []).filter(
            ({ imageSrc }) => (imageSrc ?? '') !== '' && !photos.kept.includes(imageSrc ?? ''),
          ).length,
        })),
      products: plan.products.length,
      productsToChange: changed.length,
      productTextChanges: plan.products.filter(({ before }) => textChanges(before)).length,
      totalBytes: allImages.reduce((count, image) => count + image.bytes, 0),
      unavailableImages: plan.products.flatMap(({ before, unavailable }) =>
        unavailable.map((source) => ({ product: before.name, source })),
      ),
      uniqueDownloadBytes: [...unique.values()].reduce((count, image) => count + image.bytes, 0),
      uniqueDownloads: unique.size,
      variants: plan.products.reduce((count, { before }) => count + (before.variants?.length ?? 0), 0),
      variantsToChange: changed.reduce(
        (count, { before }) => count + (before.variants ?? []).filter(variantHasBrand).length,
        0,
      ),
    };
    yield* jsonWrite(`${root}/approval.json`, Approval, { fingerprint, manifest: plan.manifest });
    yield* jsonWrite(`${root}/summary.json`, Summary, summary);
    return yield* Console.log(yield* Schema.encodeEffect(Schema.fromJsonString(Summary))(summary));
  });

/**
 * Maps already-uploaded photos from the live gallery's governed media SHA-256, so a lost journal or a rerun never
 * uploads the same photo twice. Anything else new in the gallery is a staff change and stops the operation.
 */
const recoverUploads = (client: SeedClient, root: string, entry: PlannedProduct, current: CatalogProduct) =>
  Effect.gen(function* recoverProductUploads() {
    const fs = yield* FileSystem.FileSystem;
    const journal = uploadJournal(root, entry.before.id);
    const stored = (yield* fs.exists(journal)) ? yield* jsonRead(journal, UploadState) : { mapping: {} };
    const mapping = new Map(Object.entries(stored.mapping));
    const known = new Set(mapping.values());
    for (const reference of current.images ?? []) {
      const planned = (entry.before.images ?? []).includes(reference);
      if (reference.startsWith('media:') && !known.has(reference)) {
        const media = yield* client.call(
          'merchandise',
          '/reads/media',
          MediaRequest,
          { image: reference, productId: entry.before.id, rendition: 'full' },
          MediaResponse,
        );
        const matched = entry.images.filter((image) => media.contentSha256 === image.hash);
        for (const image of matched) {
          mapping.set(image.source, reference);
        }
        if (matched.length === 0 && !planned) {
          return yield* fail('Unexpected staff-uploaded image since plan.');
        }
      } else if (!reference.startsWith('media:') && !planned) {
        return yield* fail('Unexpected gallery image since plan.');
      }
    }
    for (const reference of mapping.values()) {
      if (!(current.images ?? []).includes(reference)) {
        return yield* fail('A checkpoint photo was removed; manual review required.');
      }
    }
    const state = { mapping: Object.fromEntries(mapping) };
    yield* jsonWrite(journal, UploadState, state);
    return state;
  });
const uploadPhoto = (client: SeedClient, root: string, id: string, image: typeof Image.Type) =>
  Effect.gen(function* uploadFrozenPhoto() {
    const fs = yield* FileSystem.FileSystem;
    const bytes = yield* fs.readFile(imageFile(root, image.source));
    const mimeType = detectImageMimeType(bytes);
    if (bytesDigest(bytes) !== image.hash || mimeType === undefined) {
      return yield* fail('Frozen photo bytes changed.');
    }
    const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType.slice('image/'.length);
    const result = yield* galleryChange(client, id, {
      _tag: 'Upload',
      image: {
        filename: `foto-${image.hash.slice(0, 16)}.${extension}`,
        full: { contentBase64: Base64.encode(bytes) },
      },
    });
    if (result.image === undefined) {
      return yield* fail('Upload omitted its gallery reference; rerun to reconcile.');
    }
    return result.image;
  });
const applyProduct = (client: SeedClient, root: string, entry: PlannedProduct) =>
  Effect.gen(function* migrateProduct() {
    const { id } = entry.before;
    const { product: initial } = yield* readProduct(client, id);
    // Neutral rewriting is idempotent, so a resumed product (already rewritten) still matches its snapshot.
    if (digest(displayContent(initial)) !== digest(displayContent(entry.before))) {
      return yield* fail('Product content changed since the approved plan.');
    }
    if (digest(protectedProduct(initial)) !== digest(protectedProduct(entry.before))) {
      return yield* fail('Product prices, stock, variants or catalog structure changed since plan; stop and re-plan.');
    }
    const recovered = yield* recoverUploads(client, root, entry, initial);
    const mapping = new Map(Object.entries(recovered.mapping));
    // Free the source slots first (the owner gallery holds at most 20). Frozen bytes keep a resume deterministic.
    for (const image of initial.images ?? []) {
      if (isBrandedCatalogImage(image)) {
        yield* galleryChange(client, id, { _tag: 'Remove', image });
      }
    }
    for (const image of entry.images) {
      if (!mapping.has(image.source)) {
        mapping.set(image.source, yield* uploadPhoto(client, root, id, image));
        yield* jsonWrite(uploadJournal(root, id), UploadState, { mapping: Object.fromEntries(mapping) });
      }
    }
    const kept = keptPhotos(entry);
    const resolve = (image: string) => mapping.get(image) ?? (isBrandedCatalogImage(image) ? '' : image);
    const order = kept.map(resolve).filter((image) => image !== '');
    const { product: gallery } = yield* readProduct(client, id);
    if (order.length > 1 && digest(gallery.images ?? []) !== digest(order)) {
      yield* galleryChange(client, id, { _tag: 'Reorder', images: order });
    }
    const main = order[0] ?? '';
    const patch = productTextPatch(entry.before);
    const finalPatch: Types.Mutable<typeof patch> = { ...patch, imageSrc: main };
    if (patch.variants !== undefined) {
      finalPatch.variants = patch.variants.map((variant, index) => {
        const source = entry.photos.variants?.[index]?.imageSrc ?? '';
        if (source === '' || isSourcePlaceholder(source)) {
          return { ...variant, imageSrc: '' };
        }
        return { ...variant, imageSrc: kept.includes(source) ? resolve(source) : main };
      });
    }
    const { product: current, revision } = yield* readProduct(client, id);
    if (digest({ ...productTextPatch(current), imageSrc: current.imageSrc }) !== digest(finalPatch)) {
      yield* command(client, { _tag: 'UpdateProduct', id, patch: finalPatch }, revision);
    }
    const { product: after } = yield* readProduct(client, id);
    if (
      catalogHasBrand(after) ||
      !galleryConsistent(after) ||
      digest(protectedProduct(after)) !== digest(protectedProduct(entry.before))
    ) {
      return yield* fail('Product verification failed.');
    }
    return yield* markDone(productDone(root, id), 'done');
  });

const representativeImage = (client: SeedClient, productId: string | undefined, publicOrigin: string) =>
  Effect.gen(function* resolveRepresentativeImage() {
    if (productId === undefined) {
      return '';
    }
    const { product } = yield* readProduct(client, productId);
    const main = product.images?.[0];
    if (main === undefined || !main.startsWith('media:')) {
      return '';
    }
    const path = mediaPath(product.id, main);
    return (yield* publicImage(publicOrigin, path)) ? path : '';
  });
const applyCategory = (
  client: SeedClient,
  root: string,
  before: CatalogCategory,
  representative: CatalogProduct | undefined,
  publicOrigin: string,
) =>
  Effect.gen(function* applyCatalogCategory() {
    const { category: live, revision } = yield* readCategory(client, before.id);
    const imageSrc =
      isBrandedCatalogImage(before.imageSrc) || before.imageSrc === ''
        ? yield* representativeImage(client, representative?.id, publicOrigin)
        : before.imageSrc;
    if (
      digest(categoryTextPatch(live)) !== digest(categoryTextPatch(before)) ||
      live.slug !== before.slug ||
      live.parentId !== before.parentId ||
      live.position !== before.position ||
      (live.imageSrc !== before.imageSrc && live.imageSrc !== imageSrc)
    ) {
      return yield* fail('Category changed since plan.');
    }
    const patch = { ...categoryTextPatch(before), imageSrc };
    if (digest(patch) !== digest({ ...categoryTextPatch(live), imageSrc: live.imageSrc }) || categoryHasBrand(live)) {
      yield* command(client, { _tag: 'UpdateCategory', id: before.id, patch }, revision);
    }
    return yield* markDone(categoryDone(root, before.id), imageSrc === '' ? 'cleared' : imageSrc);
  });
const applyBatch = (client: SeedClient, root: string, approved: string, publicOrigin: string) =>
  Effect.gen(function* applyCatalogBatch() {
    const fs = yield* FileSystem.FileSystem;
    const plan = yield* loadPlan(root);
    if (digest(plan) !== approved) {
      return yield* fail('Approved fingerprint does not match the complete frozen plan.');
    }
    const { expired } = yield* deadline;
    let processed = 0;
    let pendingProducts = 0;
    for (const entry of plan.products) {
      if (!(yield* fs.exists(productDone(root, entry.before.id)))) {
        if (!catalogHasBrand(entry.before) && entry.images.length === 0) {
          yield* markDone(productDone(root, entry.before.id), 'unchanged');
        } else if (yield* expired) {
          pendingProducts += 1;
        } else {
          yield* applyProduct(client, root, entry);
          processed += 1;
        }
      }
    }
    let categoriesDone = 0;
    let cleared = 0;
    if (pendingProducts === 0) {
      const reps = representativesOf(plan.products, plan.categories, hasPhoto);
      for (const { before } of plan.categories) {
        if (!(yield* fs.exists(categoryDone(root, before.id))) && !(yield* expired)) {
          yield* applyCategory(client, root, before, reps.get(before.id), publicOrigin);
          processed += 1;
        }
        if (yield* fs.exists(categoryDone(root, before.id))) {
          categoriesDone += 1;
          cleared += (yield* fs.readFileString(categoryDone(root, before.id))) === 'cleared' ? 1 : 0;
        }
      }
    }
    const complete = pendingProducts === 0 && categoriesDone === plan.categories.length;
    return yield* Console.log(
      `APPLY processed=${processed}; productsPending=${pendingProducts}; categories=${categoriesDone}/${plan.categories.length} (cleared=${cleared}); complete=${complete}`,
    );
  });

const verifyProduct = (client: SeedClient, entry: PlannedProduct) =>
  Effect.gen(function* verifyCatalogProduct() {
    const { product } = yield* readProduct(client, entry.before.id);
    const valid =
      !catalogHasBrand(product) &&
      galleryConsistent(product) &&
      digest(protectedProduct(product)) === digest(protectedProduct(entry.before));
    return valid
      ? product.id
      : yield* fail('Catalog verification failed: brand, gallery or protected product changes.');
  });
const verifyCategory = (client: SeedClient, before: CatalogCategory, publicOrigin: string) =>
  Effect.gen(function* verifyCatalogCategory() {
    const { category } = yield* readCategory(client, before.id);
    if (
      categoryHasBrand(category) ||
      category.slug !== before.slug ||
      category.parentId !== before.parentId ||
      category.position !== before.position
    ) {
      return yield* fail('Catalog verification failed: category brand/tree/order changed.');
    }
    const deliverableImage =
      category.imageSrc === '' ||
      (category.imageSrc.startsWith('/obrazky/') && (yield* publicImage(publicOrigin, category.imageSrc)));
    return deliverableImage
      ? category.id
      : yield* fail('Catalog verification failed: category image is not anonymously deliverable.');
  });
const verifyBatch = (client: SeedClient, root: string, approved: string, publicOrigin: string) =>
  Effect.gen(function* verifyCatalogBatch() {
    const fs = yield* FileSystem.FileSystem;
    const plan = yield* loadPlan(root);
    if (digest(plan) !== approved) {
      return yield* fail('Verification fingerprint mismatch.');
    }
    const cursorFile = `${root}/verify.json`;
    let { cursor } = (yield* fs.exists(cursorFile)) ? yield* jsonRead(cursorFile, Cursor) : { cursor: 0 };
    const total = plan.products.length + plan.categories.length;
    const { expired } = yield* deadline;
    while (cursor < total && !(yield* expired)) {
      const product = plan.products[cursor];
      const category = plan.categories[cursor - plan.products.length];
      if (product !== undefined) {
        yield* verifyProduct(client, product);
      } else if (category === undefined) {
        return yield* fail('Incomplete verification inventory.');
      } else {
        yield* verifyCategory(client, category.before, publicOrigin);
      }
      cursor += 1;
      yield* jsonWrite(cursorFile, Cursor, { cursor });
    }
    const head = yield* readRecords(client, { includeCategories: true, limit: 0, ordersLimit: 0, summary: true });
    if (head.totalProducts !== plan.products.length || head.categories?.length !== plan.categories.length) {
      return yield* fail('Product/category inventory changed.');
    }
    return yield* Console.log(`VERIFY ${cursor}/${total}; complete=${cursor === total}`);
  });
const planMode = (client: SeedClient, origin: string, root: string, seedImages: boolean) =>
  Effect.gen(function* runPlanBatch() {
    if (yield* planBatch(client, origin, root, seedImages)) {
      yield* resolveMarketingPhotos(root);
      yield* summarizePlan(root);
    }
  });

if (import.meta.main) {
  const cli = Command.make(
    'pseudonymize-akros-catalog',
    {
      approved: Flag.String('approved').pipe(Flag.withDefault('')),
      checkpoint: Flag.String('checkpoint').pipe(Flag.withDefault('/var/www/ontos-pseudonym-catalog-v2')),
      mode: Flag.Literals('mode', ['plan', 'apply', 'verify', 'summary']).pipe(Flag.withDefault('plan')),
      seedImages: Flag.Boolean('seed-images').pipe(Flag.withDefault(false)),
    },
    ({ approved, checkpoint: root, mode, seedImages }) =>
      Effect.gen(function* runCatalogOperator() {
        const fs = yield* FileSystem.FileSystem;
        for (const directory of ['', '/products', '/categories', '/images', '/uploads', '/done']) {
          yield* fs.makeDirectory(`${root}${directory}`, { mode: 0o700, recursive: true });
        }
        if (mode === 'summary') {
          return yield* summarizePlan(root);
        }
        const target = {
          legalEntityId: akrosDemoLegalEntityId,
          shellUrl: yield* Config.String('ONTOS_DEMO_SEED_URL').pipe(
            Config.withDefault('https://ontos-stage.web-revolution.cz'),
          ),
          tenantId: demoTenantId,
        };
        const publicOrigin = PUBLIC_STOREFRONT.get(target.shellUrl);
        if (publicOrigin === undefined) {
          return yield* fail('Only the stage demo or the local demo is supported.');
        }
        if (mode !== 'plan' && approved === '') {
          return yield* fail('Pass --approved <fingerprint from summary.json>.');
        }
        const email = yield* Config.String('ONTOS_AGENT_SETUP_EMAIL');
        const password = yield* Config.Redacted('ONTOS_AGENT_SETUP_PASSWORD');
        const client = yield* Effect.acquireRelease(
          connectSeedClient(
            target,
            email,
            password,
            seedWriteCheckpoint(fs, seedCheckpointDirectory(target, `${root}/writes`)),
          ),
          (connected) => connected.signOut.pipe(Effect.ignore),
        );
        if (mode === 'plan') {
          return yield* planMode(client, target.shellUrl, root, seedImages);
        }
        if (mode === 'apply') {
          return yield* applyBatch(client, root, approved, publicOrigin);
        }
        return yield* verifyBatch(client, root, approved, publicOrigin);
      }),
  );
  const exit = await Effect.runPromiseExit(
    Command.run(cli, { version: '2.0.0' }).pipe(
      Effect.scoped,
      Effect.tapErrorTag('DemoSeedError', (error) => Console.error(error.reason)),
      Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'manual' }),
    ),
  );
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
