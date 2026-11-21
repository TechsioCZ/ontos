import { PgClient } from '@effect/sql-pg';
import { Reactivity } from 'effect/reactivity';
import { generateKeyPairSync, sign } from 'node:crypto';

import {
  GatewayAssertionRedemptionService,
  GatewayAssertionReplayError,
  makeContextPermissionRelationshipMutationLive,
} from '@app/core-runtime';
import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeActiveApplicationCompositionLayer } from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { EXTERNAL_GATEWAY_ASSERTION_VERSION } from '@app/shared-contracts';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { HttpApi, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { and, eq } from 'drizzle-orm';
import { ConfigProvider, Context, Crypto, DateTime, Effect, Layer, Match, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { ActionPrincipalVerifierLive } from '../../api/auth/action-principal.ts';
import { createProductActionApiLive } from '../../api/create-product-action-server.ts';
import { productPageReadApiLive } from '../../api/product-page-read-server.ts';
import { catalogApi } from '../../shared/api.ts';
import { CreateProductResultSchema } from '../../shared/actions/create-product.ts';
import type { CreateProductPayload } from '../../shared/actions/create-product.ts';
import { ProductPageResponseSchema } from '../../shared/apis/product-page.ts';
import type { ProductPageRequestSchema } from '../../shared/apis/product-page.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { createProductAction } from '../../src/actions/create-product.action.ts';
import { executeCreateProductWithAuthorization } from '../../src/api/create-product-action-client.ts';
import {
  productLifecycleEvents,
  productLocalizedFactRevisions,
  productLocalizedFacts,
  productRevisions,
  products,
  productVariantAxisEvents,
  productVariantRevisions,
  productVariants,
  variantLocalizedFactRevisions,
  variantLocalizedFacts,
} from '../../src/database/schema.ts';
import { categoryPersistenceForScope } from '../../src/persistence/category-persistence.ts';
import { skuPersistenceForScope } from '../../src/persistence/sku-persistence.ts';
import { axisFreeCombinationKey } from '../../src/persistence/variant-current-basis.ts';
import { catalogRegistration } from '../../vertical.registration.ts';
import { requireExecutionResult } from '../support/action-execution-result.ts';
import { createCatalogDeniedAccess } from '../support/live-access-authority.ts';

const nativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const emptyContext = Context.makeUnsafe<unknown>(new Map());
const pageCapability = 'commerce.catalog.product-page.read';
const detailCapability = 'commerce.catalog.product-detail.read';
const createCapability = 'commerce.catalog.product.create';
const setupReason = 'Product page fixture: explicit test setup, never a source activation decision';
const setupEvidence = ['test:catalog-product-page-postgres'];

interface Text {
  readonly description?: string;
  readonly locale: string;
  readonly name: string;
}

/**
 * Sanctioned test setup of an ACTIVE axis-free Product, row for row as the pricing readiness fixture writes it:
 * the Catalog has no single Action that activates a Product, and these rows are the facts activation leaves.
 */
const activate = Effect.fn('ProductPagePostgres.activate')(function* activate(
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  at: Date,
  ids: { readonly productId: string; readonly variantId: string },
  texts: readonly Text[],
) {
  const { principalId: actingPrincipalId, tenantId } = scope;
  const evidence = (actionInvocationId: string) => ({
    actingPrincipalId,
    actionInvocationId,
    evidenceRefs: setupEvidence,
    reason: setupReason,
    tenantId,
  });
  const combinationKey = axisFreeCombinationKey();
  yield* transaction.insert(productVariantAxisEvents).values({
    ...evidence(yield* nextId),
    attributeDefinitionIds: [],
    attributeDefinitionRevisions: [],
    axisRevision: 1,
    productId: ids.productId,
  });
  yield* transaction
    .update(productVariants)
    .set({ combinationAxisRevision: 1, combinationKey, currentRevision: 2, lifecycleState: 'ACTIVE', updatedAt: at })
    .where(and(eq(productVariants.tenantId, tenantId), eq(productVariants.variantId, ids.variantId)));
  yield* transaction.insert(productVariantRevisions).values({
    ...evidence(yield* nextId),
    changeKind: 'LIFECYCLE',
    combinationAxisRevision: 1,
    combinationKey,
    lifecycleState: 'ACTIVE',
    productId: ids.productId,
    revision: 2,
    variantId: ids.variantId,
  });
  for (const text of texts) {
    const facts = { description: text.description ?? null, locale: text.locale, name: text.name };
    yield* transaction
      .insert(productLocalizedFacts)
      .values({ ...facts, currentRevision: 1, productId: ids.productId, state: 'SET', tenantId });
    yield* transaction
      .insert(productLocalizedFactRevisions)
      .values({ ...evidence(yield* nextId), ...facts, productId: ids.productId, revision: 1, state: 'SET' });
  }
  const [created] = yield* transaction
    .update(products)
    .set({ currentRevision: 2, lifecycleState: 'ACTIVE', updatedAt: at })
    .where(and(eq(products.tenantId, tenantId), eq(products.productId, ids.productId)))
    .returning();
  yield* transaction.insert(productRevisions).values({
    ...evidence(yield* nextId),
    changeKind: 'LIFECYCLE',
    description: created?.description ?? null,
    lifecycleState: 'ACTIVE',
    name: created?.name ?? null,
    productId: ids.productId,
    revision: 2,
  });
  yield* transaction.insert(productLifecycleEvents).values({
    ...evidence(yield* nextId),
    effectiveAt: at,
    event: 'ACTIVATED',
    productId: ids.productId,
  });
});

/** The variant text the Symmy import writes through set-variant-localized-facts, row for row. */
const setVariantText = Effect.fn('ProductPagePostgres.setVariantText')(function* setVariantText(
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  ids: { readonly productId: string; readonly variantId: string },
  text: Text,
) {
  const facts = { description: text.description ?? null, locale: text.locale, name: text.name };
  const keys = { productId: ids.productId, tenantId: scope.tenantId, variantId: ids.variantId };
  yield* transaction.insert(variantLocalizedFacts).values({ ...facts, ...keys, currentRevision: 1, state: 'SET' });
  yield* transaction.insert(variantLocalizedFactRevisions).values({
    ...facts,
    ...keys,
    actingPrincipalId: scope.principalId,
    actionInvocationId: yield* nextId,
    evidenceRefs: setupEvidence,
    reason: setupReason,
    revision: 1,
    state: 'SET',
  });
});

const ids = (result: { readonly items: readonly { readonly productRef: { readonly resourceId: string } }[] }) =>
  result.items.map(({ productRef }) => productRef.resourceId);

it.live(
  'pages the sellable Catalog of one Tenant by localized name with Categories, SKU, lifecycle and access',
  () =>
    Effect.gen(function* productPagePostgres() {
      const composition = yield* makeApplicationCompositionSnapshotFixture(
        ['catalog'],
        ultramodernApiMarker.buildMarker,
      );
      const isolated = yield* makeIsolatedNativeDatabaseFixture({
        compositionSnapshot: composition,
        mode: 'schema-only',
        purpose: 'stabilization-1262-catalog-public-reads',
      });
      // The composition's observation instant is this suite's clock, for its assertions and its setup rows alike.
      const now = Math.floor(DateTime.toEpochMillis(composition.observedAt) / 1000);
      const at = DateTime.toDateUtc(composition.observedAt);
      yield* Layer.build(
        PgClient.layer({ url: Redacted.make(isolated.connections.admin.connectionString) }).pipe(
          Layer.provideMerge(Reactivity.layer),
        ),
      );
      const fixtureOf = (access: Readonly<Record<string, 'allowed'>>) =>
        Effect.acquireRelease(
          makeLiveOperationFixture({
            access,
            actionKeys: [createProductAction.descriptor.actionKey],
            adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
            allowedAudiences: ['catalog'],
            authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
            compositionRevision: composition.composition.revision,
            moduleKeys: ['commerce.catalog'],
            ownerRegistration: catalogRegistration,
            runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
          }),
          (value) => value.close().pipe(Effect.orDie),
        );
      // Tenant A's staff may read any Product detail; Tenant B's staff may page the Catalog only.
      const staff = yield* fixtureOf({
        [createCapability]: 'allowed',
        [detailCapability]: 'allowed',
        [pageCapability]: 'allowed',
      });
      const pageOnly = yield* fixtureOf({ [createCapability]: 'allowed', [pageCapability]: 'allowed' });
      const permissions = yield* makeContextPermissionRelationshipMutationLive();
      for (const fixture of [staff, pageOnly]) {
        const principal = { principalId: fixture.manager.principalId, tenantId: fixture.tenantId };
        const targets = [
          { moduleId: 'commerce.catalog', permission: 'module.access' as const },
          { moduleId: 'commerce.catalog', permission: 'commerce.catalog.read.product-page' as const },
        ];
        yield* Effect.forEach(
          targets,
          (target) => permissions.mutate({ operation: 'grant', principal, target, tenantId: fixture.tenantId }),
          { concurrency: 1 },
        );
        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            targets,
            (target) => permissions.mutate({ operation: 'revoke', principal, target, tenantId: fixture.tenantId }),
            { concurrency: 1 },
          ).pipe(Effect.asVoid, Effect.orDie),
        );
      }
      const keyPair = yield* Effect.sync(() => generateKeyPairSync('ed25519'));
      const kid = 'catalog-product-page';
      const tokenIssuer = 'https://disposable-shell.ontos.test';
      const jwks = JSON.stringify({
        keys: [{ ...keyPair.publicKey.export({ format: 'jwk' }), alg: 'EdDSA', kid, use: 'sig' }],
      });
      const redeemed = new Set<string>();
      const redemption = Layer.succeed(GatewayAssertionRedemptionService, {
        consume: ({ jti }) =>
          Effect.suspend(() => {
            if (redeemed.has(jti)) {
              return Effect.fail(new GatewayAssertionReplayError({ reason: 'Assertion already redeemed' }));
            }
            redeemed.add(jti);
            return Effect.void;
          }),
      });
      /** One Catalog BFF over one fixture's gate, with its own per-principal refusals. */
      const catalogFor = Effect.fn('ProductPagePostgres.catalogFor')(function* catalogFor(fixture: typeof staff) {
        const deniedAccess = createCatalogDeniedAccess();
        const accessLayer = fixture.layer.pipe(Layer.provide(deniedAccess.layer));
        const api = HttpApi.make('CatalogApi')
          .add(catalogApi.groups.createProductAction)
          .add(catalogApi.groups.productPage);
        const handlers = Layer.mergeAll(createProductActionApiLive, productPageReadApiLive).pipe(
          Layer.provide(
            Layer.mergeAll(
              ActionPrincipalVerifierLive,
              makeActiveApplicationCompositionLayer(Effect.succeed(composition)),
            ).pipe(Layer.provide(ActiveApplicationCompositionSourceLive), Layer.provide(FetchHttpClient.layer)),
          ),
          Layer.provide(redemption),
          Layer.provide(accessLayer),
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({ ONTOS_GATEWAY_ISSUER: tokenIssuer, ONTOS_GATEWAY_PUBLIC_JWKS: jwks }),
            ),
          ),
        );
        const app = yield* Effect.acquireRelease(
          Effect.sync(() =>
            HttpRouter.toWebHandler(
              HttpApiBuilder.layer(api).pipe(
                Layer.provide(handlers),
                Layer.provideMerge(accessLayer),
                Layer.provide(HttpServer.layerServices),
                Layer.provide(NodeCrypto.layer),
              ),
              { disableLogger: true },
            ),
          ),
          (value) => Effect.promise(value.dispose.bind(value)).pipe(Effect.orDie),
        );
        const authorization = Effect.fn('ProductPagePostgres.authorization')(function* authorization() {
          const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid, typ: 'JWT' })).toString('base64url');
          const payload = Buffer.from(
            JSON.stringify({
              aud: 'catalog',
              compositionRevision: composition.composition.revision,
              exp: now + 300,
              iat: now,
              iss: tokenIssuer,
              jti: yield* nextId,
              principal: fixture.manager,
              sub: fixture.manager.principalId,
              targetBuildMarker: ultramodernApiMarker.buildMarker,
              ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
            }),
          ).toString('base64url');
          const content = `${header}.${payload}`;
          return `Bearer ${content}.${sign(null, Buffer.from(content), keyPair.privateKey).toString('base64url')}`;
        });
        const nativeFetch: typeof fetch = (input, init) => app.handler(new Request(input, init), emptyContext);
        const create = Effect.fn('ProductPagePostgres.create')(function* create(payload: CreateProductPayload) {
          const result = yield* requireExecutionResult(
            CreateProductResultSchema,
            executeCreateProductWithAuthorization(payload, yield* authorization(), yield* nextId, {
              baseUrl: 'https://catalog.ontos.test',
              compositionRevision: composition.composition.revision,
              idempotencyKey: yield* nextId,
            }).pipe(Effect.provideService(FetchHttpClient.Fetch, nativeFetch)),
          );
          const [variant] = result.product.variants;
          expect(result.product.lifecycle).toBe('DRAFT');
          expect(variant?.lifecycle).toBe('WORK_IN_PROGRESS');
          return { productId: result.product.productRef.resourceId, variantId: variant?.variantId ?? '' };
        });
        const rawRead = Effect.fn('ProductPagePostgres.rawRead')(function* rawRead(
          body: typeof ProductPageRequestSchema.Encoded,
        ) {
          const bearer = yield* authorization();
          return yield* Effect.tryPromise(() =>
            app.handler(
              new Request('https://catalog.ontos.test/reads/product-page', {
                body: JSON.stringify(body),
                headers: {
                  authorization: bearer,
                  'content-type': 'application/json',
                  'x-correlation-id': crypto.randomUUID(),
                },
                method: 'POST',
              }),
              emptyContext,
            ),
          );
        });
        const read = (request: Partial<typeof ProductPageRequestSchema.Encoded>) =>
          rawRead({ lifecycles: ['ACTIVE'], limit: 50, locale: 'cs-CZ', offset: 0, ...request });
        const page = Effect.fn('ProductPagePostgres.page')(function* page(
          request: Partial<typeof ProductPageRequestSchema.Encoded>,
        ) {
          const response = yield* read(request);
          const body = yield* Effect.tryPromise(() => response.json());
          expect(response.status, JSON.stringify(body)).toBe(200);
          return yield* Schema.decodeUnknownEffect(ProductPageResponseSchema)(body);
        });
        const status = (request: Partial<typeof ProductPageRequestSchema.Encoded>) =>
          read(request).pipe(Effect.map((response) => response.status));
        return { create, deniedAccess, page, status };
      });
      const tenantA = yield* catalogFor(staff);
      const tenantB = yield* catalogFor(pageOnly);

      // As Symmy imports it: a DRAFT Product with a WORK_IN_PROGRESS Variant, its name only in the legacy column
      // and its text on the Variant. The other Products are activated; Delta has a name in English only.
      const imported = yield* tenantA.create({ description: 'Ze Symmy', name: 'Kladivo import' });
      const alfa = yield* tenantA.create({ name: 'alfa legacy' });
      const beta = yield* tenantA.create({ name: 'beta legacy' });
      const delta = yield* tenantA.create({ name: 'delta legacy' });
      const foreign = yield* tenantB.create({ name: 'alfa b legacy' });
      const categoryId = yield* nextId;
      yield* staff
        .prepareOwner((transaction, scope) =>
          Effect.gen(function* seedTenantA() {
            yield* setVariantText(transaction, scope, imported, {
              description: 'Ocelové kladivo',
              locale: 'cs-CZ',
              name: 'Kladivo 500 g',
            });
            yield* activate(transaction, scope, at, alfa, [
              { locale: 'cs-CZ', name: 'Alfa' },
              { locale: 'en', name: 'Alpha' },
            ]);
            yield* activate(transaction, scope, at, beta, [
              { description: 'Popis bety', locale: 'cs-CZ', name: 'Beta' },
            ]);
            yield* activate(transaction, scope, at, delta, [{ locale: 'en', name: 'Delta' }]);
            const categories = yield* categoryPersistenceForScope(transaction, scope);
            const base = { principalId: scope.principalId, reason: setupReason, tenantId: scope.tenantId };
            const created = yield* categories.createCategory({
              ...base,
              actionInvocationId: yield* nextId,
              categoryId,
              name: 'Ruční nářadí',
            });
            expect(
              Match.value(created).pipe(
                Match.tag('created', () => true),
                Match.orElse(() => false),
              ),
            ).toBe(true);
            for (const product of [imported, alfa]) {
              const added = yield* categories.addAssignment({
                ...base,
                actionInvocationId: yield* nextId,
                categoryId,
                productId: product.productId,
              });
              expect(
                Match.value(added).pipe(
                  Match.tag('added', () => true),
                  Match.orElse(() => false),
                ),
              ).toBe(true);
            }
            const sku = yield* skuPersistenceForScope(transaction, scope).assign({
              actionInvocationId: yield* nextId,
              code: 'ALFA-1',
              evidenceRefs: setupEvidence,
              expectedRevision: 0,
              principalId: scope.principalId,
              reason: setupReason,
              target: { kind: 'VARIANT', tenantId: scope.tenantId, variantId: alfa.variantId },
            });
            expect(
              Match.value(sku).pipe(
                Match.tag('applied', () => true),
                Match.orElse(() => false),
              ),
            ).toBe(true);
          }),
        )
        .pipe(Effect.provide(staff.layer));
      yield* pageOnly
        .prepareOwner((transaction, scope) =>
          activate(transaction, scope, at, foreign, [{ locale: 'cs-CZ', name: 'Alfa B' }]),
        )
        .pipe(Effect.provide(pageOnly.layer));

      // ACTIVE only, by the name in the locale and Products without one last; count is the total before paging.
      const activePage = yield* tenantA.page({});
      expect({ count: activePage.count, ids: ids(activePage) }).toEqual({
        count: 3,
        ids: [alfa.productId, beta.productId, delta.productId],
      });
      expect(ids(yield* tenantA.page({ limit: 2 }))).toEqual([alfa.productId, beta.productId]);
      const tail = yield* tenantA.page({ limit: 2, offset: 2 });
      expect({ count: tail.count, ids: ids(tail) }).toEqual({ count: 3, ids: [delta.productId] });
      expect(yield* tenantA.page({ offset: 3 })).toEqual({ count: 3, items: [] });
      expect(ids(yield* tenantA.page({ locale: 'en' }))).toEqual([alfa.productId, delta.productId, beta.productId]);

      // The text as the detail read answers it: no other locale stands in for a missing one.
      const [alfaItem, betaItem, deltaItem] = activePage.items;
      expect(alfaItem).toMatchObject({
        categories: [{ categoryRef: { resourceId: categoryId, tenantId: staff.tenantId }, name: 'Ruční nářadí' }],
        lifecycle: 'ACTIVE',
        localized: { kind: 'PRESENT', locale: 'cs-CZ', name: 'Alfa' },
        media: [],
        revision: 2,
        variants: [
          {
            lifecycle: 'ACTIVE',
            localized: { kind: 'MISSING_TRANSLATION', requestedLocale: 'cs-CZ' },
            options: [],
            sku: 'ALFA-1',
            variantRef: {
              moduleId: 'commerce.catalog',
              resourceId: alfa.variantId,
              resourceType: 'commerce.catalog.variant',
              tenantId: staff.tenantId,
            },
          },
        ],
      });
      // No Category and no media: both are empty, never invented.
      expect(betaItem).toMatchObject({
        categories: [],
        localized: { description: 'Popis bety', kind: 'PRESENT', locale: 'cs-CZ', name: 'Beta' },
        media: [],
      });
      expect(betaItem?.variants[0]).not.toHaveProperty('sku');
      expect(deltaItem?.localized).toEqual({ kind: 'MISSING_TRANSLATION', requestedLocale: 'cs-CZ' });

      // Search is a literal contains over the name in the locale; the legacy name the import writes is no shop name.
      const searched = yield* tenantA.page({ search: 'ALF' });
      expect({ count: searched.count, ids: ids(searched) }).toEqual({ count: 1, ids: [alfa.productId] });
      expect(ids(yield* tenantA.page({ locale: 'en', search: 'pha' }))).toEqual([alfa.productId]);
      expect(yield* tenantA.page({ search: 'delta' })).toEqual({ count: 0, items: [] });
      expect(yield* tenantA.page({ lifecycles: ['ACTIVE', 'DRAFT'], search: 'kladivo' })).toEqual({
        count: 0,
        items: [],
      });

      // An imported Product is a DRAFT: staff who may read any Product detail see it, with its Variant text.
      const category = {
        moduleId: 'commerce.catalog',
        resourceId: categoryId,
        resourceType: 'commerce.catalog.product-category',
        tenantId: staff.tenantId,
      } as const;
      const drafts = yield* tenantA.page({ lifecycles: ['DRAFT'] });
      expect(ids(drafts)).toEqual([imported.productId]);
      expect(drafts.items[0]).toMatchObject({
        categories: [{ name: 'Ruční nářadí' }],
        lifecycle: 'DRAFT',
        localized: { kind: 'MISSING_TRANSLATION', requestedLocale: 'cs-CZ' },
        variants: [
          {
            lifecycle: 'WORK_IN_PROGRESS',
            localized: { description: 'Ocelové kladivo', kind: 'PRESENT', locale: 'cs-CZ', name: 'Kladivo 500 g' },
            options: [],
          },
        ],
      });
      expect(ids(yield* tenantA.page({ categoryRef: category }))).toEqual([alfa.productId]);
      const inCategory = yield* tenantA.page({ categoryRef: category, lifecycles: ['ACTIVE', 'DRAFT'] });
      expect({ count: inCategory.count, ids: ids(inCategory) }).toEqual({
        count: 2,
        ids: [alfa.productId, imported.productId],
      });
      expect(yield* tenantA.page({ categoryRef: category, lifecycles: ['RETIRED'] })).toEqual({ count: 0, items: [] });

      // Tenant isolation: each Tenant pages only its own Products, and a Category of another Tenant is unknown.
      expect(ids(yield* tenantB.page({}))).toEqual([foreign.productId]);
      expect(yield* tenantB.status({ categoryRef: category })).toBe(404);
      expect(ids(yield* tenantA.page({ search: 'alfa b' }))).toEqual([]);

      // Demo-line rule: staff who may not read any Product detail page DRAFT and ACTIVE, as the storefront does,
      // because imported Products stay DRAFTs; only RETIRED is refused to them.
      const importedB = yield* tenantB.create({ name: 'import b legacy' });
      const unprivileged = yield* tenantB.page({ lifecycles: ['DRAFT', 'ACTIVE'] });
      expect({ count: unprivileged.count, ids: ids(unprivileged) }).toEqual({
        count: 2,
        ids: [foreign.productId, importedB.productId],
      });
      expect(unprivileged.items[1]).toMatchObject({
        lifecycle: 'DRAFT',
        variants: [{ lifecycle: 'WORK_IN_PROGRESS', options: [] }],
      });
      expect(yield* tenantB.status({ lifecycles: ['RETIRED'] })).toBe(403);
      expect(yield* tenantB.status({ lifecycles: ['ACTIVE', 'RETIRED'] })).toBe(403);

      // Out-of-range paging, a repeated or missing state and an empty search are refused by the request schema.
      const badRequests: readonly Partial<typeof ProductPageRequestSchema.Encoded>[] = [
        { limit: 0 },
        { limit: 101 },
        { offset: -1 },
        { lifecycles: [] },
        { lifecycles: ['ACTIVE', 'ACTIVE'] },
        { search: '' },
      ];
      for (const bad of badRequests) {
        expect(yield* tenantA.status(bad)).toBe(400);
      }
      // A staff member without the capability is refused.
      tenantA.deniedAccess.deny(staff.manager.principalId, pageCapability);
      expect(yield* tenantA.status({})).toBe(403);
    }).pipe(Effect.provide(nativeServices)),
  180_000,
);
