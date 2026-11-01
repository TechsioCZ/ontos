import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Schema } from 'effect';
import { Hex } from 'effect/encoding';

import {
  canonicalizeApplicationComposition,
  freezeApplicationCompositionArtifact,
  ONTOS_SHELL_CONTRIBUTION_ABI,
} from '../../src/modules/application-composition.ts';
import type {
  ApplicationComposition,
  ApplicationCompositionModule,
} from '../../src/modules/application-composition.ts';
import { OntosModuleDeploymentContractSchema } from '../../src/modules/manifest.ts';
import type { OntosModuleRequirements, OntosOperationContract } from '../../src/modules/manifest.ts';
import type { OutboxWorkerSubscription } from '../../src/outbox/definition.ts';
import { makeModuleContractFixture } from '../../src/testing/module-contract.ts';

/** Schema-free fixture metadata only. Executable owner/worker values belong to the caller. */
export interface NativeOutboxWorkerModuleMetadata {
  readonly appId: string;
  readonly buildMarker: string;
  readonly moduleId: string;
  readonly operationContracts?: readonly OntosOperationContract[];
  readonly requirements: OntosModuleRequirements | undefined;
  readonly subscriptions: readonly OutboxWorkerSubscription[];
}
type NativeModuleContract = typeof OntosModuleDeploymentContractSchema.Type;
const digest = (document: string) => Hex.encode(sha256(utf8ToBytes(document)));
const decodeContract = Schema.decodeUnknownSync(OntosModuleDeploymentContractSchema, { onExcessProperty: 'error' });
const encodeContract = Schema.encodeSync(Schema.fromJsonString(OntosModuleDeploymentContractSchema));
const withFixtureRequirements = <Manifest>(manifest: Manifest, requirements: OntosModuleRequirements | undefined) =>
  requirements === undefined ? manifest : { ...manifest, requirements };

/** Validated compatibility documents authored entirely from closed metadata DTOs. */
export const buildNativeOutboxWorkerContracts = (
  metadata: readonly NativeOutboxWorkerModuleMetadata[],
): readonly NativeModuleContract[] =>
  metadata.map(({ appId, buildMarker, moduleId, operationContracts, requirements, subscriptions }) => {
    const base = makeModuleContractFixture({ appId, buildMarker, moduleId, outboxSubscriptions: subscriptions });
    const manifest = withFixtureRequirements(base.manifest, requirements);
    if (operationContracts === undefined) {
      return decodeContract({ ...base, manifest });
    }
    return decodeContract({
      ...base,
      manifest: {
        ...manifest,
        publicSurface: {
          ...base.manifest.publicSurface,
          api: operationContracts.map(({ apiKey, operationKey }) => ({ key: apiKey, operationKeys: [operationKey] })),
          operationContracts,
        },
      },
    });
  });

/** Content-addressed Composition; neither the input nor output contains executable registrations. */
export const buildNativeOutboxWorkerComposition = (
  contracts: readonly NativeModuleContract[],
  shellBuildMarker: string,
): ApplicationComposition => {
  const modules = contracts.map((contract) => {
    const contractDocument = encodeContract(contract);
    const contractSha256 = digest(contractDocument);
    return {
      allowedContributions: [],
      backend: { baseUrl: `https://${contract.deployment.appId}.example/`, transport: 'node-http' },
      contract: {
        sha256: contractSha256,
        url: `https://${contract.deployment.appId}.example/.well-known/ontos-module-manifest.json`,
      },
      contractDocument,
      dependencies: (contract.manifest.requirements?.intrinsic ?? []).map(({ moduleId }) => moduleId).toSorted(),
      deployment: contract.deployment,
      federation: { execution: 'server' },
      moduleId: contract.manifest.module.id,
      publicContract: { id: contract.manifest.module.id, sha256: contractSha256, version: contract.schemaVersion },
      requiredCoreCapabilities: contract.manifest.requirements?.coreCapabilities ?? [],
      requiredShellAbi: ONTOS_SHELL_CONTRIBUTION_ABI,
      sharedSingletons: [],
    } satisfies ApplicationCompositionModule;
  });
  const candidate: ApplicationComposition = {
    modules,
    revision: '0'.repeat(64),
    schemaVersion: '2',
    shell: {
      contributionAbi: ONTOS_SHELL_CONTRIBUTION_ABI,
      coreCapabilities: [],
      deployment: {
        appId: 'shell-super-app',
        buildMarker: shellBuildMarker,
      },
      federationManifest: { sha256: 'a'.repeat(64), url: 'https://shell.example/mf-manifest.json' },
      runtimeContract: { sha256: 'b'.repeat(64), url: 'https://shell.example/ontos-shell-runtime.json' },
      sharedSingletons: [],
    },
  };
  return freezeApplicationCompositionArtifact({
    ...candidate,
    revision: digest(canonicalizeApplicationComposition(candidate)),
  });
};
