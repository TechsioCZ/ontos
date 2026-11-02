import { describe, expect, it } from 'effect-rstest';
import { Cause, Console, Effect, FileSystem, Match, Option, PlatformError, Schema } from 'effect';
import { TestClock, TestConsole } from 'effect/testing';
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from 'effect/http';
import {
  catalogFailureDiagnostic,
  catalogFailureKind,
  catalogBatchBudget,
  catalogStep,
  applyBatch,
  applyCategory,
  publicImage,
} from './pseudonymize-akros-catalog.mts';
import { MerchandiseCommandSchema } from '../../verticals/merchandise/shared/actions/apply-command.ts';
import { CatalogCategoryIdSchema } from '../../verticals/merchandise/shared/domain/merchandise-model.ts';
import { DemoSeedError } from './seed-client.mts';
import type { SeedClient } from './seed-client.mts';
import { seedWriteCheckpoint } from './seed-checkpoint.mts';
import type { CatalogCategory } from './pseudonymize-akros-catalog-policy.mts';
import { buildAkrosEncoded, buildSroubshopEncoded } from '../../verticals/merchandise/scripts/akros-catalog.mts';
import type { AkrosEncodedState } from '../../verticals/merchandise/scripts/akros-baseline.ts';
import { isSourceCatalogImage, neutralCatalogText } from '../../verticals/merchandise/scripts/akros-pseudonym.ts';
import { MerchandiseStateSchema } from '../../verticals/merchandise/shared/apis/records.ts';
import {
  Category,
  Product,
  categoryRepresentatives,
  categoryTextPatch,
  digest,
  galleryConsistent,
  galleryOrder,
  productPhotoPlan,
  productTextPatch,
  protectedProduct,
  twinReference,
  uniqueVariantSkus,
} from './pseudonymize-akros-catalog-policy.mts';

const fixture = Effect.gen(function* catalogFixture() {
  const baseline = yield* buildAkrosEncoded();
  const demo = yield* buildSroubshopEncoded();
  const first = yield* Schema.decodeUnknownEffect(Product)({
    ...baseline.products[0],
    lowStock: false,
    stockOnHand: 0,
    stockValueMinor: 0,
  });
  return { baseline, demo, first };
});
const commercials = (products: AkrosEncodedState['products']) =>
  products.map(({ currentPriceMinor, id, priceTiers, sku, variants }) => ({
    currentPriceMinor,
    id,
    priceTiers,
    sku,
    variants: variants?.map(({ id: variantId, priceMinor, priceTiers: tiers, sku: variantSku }) => ({
      id: variantId,
      priceMinor,
      priceTiers: tiers,
      sku: variantSku,
    })),
  }));

const categoryNode = (id: string, parentId: string | null, position: number) =>
  Schema.decodeUnknownEffect(Category)({
    description: '',
    hasChildren: false,
    heading: '',
    id,
    imageAlt: '',
    imageSrc: '',
    longDescription: '',
    name: id,
    parentId,
    position,
    slug: id,
  });

