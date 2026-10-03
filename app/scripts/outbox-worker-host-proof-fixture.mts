#!/usr/bin/env node
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { NodeHttpServer, NodeRuntime, NodeServices } from '@effect/platform-node';
import {
  resolveUltramodernReleaseIdentity,
  resolveUltramodernSourceRevision,
} from '@modern-js/app-tools-extensions/release-identity';
import { and, eq, sql } from 'drizzle-orm';
import { Config, DateTime, Duration, Effect, FileSystem, Layer, Redacted, Ref, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { HttpServerRequest, HttpServerResponse } from 'effect/unstable/http';
import { NetAddress } from 'effect/unstable/net';

import { createSharedRuntimeConfig } from '../module-federation.shared.ts';
import { CoreDatabase } from '../packages/core-runtime/src/db/client.ts';
import { parseDatabaseConnectionPair } from '../packages/core-runtime/src/db/config.ts';
import {
  applicationCompositionAuthority,
  applicationCompositionDurableWork,
  outboxDeliveries,
  outboxMessages,
} from '../packages/core-runtime/src/db/schema.ts';
import { validateActiveApplicationCompositionSnapshot } from '../packages/core-runtime/src/modules/active-application-composition.ts';
import type { ActiveApplicationCompositionSnapshot } from '../packages/core-runtime/src/modules/active-application-composition.ts';
import {
  lockApplicationCompositionPublication,
  publishApplicationCompositionAuthority,
} from '../packages/core-runtime/src/modules/application-composition-authority.ts';
import { isLoopbackHostname } from '../packages/core-runtime/src/modules/application-composition-backend.ts';
import {
  ONTOS_SHELL_RUNTIME_CONTRACT_PATH,
  OntosShellRuntimeContractSchema,
} from '../packages/core-runtime/src/modules/application-composition.ts';
import {
  ONTOS_MODULE_CONTRACT_PATH,
  OntosDeploymentAppIdSchema,
  OntosModuleDeploymentContractSchema,
} from '../packages/core-runtime/src/modules/manifest.ts';
import type { OntosModuleDeploymentContract } from '../packages/core-runtime/src/modules/manifest.ts';
import {
  deriveActiveApplicationCompositionSnapshot,
  encodeActiveApplicationCompositionSnapshot,
} from './active-application-composition.mts';
import type { ObservedModuleDeployment } from './active-application-composition.mts';
import {
  ApplicationCompositionAuthorityAdminDatabaseLive,
  withApplicationCompositionPublicationLock,
} from './application-composition-authority-publication.mts';
import { deriveOntosModuleDeploymentContract } from './generate-ontos-module-contract.mts';
import { createShellRuntimeContract } from './generate-ontos-shell-runtime-contract.mts';
import { readOutboxWorkerHost, renderOutboxWorkerHostEntry } from './generate-outbox-worker-deployment.mjs';
import { OUTBOX_WORKER_BUNDLE, OUTBOX_WORKER_HOST } from './outbox-worker-delivery.mjs';

export class OutboxWorkerHostProofFixtureError extends Schema.TaggedError<OutboxWorkerHostProofFixtureError>()(
  'OutboxWorkerHostProofFixtureError',
  { reason: Schema.String },
) {}

const fail = (reason: string) => new OutboxWorkerHostProofFixtureError({ reason });
const jsonBytes = (text: string) => new TextEncoder().encode(text);
const federationClaimsJson = Schema.fromJsonString(
  Schema.Struct({
    exposes: Schema.Array(Schema.Struct({ path: Schema.NonEmptyString })),
    name: Schema.NonEmptyString,
    shared: Schema.Array(
      Schema.Struct({ name: Schema.NonEmptyString, requiredVersion: Schema.NonEmptyString, singleton: Schema.Boolean }),
    ),
  }),
);

const UnitIdSchema = Schema.NonEmptyString.pipe(Schema.brand('UnitId'));

export const HostWorkerArtifactSchema = Schema.Struct({
  appId: Schema.Literal(OUTBOX_WORKER_HOST.id),
  entry: Schema.Literal(OUTBOX_WORKER_BUNDLE),
  ownerBuildIdentities: Schema.Array(
    Schema.Struct({
      appId: OntosDeploymentAppIdSchema,
      buildMarker: Schema.NonEmptyString,
      sourceRevision: Schema.NonEmptyString,
      unitId: UnitIdSchema,
    }),
  ),
  schemaVersion: Schema.Literal(2),
  serviceId: Schema.Literal(OUTBOX_WORKER_HOST.id),
  sourceInputs: Schema.Array(Schema.NonEmptyString),
  sourceRevision: Schema.NonEmptyString,
});
type HostWorkerArtifact = typeof HostWorkerArtifactSchema.Type;

const DeliveryIdentitySchema = Schema.Struct({ buildMarker: Schema.NonEmptyString, unitId: UnitIdSchema });
export const HostProofTopologySchema = Schema.Struct({
  shell: Schema.Struct({
    deliveryUnit: DeliveryIdentitySchema,
    id: Schema.Literal('shell-super-app'),
    moduleFederation: Schema.Struct({ name: Schema.NonEmptyString }),
    path: Schema.Literal('apps/shell-super-app'),
  }),
  verticals: Schema.Array(
    Schema.Struct({
      deliveryUnit: DeliveryIdentitySchema,
      id: Schema.NonEmptyString,
      moduleFederation: Schema.Struct({ name: Schema.NonEmptyString }),
      path: Schema.NonEmptyString,
    }),
  ),
});
type HostProofTopology = typeof HostProofTopologySchema.Type;

/** The native materializer's identities must agree with independently derived owner contracts. */
export const verifyHostProofOwnerIdentities = Effect.fn('OutboxWorkerHostProof.verifyOwnerIdentities')(
  function* verifyOwnerIdentities(input: {
    readonly artifact: HostWorkerArtifact;
    readonly contracts: readonly OntosModuleDeploymentContract[];
    readonly hostedOwnerIds: readonly string[];
    readonly sourceRevision: string;
    readonly topology: HostProofTopology;
  }) {
    const { artifact, contracts, hostedOwnerIds, sourceRevision, topology } = input;
    const identities = new Map<string, HostWorkerArtifact['ownerBuildIdentities'][number]>(
      artifact.ownerBuildIdentities.map((identity) => [identity.appId, identity]),
    );
    const topologyIds = new Set(topology.verticals.map(({ id }) => id));
    const contractIds = new Set(contracts.map(({ deployment }) => deployment.appId));
    if (
      artifact.sourceRevision !== sourceRevision ||
      identities.size !== artifact.ownerBuildIdentities.length ||
      identities.size !== hostedOwnerIds.length ||
      new Set(hostedOwnerIds).size !== hostedOwnerIds.length ||
      topologyIds.size !== topology.verticals.length ||
      contractIds.size !== contracts.length ||
      contracts.length !== topology.verticals.length ||
      contracts.some(({ deployment }) => !topologyIds.has(deployment.appId))
    ) {
      return yield* fail('the worker provenance and complete topology do not agree');
    }
    for (const appId of hostedOwnerIds) {
      const identity = identities.get(appId);
      const owner = topology.verticals.find(({ id }) => id === appId);
      const contract = contracts.find(({ deployment }) => deployment.appId === appId);
      if (
        identity === undefined ||
        owner === undefined ||
        contract === undefined ||
        identity.sourceRevision !== sourceRevision ||
        identity.unitId !== owner.deliveryUnit.unitId ||
        identity.unitId !== `app/${appId}` ||
        identity.buildMarker !== contract.deployment.buildMarker
      ) {
        return yield* fail(`the ${appId} contract does not match the actually compiled worker owner`);
      }
    }
    return yield* Effect.void;
  },
);

/** Reject routing overrides before opening an administrative pool; neither URL is included in failures. */
export const requireHostProofDatabase = Effect.fn('OutboxWorkerHostProof.requireLocalDatabase')(
  function* requireLocalDatabase(environment: { readonly DATABASE_ADMIN_URL: string; readonly DATABASE_URL: string }) {
    for (const value of [environment.DATABASE_URL, environment.DATABASE_ADMIN_URL]) {
      const parsed = URL.parse(value);
      if (parsed === null || parsed.search !== '' || parsed.hash !== '' || !isLoopbackHostname(parsed.hostname)) {
        return yield* fail('host admission proof requires PostgreSQL URLs without routing overrides on loopback');
      }
    }
    const { admin, runtime } = yield* parseDatabaseConnectionPair(environment).pipe(
      Effect.mapError(() => fail('host admission proof requires distinct native database identities')),
    );
    if (admin.host !== runtime.host || admin.port !== runtime.port || admin.database !== runtime.database) {
      return yield* fail('host admission proof database identities must target the same local database');
    }
    return yield* Effect.void;
  },
);

export const assertHostProofAuthorityEmpty = (rows: readonly { readonly revision: string }[]) =>
  rows.length === 0 ? Effect.void : Effect.fail(fail('host admission proof requires a fresh empty authority'));

const PackageSchema = Schema.Struct({
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  version: Schema.optionalKey(Schema.NonEmptyString),
});

/** Matches the actual owner-local Module Federation policy, without evaluating framework configuration. */
const ownerSharedClaims = Effect.fn('OutboxWorkerHostProof.ownerSharedClaims')(function* sharedClaims(
  directory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const ownerPackage = path.join(directory, 'package.json');
  const localRequire = createRequire(pathToFileURL(ownerPackage));
  const packageJson = yield* Schema.decodeEffect(Schema.fromJsonString(PackageSchema))(
    yield* fileSystem.readFileString(ownerPackage),
  );
  const versions = yield* Effect.forEach(
    ['@modern-js/plugin-i18n', '@modern-js/runtime', 'react', 'react-dom', '@tanstack/react-router'],
    (packageName) =>
      Effect.gen(function* installedVersion() {
        const filename = yield* Effect.try({
          catch: () => fail(`the local ${packageName} singleton cannot be resolved`),
          try: () => localRequire.resolve(`${packageName}/package.json`),
        });
        const installed = yield* Schema.decodeEffect(Schema.fromJsonString(PackageSchema))(
          yield* fileSystem.readFileString(filename),
        );
        return yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(installed.version);
      }),
    { concurrency: 1 },
  );
  const [i18n, runtime, react, reactDom, router] = versions;
  if (router !== packageJson.dependencies?.['@tanstack/react-router']) {
    return yield* fail('the installed router singleton does not match the owner policy');
  }
  const sharing = createSharedRuntimeConfig({
    '@modern-js/plugin-i18n/runtime': yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(i18n),
    '@modern-js/runtime': yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(runtime),
    '@tanstack/react-router': yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(router),
    react: yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(react),
    'react-dom': yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(reactDom),
  });
  return Object.entries(sharing).map(([name, value]) => ({
    name,
    requiredVersion: value.requiredVersion,
    singleton: value.singleton,
  }));
});

export const serveHostProofSource = Effect.fn('OutboxWorkerHostProof.serveSource')(function* serveSource(
  documents: Ref.Ref<ReadonlyMap<string, string>>,
) {
  const server = yield* NodeHttpServer.make(() => process.getBuiltinModule('http').createServer(), {
    host: '127.0.0.1',
    port: 0,
  });
  yield* server.serve(
    HttpServerRequest.HttpServerRequest.use((request) =>
      Ref.get(documents).pipe(
        Effect.map((current) => {
          if (request.method === 'GET') {
            const document = current.get(request.url);
            if (document === undefined) {
              return HttpServerResponse.empty({ status: request.url === '/active' ? 503 : 404 });
            }
            return HttpServerResponse.text(document, {
              contentType: 'application/json',
              headers: { 'cache-control': 'no-store' },
            });
          }
          return HttpServerResponse.empty({ status: 405 });
        }),
      ),
    ),
  );
  if (!NetAddress.isInetAddress(server.address)) {
    return yield* fail('the native fixture server did not bind TCP');
  }
  return `http://127.0.0.1:${server.address.port}`;
});

/** Local claims prove host admission only. They are not observed UI outputs or release envelopes. */
export const deriveHostProofSnapshot = Effect.fn('OutboxWorkerHostProof.deriveSnapshot')(
  function* deriveSnapshot(input: {
    readonly artifact: HostWorkerArtifact;
    readonly origin: string;
    readonly workspaceRoot: string;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const { artifact, origin, workspaceRoot } = input;
    const topology = yield* Schema.decodeEffect(Schema.fromJsonString(HostProofTopologySchema))(
      yield* fileSystem.readFileString(path.join(workspaceRoot, 'topology/reference-topology.json')),
    );
    const host = yield* readOutboxWorkerHost(workspaceRoot);
    if (
      host === undefined ||
      (yield* fileSystem.readFileString(path.join(workspaceRoot, host.entry))) !== renderOutboxWorkerHostEntry(host)
    ) {
      return yield* fail('the generated worker host does not match native topology discovery');
    }
    const sourceRevision = yield* Effect.try({
      catch: () => fail('the native worker source revision cannot be resolved'),
      try: () => resolveUltramodernSourceRevision(workspaceRoot, artifact.sourceRevision),
    });
    const contracts = yield* Effect.forEach(
      topology.verticals,
      ({ id }) => deriveOntosModuleDeploymentContract({ vertical: id, workspaceRoot }),
      { concurrency: 1 },
    );
    yield* verifyHostProofOwnerIdentities({
      artifact,
      contracts,
      hostedOwnerIds: host.owners.map(({ ownerId }) => ownerId),
      sourceRevision,
      topology,
    });
    const artifacts = new Map<string, string>();
    const modules = yield* Effect.forEach(
      topology.verticals,
      (owner) =>
        Effect.gen(function* observeOwner() {
          const contract = contracts.find(({ deployment }) => deployment.appId === owner.id);
          if (contract === undefined) {
            return yield* fail(`the ${owner.id} native contract is missing`);
          }
          const ownerDocuments = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
          const ownerOrigin = yield* serveHostProofSource(ownerDocuments);
          const ownerArtifacts = new Map<string, string>();
          const contractPath = ONTOS_MODULE_CONTRACT_PATH;
          const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))(
            contract,
          );
          ownerArtifacts.set(contractPath, encoded);
          const common: ObservedModuleDeployment = {
            appId: owner.id,
            backend: { baseUrl: `${ownerOrigin}/`, transport: 'node-http' },
            contract: { bytes: jsonBytes(encoded), url: `${ownerOrigin}${contractPath}` },
          };
          if (contract.manifest.publicSurface.components.length === 0) {
            yield* Ref.set(ownerDocuments, ownerArtifacts);
            return common;
          }
          const manifestPath = '/mf-manifest.json';
          const manifest = yield* Schema.encodeEffect(federationClaimsJson)({
            exposes: contract.manifest.publicSurface.components.map(({ expose }) => ({ path: expose })),
            name: owner.moduleFederation.name,
            shared: yield* ownerSharedClaims(path.join(workspaceRoot, owner.path)),
          });
          ownerArtifacts.set(manifestPath, manifest);
          yield* Ref.set(ownerDocuments, ownerArtifacts);
          return {
            ...common,
            federationManifest: { bytes: jsonBytes(manifest), url: `${ownerOrigin}${manifestPath}` },
          };
        }),
      { concurrency: 1 },
    );
    const shellIdentity = yield* Effect.try({
      catch: () => fail('the native Shell source identity cannot be resolved'),
      try: () =>
        resolveUltramodernReleaseIdentity({
          generationBuildMarker: topology.shell.deliveryUnit.buildMarker,
          sourceRevision: artifact.sourceRevision,
          unitId: topology.shell.deliveryUnit.unitId,
          workspaceRoot,
        }),
    });
    const shellRuntime = yield* Schema.encodeEffect(Schema.fromJsonString(OntosShellRuntimeContractSchema))(
      createShellRuntimeContract(shellIdentity.buildMarker),
    );
    const shellManifest = yield* Schema.encodeEffect(federationClaimsJson)({
      exposes: [],
      name: topology.shell.moduleFederation.name,
      shared: yield* ownerSharedClaims(path.join(workspaceRoot, topology.shell.path)),
    });
    artifacts.set(ONTOS_SHELL_RUNTIME_CONTRACT_PATH, shellRuntime);
    artifacts.set('/mf-manifest.json', shellManifest);
    const snapshot = yield* deriveActiveApplicationCompositionSnapshot({
      environment: 'development',
      modules,
      observedAt: yield* DateTime.now,
      shell: {
        federationManifest: { bytes: jsonBytes(shellManifest), url: `${origin}/mf-manifest.json` },
        runtimeContract: { bytes: jsonBytes(shellRuntime), url: `${origin}${ONTOS_SHELL_RUNTIME_CONTRACT_PATH}` },
      },
      validity: Duration.minutes(30),
    });
    return { artifacts, snapshot: yield* validateActiveApplicationCompositionSnapshot(snapshot) };
  },
);

