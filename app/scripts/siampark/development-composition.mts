#!/usr/bin/env node
import { createServer } from 'node:http';
import path from 'node:path';

import { NodeHttpServer, NodeServices } from '@effect/platform-node';
import { resolveUltramodernReleaseIdentity } from '@modern-js/app-tools-extensions/release-identity';
import { sql } from 'drizzle-orm';
import {
  Config,
  ConfigProvider,
  Console,
  DateTime,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Match,
  Option,
  Redacted,
  Ref,
  Schedule,
  Schema,
} from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { FetchHttpClient, HttpClient, HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http';

import {
  ONTOS_MODULE_CONTRACT_PATH,
  ONTOS_SHELL_RUNTIME_CONTRACT_PATH,
  OntosModuleDeploymentContractSchema,
  OntosShellRuntimeContractSchema,
} from '../../packages/core-runtime/src/index.ts';
import { CoreDatabase } from '../../packages/core-runtime/src/db/client.ts';
import { parseDatabaseConnectionPair } from '../../packages/core-runtime/src/db/config.ts';
import { isLoopbackHostname } from '../../packages/core-runtime/src/modules/application-composition-backend.ts';
import {
  ACTIVE_APPLICATION_COMPOSITION_POLICY,
  ARTIFACT_FETCH_TIMEOUT,
  assertNoConflictingPublication,
  deriveActiveApplicationCompositionSnapshot,
  encodeActiveApplicationCompositionSnapshot,
} from '../active-application-composition.mts';
import {
  ApplicationCompositionAuthorityAdminDatabaseLive,
  publishApplicationCompositionAuthoritySnapshot,
} from '../application-composition-authority-publication.mts';
import type { ObservedArtifact } from '../active-application-composition.mts';

export class DevelopmentCompositionError extends Schema.TaggedError<DevelopmentCompositionError>()(
  'DevelopmentCompositionError',
  { reason: Schema.String },
) {}
const fail = (reason: string) => new DevelopmentCompositionError({ reason });
const portSchema = Schema.NumberFromString.pipe(
  Schema.check(Schema.isInt(), Schema.isBetween({ maximum: 65_535, minimum: 1 })),
);
const deliveryUnit = Schema.Struct({
  buildMarker: Schema.NonEmptyString,
  unitId: Schema.NonEmptyString.pipe(Schema.brand('DeliveryUnitId')),
});
const topologySchema = Schema.fromJsonString(
  Schema.Struct({
    shell: Schema.Struct({ deliveryUnit, id: Schema.Literal('shell-super-app'), portEnv: Schema.NonEmptyString }),
    verticals: Schema.Array(
      Schema.Struct({
        deliveryUnit,
        id: Schema.NonEmptyString,
        moduleFederation: Schema.Struct({ manifestUrl: Schema.URLFromString }),
        path: Schema.NonEmptyString,
        surfaceProfile: Schema.optionalKey(Schema.Literal('api-only')),
      }),
    ),
  }),
);
const moduleJson = Schema.fromJsonString(OntosModuleDeploymentContractSchema);
const shellJson = Schema.fromJsonString(OntosShellRuntimeContractSchema);

/** This operator cannot publish against an original or remotely hosted database. */
export const validateDevelopmentDatabase = Effect.fn('SiamparkComposition.validateDatabase')(function* validateDatabase(
  environment: string,
  urls: { readonly DATABASE_ADMIN_URL: string; readonly DATABASE_URL: string },
) {
  if (environment !== 'development') {
    return yield* fail('An explicit development environment is required');
  }
  const pair = yield* parseDatabaseConnectionPair(urls).pipe(
    Effect.mapError(() => fail('Distinct native database identities are required')),
  );
  if (
    !isLoopbackHostname(pair.admin.host) ||
    !isLoopbackHostname(pair.runtime.host) ||
    pair.admin.database !== 'siampark_demo' ||
    pair.runtime.database !== 'siampark_demo' ||
    pair.admin.host !== pair.runtime.host ||
    pair.admin.port !== pair.runtime.port
  ) {
    return yield* fail('Both database identities must target the same loopback siampark_demo database');
  }
  return pair;
});

export const validateDevelopmentArtifactUrl = (url: URL) =>
  url.protocol === 'http:' &&
  isLoopbackHostname(url.hostname) &&
  url.username === '' &&
  url.password === '' &&
  url.search === '' &&
  url.hash === ''
    ? Effect.succeed(url)
    : Effect.fail(fail('Development artifacts must use credential-free loopback HTTP URLs'));

export const decodeDevelopmentArtifactText = (artifact: ObservedArtifact) =>
  Effect.try({
    catch: () => fail('Native deployment artifact is not valid UTF-8'),
    try: () => new TextDecoder('utf-8', { fatal: true }).decode(artifact.bytes),
  });

const workspaceRoot = path.resolve(import.meta.dirname, '../..');
const environmentLive = ConfigProvider.layer(
  Effect.gen(function* loadOperatorConfiguration() {
    const file = yield* ConfigProvider.fromDotEnv({ path: path.join(workspaceRoot, '.env') });
    return ConfigProvider.orElse(ConfigProvider.fromEnv(), file);
  }),
);

export const serveDevelopmentComposition = Effect.fn('SiamparkComposition.serve')(function* serve(
  environment: string,
  encodedPort: string,
) {
  const port = yield* Schema.decodeEffect(portSchema)(encodedPort);
  yield* Config.schema(Schema.Literal('development'), 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT').pipe(
    Config.withDefault('development'),
  );
  const [runtime, admin] = yield* Effect.all([Config.Redacted('DATABASE_URL'), Config.Redacted('DATABASE_ADMIN_URL')]);
  const connections = yield* validateDevelopmentDatabase(environment, {
    DATABASE_ADMIN_URL: Redacted.value(admin),
    DATABASE_URL: Redacted.value(runtime),
  });
  const fs = yield* FileSystem.FileSystem;
  const topology = yield* Schema.decodeEffect(topologySchema)(
    yield* fs.readFileString(path.join(workspaceRoot, 'topology/reference-topology.json')),
  );
  const shellPort = yield* Config.schema(portSchema, topology.shell.portEnv).pipe(Config.withDefault(3020));
  const shellOrigin = `http://127.0.0.1:${shellPort}`;
  const origin = `http://127.0.0.1:${port}`;
  const ownerPorts = topology.verticals.map(({ moduleFederation }) => moduleFederation.manifestUrl.port);
  if (port === shellPort || ownerPorts.includes(String(port)) || new Set(ownerPorts).size !== ownerPorts.length) {
    return yield* fail('Composition, Shell, and every owner must use distinct ports');
  }
  const client = HttpClient.withScope(yield* HttpClient.HttpClient);
  const observe = (url: URL) =>
    Effect.gen(function* observeArtifact() {
      yield* validateDevelopmentArtifactUrl(url);
      const response = yield* client.get(url.href, { headers: { 'cache-control': 'no-cache' } });
      if (response.status !== 200) {
        return yield* fail(`Artifact ${url.pathname} on port ${url.port} returned HTTP ${response.status}`);
      }
      return { bytes: new Uint8Array(yield* response.arrayBuffer), url: url.href } satisfies ObservedArtifact;
    }).pipe(Effect.scoped, Effect.timeout(ARTIFACT_FETCH_TIMEOUT));
  const releaseIdentity = (unit: typeof deliveryUnit.Type) =>
    Effect.try({
      catch: () => fail(`Native release identity unavailable for ${unit.unitId}`),
      try: () =>
        resolveUltramodernReleaseIdentity({
          generationBuildMarker: unit.buildMarker,
          unitId: unit.unitId,
          workspaceRoot,
        }),
    });
  const observeSnapshot = Effect.gen(function* observeEntireNativeTopology() {
    const modules = yield* Effect.forEach(
      topology.verticals,
      (owner) =>
        Effect.gen(function* observeOwner() {
          yield* validateDevelopmentArtifactUrl(owner.moduleFederation.manifestUrl);
          const base = new URL('/', owner.moduleFederation.manifestUrl);
          base.hostname = '127.0.0.1';
          yield* validateDevelopmentArtifactUrl(base);
          const contract = yield* observe(new URL(ONTOS_MODULE_CONTRACT_PATH, base));
          const text = yield* decodeDevelopmentArtifactText(contract);
          const document = yield* Schema.decodeEffect(moduleJson)(text);
          const identity = yield* releaseIdentity(owner.deliveryUnit);
          const local = yield* fs.readFile(
            path.join(workspaceRoot, owner.path, 'dist/public', ONTOS_MODULE_CONTRACT_PATH),
          );
          if (
            document.deployment.appId !== owner.id ||
            document.deployment.buildMarker !== identity.buildMarker ||
            !Buffer.from(local).equals(Buffer.from(contract.bytes))
          ) {
            return yield* fail(`Observed ${owner.id} does not match its current local native build`);
          }
          const module = {
            appId: owner.id,
            backend: { baseUrl: base.href, transport: 'node-http' as const },
            contract,
          };
          return owner.surfaceProfile === 'api-only'
            ? module
            : { ...module, federationManifest: yield* observe(new URL('/mf-manifest.json', base)) };
        }),
      { concurrency: 1 },
    );
    const runtimeContract = yield* observe(new URL(ONTOS_SHELL_RUNTIME_CONTRACT_PATH, shellOrigin));
    const text = yield* decodeDevelopmentArtifactText(runtimeContract);
    const shellDocument = yield* Schema.decodeEffect(shellJson)(text);
    const shellIdentity = yield* releaseIdentity(topology.shell.deliveryUnit);
    const shellLocal = yield* fs.readFile(
      path.join(workspaceRoot, 'apps/shell-super-app/dist/public', ONTOS_SHELL_RUNTIME_CONTRACT_PATH),
    );
    if (
      shellDocument.deployment.appId !== topology.shell.id ||
      shellDocument.deployment.buildMarker !== shellIdentity.buildMarker ||
      !Buffer.from(shellLocal).equals(Buffer.from(runtimeContract.bytes))
    ) {
      return yield* fail('Observed Shell has a different native build identity');
    }
    return yield* deriveActiveApplicationCompositionSnapshot({
      environment,
      modules,
      observedAt: yield* DateTime.now,
      shell: { federationManifest: yield* observe(new URL('/mf-manifest.json', shellOrigin)), runtimeContract },
      validity: ACTIVE_APPLICATION_COMPOSITION_POLICY.validity,
    });
  });
  const pointer = yield* Ref.make(Option.none<string>());
  const application = Effect.gen(function* respondWithApprovedSnapshot() {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.method !== 'GET') {
      return HttpServerResponse.empty({ status: 405 });
    }
    if (request.url !== '/active') {
      return HttpServerResponse.empty({ status: 404 });
    }
    const current = yield* Ref.get(pointer);
    return Option.isSome(current)
      ? HttpServerResponse.text(current.value, {
          contentType: 'application/json',
          headers: { 'cache-control': 'no-store' },
        })
      : HttpServerResponse.empty({ status: 503 });
  });
  yield* HttpServer.serveEffect(application);
  const database = yield* CoreDatabase;
  const verifyInitialCutover = (revision: string) =>
    Effect.gen(function* proveIsolatedNativeDevelopmentCutover() {
      const [actual] = yield* database.executor.execute<{ readonly admin: string; readonly database: string }>(
        sql`select current_database() as database, current_user as admin`,
        'objects',
      );
      if (actual?.database !== 'siampark_demo' || actual.admin !== connections.admin.user) {
        return yield* fail('The actual administrative session is not the validated isolated demo database');
      }
      // Re-observe every local provider at the cutover, rather than treating isolation as proof of its binaries.
      const current = yield* observeSnapshot;
      if (current.composition.revision !== revision) {
        return yield* fail('Local provider artifacts changed during initial cutover');
      }
      return yield* Effect.void;
    });
  const publish = Effect.gen(function* publishObservedNativeComposition() {
    const snapshot = yield* observeSnapshot;
    const encoded = yield* encodeActiveApplicationCompositionSnapshot(snapshot);
    const current = yield* Ref.get(pointer);
    yield* assertNoConflictingPublication(current, snapshot);
    yield* publishApplicationCompositionAuthoritySnapshot(
      snapshot,
      Ref.set(pointer, Option.some(encoded)),
      verifyInitialCutover(snapshot.composition.revision),
    ).pipe(Effect.tapError(() => Ref.set(pointer, current)));
    yield* Console.log(
      `Development composition ${snapshot.composition.revision} (${snapshot.composition.modules.length} owners) at ${origin}/active; valid until ${DateTime.formatIso(snapshot.validUntil)}`,
    );
  });
  return yield* publish.pipe(Effect.repeat(Schedule.spaced(ACTIVE_APPLICATION_COMPOSITION_POLICY.refreshInterval)));
});

