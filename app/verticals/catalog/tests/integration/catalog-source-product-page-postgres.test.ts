import { PgClient } from '@effect/sql-pg';
import { Reactivity } from 'effect/reactivity';
import { generateKeyPairSync, sign } from 'node:crypto';

import {
  GatewayAssertionRedemptionService,
  GatewayAssertionReplayError,
  makeContextPermissionRelationshipMutationLive,
} from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeActiveApplicationCompositionLayer } from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { EXTERNAL_GATEWAY_ASSERTION_VERSION } from '@app/shared-contracts';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { HttpApi, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { ConfigProvider, Context, Crypto, DateTime, Effect, Layer, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { ActionPrincipalVerifierLive } from '../../api/auth/action-principal.ts';
import { catalogSourceProductPageReadApiLive } from '../../api/catalog-source-product-page-read-server.ts';
import { createProductActionApiLive } from '../../api/create-product-action-server.ts';
import { catalogApi } from '../../shared/api.ts';
import { CatalogSourceProductPageResponseSchema } from '../../shared/apis/catalog-source-product-page.ts';
import type { CatalogSourceProductPageRequestSchema } from '../../shared/apis/catalog-source-product-page.ts';
import { CreateProductResultSchema } from '../../shared/actions/create-product.ts';
import type { CreateProductPayload } from '../../shared/actions/create-product.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { createProductAction } from '../../src/actions/create-product.action.ts';
import { executeCreateProductWithAuthorization } from '../../src/api/create-product-action-client.ts';
import { catalogRegistration } from '../../vertical.registration.ts';
import { requireExecutionResult } from '../support/action-execution-result.ts';
import { createCatalogDeniedAccess } from '../support/live-access-authority.ts';

const nativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const emptyContext = Context.makeUnsafe<unknown>(new Map());
const source = {
  issuerId: 'page-fixture-ebs-a',
  recordNamespace: 'catalog-product',
  routeScope: 'page-fixture-route',
};
const sourceProducts = [
  { description: 'Blue ONE', name: 'Alpha Widget', recordId: 'rec-a' },
  { name: '100% Cotton', recordId: 'rec-b' },
  { description: String.raw`back\slash`, name: 'Gamma_under', recordId: 'rec-c' },
  { recordId: 'rec-d' },
];

it.live(
  'pages the source products of one scope in record order with a matching total and a literal contains search',
  () =>
    Effect.gen(function* sourceProductPagePostgres() {
      const composition = yield* makeApplicationCompositionSnapshotFixture(
        ['catalog'],
        ultramodernApiMarker.buildMarker,
      );
      const isolated = yield* makeIsolatedNativeDatabaseFixture({
        compositionSnapshot: composition,
        mode: 'schema-only',
        purpose: 'stabilization-1196-product-create',
      });
      const now = Math.floor(DateTime.toEpochMillis(composition.observedAt) / 1000);
      // Only the Catalog owner of the page is under test; the tenant ledger is the real native database.
      yield* Layer.build(
        PgClient.layer({ url: Redacted.make(isolated.connections.admin.connectionString) }).pipe(
          Layer.provideMerge(Reactivity.layer),
        ),
      );
      const fixture = yield* Effect.acquireRelease(
        makeLiveOperationFixture({
          access: 'allowed',
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
      const { tenantId } = fixture;
      const deniedAccess = createCatalogDeniedAccess();
      const accessLayer = fixture.layer.pipe(Layer.provide(deniedAccess.layer));
      const permissions = yield* makeContextPermissionRelationshipMutationLive();
      const principal = { principalId: fixture.manager.principalId, tenantId };
      const targets = [
        { moduleId: 'commerce.catalog', permission: 'module.access' as const },
        { moduleId: 'commerce.catalog', permission: 'commerce.catalog.read.catalog-source-product-page' as const },
      ];
      yield* Effect.forEach(
        targets,
        (target) => permissions.mutate({ operation: 'grant', principal, target, tenantId }),
        { concurrency: 1 },
      );
      yield* Effect.addFinalizer(() =>
        Effect.forEach(targets, (target) => permissions.mutate({ operation: 'revoke', principal, target, tenantId }), {
          concurrency: 1,
        }).pipe(Effect.asVoid, Effect.orDie),
      );
      const keyPair = yield* Effect.sync(() => generateKeyPairSync('ed25519'));
      const kid = 'catalog-source-product-page';
      const tokenIssuer = 'https://disposable-shell.ontos.test';
      const jwks = JSON.stringify({
        keys: [{ ...keyPair.publicKey.export({ format: 'jwk' }), alg: 'EdDSA', kid, use: 'sig' }],
      });
      const authorization = Effect.fn('SourceProductPage.authorization')(function* authorization() {
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
      const api = HttpApi.make('CatalogApi')
        .add(catalogApi.groups.createProductAction)
        .add(catalogApi.groups.catalogSourceProductPage);
      const handlers = Layer.mergeAll(createProductActionApiLive, catalogSourceProductPageReadApiLive).pipe(
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
      const nativeFetch: typeof fetch = (input, init) => app.handler(new Request(input, init), emptyContext);
      const create = Effect.fn('SourceProductPage.create')(function* create(payload: CreateProductPayload) {
        return yield* requireExecutionResult(
          CreateProductResultSchema,
          executeCreateProductWithAuthorization(payload, yield* authorization(), yield* nextId, {
            baseUrl: 'https://catalog.ontos.test',
            compositionRevision: composition.composition.revision,
            idempotencyKey: yield* nextId,
          }).pipe(Effect.provideService(FetchHttpClient.Fetch, nativeFetch)),
        );
      });
      const rawRead = Effect.fn('SourceProductPage.rawRead')(function* rawRead(
        body: typeof CatalogSourceProductPageRequestSchema.Encoded,
      ) {
        const bearer = yield* authorization();
        return yield* Effect.tryPromise(() =>
          app.handler(
            new Request('https://catalog.ontos.test/reads/catalog-source-product-page', {
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
      const page = Effect.fn('SourceProductPage.page')(function* page(
        request: Partial<typeof CatalogSourceProductPageRequestSchema.Encoded>,
      ) {
        const response = yield* rawRead({ ...source, limit: 50, offset: 0, ...request });
        const body = yield* Effect.tryPromise(() => response.json());
        expect(response.status, JSON.stringify(body)).toBe(200);
        const decoded = yield* Schema.decodeUnknownEffect(CatalogSourceProductPageResponseSchema)(body);
        return { count: decoded.count, recordIds: decoded.items.map((item) => item.source.recordId) };
      });

      for (const { recordId, ...facts } of sourceProducts) {
        yield* create({
          ...facts,
          sourceCorrelation: { ...source, mappingRevision: 'page-v1', recordId, sourceOccurrenceId: `occ-${recordId}` },
        });
      }
      // Same record key in another issuer, and a Product with no source at all: neither belongs to the page.
      yield* create({
        name: 'Alpha elsewhere',
        sourceCorrelation: {
          ...source,
          issuerId: 'page-fixture-ebs-b',
          mappingRevision: 'page-v1',
          recordId: 'rec-a',
          sourceOccurrenceId: 'occ-other-issuer',
        },
      });
      yield* create({ name: 'Alpha without a source' });

      // Order is the ascending source record id; count is the total before paging.
      expect(yield* page({})).toEqual({ count: 4, recordIds: ['rec-a', 'rec-b', 'rec-c', 'rec-d'] });
      expect(yield* page({ limit: 2 })).toEqual({ count: 4, recordIds: ['rec-a', 'rec-b'] });
      expect(yield* page({ limit: 2, offset: 2 })).toEqual({ count: 4, recordIds: ['rec-c', 'rec-d'] });
      expect(yield* page({ limit: 1, offset: 1 })).toEqual({ count: 4, recordIds: ['rec-b'] });
      expect(yield* page({ offset: 3 })).toEqual({ count: 4, recordIds: ['rec-d'] });
      expect(yield* page({ offset: 4 })).toEqual({ count: 4, recordIds: [] });
      expect(yield* page({ offset: 100 })).toEqual({ count: 4, recordIds: [] });

      // Search is a case-insensitive contains over the name or the description, and the count follows it.
      expect(yield* page({ search: 'alpha' })).toEqual({ count: 1, recordIds: ['rec-a'] });
      expect(yield* page({ search: 'WIDGET' })).toEqual({ count: 1, recordIds: ['rec-a'] });
      expect(yield* page({ search: 'blue one' })).toEqual({ count: 1, recordIds: ['rec-a'] });
      expect(yield* page({ search: 'n' })).toEqual({ count: 3, recordIds: ['rec-a', 'rec-b', 'rec-c'] });
      expect(yield* page({ limit: 1, offset: 1, search: 'n' })).toEqual({ count: 3, recordIds: ['rec-b'] });
      expect(yield* page({ offset: 3, search: 'n' })).toEqual({ count: 3, recordIds: [] });
      expect(yield* page({ search: 'missing' })).toEqual({ count: 0, recordIds: [] });
      // A Product with neither a name nor a description never matches a search, and is still in the unfiltered page.
      for (const search of ['rec-d', 'd', 'a', 'e']) {
        expect((yield* page({ search })).recordIds).not.toContain('rec-d');
      }
      // `%`, `_` and `\` are ordinary characters.
      expect(yield* page({ search: '%' })).toEqual({ count: 1, recordIds: ['rec-b'] });
      expect(yield* page({ search: '_' })).toEqual({ count: 1, recordIds: ['rec-c'] });
      expect(yield* page({ search: '\\' })).toEqual({ count: 1, recordIds: ['rec-c'] });
      expect(yield* page({ search: '%ot' })).toEqual({ count: 0, recordIds: [] });
      expect(yield* page({ search: String.raw`back\s` })).toEqual({ count: 1, recordIds: ['rec-c'] });
      expect(yield* page({ search: '100%' })).toEqual({ count: 1, recordIds: ['rec-b'] });
      expect(yield* page({ issuerId: 'page-fixture-ebs-b', search: 'alpha' })).toEqual({
        count: 1,
        recordIds: ['rec-a'],
      });
      expect(yield* page({ issuerId: 'page-fixture-ebs-c' })).toEqual({ count: 0, recordIds: [] });

      // Out-of-range paging and an empty search are refused by the request schema.
      for (const bad of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { search: '' }, { search: 'x'.repeat(201) }]) {
        expect((yield* rawRead({ ...source, limit: 50, offset: 0, ...bad })).status).toBe(400);
      }
      deniedAccess.deny(fixture.manager.principalId, 'commerce.catalog.catalog-source-product-page.read');
      expect((yield* rawRead({ ...source, limit: 50, offset: 0 })).status).toBe(403);
    }).pipe(Effect.provide(nativeServices)),
  120_000,
);
