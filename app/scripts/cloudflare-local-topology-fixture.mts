#!/usr/bin/env node
import path from 'node:path';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { verifyCloudflareReleaseEnvelopeStaging } from '@modern-js/app-tools-extensions/release-envelope/framework-output';
import { and, eq } from 'drizzle-orm';
import { Config, DateTime, Duration, Effect, FileSystem, Layer, Redacted, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';

import { CoreDatabase } from '../packages/core-runtime/src/db/client.ts';
import { parseDatabaseConnectionPair } from '../packages/core-runtime/src/db/config.ts';
import { applicationCompositionAuthority } from '../packages/core-runtime/src/db/schema.ts';
import { moduleReleaseApiBaseUrl } from '../packages/core-runtime/src/http/module-release-identity.ts';
import { validateActiveApplicationCompositionSnapshot } from '../packages/core-runtime/src/modules/active-application-composition.ts';
import type { ActiveApplicationCompositionSnapshot } from '../packages/core-runtime/src/modules/active-application-composition.ts';
import {
  lockApplicationCompositionPublication,
  publishApplicationCompositionAuthority,
} from '../packages/core-runtime/src/modules/application-composition-authority.ts';
import { isLoopbackHostname } from '../packages/core-runtime/src/modules/application-composition-backend.ts';
import {
  ApplicationCompositionArtifactReferenceSchema,
  ApplicationCompositionBrowserFederationSchema,
  ApplicationCompositionSchema,
  ONTOS_SHELL_RUNTIME_CONTRACT_PATH,
} from '../packages/core-runtime/src/modules/application-composition.ts';
import {
  ONTOS_MODULE_CONTRACT_PATH,
  OntosDeploymentAppIdSchema,
  OntosDeploymentIdentitySchema,
  OntosModuleIdSchema,
  OntosModuleDeploymentContractSchema,
} from '../packages/core-runtime/src/modules/manifest.ts';
import { ShellPageContributionSchema } from '../packages/core-runtime/src/modules/shell-contribution.ts';
import {
  decodeActiveApplicationCompositionSnapshot,
  deriveActiveApplicationCompositionSnapshot,
  encodeActiveApplicationCompositionSnapshot,
} from './active-application-composition.mts';
import type { ObservedArtifact, ObservedModuleDeployment } from './active-application-composition.mts';
import { ApplicationReleaseIntentSchema } from './application-release-intent.mts';
import { ApplicationCompositionAuthorityAdminDatabaseLive } from './application-composition-authority-publication.mts';

export class CloudflareLocalTopologyFixtureError extends Schema.TaggedError<CloudflareLocalTopologyFixtureError>()(
  'CloudflareLocalTopologyFixtureError',
  { reason: Schema.String },
) {}

const fail = (reason: string) => new CloudflareLocalTopologyFixtureError({ reason });
const contractJson = Schema.fromJsonString(OntosModuleDeploymentContractSchema);

export const LocalTopologyProofPathsSchema = Schema.Struct({
  moduleIds: Schema.Array(OntosModuleIdSchema),
  party: Schema.Struct({
    apiBaseUrl: Schema.NonEmptyString,
    appId: OntosDeploymentAppIdSchema,
    buildMarker: OntosDeploymentIdentitySchema.fields.buildMarker,
    componentKey: ShellPageContributionSchema.fields.componentKey,
    entrypointKey: ShellPageContributionSchema.fields.entrypoint.fields.entrypointKey,
    expose: Schema.NonEmptyString,
    federationManifest: ApplicationCompositionArtifactReferenceSchema,
    moduleId: OntosModuleIdSchema,
    ownerPagePath: Schema.NonEmptyString,
    remoteName: ApplicationCompositionBrowserFederationSchema.fields.remoteName,
    routePath: Schema.NonEmptyString,
    shellPagePath: Schema.NonEmptyString,
  }),
  revision: ApplicationCompositionSchema.fields.revision,
});

const ShellLocalWorkerManifestSchema = Schema.Struct({
  deliveryUnit: Schema.Struct({
    buildMarker: OntosDeploymentIdentitySchema.fields.buildMarker,
    sourceRevision: Schema.String.check(Schema.isPattern(/^(?:[a-f\d]{40}|[a-f\d]{64})$/u)),
    unitId: Schema.Literal('app/shell-super-app'),
  }),
  runtime: Schema.Struct({
    fetchExport: Schema.Literal(true),
    nodeListen: Schema.Literal(false),
    type: Schema.Literal('cloudflare-module-worker'),
  }),
});

/** Explicit local HTTPS placement of real built Workers, never a provider deployment receipt. */
export const LocalTopologyOwnerSchema = Schema.Struct({
  appId: OntosDeploymentAppIdSchema,
  baseUrl: Schema.String.check(
    Schema.makeFilter((value) => {
      const url = URL.parse(value);
      return url !== null &&
        url.protocol === 'https:' &&
        isLoopbackHostname(url.hostname) &&
        url.port !== '' &&
        value === `${url.origin}/`
        ? undefined
        : 'the topology owner must be an explicit canonical local HTTPS origin with a port';
    }),
  ),
  outputDirectory: Schema.NonEmptyString,
});

export const deriveLocalTopologyProofPaths = Effect.fn('CloudflareLocalTopology.proofPaths')(function* deriveProofPaths(
  snapshot: ActiveApplicationCompositionSnapshot,
) {
  const approved = yield* validateActiveApplicationCompositionSnapshot(snapshot);
  const party = approved.composition.modules.find(({ deployment }) => deployment.appId === 'party-registry');
  if (party === undefined) {
    return yield* fail('the complete local composition must admit Party Registry');
  }
  const contract = yield* Schema.decodeEffect(contractJson)(party.contractDocument);
  const page = contract.manifest.publicSurface.shellContributions.pages.find(
    ({ entrypoint }) => entrypoint.moduleKey === party.moduleId,
  );
  if (page === undefined || page.routePath.includes(':') || page.routePath.includes('*')) {
    return yield* fail('Party Registry must declare an admitted concrete canonical page');
  }
  if (party.federation.execution !== 'browser') {
    return yield* fail('the admitted Party page must have a browser federation manifest');
  }
  return {
    moduleIds: approved.composition.modules.map(({ moduleId }) => moduleId),
    party: {
      apiBaseUrl: moduleReleaseApiBaseUrl(party.deployment.appId, party.deployment.buildMarker),
      appId: party.deployment.appId,
      buildMarker: party.deployment.buildMarker,
      componentKey: page.componentKey,
      entrypointKey: page.entrypoint.entrypointKey,
      expose: page.expose,
      federationManifest: party.federation.manifest,
      moduleId: party.moduleId,
      ownerPagePath: `/en${page.routePath}`,
      remoteName: party.federation.remoteName,
      routePath: page.routePath,
      shellPagePath: `/en${page.routePath}`,
    },
    revision: approved.composition.revision,
  };
});

const readLocalArtifact = (output: string, origin: string, artifactPath: string) =>
  Effect.gen(function* readArtifact() {
    const fileSystem = yield* FileSystem.FileSystem;
    const artifact: ObservedArtifact = {
      bytes: yield* fileSystem.readFile(path.join(output, 'public', artifactPath)),
      url: new URL(artifactPath, origin).href,
    };
    return artifact;
  });

const verifyLocalOutput = (output: string, appId: string) =>
  Effect.gen(function* verifyOutput() {
    const envelope = yield* Effect.tryPromise({
      catch: () => fail(`the ${appId} local Worker does not have a valid native release envelope`),
      try: async () => await verifyCloudflareReleaseEnvelopeStaging(output),
    });
    if (envelope === undefined || envelope.identity.unitId !== `app/${appId}`) {
      return yield* fail(`the ${appId} local Worker has a different native deployment identity`);
    }
    return envelope;
  });

/** A native Shell UI delivery unit reports Worker metadata, rather than a microvertical release envelope. */
const readLocalShellIdentity = Effect.gen(function* localShellIdentity() {
  const fileSystem = yield* FileSystem.FileSystem;
  return (output: string) =>
    fileSystem.readFileString(path.join(output, 'server/modern-worker-manifest.json')).pipe(
      Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(ShellLocalWorkerManifestSchema))),
      Effect.map(({ deliveryUnit }) => deliveryUnit),
    );
});