describe('pseudonymous demo catalog', () => {
  it.effect('preserves every identity, price, variant, stock movement and category', () =>
    Effect.gen(function* preserveCatalog() {
      const { baseline, demo } = yield* fixture;
      expect(demo.products).toHaveLength(baseline.products.length);
      expect(demo.products.reduce((count, product) => count + (product.variants?.length ?? 0), 0)).toBe(
        baseline.products.reduce((count, product) => count + (product.variants?.length ?? 0), 0),
      );
      expect(demo.categories?.map(({ id, parentId, position, slug }) => ({ id, parentId, position, slug }))).toEqual(
        baseline.categories?.map(({ id, parentId, position, slug }) => ({ id, parentId, position, slug })),
      );
      expect(commercials(demo.products)).toEqual(commercials(baseline.products));
      expect(demo.movements.map(({ note: _note, ...movement }) => movement)).toEqual(
        baseline.movements.map(({ note: _note, ...movement }) => movement),
      );
    }),
  );
  it.effect('neutral demo has no source references and the real-AKROS builder is unchanged', () =>
    Effect.gen(function* neutralBaseline() {
      const { baseline, demo } = yield* fixture;
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(MerchandiseStateSchema))(
        yield* Schema.decodeUnknownEffect(MerchandiseStateSchema)(demo),
      );
      expect(encoded).not.toMatch(/akros/iu);
      expect(baseline.categories?.some(({ imageSrc }) => /akros/iu.test(imageSrc))).toBe(true);
      expect(baseline.products.some(({ images }) => (images ?? []).some(isSourceCatalogImage))).toBe(true);
    }),
  );
  it('rewrites Czech phrases with their correct case', () => {
    expect(neutralCatalogText('V sortimentu Akrosu najdete')).toBe('V našem sortimentu najdete');
    expect(neutralCatalogText('V nabídce AKROS.cz naleznete')).toBe('V naší nabídce naleznete');
    expect(neutralCatalogText('společně s Akrosem, z AKROSu, u Akrosu')).toBe(
      'společně se ŠroubShopem, z naší nabídky, u nás',
    );
    expect(neutralCatalogText('AKROS nabízí šrouby.')).toBe('Nabízíme šrouby.');
    expect(neutralCatalogText('Pokud hledáte L profil, AKROS nabízí výběr. Na webu Akros.cz najdete více.')).toBe(
      'Pokud hledáte L profil, nabízíme výběr. V našem obchodě najdete více.',
    );
    expect(neutralCatalogText('Výhody nákupu u AKROS: rychlost.​ V Akros nabídce je vše.')).toBe(
      'Výhody nákupu u nás: rychlost.​ V naší nabídce je vše.',
    );
    const once = neutralCatalogText('Akros šroub z nabídky Akrosu');
    expect(neutralCatalogText(once)).toBe(once);
  });
  it.effect('keeps main plus first nineteen distinct variant photos', () =>
    Effect.gen(function* photoCap() {
      const { first } = yield* fixture;
      const variants = Array.from({ length: 30 }, (_, index) => ({
        attributes: '',
        imageSrc: `${index}.jpg`,
        name: `M${index}`,
      }));
      const product = { ...first, images: ['main.jpg'], imageSrc: 'main.jpg', variants };
      const photos = productPhotoPlan(product);
      expect(photos.kept).toEqual(['main.jpg', ...Array.from({ length: 19 }, (_, index) => `${index}.jpg`)]);
      expect(photos.fallback).toBe(11);
      const unavailable = '3.jpg';
      expect(productPhotoPlan(product, new Set([unavailable])).kept).toContain('19.jpg');
      expect(productPhotoPlan(product, new Set([unavailable])).kept).not.toContain(unavailable);
    }),
  );
  it.effect('preserves staff-edited commercial fields while rewriting labels and parameters', () =>
    Effect.gen(function* staffEdits() {
      const { first } = yield* fixture;
      const edited = {
        ...first,
        description: 'V nabídce Akrosu najdete šrouby.',
        name: 'Akros šroub',
        parameters: [{ label: 'Dodavatel', unit: '', value: 'AKROS' }],
        variants: [{ ...first.variants?.[0], attributes: 'od Akrosu', name: 'Akros varianta' }],
      };
      const patch = productTextPatch(edited);
      expect(patch.name).toBe('ŠroubShop šroub');
      expect(patch.description).toBe('V naší nabídce najdete šrouby.');
      expect(patch.parameters?.[0]?.value).toBe('ŠroubShop');
      expect(patch.variants?.[0]?.name).toBe('ŠroubShop varianta');
      expect(digest(protectedProduct({ ...edited, ...patch }))).toBe(digest(protectedProduct(edited)));
    }),
  );
  it.effect('excludes unavailable placeholders and branded marketing graphics from uploads', () =>
    Effect.gen(function* excludedImages() {
      const { first } = yield* fixture;
      const images = [
        '/akros/products/image-unavailable.svg',
        'https://www.akros.cz/data/product/fve-konstrukce-banner-sekce.jpg',
      ];
      expect(productPhotoPlan({ ...first, images, imageSrc: images[0], variants: [] }).kept).toEqual([]);
    }),
  );
  it('downloads only fixed source-host image URLs', () => {
    expect(isSourceCatalogImage('https://www.akros.cz/data/product/a.jpg')).toBe(true);
    expect(isSourceCatalogImage('https://www.akros.cz@localhost/data/product/a.jpg')).toBe(false);
    expect(isSourceCatalogImage('http://127.0.0.1/data/product/a.jpg')).toBe(false);
    expect(isSourceCatalogImage('https://www.akros.cz/redirect?to=localhost')).toBe(false);
  });
  it('fingerprints ignore object key order but not array order', () => {
    const value = { a: 1, b: ['x', 'y'] };
    expect(digest(value)).toBe(
      digest(
        Object.fromEntries([
          ['b', value.b],
          ['a', value.a],
        ]),
      ),
    );
    expect(digest(value)).not.toBe(digest({ ...value, b: ['y', 'x'] }));
  });
  it.effect('rewrites category copy without changing identity or tree', () =>
    Effect.gen(function* categoryCopy() {
      const { baseline } = yield* fixture;
      const category = yield* Schema.decodeUnknownEffect(Category)(
        baseline.categories?.find(({ id }) => id === '1485'),
      );
      expect(categoryTextPatch(category).description).toContain('V naší nabídce');
    }),
  );
  it.effect('picks the first own eligible product, otherwise the first one in descendants by position', () =>
    Effect.gen(function* categoryRepresentative() {
      const { first } = yield* fixture;
      const categories = [
        yield* categoryNode('root', null, 0),
        yield* categoryNode('late', 'root', 2),
        yield* categoryNode('early', 'root', 1),
        yield* categoryNode('leaf', 'early', 0),
        yield* categoryNode('empty', null, 1),
      ];
      const product = (id: string, categoryId: string) => ({ ...first, categoryId, id });
      const products = [product('p-late', 'late'), product('p-hidden', 'leaf'), product('p-leaf', 'leaf')];
      const reps = categoryRepresentatives(products, categories, ({ id }) => id !== 'p-hidden');
      expect(reps.get('root')?.id).toBe('p-leaf');
      expect(reps.get('late')?.id).toBe('p-late');
      expect(reps.get('leaf')?.id).toBe('p-leaf');
      expect(reps.get('empty')).toBeUndefined();
    }),
  );
  it.effect('accepts only galleries whose main and variant photos are gallery photos', () =>
    Effect.gen(function* galleryReferences() {
      const { first } = yield* fixture;
      const variant = { ...first.variants?.[0], attributes: '', name: 'M' };
      const gallery = { ...first, images: ['media:a', 'media:b'], imageSrc: 'media:a' };
      expect(
        galleryConsistent({
          ...gallery,
          variants: [
            { ...variant, imageSrc: 'media:b' },
            { ...variant, imageSrc: '' },
          ],
        }),
      ).toBe(true);
      expect(galleryConsistent({ ...gallery, variants: [{ ...variant, imageSrc: 'media:c' }] })).toBe(false);
      expect(galleryConsistent({ ...gallery, imageSrc: 'media:b', variants: [] })).toBe(false);
    }),
  );
});

