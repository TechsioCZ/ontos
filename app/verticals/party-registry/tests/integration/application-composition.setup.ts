import type { ApplicationComposition } from '@app/core-runtime';
import {
  canonicalizeApplicationComposition,
  canonicalOntosPublicApiKey,
  DatabaseConfig,
  extractVerticalRuntimeSafeDescriptors,
  loadDatabaseConnectionPair,
  OntosModuleDeploymentContractSchema,
  OntosShellRuntimeContractSchema,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { Array as EffectArray, Crypto, DateTime, Effect, FileSystem, Layer, Schema, Semaphore } from 'effect';
import { Hex } from 'effect/encoding';
import { HttpApi } from 'effect/http-api';
import {
  CoreDatabase,
  CoreDatabaseLive,
  publishTestApplicationCompositionAuthority,
} from '@app/core-runtime/testing/owner-evidence';
import { partySourceComponentContracts } from '../fixtures/party-source-components.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { partyRegistryManifest } from '../../vertical.manifest.ts';
import { partyRegistryBackendRegistration } from '../../vertical.runtime-declaration.ts';

class PartySourceCompositionUnavailable extends Schema.TaggedError<PartySourceCompositionUnavailable>()(
  'PartySourceCompositionUnavailable',
  {
    reason: Schema.String,
  },
) {}
const unavailable = () =>
  new PartySourceCompositionUnavailable({
    reason: 'The actual Party source declaration or Shell public metadata is unavailable',
  });
const digest = Effect.fn('PartySourceComposition.digest')(function* digest(document: string) {
  const crypto = yield* Crypto.Crypto;
  return Hex.encode(new Uint8Array(yield* crypto.digest('SHA-256', new TextEncoder().encode(document))));
});
const compareKeys = (left: string, right: string): -1 | 0 | 1 => {
  const compared = left.localeCompare(right);
  if (compared < 0) {
    return -1;
  }
  if (compared > 0) {
    return 1;
  }
  return 0;
};
const fixtureAppId = Schema.NonEmptyString.pipe(Schema.brand('FixtureDeploymentAppId'), Schema.decodeTo(Schema.String));

/** Full SOURCE fixture declarations; this makes no packaged Party browser or backend claim. */
const sourceComposition = Effect.scoped(
  Effect.gen(function* derivePartySourceComposition() {
    const fs = yield* FileSystem.FileSystem;
    const base = yield* makeApplicationCompositionSnapshotFixture(
      [ultramodernApiMarker.appId],
      ultramodernApiMarker.buildMarker,
    );
    const owner = yield* Effect.try({
      catch: unavailable,
      try: () => extractVerticalRuntimeSafeDescriptors(partyRegistryBackendRegistration),
    });
    const manifest = partyRegistryManifest;
    const topology = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(
        Schema.Struct({
          shell: Schema.Struct({ moduleFederation: Schema.Struct({ name: Schema.NonEmptyString }) }),
          verticals: Schema.Array(
            Schema.Struct({
              id: fixtureAppId,
              moduleFederation: Schema.optionalKey(Schema.Struct({ name: Schema.NonEmptyString })),
            }),
          ),
        }),
      ),
    )(yield* fs.readFileString(new URL('../../../../topology/reference-topology.json', import.meta.url).pathname));
    const federation = topology.verticals.find(({ id }) => id === ultramodernApiMarker.appId)?.moduleFederation;
    if (federation === undefined) {
      return yield* unavailable();
    }
    // Owner page bindings plus the module federation config's declared exposures are the SOURCE
    // component metadata; the topology placement only names the Federation boundary.
    const components = yield* partySourceComponentContracts().pipe(Effect.mapError(() => unavailable()));
    const events = yield* Effect.all(
      manifest.publicSurface.events.map((event) =>
        Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))(
          Schema.toJsonSchemaDocument(event.payloadSchema),
        ).pipe(
          Effect.flatMap((document) => digest(`${document}\n`)),
          Effect.map((payloadContract) => ({
            key: event.key,
            owningModuleId: event.owningModuleId,
            payloadContract,
            referencesResourceTypes: event.referencesResourceTypes,
            tense: event.tense,
            visibility: event.visibility,
          })),
        ),
      ),
    );
    const apis = yield* Effect.forEach(Object.entries(manifest.publicSurface.api), ([key, api]) => {
      if (!HttpApi.isHttpApi(api)) {
        return Effect.fail(unavailable());
      }
      return Effect.succeed({
        key: canonicalOntosPublicApiKey(owner.moduleId, key),
        operationKeys: EffectArray.sort(
          Object.values(api.groups).flatMap((group) =>
            Object.values(group.endpoints).map((endpoint) =>
              group.topLevel ? endpoint.identifier : `${group.identifier}.${endpoint.identifier}`,
            ),
          ),
          compareKeys,
        ),
      });
    });
    const authoredManifest = {
      activation: manifest.activation,
      module: manifest.module,
      publicSurface: {
        actions: owner.actions,
        api: apis,
        businessPermissions: manifest.publicSurface.businessPermissions ?? [],
        components,
        events,
        operationContracts: owner.operationContracts,
        reports: manifest.publicSurface.reports,
        resourceTypes: manifest.publicSurface.resourceTypes,
        search: manifest.publicSurface.search,
        shellContributions: owner.shellContributions,
      },
    };
    if (owner.requirements !== undefined) {
      Object.assign(authoredManifest, { requirements: owner.requirements });
    }
    const contract = yield* Schema.decodeUnknownEffect(OntosModuleDeploymentContractSchema, {
      onExcessProperty: 'error',
    })({
      deployment: { appId: ultramodernApiMarker.appId, buildMarker: ultramodernApiMarker.buildMarker },
      manifest: authoredManifest,
      runtime: { outboxSubscriptions: owner.outboxSubscriptions },
      schemaVersion: '2',
    });
    const contractDocument = yield* Schema.encodeEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))(
      contract,
    );
    const sha256 = yield* digest(contractDocument);
    const shellDocument = yield* fs.readFileString(
      new URL('../../../../apps/shell-super-app/dist/public/.well-known/ontos-shell-runtime.json', import.meta.url)
        .pathname,
    );
    const shell = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(OntosShellRuntimeContractSchema))(
      shellDocument,
    );
    const shellFederationPath = new URL('../../../../apps/shell-super-app/.output/mf-manifest.json', import.meta.url)
      .pathname;
    // Node-only CI restores runtime metadata, not a packaged Shell browser build. Missing MF
    // bytes use an explicit SOURCE fixture boundary from the actual topology, with no singleton claim.
    const hasShellFederation = yield* fs.exists(shellFederationPath);
    const shellFederationDocument = hasShellFederation
      ? yield* fs.readFileString(shellFederationPath)
      : yield* Schema.encodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              name: Schema.NonEmptyString,
              shared: Schema.Array(Schema.String),
            }),
          ),
        )({ name: topology.shell.moduleFederation.name, shared: [] });
    const shellFederation = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(
        Schema.Struct({
          shared: Schema.Array(
            Schema.Struct({
              name: Schema.NonEmptyString,
              requiredVersion: Schema.optionalKey(Schema.NonEmptyString),
              singleton: Schema.optionalKey(Schema.Boolean),
            }),
          ),
        }),
      ),
    )(shellFederationDocument);
    const sharedSingletons = yield* Effect.forEach(
      shellFederation.shared.filter(({ singleton }) => singleton === true),
      (entry) =>
        entry.requiredVersion === undefined
          ? Effect.fail(unavailable())
          : Effect.succeed({ packageName: entry.name, version: entry.requiredVersion }),
    );
    const fixtureFederationDocument = yield* Schema.encodeEffect(
      Schema.fromJsonString(
        Schema.Struct({
          exposes: Schema.Array(Schema.String),
          name: Schema.String,
          shared: Schema.Array(Schema.String),
        }),
      ),
    )({ exposes: components.map(({ expose }) => expose), name: federation.name, shared: [] });
    const federationSha256 = yield* digest(fixtureFederationDocument);
    const shellSha256 = yield* digest(shellDocument);
    const shellFederationSha256 = yield* digest(shellFederationDocument);
    const composition = {
      ...base.composition,
      modules: base.composition.modules.map((module) => ({
        ...module,
        allowedContributions: Object.values(owner.shellContributions).flatMap((items) =>
          items.map(({ contributionKey }) => contributionKey),
        ),
        contract: { ...module.contract, sha256 },
        contractDocument,
        dependencies: EffectArray.sort(
          (owner.requirements?.intrinsic ?? []).map(({ moduleId }) => moduleId),
          compareKeys,
        ),
        deployment: contract.deployment,
        federation: {
          execution: 'browser' as const,
          exposes: components.map(({ expose }) => expose),
          manifest: {
            sha256: federationSha256,
            url: `https://party-source-fixture.example/releases/${ultramodernApiMarker.buildMarker}/mf-manifest.json`,
          },
          remoteName: federation.name,
        },
        moduleId: contract.manifest.module.id,
        publicContract: { id: contract.manifest.module.id, sha256, version: contract.schemaVersion },
        requiredCoreCapabilities: owner.requirements?.coreCapabilities ?? [],
        requiredShellAbi: shell.contributionAbi,
      })),
      revision: '0'.repeat(64),
      shell: {
        ...base.composition.shell,
        contributionAbi: shell.contributionAbi,
        coreCapabilities: shell.coreCapabilities,
        deployment: shell.deployment,
        federationManifest: { ...base.composition.shell.federationManifest, sha256: shellFederationSha256 },
        runtimeContract: { ...base.composition.shell.runtimeContract, sha256: shellSha256 },
        sharedSingletons,
      },
    };
    const revision = yield* digest(canonicalizeApplicationComposition(composition));
    return (yield* validateActiveApplicationCompositionSnapshot({
      ...base,
      composition: { ...composition, revision },
    })).composition;
  }),
);

