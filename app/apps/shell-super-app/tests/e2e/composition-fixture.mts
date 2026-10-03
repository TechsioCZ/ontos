#!/usr/bin/env node
import { createServer } from 'node:http';
import path from 'node:path';

import { NodeHttpServer, NodeRuntime, NodeServices } from '@effect/platform-node';
import { resolveUltramodernReleaseIdentity } from '@modern-js/app-tools-extensions/release-identity';
import { and, eq } from 'drizzle-orm';
import { Config, Context, DateTime, Duration, Effect, FileSystem, Layer, Redacted, Schema, Scope } from 'effect';
import { FetchHttpClient, HttpClient, HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http';

import { parseDatabaseConnectionPair } from '../../../../packages/core-runtime/src/db/config.ts';
import { CoreDatabase } from '../../../../packages/core-runtime/src/db/client.ts';
import { applicationCompositionAuthority } from '../../../../packages/core-runtime/src/db/schema.ts';
import { validateActiveApplicationCompositionSnapshot } from '../../../../packages/core-runtime/src/modules/active-application-composition.ts';
import {
  lockApplicationCompositionPublication,
  publishApplicationCompositionAuthority,
} from '../../../../packages/core-runtime/src/modules/application-composition-authority.ts';
import { isLoopbackHostname } from '../../../../packages/core-runtime/src/modules/application-composition-backend.ts';
import {
  ONTOS_SHELL_RUNTIME_CONTRACT_PATH,
  OntosShellRuntimeContractSchema,
} from '../../../../packages/core-runtime/src/modules/application-composition.ts';
import { ONTOS_MODULE_CONTRACT_PATH } from '../../../../packages/core-runtime/src/modules/manifest.ts';
import {
  ARTIFACT_FETCH_TIMEOUT,
  deriveActiveApplicationCompositionSnapshot,
  encodeActiveApplicationCompositionSnapshot,
} from '../../../../scripts/active-application-composition.mts';
import { ApplicationCompositionAuthorityAdminDatabaseLive } from '../../../../scripts/application-composition-authority-publication.mts';
import { createShellRuntimeContract } from '../../../../scripts/generate-ontos-shell-runtime-contract.mts';

class BrowserCompositionFixtureError extends Schema.TaggedError<BrowserCompositionFixtureError>()(
  'BrowserCompositionFixtureError',
  { reason: Schema.String },
) {}

const fail = (reason: string) => new BrowserCompositionFixtureError({ reason });
const portSchema = Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ maximum: 65_535, minimum: 1 }));
const topologySchema = Schema.fromJsonString(
  Schema.Struct({
    shell: Schema.Struct({
      deliveryUnit: Schema.Struct({
        buildMarker: Schema.NonEmptyString,
        unitId: Schema.Literal('app/shell-super-app'),
      }),
      id: Schema.Literal('shell-super-app'),
    }),
  }),
);
const shellContractJson = Schema.fromJsonString(OntosShellRuntimeContractSchema, { space: 2 });

// These are exactly the two native owners started by this browser test topology.
const ownerOrigins = [
  { appId: 'party-registry', baseUrl: 'http://127.0.0.1:4102/' },
  { appId: 'inventory', baseUrl: 'http://127.0.0.1:4110/' },
] as const;