const twinResolve = (image: string) => (image.includes('img-5293') ? 'media:one' : 'media:two');
const categoryWriteEvent = 'native-write';
const firstCategoryRead = 'native-read:433';
const uncommittedFailure = 'before-commit';
const shopOrigin = 'https://ontos-stage-shop.web-revolution.cz';
const unusedCategorySeam = () => Effect.die(new Error('Unused fixture seam'));

const categoryRecoveryFixture = Effect.gen(function* categoryRecoveryFixture() {
  const root = '/catalog';
  const before = {
    ...(yield* categoryNode('433', null, 0)),
    imageSrc: 'https://www.akros.cz/data/category/photo.jpg',
    name: 'AKROS šrouby',
  };
  const live = new Map<string, CatalogCategory>([[before.id, before]]);
  const files = new Map<string, string>();
  const events: string[] = [];
  const keys: string[] = [];
  let revision = 7;
  let mode: 'none' | 'before-commit' | 'after-commit' | 'readback' = 'none';
  let writes = 0;
  let committed = false;
  let storageFails = false;
  const error = new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({
      cause: Object.assign(new Error('private'), { code: 'ECONNRESET' }),
      request: HttpClientRequest.post(
        'https://ontos-stage.web-revolution.cz/merchandise-api/merchandise/actions/apply-command',
      ),
    }),
  });
  const fs = FileSystem.makeNoop({
    exists: (file) => Effect.succeed(files.has(file)),
    makeDirectory: () => Effect.void,
    readFileString: (file) => Effect.succeed(files.get(file) ?? ''),
    rename: (source, target) =>
      Effect.sync(() => {
        files.set(target, files.get(source) ?? '');
        files.delete(source);
      }),
    writeFileString: (file, body, options) =>
      Effect.gen(function* writeFixtureFile() {
        if (storageFails && file.includes('/category-intents/')) {
          return yield* PlatformError.systemError({
            _tag: 'PermissionDenied',
            method: 'writeFileString',
            module: 'FileSystem',
          });
        }
        if (options?.flag === 'wx') {
          expect(files.has(file)).toBe(false);
        }
        events.push(`save:${file}`);
        files.set(file, body);
        return yield* Effect.void;
      }),
  });
  const checkpoint = seedWriteCheckpoint(fs, `${root}/writes/native`);
  const payloadSchema = Schema.Struct({
    command: Schema.toEncoded(MerchandiseCommandSchema),
    expectedRevision: Schema.Int,
  });
  const http = HttpClient.make(unusedCategorySeam);
  const client: SeedClient = {
    apply: unusedCategorySeam,
    authorize: unusedCategorySeam,
    call: (_audience, path, inputSchema, input, outputSchema) =>
      Effect.gen(function* nativeCategoryCall() {
        const encoded = yield* Schema.encodeEffect(inputSchema)(input);
        if (path === '/reads/records') {
          const request = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              view: Schema.Struct({ categoryId: Schema.toEncoded(CatalogCategoryIdSchema) }),
            }),
          )(encoded);
          events.push(`native-read:${request.view.categoryId}`);
          if (mode === 'readback' && committed) {
            return yield* error;
          }
          return yield* Schema.decodeUnknownEffect(outputSchema)({
            actorPrincipalRef: {
              principalId: '72000000-0000-4000-8000-000000000020',
              tenantId: '70000000-0000-4000-8000-000000000020',
            },
            canWrite: true,
            categories: [live.get(request.view.categoryId)],
            indicators: {
              lowStockCount: 0,
              openOrderValueMinor: 0,
              orderCount: 0,
              productCount: 0,
              stockValueMinor: 0,
            },
            movements: [],
            orders: [],
            products: [],
            revision,
          });
        }
        const payload = yield* Schema.decodeUnknownEffect(payloadSchema)(encoded);
        const key = yield* checkpoint(
          'merchandise',
          path,
          yield* Schema.encodeEffect(Schema.fromJsonString(inputSchema))(input),
        );
        keys.push(key);
        writes += 1;
        events.push(categoryWriteEvent);
        if (mode === uncommittedFailure) {
          return yield* error;
        }
        const command = Match.value(payload.command).pipe(
          Match.tag('UpdateCategory', (value) => Option.some(value)),
          Match.orElse(() => Option.none()),
        );
        if (Option.isNone(command)) {
          return yield* Effect.die(new Error('Only category writes are expected'));
        }
        expect(payload.expectedRevision).toBe(revision);
        expect(files.has(`${root}/writes/category-intents/${digest(command.value.id)}.json`)).toBe(true);
        const category = live.get(command.value.id);
        expect(category).toBeDefined();
        if (category !== undefined) {
          live.set(command.value.id, { ...category, ...command.value.patch });
        }
        revision += 1;
        committed = true;
        if (mode === 'after-commit') {
          return yield* error;
        }
        return yield* Schema.decodeUnknownEffect(outputSchema)({ revision });
      }),
    read: unusedCategorySeam,
    signOut: Effect.void,
  };
  const console = yield* TestConsole.make;
  const run = applyCategory(client, root, before, undefined, shopOrigin).pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Console.Console, console),
    Effect.provideService(HttpClient.HttpClient, http),
  );
  return {
    advanceRevision: () => {
      revision += 1;
    },
    before,
    client,
    console,
    done: `${root}/done/category-${digest(before.id)}`,
    error,
    events,
    failAt: (next: typeof mode) => {
      mode = next;
    },
    failStorage: () => {
      storageFails = true;
    },
    files,
    fs,
    http,
    keys,
    live,
    root,
    run,
    writes: () => writes,
  };
});

