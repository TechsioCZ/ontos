import {
  canonicalizeApplicationComposition,
  canonicalOntosPublicApiKey,
  extractVerticalRuntimeSafeDescriptors,
  OntosModuleDeploymentContractSchema,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Array as EffectArray, Effect, Order, Schema } from 'effect';
import { Hex } from 'effect/encoding';
import { HttpApi } from 'effect/http-api';
import { inventoryManifest } from '../../vertical.manifest.ts';
import { inventoryRegistration } from '../../vertical.registration.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';

class InventorySourceCompositionFixtureUnavailable extends Schema.TaggedError<InventorySourceCompositionFixtureUnavailable>()(
  'InventorySourceCompositionFixtureUnavailable',
  { reason: Schema.String },
) {}
const unavailable = (cause: unknown) =>
  Object.defineProperty(
    new InventorySourceCompositionFixtureUnavailable({
      reason: 'The actual Inventory source fixture contract is unavailable',
    }),
    'cause',
    { value: cause },
  );
const digest = (content: string) => Hex.encode(sha256(utf8ToBytes(content)));

/** Derive the actual owner descriptors; only hosting placement is an internal test fixture. */
export const sourceImportCompositionFixture = Effect.gen(function* sourceImportCompositionFixture() {
  const base = yield* makeApplicationCompositionSnapshotFixture(['inventory'], ultramodernApiMarker.buildMarker);
  const owner = yield* Effect.try({
    catch: unavailable,
    try: () => extractVerticalRuntimeSafeDescriptors(inventoryRegistration),
  });
  const manifest = inventoryManifest;
  const api = yield* Effect.forEach(
    Object.entries(manifest.publicSurface.api),
    ([key, value]) => {
      if (!HttpApi.isHttpApi(value)) {
        return Effect.fail(unavailable('The Inventory API is not an HttpApi'));
      }
      return Effect.succeed({
        key: canonicalOntosPublicApiKey(owner.moduleId, key),
        operationKeys: EffectArray.sort(
          Object.values(value.groups).flatMap((group) =>
            Object.values(group.endpoints).map((endpoint) =>
              group.topLevel ? endpoint.identifier : `${group.identifier}.${endpoint.identifier}`,
            ),
          ),
          Order.String,
        ),
      });
    },
    { concurrency: 1 },
  );
  const events = yield* Effect.forEach(
    manifest.publicSurface.events,
    (event) =>
      Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))(
        Schema.toJsonSchemaDocument(event.payloadSchema),
      ).pipe(
        Effect.map((document) => ({
          key: event.key,
          owningModuleId: event.owningModuleId,
          payloadContract: digest(`${document}\n`),
          referencesResourceTypes: event.referencesResourceTypes,
          tense: event.tense,
          visibility: event.visibility,
        })),
      ),
    { concurrency: 1 },
  );
  const authoredManifest = {
    activation: manifest.activation,
    module: manifest.module,
    originatorActions: manifest.originatorActions ?? [],
    publicSurface: {
      actions: owner.actions,
      api,
      businessPermissions: manifest.publicSurface.businessPermissions ?? [],
      components: Object.values(manifest.publicSurface.components),
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
  const contract = yield* Schema.decodeUnknownEffect(OntosModuleDeploymentContractSchema)({
    deployment: { appId: ultramodernApiMarker.appId, buildMarker: ultramodernApiMarker.buildMarker },
    manifest: authoredManifest,
    runtime: { outboxSubscriptions: owner.outboxSubscriptions },
    schemaVersion: '2',
  });
  const contractDocument = yield* Schema.encodeEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))(
    contract,
  );
  const contractDigest = digest(contractDocument);
  const composition = {
    ...base.composition,
    modules: base.composition.modules.map((module) => ({
      ...module,
      allowedContributions: Object.values(owner.shellContributions).flatMap((items) =>
        items.map(({ contributionKey }) => contributionKey),
      ),
      contract: { ...module.contract, sha256: contractDigest },
      contractDocument,
      dependencies: (owner.requirements?.intrinsic ?? []).map(({ moduleId }) => moduleId),
      deployment: contract.deployment,
      moduleId: owner.moduleId,
      publicContract: { id: owner.moduleId, sha256: contractDigest, version: contract.schemaVersion },
      requiredCoreCapabilities: owner.requirements?.coreCapabilities ?? [],
    })),
    revision: '0'.repeat(64),
  };
  return yield* validateActiveApplicationCompositionSnapshot({
    ...base,
    composition: { ...composition, revision: digest(canonicalizeApplicationComposition(composition)) },
  });
});