const prepareCommand = Command.make(
  'prepare',
  {
    intentFile: Flag.String('intent-file'),
    ownersFile: Flag.String('owners-file'),
    pathsFile: Flag.String('paths-file'),
    shellOrigin: Flag.String('shell-origin'),
    shellOutput: Flag.String('shell-output'),
    snapshotFile: Flag.String('snapshot-file'),
  },
  (input) =>
    Effect.gen(function* prepareLocalTopologyFixture() {
      const fileSystem = yield* FileSystem.FileSystem;
      const shellUrl = URL.parse(input.shellOrigin);
      if (shellUrl === null || !isLoopbackHostname(shellUrl.hostname) || shellUrl.origin !== input.shellOrigin) {
        return yield* fail('the topology Shell must have an explicit canonical local origin');
      }
      const intent = yield* Schema.decodeEffect(Schema.fromJsonString(ApplicationReleaseIntentSchema), {
        onExcessProperty: 'error',
      })(yield* fileSystem.readFileString(input.intentFile));
      const owners = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Array(LocalTopologyOwnerSchema)), {
        onExcessProperty: 'error',
      })(yield* fileSystem.readFileString(input.ownersFile));
      const intendedIds = new Set(intent.modules.map(({ appId }) => appId));
      if (
        intendedIds.size !== intent.modules.length ||
        owners.length !== intendedIds.size ||
        new Set(owners.map(({ appId }) => appId)).size !== owners.length ||
        owners.some(({ appId }) => !intendedIds.has(appId))
      ) {
        return yield* fail('local owners must match the complete reviewed module intent exactly');
      }
      const shellIdentity = yield* (yield* readLocalShellIdentity)(input.shellOutput);
      const modules = yield* Effect.forEach(
        owners,
        (owner) =>
          Effect.gen(function* observeLocalOwner() {
            const envelope = yield* verifyLocalOutput(owner.outputDirectory, owner.appId);
            if (envelope.identity.sourceRevision !== shellIdentity.sourceRevision) {
              return yield* fail('all local Worker outputs must come from the same native source revision');
            }
            const contract = yield* readLocalArtifact(owner.outputDirectory, owner.baseUrl, ONTOS_MODULE_CONTRACT_PATH);
            const decoded = yield* Schema.decodeEffect(contractJson)(new TextDecoder().decode(contract.bytes));
            if (decoded.deployment.buildMarker !== envelope.identity.buildMarker) {
              return yield* fail(`the ${owner.appId} contract differs from its native executable marker`);
            }
            const common: ObservedModuleDeployment = {
              appId: owner.appId,
              backend: { baseUrl: owner.baseUrl, transport: 'node-http' },
              contract,
            };
            return decoded.manifest.publicSurface.components.length === 0
              ? common
              : {
                  ...common,
                  federationManifest: yield* readLocalArtifact(
                    owner.outputDirectory,
                    owner.baseUrl,
                    '/mf-manifest.json',
                  ),
                };
          }),
        { concurrency: 1 },
      );
      const snapshot = yield* deriveActiveApplicationCompositionSnapshot({
        environment: 'development',
        modules,
        observedAt: yield* DateTime.now,
        shell: {
          federationManifest: yield* readLocalArtifact(input.shellOutput, input.shellOrigin, '/mf-manifest.json'),
          runtimeContract: yield* readLocalArtifact(
            input.shellOutput,
            input.shellOrigin,
            ONTOS_SHELL_RUNTIME_CONTRACT_PATH,
          ),
        },
        validity: Duration.minutes(30),
      });
      if (snapshot.composition.shell.deployment.buildMarker !== shellIdentity.buildMarker) {
        return yield* fail('the local Shell contract differs from its native executable marker');
      }
      const paths = yield* deriveLocalTopologyProofPaths(snapshot);
      yield* fileSystem.writeFileString(
        input.snapshotFile,
        yield* encodeActiveApplicationCompositionSnapshot(snapshot),
      );
      yield* fileSystem.writeFileString(
        input.pathsFile,
        yield* Schema.encodeEffect(Schema.fromJsonString(LocalTopologyProofPathsSchema))(paths),
      );
      return yield* Effect.void;
    }),
);

