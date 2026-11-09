import {
  ActiveApplicationCompositionSnapshotSchema,
  OntosModuleDeploymentContractSchema,
  canonicalOntosPublicApiKey,
  extractVerticalRuntimeSafeDescriptors,
} from '@app/core-runtime';
import { NodeHttpServer } from '@effect/platform-node';
import { Array as EffectArray, Config, Context, Crypto, Effect, FileSystem, Layer, Schema, Stream } from 'effect';
import { Hex } from 'effect/encoding';
import { HttpApi } from 'effect/http-api';
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { ChildProcess } from 'effect/process';

import { catalogManifest } from '../../vertical.manifest.ts';
import { catalogRegistration } from '../../vertical.registration.ts';
import { ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';

class ActualCatalogCompositionUnavailable extends Schema.TaggedError<ActualCatalogCompositionUnavailable>()(
  'ActualCatalogCompositionUnavailable',
  { stage: Schema.String },
) {}
const unavailable = (stage: string) => new ActualCatalogCompositionUnavailable({ stage });
const compareApiKeys = (left: string, right: string): -1 | 0 | 1 => {
  const compared = left.localeCompare(right);
  if (compared < 0) {
    return -1;
  }
  return compared > 0 ? 1 : 0;
};
const digest = Effect.fn('ActualCatalogComposition.digest')(function* digest(document: string) {
  const crypto = yield* Crypto.Crypto;
  return Hex.encode(new Uint8Array(yield* crypto.digest('SHA-256', new TextEncoder().encode(document))));
});

/** Same-running SOURCE metadata, following the existing native owner-intent fixture projection. */
const sourceContract = Effect.fn('ActualCatalogComposition.sourceContract')(function* sourceContract(
  mfBoundaryId: string,
  declaredExposes: ReadonlySet<string>,
) {
  const owner = yield* Effect.try({
    catch: () => unavailable('owner-registration'),
    try: () => extractVerticalRuntimeSafeDescriptors(catalogRegistration),
  });
  const events = yield* Effect.all(
    catalogManifest.publicSurface.events.map((event) =>
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
  const apis = yield* Effect.forEach(Object.entries(catalogManifest.publicSurface.api), ([key, api]) => {
    if (!HttpApi.isHttpApi(api)) {
      return Effect.fail(unavailable('owner-api'));
    }
    return Effect.succeed({
      key: canonicalOntosPublicApiKey(owner.moduleId, key),
      operationKeys: EffectArray.sort(
        Object.values(api.groups).flatMap((group) =>
          Object.values(group.endpoints).map((endpoint) =>
            group.topLevel ? endpoint.identifier : `${group.identifier}.${endpoint.identifier}`,
          ),
        ),
        compareApiKeys,
      ),
    });
  });
  const bindings = [...owner.shellContributions.pages, ...owner.shellContributions.publicComponents];
  const components = yield* Effect.forEach(Object.keys(catalogManifest.publicSurface.components), (localKey) => {
    const key = canonicalOntosPublicApiKey(owner.moduleId, localKey);
    const selectors = new Set(bindings.filter((binding) => binding.componentKey === key).map(({ expose }) => expose));
    const [expose] = selectors;
    if (selectors.size !== 1 || expose === undefined || !declaredExposes.has(expose)) {
      return Effect.fail(unavailable('owner-component'));
    }
    return Effect.succeed({ expose, key, mfBoundaryId });
  });
  const manifest = {
    activation: catalogManifest.activation,
    module: catalogManifest.module,
    publicSurface: {
      actions: owner.actions,
      api: apis,
      businessPermissions: catalogManifest.publicSurface.businessPermissions ?? [],
      components,
      events,
      operationContracts: owner.operationContracts,
      reports: catalogManifest.publicSurface.reports,
      resourceTypes: catalogManifest.publicSurface.resourceTypes,
      search: catalogManifest.publicSurface.search,
      shellContributions: owner.shellContributions,
    },
  };
  if (owner.requirements !== undefined) {
    Object.assign(manifest, { requirements: owner.requirements });
  }
  return yield* Schema.decodeUnknownEffect(OntosModuleDeploymentContractSchema, { onExcessProperty: 'error' })({
    deployment: { appId: ultramodernDeliveryUnit.appId, buildMarker: ultramodernDeliveryUnit.buildMarker },
    manifest,
    runtime: { outboxSubscriptions: owner.outboxSubscriptions },
    schemaVersion: '2',
  });
});

/** Stream source to Node so full owner contracts never become an OS-limited argv entry. */
export const catalogSourceObservationProcess = (
  program: string,
  appRoot: string,
  environment: Readonly<Record<string, string>>,
) =>
  ChildProcess.make(process.execPath, ['--experimental-strip-types', '--input-type=module', '-'], {
    cwd: appRoot,
    env: environment,
    extendEnv: false,
    stderr: 'pipe',
    stdin: Stream.make(new TextEncoder().encode(program)),
    stdout: 'pipe',
  });

/** Actual owner SOURCE identity and observed MF bytes; no deployed backend/browser receipt is claimed. */
export const deriveActualCatalogCompositionSnapshot = Effect.fn('ActualCatalogComposition.make')(function* make(
  appRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const boundarySchema = Schema.Struct({ name: Schema.NonEmptyString });
  const topology = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(
      Schema.Struct({
        shell: Schema.Struct({ moduleFederation: boundarySchema }),
        verticals: Schema.Array(
          Schema.Struct({ id: Schema.String, moduleFederation: Schema.optionalKey(boundarySchema) }),
        ),
      }),
    ),
  )(yield* fs.readFileString(`${appRoot}/topology/reference-topology.json`));
  const owners = topology.verticals.filter(({ id }) => id === ultramodernDeliveryUnit.appId);
  const [owner] = owners;
  if (owners.length !== 1 || owner?.moduleFederation === undefined) {
    return yield* unavailable('owner-component');
  }
  // Same declared exposure extraction as the existing module-contract emitter; no component function is serialized.
  const configuration = yield* fs.readFileString(`${appRoot}/verticals/catalog/module-federation.config.ts`);
  const exposurePattern =
    /['"](?<key>\.\/[A-Za-z][A-Za-z0-9._-]*(?:\/[A-Za-z][A-Za-z0-9._-]*)*)['"]\s*:\s*['"][^'"]+['"]/gu;
  const declaredExposes = new Set<string>();
  for (const match of configuration.matchAll(exposurePattern)) {
    if (match.groups?.key !== undefined) {
      declaredExposes.add(match.groups.key);
    }
  }
  const contract = yield* sourceContract(owner.moduleFederation.name, declaredExposes);
  const contractDocument = yield* Schema.encodeEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))(
    contract,
  );
  const federationSchema = Schema.Struct({
    exposes: Schema.Array(Schema.Struct({ path: Schema.String })),
    name: Schema.String,
    shared: Schema.Array(Schema.Never),
  });
  const catalogManifestPath = `${appRoot}/verticals/catalog/.output/mf-manifest.json`;
  const shellManifestPath = `${appRoot}/apps/shell-super-app/.output/mf-manifest.json`;
  // Backend-only CI uses explicitly SOURCE-native metadata, never an invented browser-build receipt.
  const available = yield* Effect.all({ catalog: fs.exists(catalogManifestPath), shell: fs.exists(shellManifestPath) });
  const observedBuildPair = available.catalog && available.shell;
  const metadata = yield* Effect.all({
    catalog: observedBuildPair
      ? fs.readFileString(catalogManifestPath)
      : Schema.encodeEffect(Schema.fromJsonString(federationSchema))({
          exposes: [...declaredExposes].map((path) => ({ path })),
          name: owner.moduleFederation.name,
          shared: [],
        }),
    shell: observedBuildPair
      ? fs.readFileString(shellManifestPath)
      : Schema.encodeEffect(Schema.fromJsonString(federationSchema))({
          exposes: [],
          name: topology.shell.moduleFederation.name,
          shared: [],
        }),
  });
  const catalogFederationDocument = metadata.catalog;
  const shellFederationDocument = metadata.shell;
  const server = Context.get(yield* Layer.build(NodeHttpServer.layerTest), HttpServer.HttpServer);
  yield* server.serve(
    Effect.gen(function* serveObservedMetadata() {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (request.url === '/catalog/source-native-mf-fixture.json') {
        return HttpServerResponse.text(catalogFederationDocument, { contentType: 'application/json' });
      }
      if (request.url === '/shell-super-app/source-native-mf-fixture.json') {
        return HttpServerResponse.text(shellFederationDocument, { contentType: 'application/json' });
      }
      return HttpServerResponse.empty({ status: 404 });
    }),
  );
  const address = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Number }))(server.address);
  const origin = `http://127.0.0.1:${address.port}`;
  // Reuse the existing media fixture's compiler-SDK Shell identity and canonical publisher observation path.
  const program = `import { DateTime, Duration, Effect, FileSystem, ManagedRuntime, Schema } from 'effect';
    import { NodeServices } from '@effect/platform-node';
    import { resolveUltramodernReleaseIdentity } from '@modern-js/app-tools-extensions/release-identity';
    import { createShellRuntimeContract } from './scripts/generate-ontos-shell-runtime-contract.mts';
    import { deriveActiveApplicationCompositionSnapshot } from './scripts/active-application-composition.mts';
    import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
    import { ActiveApplicationCompositionSnapshotSchema, OntosModuleDeploymentContractSchema, OntosShellRuntimeContractSchema } from '@app/core-runtime';
    const runtime = ManagedRuntime.make(NodeServices.layer);
    try { const text = await runtime.runPromise(Effect.gen(function* deriveActualOwnerComposition() {
      const fs = yield* FileSystem.FileSystem;
      const unit = Schema.Struct({id: Schema.String,
        deliveryUnit: Schema.Struct({buildMarker: Schema.String, unitId: Schema.String})});
      const topology = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({shell: unit})))(
        yield* fs.readFileString('./topology/reference-topology.json'));
      const shellIdentity = yield* Effect.try(() => resolveUltramodernReleaseIdentity({
        generationBuildMarker: topology.shell.deliveryUnit.buildMarker,
        unitId: topology.shell.deliveryUnit.unitId, workspaceRoot: process.cwd()
      }));
      const contractDocument = ${JSON.stringify(contractDocument)};
      const contract = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))(contractDocument);
      const shellRuntime = createShellRuntimeContract(shellIdentity.buildMarker);
      const initial = yield* makeApplicationCompositionSnapshotFixture(['catalog'], contract.deployment.buildMarker);
      const [placement] = initial.composition.modules;
      if (placement === undefined) { throw new Error('Catalog fixture placement is missing'); }
      const shellDocument = yield* Schema.encodeEffect(Schema.fromJsonString(OntosShellRuntimeContractSchema))(shellRuntime);
      const artifact = (url, document) => ({url, bytes: new TextEncoder().encode(document)});
      const composition = yield* deriveActiveApplicationCompositionSnapshot({
        environment: 'development',
        modules: [{appId: contract.deployment.appId, backend: placement.backend,
          contract: artifact(placement.contract.url, contractDocument),
          federationManifest: artifact(${JSON.stringify(`${origin}/catalog/source-native-mf-fixture.json`)}, ${JSON.stringify(catalogFederationDocument)})}],
        observedAt: initial.observedAt,
        shell: {runtimeContract: artifact(initial.composition.shell.runtimeContract.url, shellDocument),
          federationManifest: artifact(${JSON.stringify(`${origin}/shell-super-app/source-native-mf-fixture.json`)}, ${JSON.stringify(shellFederationDocument)})},
        validity: Duration.millis(DateTime.toEpochMillis(initial.validUntil) - DateTime.toEpochMillis(initial.observedAt))
      });
      return yield* Schema.encodeEffect(Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema))(composition);
    })); process.stdout.write(text); } finally { await runtime.dispose(); }`;
  const child = yield* catalogSourceObservationProcess(program, appRoot, {
    APP_ENV_PATH: '/dev/null',
    HOME: yield* Config.String('HOME'),
    PATH: yield* Config.String('PATH'),
    TMPDIR: yield* Config.String('TMPDIR').pipe(Config.withDefault('/tmp')),
  });
  const [output, code] = yield* Effect.all(
    [child.stdout.pipe(Stream.decodeText(), Stream.runCollect), child.exitCode, Stream.runDrain(child.stderr)],
    { concurrency: 3 },
  );
  if (code !== 0) {
    return yield* unavailable('publisher-source-observation');
  }
  const snapshot = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema))(
    output.join(''),
  );
  const selected = snapshot.composition.modules.find(({ moduleId }) => moduleId === contract.manifest.module.id);
  if (
    selected?.deployment.appId !== ultramodernDeliveryUnit.appId ||
    selected.deployment.buildMarker !== ultramodernDeliveryUnit.buildMarker ||
    selected.contractDocument !== contractDocument
  ) {
    return yield* unavailable('same-running-owner-identity');
  }
  return snapshot;
});