const browserCompositionFixture = Effect.gen(function* serveBrowserComposition() {
  const shellPort = yield* Config.schema(portSchema, 'SHELL_SUPER_APP_PORT').pipe(Config.withDefault(3020));
  const compositionPort = yield* Config.schema(portSchema, 'SHELL_E2E_COMPOSITION_PORT').pipe(Config.withDefault(3021));
  if (new Set([shellPort, compositionPort, 4102, 4110]).size !== 4) {
    return yield* fail('The browser topology requires four distinct native server ports');
  }
  const shellOrigin = `http://127.0.0.1:${shellPort}`;
  const compositionOrigin = `http://127.0.0.1:${compositionPort}`;
  const [runtimeUrl, adminUrl] = yield* Effect.all([
    Config.Redacted('DATABASE_URL'),
    Config.Redacted('DATABASE_ADMIN_URL'),
  ]);
  const connections = yield* parseDatabaseConnectionPair({
    DATABASE_ADMIN_URL: Redacted.value(adminUrl),
    DATABASE_URL: Redacted.value(runtimeUrl),
  });
  if (
    !isLoopbackHostname(connections.admin.host) ||
    !isLoopbackHostname(connections.runtime.host) ||
    connections.admin.database !== connections.runtime.database ||
    connections.admin.port !== connections.runtime.port
  ) {
    return yield* fail('Browser composition fixtures require one explicit local administrative and runtime database');
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const workspaceRoot = path.resolve(import.meta.dirname, '../../../..');
  const { shell } = yield* Schema.decodeEffect(topologySchema)(
    yield* fileSystem.readFileString(path.join(workspaceRoot, 'topology/reference-topology.json')),
  );
  const { buildMarker } = yield* Effect.try({
    catch: () => fail('The browser Shell must have a genuine native deployment identity'),
    try: () =>
      resolveUltramodernReleaseIdentity({
        generationBuildMarker: shell.deliveryUnit.buildMarker,
        unitId: shell.deliveryUnit.unitId,
        workspaceRoot,
      }),
  });
  const shellContract = `${yield* Schema.encodeEffect(shellContractJson)(createShellRuntimeContract(buildMarker))}\n`;
  const client = HttpClient.withScope(yield* HttpClient.HttpClient);
  const observe = (url: string) =>
    Effect.gen(function* observeNativeArtifact() {
      const response = yield* client.get(url, { headers: { 'cache-control': 'no-cache' } });
      if (response.status !== 200) {
        return yield* fail(`The browser topology artifact ${url} returned HTTP ${response.status}`);
      }
      return { bytes: new Uint8Array(yield* response.arrayBuffer), url };
    }).pipe(Effect.scoped, Effect.timeout(ARTIFACT_FETCH_TIMEOUT));
  const modules = yield* Effect.forEach(
    ownerOrigins,
    ({ appId, baseUrl }) =>
      Effect.gen(function* observeNativeOwner() {
        return {
          appId,
          backend: { baseUrl, transport: 'node-http' as const },
          contract: yield* observe(new URL(ONTOS_MODULE_CONTRACT_PATH, baseUrl).href),
          federationManifest: yield* observe(new URL('/mf-manifest.json', baseUrl).href),
        };
      }),
    { concurrency: 1 },
  );
  const snapshot = yield* deriveActiveApplicationCompositionSnapshot({
    environment: 'development',
    modules,
    observedAt: yield* DateTime.now,
    shell: {
      federationManifest: yield* observe(`${shellOrigin}/mf-manifest.json`),
      runtimeContract: {
        bytes: new TextEncoder().encode(shellContract),
        url: `${compositionOrigin}${ONTOS_SHELL_RUNTIME_CONTRACT_PATH}`,
      },
    },
    validity: Duration.minutes(30),
  });
  const approved = yield* validateActiveApplicationCompositionSnapshot(snapshot);
  const encoded = yield* encodeActiveApplicationCompositionSnapshot(approved);
  // Keep the native admin pool's scope open until the authority finalizer has finished.
  const databaseScope = yield* Scope.make();
  yield* Effect.addFinalizer((exit) => Scope.close(databaseScope, exit));
  const databaseServices = yield* Layer.build(ApplicationCompositionAuthorityAdminDatabaseLive).pipe(
    Scope.provide(databaseScope),
  );
  const database = Context.get(databaseServices, CoreDatabase).executor;
  yield* Effect.acquireRelease(
    database.transaction((transaction) =>
      Effect.gen(function* publishBrowserAuthority() {
        yield* lockApplicationCompositionPublication(transaction);
        const existing = yield* transaction.select().from(applicationCompositionAuthority);
        if (existing.length !== 0) {
          return yield* fail('The browser fixture requires an empty native composition authority');
        }
        return yield* publishApplicationCompositionAuthority(transaction, approved);
      }),
    ),
    () =>
      database
        .transaction((transaction) =>
          Effect.gen(function* cleanupBrowserAuthority() {
            yield* lockApplicationCompositionPublication(transaction);
            const existing = yield* transaction.select().from(applicationCompositionAuthority);
            const [current] = existing;
            if (existing.length === 0) {
              return yield* Effect.void;
            }
            if (
              existing.length !== 1 ||
              current?.revision !== approved.composition.revision ||
              current.validUntil.getTime() !== DateTime.toEpochMillis(approved.validUntil) ||
              current.phase !== 'active' ||
              current.durableWorkAdmission !== 'open'
            ) {
              return yield* fail('The browser fixture no longer owns the native composition authority');
            }
            yield* transaction
              .delete(applicationCompositionAuthority)
              .where(
                and(
                  eq(applicationCompositionAuthority.authorityKey, 'active'),
                  eq(applicationCompositionAuthority.revision, approved.composition.revision),
                  eq(applicationCompositionAuthority.validUntil, DateTime.toDateUtc(approved.validUntil)),
                  eq(applicationCompositionAuthority.phase, 'active'),
                  eq(applicationCompositionAuthority.durableWorkAdmission, 'open'),
                ),
              );
            return yield* Effect.void;
          }),
        )
        .pipe(Effect.orDie),
  );
  yield* Layer.build(NodeHttpServer.layer(createServer, { host: '127.0.0.1', port: compositionPort })).pipe(
    Effect.flatMap((services) =>
      HttpServer.serveEffect(
        Effect.gen(function* serveFixtureArtifact() {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.method !== 'GET') {
            return HttpServerResponse.empty({ status: 405 });
          }
          if (request.url === '/active' || request.url === ONTOS_SHELL_RUNTIME_CONTRACT_PATH) {
            return HttpServerResponse.text(request.url === '/active' ? encoded : shellContract, {
              contentType: 'application/json',
              headers: { 'cache-control': 'no-store' },
            });
          }
          return HttpServerResponse.empty({ status: 404 });
        }),
      ).pipe(Effect.provide(services)),
    ),
  );
  return yield* Effect.never;
});

if (import.meta.main) {
  NodeRuntime.runMain(
    browserCompositionFixture.pipe(
      Effect.scoped,
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(NodeServices.layer),
    ),
  );
}