describe('bounded category recovery', () => {
  it.effect('persists an intent before dispatch and reads native committed state before marking done', () =>
    Effect.gen(function* categoryWriteOrdering() {
      const f = yield* categoryRecoveryFixture;
      yield* f.run;
      expect(f.writes()).toBe(1);
      expect(f.files.get(f.done)).toBe('cleared');
      expect(f.events[0]).toBe(firstCategoryRead);
      expect(f.events.filter((event) => event.startsWith('native-'))).toEqual([
        firstCategoryRead,
        categoryWriteEvent,
        firstCategoryRead,
      ]);
      expect(f.events.indexOf(`save:${f.root}/writes/category-intents/${digest(f.before.id)}.json.next`)).toBeLessThan(
        f.events.indexOf(categoryWriteEvent),
      );
      expect(f.events.at(-1)).toBe(`save:${f.done}`);
    }),
  );
  it.effect('does not retry a lost commit response and reconciles it on the next explicit invocation', () =>
    Effect.gen(function* lostCategoryCommitResponse() {
      const f = yield* categoryRecoveryFixture;
      f.failAt('after-commit');
      expect(yield* Effect.flip(f.run)).toBe(f.error);
      expect(f.writes()).toBe(1);
      expect(f.files.has(f.done)).toBe(false);
      f.failAt('none');
      yield* f.run;
      expect(f.writes()).toBe(1);
      expect(f.files.get(f.done)).toBe('cleared');
      expect(f.events.filter((event) => event.startsWith('native-'))).toEqual([
        firstCategoryRead,
        categoryWriteEvent,
        firstCategoryRead,
      ]);
    }),
  );
  it.effect('adopts an already-applied native category from the older checkpoint without another Action', () =>
    Effect.gen(function* reconcilePriorOperatorBoundary() {
      const f = yield* categoryRecoveryFixture;
      f.live.set(f.before.id, { ...f.before, ...categoryTextPatch(f.before), imageSrc: '' });
      yield* f.run;
      expect(f.writes()).toBe(0);
      expect(f.events.filter((event) => event.startsWith('native-'))).toEqual([firstCategoryRead]);
      expect(f.files.get(f.done)).toBe('cleared');
      expect(f.keys).toEqual([]);
    }),
  );
  it.effect('reconciles a failed read-back without dispatching the committed Action again', () =>
    Effect.gen(function* lostCategoryReadback() {
      const f = yield* categoryRecoveryFixture;
      f.failAt('readback');
      expect(yield* Effect.flip(f.run)).toBe(f.error);
      expect(f.files.has(f.done)).toBe(false);
      f.failAt('none');
      yield* f.run;
      expect(f.writes()).toBe(1);
      expect(f.files.has(f.done)).toBe(true);
    }),
  );
  it.effect('reuses the exact saved invocation after native reads prove the prior state is unchanged', () =>
    Effect.gen(function* reconcileUncommittedCategory() {
      const f = yield* categoryRecoveryFixture;
      f.failAt(uncommittedFailure);
      expect(yield* Effect.flip(f.run)).toBe(f.error);
      expect(f.writes()).toBe(1);
      f.failAt('none');
      yield* f.run;
      expect(f.writes()).toBe(2);
      expect(f.keys[1]).toBe(f.keys[0]);
      expect(f.events.filter((event) => event.startsWith('native-'))).toEqual([
        firstCategoryRead,
        categoryWriteEvent,
        firstCategoryRead,
        categoryWriteEvent,
        firstCategoryRead,
      ]);
    }),
  );
  it.effect('blocks an uncertain write if the native revision changed instead of generating a new Action', () =>
    Effect.gen(function* conflictingCategoryRevision() {
      const f = yield* categoryRecoveryFixture;
      f.failAt(uncommittedFailure);
      yield* Effect.flip(f.run);
      f.failAt('none');
      f.advanceRevision();
      const failure = yield* Effect.flip(f.run);
      expect(failure).toBeInstanceOf(DemoSeedError);
      expect(f.writes()).toBe(1);
      expect(f.files.has(f.done)).toBe(false);
    }),
  );
  it.effect('dispatches no Action when its intent cannot be persisted', () =>
    Effect.gen(function* intentStorageFailure() {
      const f = yield* categoryRecoveryFixture;
      f.failStorage();
      const failure = yield* Effect.flip(f.run);
      expect(failure).toBeInstanceOf(PlatformError.PlatformError);
      expect(f.writes()).toBe(0);
      expect(f.files.has(f.done)).toBe(false);
    }),
  );
  it.effect('rejects an altered pending payload without allocating another invocation', () =>
    Effect.gen(function* changedCategoryIntent() {
      const f = yield* categoryRecoveryFixture;
      f.failAt(uncommittedFailure);
      yield* Effect.flip(f.run);
      f.failAt('none');
      const file = `${f.root}/writes/category-intents/${digest(f.before.id)}.json`;
      f.files.set(
        file,
        JSON.stringify({
          beforeDigest: 'changed',
          expectedRevision: 7,
          patch: { imageSrc: '/changed' },
        }),
      );
      expect(yield* Effect.flip(f.run)).toBeInstanceOf(DemoSeedError);
      expect(f.writes()).toBe(1);
      expect(f.keys).toHaveLength(1);
      expect(f.files.has(f.done)).toBe(false);
    }),
  );
  it.effect('caps a batch at the record limit even when every operation is fast', () =>
    Effect.gen(function* recordBudget() {
      const budget = yield* catalogBatchBudget(50);
      for (let index = 0; index < 50; index += 1) {
        expect(yield* budget.take).toBe(true);
      }
      expect(yield* budget.take).toBe(false);
    }),
  );
  it.effect('stops starting records when the 45-second start budget expires', () =>
    Effect.gen(function* boundedRecordStart() {
      const budget = yield* catalogBatchBudget(50);
      expect(yield* budget.take).toBe(true);
      yield* TestClock.adjust('45 seconds');
      expect(yield* budget.take).toBe(false);
    }).pipe(Effect.provide(TestClock.layer())),
  );
  it.effect('rejects invalid record limits', () =>
    Effect.gen(function* invalidRecordBudget() {
      for (const count of [0, 101, 1.5]) {
        expect(yield* Effect.flip(catalogBatchBudget(count))).toBeInstanceOf(Schema.SchemaError);
      }
    }),
  );
  it.effect('resumes a bounded batch from category markers without touching products or completed categories', () =>
    Effect.gen(function* boundedForwardCursor() {
      const f = yield* categoryRecoveryFixture;
      const categories = ['433', '434', '435'].map((id) => ({ before: { ...f.before, id, slug: id } }));
      for (const entry of categories) {
        f.live.set(entry.before.id, entry.before);
        f.files.set(`${f.root}/categories/${digest(entry.before.id)}.json`, JSON.stringify(entry));
      }
      const { first } = yield* fixture;
      const completedProduct = {
        before: first,
        images: [],
        marketing: [],
        marketingReplacement: '',
        photos: { ...first, images: [], imageSrc: '', variants: [] },
        unavailable: [],
      };
      f.files.set(`${f.root}/products/${digest(first.id)}.json`, JSON.stringify(completedProduct));
      f.files.set(`${f.root}/done/${digest(first.id)}`, 'done');
      const manifest = {
        categories: categories.map((entry) => entry.before.id),
        cursor: 4,
        origin: 'https://ontos-stage.web-revolution.cz',
        products: [first.id],
        revision: 7,
        version: 2,
      };
      f.files.set(`${f.root}/manifest.json`, JSON.stringify(manifest));
      const approved = digest({ categories, manifest, products: [completedProduct] });
      const batch = applyBatch(f.client, f.root, approved, shopOrigin, 2).pipe(
        Effect.provideService(FileSystem.FileSystem, f.fs),
        Effect.provideService(Console.Console, f.console),
        Effect.provideService(HttpClient.HttpClient, f.http),
      );
      yield* batch;
      expect(f.writes()).toBe(2);
      expect(f.files.has(`${f.root}/done/category-${digest('435')}`)).toBe(false);
      f.events.length = 0;
      yield* batch;
      expect(f.writes()).toBe(3);
      expect(f.events.filter((event) => event.startsWith('native-'))).toEqual([
        'native-read:435',
        categoryWriteEvent,
        'native-read:435',
      ]);
    }),
  );
});

