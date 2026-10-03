import assert from 'node:assert/strict';
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import {
  resolveUltramodernReleaseIdentity,
  resolveUltramodernSourceRevision,
} from '@modern-js/app-tools-extensions/release-identity';
import { Array as EffectArray, Console, Effect, FileSystem, Order, Ref, Schema } from 'effect';
import { FetchHttpClient, HttpClient } from 'effect/unstable/http';
import { buildApplicationCompositionCatalog } from '../../packages/core-runtime/src/modules/application-composition-catalog.ts';
import { OntosModuleDeploymentContractSchema } from '../../packages/core-runtime/src/modules/manifest.ts';
import {
  decodeActiveApplicationCompositionSnapshot,
  encodeActiveApplicationCompositionSnapshot,
} from '../active-application-composition.mts';
import { readOutboxWorkerHost } from '../generate-outbox-worker-deployment.mjs';
import {
  deriveHostProofSnapshot,
  HostProofTopologySchema,
  HostWorkerArtifactSchema,
  OutboxWorkerHostProofFixtureError,
  serveHostProofSource,
  verifyHostProofOwnerIdentities,
} from '../outbox-worker-host-proof-fixture.mts';

const nativeHostAdmissionControl = Effect.gen(function* nativeHostAdmissionControls() {
  const workspaceRoot = process.cwd();
  const fileSystem = yield* FileSystem.FileSystem;
  const topology = yield* Schema.decodeEffect(Schema.fromJsonString(HostProofTopologySchema))(
    yield* fileSystem.readFileString('topology/reference-topology.json'),
  );
  const host = yield* readOutboxWorkerHost(workspaceRoot);
  assert.ok(host);
  // Unit control identities derive natively. The packaged shell proof supplies actual compiler metadata.
  const sourceRevision = yield* Effect.try({
    catch: () => new OutboxWorkerHostProofFixtureError({ reason: 'native source identity is unavailable' }),
    try: () => resolveUltramodernSourceRevision(workspaceRoot),
  });
  const ownerBuildIdentities = yield* Effect.try({
    catch: () => new OutboxWorkerHostProofFixtureError({ reason: 'native owner identity is unavailable' }),
    try: () =>
      host.owners.map(({ ownerId }) => {
        const owner = topology.verticals.find(({ id }) => id === ownerId);
        assert.ok(owner);
        return {
          appId: ownerId,
          unitId: owner.deliveryUnit.unitId,
          ...resolveUltramodernReleaseIdentity({
            generationBuildMarker: owner.deliveryUnit.buildMarker,
            sourceRevision,
            unitId: owner.deliveryUnit.unitId,
            workspaceRoot,
          }),
        };
      }),
  });
  const artifact = yield* Schema.decodeEffect(HostWorkerArtifactSchema, { onExcessProperty: 'error' })({
    appId: 'outbox-worker-host',
    entry: 'worker.mjs',
    ownerBuildIdentities,
    schemaVersion: 2,
    serviceId: 'outbox-worker-host',
    sourceInputs: [host.entry],
    sourceRevision,
  });
  const documents = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
  const origin = yield* serveHostProofSource(documents);
  const client = yield* HttpClient.HttpClient;
  assert.equal((yield* client.get(`${origin}/active`)).status, 503);
  const { artifacts, snapshot } = yield* deriveHostProofSnapshot({ artifact, origin, workspaceRoot });
  assert.equal(snapshot.composition.modules.length, topology.verticals.length);
  assert.equal(
    new Set(snapshot.composition.modules.map(({ backend }) => backend.baseUrl)).size,
    topology.verticals.length,
  );
  const contracts = yield* Effect.forEach(
    snapshot.composition.modules,
    ({ contractDocument }) =>
      Schema.decodeEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))(contractDocument),
    { concurrency: 1 },
  );
  const expected = EffectArray.sort(
    contracts.flatMap(({ runtime }) => runtime.outboxSubscriptions),
    Order.mapInput(Order.String, ({ workerKey }: { readonly workerKey: string }) => workerKey),
  );
  assert.ok(expected.length > 0);
  const encoded = yield* encodeActiveApplicationCompositionSnapshot(snapshot);
  const decoded = yield* decodeActiveApplicationCompositionSnapshot(encoded);
  const catalog = yield* buildApplicationCompositionCatalog(decoded.composition);
  assert.deepEqual(catalog.outboxSubscriptions, expected);
  const base = {
    artifact,
    contracts,
    hostedOwnerIds: host.owners.map(({ ownerId }) => ownerId),
    sourceRevision,
    topology,
  };
  yield* verifyHostProofOwnerIdentities(base);
  const [first] = artifact.ownerBuildIdentities;
  assert.ok(first !== undefined);
  for (const alteredIdentities of [
    artifact.ownerBuildIdentities.slice(1),
    [...artifact.ownerBuildIdentities, first],
    [{ ...first, appId: 'extra-owner' }, ...artifact.ownerBuildIdentities.slice(1)],
    [{ ...first, buildMarker: 'wrong-compiled-marker' }, ...artifact.ownerBuildIdentities.slice(1)],
    [{ ...first, sourceRevision: 'wrong-source-revision' }, ...artifact.ownerBuildIdentities.slice(1)],
    [{ ...first, unitId: 'app/wrong-owner' }, ...artifact.ownerBuildIdentities.slice(1)],
  ]) {
    const altered = yield* Schema.decodeEffect(HostWorkerArtifactSchema)({
      ...artifact,
      ownerBuildIdentities: alteredIdentities,
    });
    const rejected = yield* Effect.flip(verifyHostProofOwnerIdentities({ ...base, artifact: altered }));
    assert.ok(Schema.is(OutboxWorkerHostProofFixtureError)(rejected));
  }
  assert.match(
    (yield* Effect.flip(
      verifyHostProofOwnerIdentities({ ...base, artifact: { ...artifact, sourceRevision: 'other-source' } }),
    )).reason,
    /provenance/u,
  );
  assert.match(
    (yield* Effect.flip(verifyHostProofOwnerIdentities({ ...base, contracts: contracts.slice(1) }))).reason,
    /complete topology/u,
  );
  artifacts.set('/active', encoded);
  yield* Ref.set(documents, artifacts);
  const response = yield* client.get(`${origin}/active`);
  assert.equal(response.status, 200);
  assert.equal(yield* response.text, encoded);
  assert.equal((yield* client.get(`${origin}/unknown`)).status, 404);
  for (const module of snapshot.composition.modules) {
    const contractResponse = yield* client.get(module.contract.url);
    assert.equal(contractResponse.status, 200);
    assert.equal(yield* contractResponse.text, module.contractDocument);
  }
  yield* Console.log('complete native host admission controls passed');
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.provide(FetchHttpClient.layer));

if (import.meta.main) {
  NodeRuntime.runMain(nativeHostAdmissionControl);
}
