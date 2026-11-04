#!/usr/bin/env node
import { createServer } from 'node:http';
import path from 'node:path';

import { NodeHttpServer, NodeRuntime, NodeServices } from '@effect/platform-node';
import { resolveUltramodernReleaseIdentity } from '@modern-js/app-tools-extensions/release-identity';
import { and, eq } from 'drizzle-orm';
import { Config, Context, DateTime, Duration, Effect, FileSystem, Layer, Redacted, Ref, Schema, Scope } from 'effect';
import { FetchHttpClient, HttpClient, HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';

import { parseDatabaseConnectionPair } from '../../../../packages/core-runtime/src/db/config.ts';
import { CoreDatabase } from '../../../../packages/core-runtime/src/db/client.ts';
import { applicationCompositionAuthority } from '../../../../packages/core-runtime/src/db/schema.ts';
import { validateActiveApplicationCompositionSnapshot } from '../../../../packages/core-runtime/src/modules/active-application-composition.ts';
import type { ActiveApplicationCompositionSnapshot } from '../../../../packages/core-runtime/src/modules/active-application-composition.ts';
import {
  closeApplicationCompositionDurableAdmission,
  drainApplicationCompositionAuthority,
  isApplicationCompositionDurableWorkDrained,
  isApplicationCompositionWorkDrained,
  lockApplicationCompositionPublication,
  publishApplicationCompositionAuthority,
} from '../../../../packages/core-runtime/src/modules/application-composition-authority.ts';
import { isLoopbackHostname } from '../../../../packages/core-runtime/src/modules/application-composition-backend.ts';
import {
  canonicalizeApplicationComposition,
  ONTOS_SHELL_RUNTIME_CONTRACT_PATH,
  OntosShellRuntimeContractSchema,
} from '../../../../packages/core-runtime/src/modules/application-composition.ts';
import { ONTOS_MODULE_CONTRACT_PATH } from '../../../../packages/core-runtime/src/modules/manifest.ts';
import {
  ARTIFACT_FETCH_TIMEOUT,
  deriveActiveApplicationCompositionSnapshot,
  encodeActiveApplicationCompositionSnapshot,
} from '../../../../scripts/active-application-composition.mts';
import {
  ApplicationCompositionAuthorityAdminDatabaseLive,
  withApplicationCompositionPublicationLock,
} from '../../../../scripts/application-composition-authority-publication.mts';
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
const promotionResponseJson = Schema.fromJsonString(
  Schema.Struct({ compositionRevision: Schema.String, previousRevision: Schema.String }),
);

const PARTY_APP_ID = 'party-registry';

// These are exactly the two native owners started by this browser test topology.
const ownerOrigins = [
  { appId: PARTY_APP_ID, baseUrl: 'http://127.0.0.1:4102/' },
  { appId: 'inventory', baseUrl: 'http://127.0.0.1:4110/' },
] as const;

const findOwnedPublication = (
  publications: readonly ActiveApplicationCompositionSnapshot[],
  revision: string,
  deadline: number,
): ActiveApplicationCompositionSnapshot | undefined =>
  publications.find(
    (publication) =>
      publication.composition.revision === revision && DateTime.toEpochMillis(publication.validUntil) === deadline,
  );

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
  const observeOwner = ({ appId, baseUrl }: (typeof ownerOrigins)[number]) =>
    Effect.gen(function* observeNativeOwner() {
      return {
        appId,
        backend: { baseUrl, transport: 'node-http' as const },
        contract: yield* observe(new URL(ONTOS_MODULE_CONTRACT_PATH, baseUrl).href),
        federationManifest: yield* observe(new URL('/mf-manifest.json', baseUrl).href),
      };
    });
  const observeComposition = (retainedOnly: boolean) =>
    Effect.gen(function* observeBrowserComposition() {
      const modules = yield* Effect.forEach(
        ownerOrigins.filter(({ appId }) => !retainedOnly || appId === PARTY_APP_ID),
        observeOwner,
        { concurrency: 1 },
      );
      return yield* deriveActiveApplicationCompositionSnapshot({
        environment: 'development',
        modules,
        observedAt: yield* DateTime.now,
        shell: {
          federationManifest: yield* observe(`${shellOrigin}/mf-manifest.json`),
          runtimeContract: retainedOnly
            ? yield* observe(`${compositionOrigin}${ONTOS_SHELL_RUNTIME_CONTRACT_PATH}`)
            : {
                bytes: new TextEncoder().encode(shellContract),
                url: `${compositionOrigin}${ONTOS_SHELL_RUNTIME_CONTRACT_PATH}`,
              },
        },
        validity: Duration.minutes(30),
      }).pipe(Effect.flatMap(validateActiveApplicationCompositionSnapshot));
    });
  const approved = yield* observeComposition(false);
  const encoded = yield* encodeActiveApplicationCompositionSnapshot(approved);
  const activeStorage = yield* Ref.make(encoded);
  const ownedPublications = yield* Ref.make<readonly ActiveApplicationCompositionSnapshot[]>([approved]);
  const attemptedPromotion = yield* Ref.make<ActiveApplicationCompositionSnapshot | null>(null);
  const promotionEnabled = yield* Config.Boolean('ONTOS_E2E_RETAINED_PARTY_R2').pipe(Config.withDefault(false));
  // Keep the native admin pool's scope open until the authority finalizer has finished.
  const databaseScope = yield* Scope.make();
  yield* Effect.addFinalizer((exit) => Scope.close(databaseScope, exit));
  const databaseServices = yield* Layer.build(ApplicationCompositionAuthorityAdminDatabaseLive).pipe(
    Scope.provide(databaseScope),
  );
  const coreDatabase = Context.get(databaseServices, CoreDatabase);
  const database = coreDatabase.executor;
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
            if (existing.length !== 1 || current === undefined) {
              return yield* fail('The browser fixture no longer owns the native composition authority');
            }
            const owned = findOwnedPublication(
              yield* Ref.get(ownedPublications),
              current.revision,
              current.validUntil.getTime(),
            );
            if (owned === undefined || current.phase !== 'active' || current.durableWorkAdmission !== 'open') {
              return yield* fail('The browser fixture no longer owns the native composition authority');
            }
            yield* transaction
              .delete(applicationCompositionAuthority)
              .where(
                and(
                  eq(applicationCompositionAuthority.authorityKey, 'active'),
                  eq(applicationCompositionAuthority.revision, owned.composition.revision),
                  eq(applicationCompositionAuthority.validUntil, DateTime.toDateUtc(owned.validUntil)),
                  eq(applicationCompositionAuthority.phase, 'active'),
                  eq(applicationCompositionAuthority.durableWorkAdmission, 'open'),
                ),
              );
            return yield* Effect.void;
          }),
        )
        .pipe(Effect.orDie),
  );
  const promoteRetainedParty = Effect.fn('BrowserCompositionFixture.promoteRetainedParty')(
    function* promoteRetainedPartyEffect() {
      const observed = yield* observeComposition(true);
      const retained = approved.composition.modules.filter(({ deployment }) => deployment.appId === PARTY_APP_ID);
      if (
        retained.length !== 1 ||
        observed.composition.modules.length !== 1 ||
        observed.composition.revision === approved.composition.revision ||
        canonicalizeApplicationComposition(observed.composition) !==
          canonicalizeApplicationComposition({
            ...approved.composition,
            modules: retained,
            revision: observed.composition.revision,
          })
      ) {
        return yield* fail('R2 must retain the exact observed Party and Shell artifacts and remove only Inventory');
      }
      const next = yield* Ref.modify(attemptedPromotion, (previous) =>
        previous === null ? [observed, observed] : [previous, previous],
      );
      yield* validateActiveApplicationCompositionSnapshot(next);
      // Record exact attempted identity/deadline before any authority or provider mutation.
      yield* Ref.update(ownedPublications, (publications) =>
        publications.some(
          (publication) =>
            publication.composition.revision === next.composition.revision &&
            DateTime.toEpochMillis(publication.validUntil) === DateTime.toEpochMillis(next.validUntil),
        )
          ? publications
          : [...publications, next],
      );
      const nextEncoded = yield* encodeActiveApplicationCompositionSnapshot(next);
      const publishStorageAndReadBack = Effect.gen(function* publishFixtureStorage() {
        yield* Ref.set(activeStorage, nextEncoded);
        const readback = yield* observe(`${compositionOrigin}/active`);
        if (new TextDecoder().decode(readback.bytes) !== nextEncoded) {
          return yield* fail('The local Composition publication did not read back the exact approved bytes');
        }
        return yield* Effect.void;
      });
      const promote = Effect.gen(function* publishFencedCurrentExecutables() {
        const rows = yield* database.select().from(applicationCompositionAuthority);
        const [current] = rows;
        if (rows.length !== 1 || current === undefined) {
          return yield* fail('The fixture requires exactly its own current authority row');
        }
        if (current.revision === next.composition.revision) {
          if (
            current.phase !== 'active' ||
            current.durableWorkAdmission !== 'open' ||
            current.validUntil.getTime() !== DateTime.toEpochMillis(next.validUntil)
          ) {
            return yield* fail('An existing R2 publication no longer matches this fixture');
          }
          return yield* publishStorageAndReadBack;
        }
        if (
          current?.revision !== approved.composition.revision ||
          current.validUntil.getTime() !== DateTime.toEpochMillis(approved.validUntil) ||
          (current.phase !== 'active' && current.phase !== 'draining')
        ) {
          return yield* fail("Only this fixture's exact R1 authority may be replaced");
        }
        if (DateTime.toEpochMillis(next.validUntil) <= current.validUntil.getTime()) {
          return yield* fail('R2 publication requires genuinely newer observation freshness');
        }
        if (current.phase === 'active') {
          yield* database.transaction((transaction) =>
            closeApplicationCompositionDurableAdmission(transaction, approved.composition.revision),
          );
          if (
            !(yield* database.transaction((transaction) =>
              isApplicationCompositionDurableWorkDrained(transaction, approved.composition.revision),
            ))
          ) {
            return yield* fail('Existing durable work must finish before the browser Composition can drain');
          }
          yield* database.transaction((transaction) =>
            drainApplicationCompositionAuthority(transaction, approved.composition.revision),
          );
        }
        if (
          !(yield* database.transaction((transaction) =>
            isApplicationCompositionWorkDrained(transaction, approved.composition.revision),
          ))
        ) {
          return yield* fail('Existing Outbox work must finish before the browser Composition can be replaced');
        }
        // Real exclusive Core authority locking waits for current-executable transactions.
        // This local fixture does not claim production provider-inventory/legacy-cutover acceptance.
        return yield* database.transaction((transaction) =>
          publishApplicationCompositionAuthority(transaction, next).pipe(Effect.andThen(publishStorageAndReadBack)),
        );
      });
      yield* withApplicationCompositionPublicationLock(promote, {
        baselineRevision: approved.composition.revision,
        targetRevision: next.composition.revision,
      }).pipe(Effect.provideService(CoreDatabase, coreDatabase));
      const [published] = yield* database.select().from(applicationCompositionAuthority);
      if (
        published?.revision !== next.composition.revision ||
        published.phase !== 'active' ||
        published.durableWorkAdmission !== 'open' ||
        published.validUntil.getTime() !== DateTime.toEpochMillis(next.validUntil)
      ) {
        return yield* fail('The browser Composition publication did not settle its exact native authority');
      }
      return yield* Schema.encodeEffect(promotionResponseJson)({
        compositionRevision: next.composition.revision,
        previousRevision: approved.composition.revision,
      });
    },
  );
  yield* Layer.build(NodeHttpServer.layer(createServer, { host: '127.0.0.1', port: compositionPort })).pipe(
    Effect.flatMap((services) =>
      HttpServer.serveEffect(
        Effect.gen(function* serveFixtureArtifact() {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.url === '/promote-retained-party' && promotionEnabled) {
            if (request.method !== 'POST') {
              return HttpServerResponse.empty({ status: 405 });
            }
            if (request.headers.origin !== shellOrigin) {
              return HttpServerResponse.empty({ status: 403 });
            }
            if (
              request.headers['transfer-encoding'] !== undefined ||
              (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0') ||
              (yield* request.text) !== ''
            ) {
              return HttpServerResponse.empty({ status: 400 });
            }
            return yield* promoteRetainedParty().pipe(
              Effect.map((response) =>
                HttpServerResponse.text(response, {
                  contentType: 'application/json',
                  headers: { 'cache-control': 'no-store' },
                }),
              ),
              Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 503 }))),
            );
          }
          if (request.method !== 'GET') {
            return HttpServerResponse.empty({ status: 405 });
          }
          if (request.url === '/active' || request.url === ONTOS_SHELL_RUNTIME_CONTRACT_PATH) {
            return HttpServerResponse.text(request.url === '/active' ? yield* Ref.get(activeStorage) : shellContract, {
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