describe('catalog failure diagnostics', () => {
  const staffOrigin = 'https://ontos-stage.web-revolution.cz';
  const privateDetail = 'must-not-log';
  const representativePhase = 'representative-image';
  const readPhase = 'read-category';
  const transportFailure = (
    url: string,
    cause = new TypeError(privateDetail, {
      cause: Object.assign(new Error(privateDetail), {
        code: 'UND_ERR_SOCKET',
        name: 'SocketError',
        socket: { remoteAddress: privateDetail },
      }),
    }),
  ) =>
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({
        cause,
        description: privateDetail,
        request: HttpClientRequest.post(url).pipe(
          HttpClientRequest.setHeaders({ authorization: privateDetail, cookie: privateDetail }),
          HttpClientRequest.bodyText(privateDetail),
        ),
      }),
    });
  it('reports transport and timeout kinds without copying private provider details', () => {
    const privateMessage = 'private credential';
    const error = new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({
        cause: new Error(privateMessage),
        request: HttpClientRequest.get('https://private.invalid/?token=secret'),
      }),
    });
    expect(catalogFailureKind(error)).toBe('HttpClientError/TransportError');
    expect(catalogFailureKind(new Cause.TimeoutError())).toBe('TimeoutError');
    expect(catalogFailureKind({ _tag: privateMessage })).toBe('UnclassifiedError');
  });
  it.effect('reports a schema failure without copying its rejected payload', () =>
    Effect.gen(function* schemaFailureKind() {
      const error = yield* Effect.flip(Schema.decodeUnknownEffect(Schema.Number)('private credential'));
      expect(catalogFailureKind(error)).toBe('SchemaError');
    }),
  );
  it('retains the category phase, known host class and nested transport code, not private details', () => {
    const diagnostic = catalogFailureDiagnostic(
      transportFailure(`${staffOrigin}/shell-super-app-api/auth/gateway-context?token=${privateDetail}`),
      { categoryId: '433', phase: readPhase },
    );
    expect(diagnostic).toEqual({
      categoryId: '433',
      causeCode: null,
      causeName: 'TypeError',
      hostClass: 'staff',
      kind: 'HttpClientError/TransportError',
      nestedCauseCode: 'UND_ERR_SOCKET',
      nestedCauseName: 'SocketError',
      phase: readPhase,
      requestPhase: 'gateway-assertion',
    });
    expect(JSON.stringify(diagnostic)).not.toContain(privateDetail);
    expect(JSON.stringify(diagnostic)).not.toContain(staffOrigin);
  });
  it('distinguishes staff owner reads, Action dispatch and the public storefront image request', () => {
    for (const [url, hostClass, requestPhase] of [
      [`${staffOrigin}/merchandise-api/reads/records`, 'staff', 'owner-records'],
      [`${staffOrigin}/merchandise-api/merchandise/actions/apply-command`, 'staff', 'owner-action'],
      ['https://ontos-stage-shop.web-revolution.cz/cs/obrazky/product/photo', 'shop', 'public-image'],
      ['https://private.invalid/a?token=secret', 'other', 'other'],
    ]) {
      const diagnostic = catalogFailureDiagnostic(transportFailure(url ?? 'invalid'));
      expect(diagnostic.hostClass).toBe(hostClass);
      expect(diagnostic.requestPhase).toBe(requestPhase);
    }
  });
  it('drops unrecognized cause identities and redacts a non-catalog category identifier', () => {
    const cause = Object.assign(new TypeError(privateDetail), { code: privateDetail, name: privateDetail });
    const diagnostic = catalogFailureDiagnostic(transportFailure(staffOrigin, cause), {
      categoryId: privateDetail,
      phase: representativePhase,
    });
    expect(diagnostic.categoryId).toBe('redacted');
    expect(diagnostic.causeCode).toBeNull();
    expect(diagnostic.causeName).toBeNull();
    expect(JSON.stringify(diagnostic)).not.toContain(privateDetail);
  });
  it('retains a known resolver code without logging its hostname, stack or syscall', () => {
    const cause = new TypeError(privateDetail, {
      cause: Object.assign(new Error(privateDetail), {
        code: 'EAI_AGAIN',
        hostname: privateDetail,
        syscall: 'getaddrinfo',
      }),
    });
    expect(catalogFailureDiagnostic(transportFailure(staffOrigin, cause)).nestedCauseCode).toBe('EAI_AGAIN');
    expect(JSON.stringify(catalogFailureDiagnostic(transportFailure(staffOrigin, cause)))).not.toContain(privateDetail);
  });
  it.effect('logs a failed step once and preserves the original error with no retry or later operation', () =>
    Effect.gen(function* observeFailedStep() {
      const console = yield* TestConsole.make;
      const error = transportFailure(`${staffOrigin}/merchandise-api/reads/records`);
      let attempts = 0;
      let continued = false;
      const failure = yield* Effect.flip(
        catalogStep(
          { categoryId: '433', phase: representativePhase },
          Effect.suspend(() => {
            attempts += 1;
            return Effect.fail(error);
          }),
        ).pipe(
          Effect.andThen(() =>
            Effect.sync(() => {
              continued = true;
            }),
          ),
          Effect.provideService(Console.Console, console),
        ),
      );
      expect(failure).toBe(error);
      expect(attempts).toBe(1);
      expect(continued).toBe(false);
      expect(yield* console.errorLines).toEqual([
        'Catalog diagnostic',
        catalogFailureDiagnostic(error, { categoryId: '433', phase: representativePhase }),
      ]);
    }),
  );
  it.effect('does not log or alter a successful step', () =>
    Effect.gen(function* observeSuccessfulStep() {
      const console = yield* TestConsole.make;
      const value = yield* catalogStep({ categoryId: '433', phase: readPhase }, Effect.succeed(42)).pipe(
        Effect.provideService(Console.Console, console),
      );
      expect(value).toBe(42);
      expect(yield* console.errorLines).toEqual([]);
    }),
  );
});