const command = Command.make(
  'siampark-development-composition',
  {
    environment: Flag.String('environment'),
    port: Flag.String('port').pipe(Flag.withDefault('3031')),
  },
  ({ environment, port }) =>
    Effect.gen(function* startDevelopmentOperator() {
      const parsedPort = yield* Schema.decodeEffect(portSchema)(port);
      const serverLive = NodeHttpServer.layer(createServer, { host: '127.0.0.1', port: parsedPort });
      return yield* Layer.build(
        Layer.effectDiscard(serveDevelopmentComposition(environment, port)).pipe(Layer.provide(serverLive)),
      );
    }).pipe(Effect.scoped),
);

if (import.meta.main) {
  const operatorLive = Layer.effectDiscard(
    Command.run(command, { version: '1.0.0' }).pipe(
      Effect.tapError((failure) =>
        Match.value(failure).pipe(
          Match.tags({
            ApplicationCompositionAuthorityError: (error) =>
              Console.error(`ApplicationCompositionAuthorityError: ${error.reason}`),
            DevelopmentCompositionError: (error) => Console.error(`DevelopmentCompositionError: ${error.reason}`),
          }),
          Match.orElse((problem) =>
            Console.error(
              `Composition failed (${problem._tag}); native artifact/configuration validation stopped publication`,
            ),
          ),
        ),
      ),
    ),
  ).pipe(
    Layer.provide(ApplicationCompositionAuthorityAdminDatabaseLive.pipe(Layer.provide(environmentLive))),
    Layer.provide(environmentLive),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(NodeServices.layer),
  );
  const exit = await Effect.runPromiseExit(Effect.scoped(Layer.build(operatorLive)));
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