const operateHostProofAuthority = Effect.fn('OutboxWorkerHostProof.authority')(function* authority(
  operation: 'seed' | 'cleanup',
  snapshot: ActiveApplicationCompositionSnapshot,
) {
  const database = yield* CoreDatabase;
  return yield* withApplicationCompositionPublicationLock(
    database.executor.transaction((transaction) =>
      Effect.gen(function* ownAuthority() {
        yield* lockApplicationCompositionPublication(transaction);
        const current = yield* transaction.select().from(applicationCompositionAuthority);
        const [state] = yield* transaction.execute<{ readonly busy: boolean; readonly dirty: boolean }>(
          sql`select
      exists(select 1 from ${outboxMessages}) or exists(select 1 from ${outboxDeliveries}) or exists(select 1 from ${applicationCompositionDurableWork}) as dirty,
      exists(select 1 from pg_stat_activity where datname = current_database() and usename <> current_user and pid <> pg_backend_pid() and (state is distinct from 'idle' or xact_start is not null)) as busy`,
          'objects',
        );
        if (state === undefined || state.dirty || state.busy) {
          return yield* fail('host admission proof requires an empty durable store and quiescent runtime');
        }
        if (operation === 'seed') {
          yield* assertHostProofAuthorityEmpty(current);
          yield* publishApplicationCompositionAuthority(transaction, snapshot);
          return yield* Effect.void;
        }
        const [owned] = current;
        if (
          current.length !== 1 ||
          owned?.revision !== snapshot.composition.revision ||
          owned.phase !== 'active' ||
          owned.durableWorkAdmission !== 'open' ||
          owned.validUntil.getTime() !== DateTime.toEpochMillis(snapshot.validUntil)
        ) {
          return yield* fail('host admission proof no longer owns this exact authority and freshness');
        }
        const removed = yield* transaction
          .delete(applicationCompositionAuthority)
          .where(
            and(
              eq(applicationCompositionAuthority.authorityKey, 'active'),
              eq(applicationCompositionAuthority.revision, snapshot.composition.revision),
              eq(applicationCompositionAuthority.phase, 'active'),
              eq(applicationCompositionAuthority.durableWorkAdmission, 'open'),
              eq(applicationCompositionAuthority.validUntil, DateTime.toDateUtc(snapshot.validUntil)),
            ),
          )
          .returning({ revision: applicationCompositionAuthority.revision });
        if (removed.length !== 1) {
          return yield* fail('host admission proof did not remove its exact authority');
        }
        return yield* Effect.void;
      }),
    ),
  );
});