describe('anonymous category image delivery', () => {
  const origin = shopOrigin;
  const image = '/obrazky/product-16605/photo';
  const photoHeaders = { 'content-type': 'image/jpeg' };
  const check = (respond: (url: URL) => Response) => {
    const requested: string[] = [];
    const signals: AbortSignal[] = [];
    const client = HttpClient.make((request, url, signal) => {
      requested.push(url.href);
      signals.push(signal);
      return Effect.succeed(HttpClientResponse.fromWeb(request, respond(url)));
    });
    return publicImage(origin, image).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.map((delivered) => ({ aborted: signals.map((signal) => signal.aborted), delivered, requested })),
    );
  };
  it.effect('releases the unread image body after checking its headers', () =>
    Effect.gen(function* imageRequestLifetime() {
      const result = yield* check(() => new Response('photo', { headers: photoHeaders, status: 200 }));
      expect(result.delivered).toBe(true);
      expect(result.aborted).toEqual([true]);
    }),
  );
  it.effect('releases every redirect response and the final image body', () =>
    Effect.gen(function* redirectRequestLifetime() {
      const result = yield* check((url) =>
        url.pathname === image
          ? new Response('redirect', { headers: { location: `/cs${image}` }, status: 308 })
          : new Response('photo', { headers: photoHeaders, status: 200 }),
      );
      expect(result.delivered).toBe(true);
      expect(result.aborted).toEqual([true, true]);
    }),
  );
  it.effect('follows the same-origin default-market redirect to the image', () =>
    Effect.gen(function* marketRedirect() {
      const result = yield* check((url) =>
        url.pathname === image
          ? new Response(null, { headers: { location: `${origin}/cs${image}` }, status: 308 })
          : new Response(null, { headers: photoHeaders, status: 200 }),
      );
      expect(result.delivered).toBe(true);
      expect(result.requested).toEqual([`${origin}${image}`, `${origin}/cs${image}`]);
    }),
  );
  it.effect('resolves a relative redirect against its current URL', () =>
    Effect.gen(function* relativeRedirect() {
      const result = yield* check((url) =>
        url.pathname === image
          ? new Response(null, { headers: { location: '/cs/photo' }, status: 307 })
          : new Response(null, { headers: { 'content-type': 'image/webp' }, status: 200 }),
      );
      expect(result.delivered).toBe(true);
      expect(result.requested).toEqual([`${origin}${image}`, `${origin}/cs/photo`]);
    }),
  );
  it.effect('does not request a foreign-origin redirect', () =>
    Effect.gen(function* foreignRedirect() {
      const result = yield* check(
        () => new Response(null, { headers: { location: 'https://foreign.invalid/photo' }, status: 302 }),
      );
      expect(result.delivered).toBe(false);
      expect(result.requested).toEqual([`${origin}${image}`]);
    }),
  );
  it.effect('bounds a same-origin redirect loop', () =>
    Effect.gen(function* redirectLoop() {
      const result = yield* check(() => new Response(null, { headers: { location: image }, status: 308 }));
      expect(result.delivered).toBe(false);
      expect(result.requested).toHaveLength(3);
    }),
  );
  it.effect('rejects a successful HTML response instead of treating it as an image', () =>
    Effect.gen(function* htmlResponse() {
      const result = yield* check(() => new Response(null, { headers: { 'content-type': 'text/html' }, status: 200 }));
      expect(result.delivered).toBe(false);
    }),
  );
  it.effect('rejects an unavailable image', () =>
    Effect.gen(function* missingImage() {
      const result = yield* check(() => new Response(null, { headers: photoHeaders, status: 404 }));
      expect(result.delivered).toBe(false);
    }),
  );
});