const requireLocalDatabase = Effect.gen(function* localAuthorityDatabase() {
  const [runtimeUrl, adminUrl] = yield* Effect.all([
    Config.Redacted('DATABASE_URL'),
    Config.Redacted('DATABASE_ADMIN_URL'),
  ]);
  const connections = yield* parseDatabaseConnectionPair({
    DATABASE_ADMIN_URL: Redacted.value(adminUrl),
    DATABASE_URL: Redacted.value(runtimeUrl),
  });
  if (!isLoopbackHostname(connections.admin.host) || !isLoopbackHostname(connections.runtime.host)) {
    return yield* fail('composition authority fixtures may use only explicit local PostgreSQL endpoints');
  }
  return yield* Effect.void;
});

const operateLocalAuthority = Effect.fn('CloudflareLocalTopology.authority')(function* ownLocalAuthority(
  operation: 'seed' | 'cleanup',
  snapshot: ActiveApplicationCompositionSnapshot,
) {
  const database = yield* CoreDatabase;
  return yield* database.executor.transaction((transaction) =>
    Effect.gen(function* ownAuthorityRow() {
      yield* lockApplicationCompositionPublication(transaction);
      const existing = yield* transaction.select().from(applicationCompositionAuthority);
      if (operation === 'seed') {
        if (existing.length !== 0) {
          return yield* fail('the local topology proof requires a fresh empty composition authority');
        }
        yield* publishApplicationCompositionAuthority(
          transaction,
          yield* validateActiveApplicationCompositionSnapshot(snapshot),
        );
      } else if (existing.length !== 0) {
        const [current] = existing;
        if (
          existing.length !== 1 ||
          current?.revision !== snapshot.composition.revision ||
          current.validUntil.getTime() !== DateTime.toEpochMillis(snapshot.validUntil) ||
          current.phase !== 'active' ||
          current.durableWorkAdmission !== 'open'
        ) {
          return yield* fail('the topology fixture no longer owns this composition authority');
        }
        yield* transaction
          .delete(applicationCompositionAuthority)
          .where(
            and(
              eq(applicationCompositionAuthority.authorityKey, 'active'),
              eq(applicationCompositionAuthority.revision, snapshot.composition.revision),
              eq(applicationCompositionAuthority.validUntil, DateTime.toDateUtc(snapshot.validUntil)),
              eq(applicationCompositionAuthority.phase, 'active'),
              eq(applicationCompositionAuthority.durableWorkAdmission, 'open'),
            ),
          );
      }
      return yield* Effect.void;
    }),
  );
});

const authorityCommand = (operation: 'seed' | 'cleanup') =>
  Command.make(operation, { snapshotFile: Flag.String('snapshot-file') }, ({ snapshotFile }) =>
    Effect.gen(function* localAuthorityFixture() {
      const fileSystem = yield* FileSystem.FileSystem;
      const snapshot = yield* decodeActiveApplicationCompositionSnapshot(
        yield* fileSystem.readFileString(snapshotFile),
      );
      yield* operateLocalAuthority(operation, snapshot);
    }).pipe(Effect.scoped),
  ).pipe(
    Command.provide(() =>
      Layer.unwrap(requireLocalDatabase.pipe(Effect.as(ApplicationCompositionAuthorityAdminDatabaseLive))),
    ),
  );

const command = Command.make('cloudflare-local-topology-fixture').pipe(
  Command.withSubcommands([prepareCommand, authorityCommand('seed'), authorityCommand('cleanup')]),
);

if (import.meta.main) {
  NodeRuntime.runMain(
    Layer.build(
      Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(Layer.provide(NodeServices.layer)),
    ).pipe(Effect.scoped),
  );
}