const waitForHostStopped = (filename: string, readyTimeout: number) =>
  Effect.gen(function* parentConfirmedShutdown() {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* Effect.gen(function* awaitMarker() {
      while (!(yield* fileSystem.exists(filename))) {
        yield* Effect.sleep(Duration.millis(100));
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: Duration.seconds(readyTimeout + 90),
        orElse: () => Effect.fail(fail('the parent did not confirm host reaping; authority is retained')),
      }),
    );
  });

const command = Command.make(
  'outbox-worker-host-proof-fixture',
  {
    hostStoppedFile: Flag.String('host-stopped-file'),
    sourceUrlFile: Flag.String('source-url-file'),
    workerArtifact: Flag.String('worker-artifact'),
  },
  (input) =>
    Effect.gen(function* runFixture() {
      const fileSystem = yield* FileSystem.FileSystem;
      const readyTimeout = yield* Config.Int('OUTBOX_WORKER_HOST_READY_TIMEOUT_SECONDS').pipe(Config.withDefault(120));
      if (
        !Number.isSafeInteger(readyTimeout) ||
        readyTimeout < 1 ||
        !Number.isSafeInteger((readyTimeout + 90) * 1000)
      ) {
        return yield* fail('host admission readiness timeout must be a positive bounded integer');
      }
      for (const filename of [input.hostStoppedFile, input.sourceUrlFile]) {
        if (!path.isAbsolute(filename) || (yield* fileSystem.exists(filename))) {
          return yield* fail('fixture control files must be fresh absolute caller-owned paths');
        }
      }
      const artifact = yield* Schema.decodeEffect(Schema.fromJsonString(HostWorkerArtifactSchema), {
        onExcessProperty: 'error',
      })(yield* fileSystem.readFileString(input.workerArtifact));
      const documents = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
      const origin = yield* serveHostProofSource(documents);
      const { artifacts, snapshot } = yield* deriveHostProofSnapshot({
        artifact,
        origin,
        workspaceRoot: path.resolve(import.meta.dirname, '..'),
      });
      yield* Effect.acquireRelease(operateHostProofAuthority('seed', snapshot), () =>
        waitForHostStopped(input.hostStoppedFile, readyTimeout).pipe(
          Effect.andThen(operateHostProofAuthority('cleanup', snapshot)),
          Effect.orDie,
        ),
      );
      artifacts.set('/active', yield* encodeActiveApplicationCompositionSnapshot(snapshot));
      yield* Ref.set(documents, artifacts);
      yield* fileSystem.writeFileString(input.sourceUrlFile, `${origin}/active\n`, { flag: 'wx' });
      return yield* Effect.never;
    }).pipe(Effect.scoped),
).pipe(
  Command.provide(() =>
    Layer.unwrap(
      Effect.gen(function* localDatabaseLayer() {
        const [runtime, admin] = yield* Effect.all([
          Config.Redacted('DATABASE_URL'),
          Config.Redacted('DATABASE_ADMIN_URL'),
        ]);
        yield* requireHostProofDatabase({
          DATABASE_ADMIN_URL: Redacted.value(admin),
          DATABASE_URL: Redacted.value(runtime),
        });
        return ApplicationCompositionAuthorityAdminDatabaseLive;
      }),
    ),
  ),
);

if (import.meta.main) {
  NodeRuntime.runMain(
    Layer.build(
      Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(Layer.provide(NodeServices.layer)),
    ).pipe(Effect.scoped),
  );
}