describe('photos published twice under different names', () => {
  it('reuses the gallery reference of an identical uploaded photo and lists it once', () => {
    const images = [
      { hash: 'a', source: 'https://src/img-5293.jpg' },
      { hash: 'a', source: 'https://src/img-5293_1.jpg' },
      { hash: 'b', source: 'https://src/other.jpg' },
    ];
    const mapping = new Map([['https://src/img-5293.jpg', 'media:one']]);
    expect(twinReference(images, mapping, images[1] ?? { hash: '' })).toBe('media:one');
    expect(twinReference(images, mapping, images[2] ?? { hash: '' })).toBeUndefined();
    expect(
      galleryOrder([images[0]?.source ?? '', images[1]?.source ?? '', images[2]?.source ?? ''], twinResolve),
    ).toEqual(['media:one', 'media:two']);
  });
});

describe('repeated variant SKUs from the source', () => {
  it('numbers a later repeat so the owner accepts the update, keeping the first and every other SKU', () => {
    const variants = [
      { id: 'item-1', sku: '3dn31028000000025' },
      { id: 'item-2', sku: 'other' },
      { id: 'item-3', sku: '3DN31028000000025 ' },
      { id: 'item-4' },
    ];
    expect(uniqueVariantSkus(variants).map(({ sku }) => sku)).toEqual([
      '3dn31028000000025',
      'other',
      '3DN31028000000025-2',
      undefined,
    ]);
    expect(uniqueVariantSkus([{ sku: 'a' }, { sku: 'b' }])).toEqual([{ sku: 'a' }, { sku: 'b' }]);
  });
});