// Only immutable validated metadata is retained after a test has published it.
let preparedComposition: ApplicationComposition | undefined;
const preparation = Semaphore.makeUnsafe(1);

const adminDatabaseLive = CoreDatabaseLive.pipe(
  Layer.provide(
    Layer.effect(
      DatabaseConfig,
      loadDatabaseConnectionPair({ envPath: '/dev/null' }).pipe(Effect.map((connections) => connections.admin)),
    ),
  ),
);
const partyAuthorityBootstrap = Layer.effectDiscard(
  Effect.gen(function* publishPartyCompositionAuthority() {
    const { executor } = yield* CoreDatabase;
    if (preparedComposition !== undefined) {
      return yield* unavailable();
    }
    const composition = yield* sourceComposition;
    const observedAt = yield* DateTime.now;
    const snapshot = yield* validateActiveApplicationCompositionSnapshot({
      composition,
      observedAt,
      validUntil: DateTime.add(observedAt, { hours: 1 }),
    });
    yield* publishTestApplicationCompositionAuthority(executor, snapshot);
    preparedComposition = snapshot.composition;
  }),
).pipe(Layer.provide(Layer.mergeAll(adminDatabaseLive, NodeServices.layer, NodeCrypto.layer)));
// Importing setup never opens a database. The first test observation owns bootstrap and cleanup.
const preparePartyAuthority = preparation.withPermits(1)(
  Effect.suspend(() =>
    preparedComposition === undefined
      ? Effect.scoped(Layer.build(partyAuthorityBootstrap)).pipe(Effect.asVoid)
      : Effect.void,
  ),
);

// Every explicit observation, including publication, uses the calling test's clock and cancellation.
export const partyCompositionSnapshot = Effect.gen(function* observePartyCompositionSnapshot() {
  yield* preparePartyAuthority;
  const composition = preparedComposition;
  if (composition === undefined) {
    return yield* unavailable();
  }
  const observedAt = yield* DateTime.now;
  return yield* validateActiveApplicationCompositionSnapshot({
    composition,
    observedAt,
    validUntil: DateTime.add(observedAt, { hours: 1 }),
  });
});
