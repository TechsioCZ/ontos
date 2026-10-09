import { createHash } from 'node:crypto';

import {
  ApplicationCompositionSchema,
  canonicalizeApplicationComposition,
  OntosModuleDeploymentContractSchema,
  ONTOS_APPLICATION_COMPOSITION_SCHEMA_VERSION,
  ONTOS_SHELL_CONTRIBUTION_ABI,
  ONTOS_SHELL_RUNTIME_CONTRACT_PATH,
} from '@app/core-runtime';
import type {
  ActiveApplicationCompositionSnapshot,
  ApplicationComposition,
  ApplicationCompositionModule,
  OntosModuleDeploymentContract,
} from '@app/core-runtime';
import { DateTime, Effect, Schema } from 'effect';

import { ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';

export const contentDigest = (document: string): string => createHash('sha256').update(document, 'utf-8').digest('hex');

const shellDeployment = {
  appId: ultramodernDeliveryUnit.appId,
  buildMarker: ultramodernDeliveryUnit.buildMarker,
};
const shellReleaseUrl = `https://${shellDeployment.appId}.example.test/releases/${shellDeployment.buildMarker}/`;
const shellFederationManifestDocument = JSON.stringify({ exposes: [], name: 'shellSuperApp', shared: [] });
const shellRuntimeContractDocument = JSON.stringify({
  contributionAbi: ONTOS_SHELL_CONTRIBUTION_ABI,
  coreCapabilities: [],
  deployment: shellDeployment,
  schemaVersion: '2',
});

/** Test fixtures use native hashing independently of the production verification code. */
export const sealComposition = (composition: ApplicationComposition): ApplicationComposition => ({
  ...composition,
  revision: contentDigest(canonicalizeApplicationComposition({ ...composition, revision: '0'.repeat(64) })),
});

const compositionModule = (contract: OntosModuleDeploymentContract): ApplicationCompositionModule => {
  const contractDocument = JSON.stringify(contract);
  const digest = contentDigest(contractDocument);
  const { components, shellContributions } = contract.manifest.publicSurface;
  const [component] = components;
  return {
    allowedContributions: Object.values(shellContributions).flatMap((items) =>
      items.map(({ contributionKey }) => contributionKey),
    ),
    backend: { baseUrl: `https://${contract.deployment.appId}.example.test/`, transport: 'node-http' },
    contract: {
      sha256: digest,
      url: `https://${contract.deployment.appId}.example.test/.well-known/ontos-module-manifest.json`,
    },
    contractDocument,
    dependencies: [],
    deployment: contract.deployment,
    federation:
      component === undefined
        ? { execution: 'server' }
        : {
            execution: 'browser',
            exposes: components.map(({ expose }) => expose),
            manifest: {
              sha256: contentDigest(`${contract.deployment.buildMarker}-manifest`),
              url: `https://${contract.deployment.appId}.example.test/releases/${contract.deployment.buildMarker}/mf-manifest.json`,
            },
            remoteName: component.mfBoundaryId,
          },
    moduleId: contract.manifest.module.id,
    publicContract: { id: contract.manifest.module.id, sha256: digest, version: contract.schemaVersion },
    requiredCoreCapabilities: [],
    requiredShellAbi: ONTOS_SHELL_CONTRIBUTION_ABI,
    sharedSingletons: [],
  };
};

export const makeCompositionSnapshot = (
  contractInputs: readonly unknown[],
  validityMs = 60_000,
): Effect.Effect<ActiveApplicationCompositionSnapshot> =>
  Effect.gen(function* makeSnapshot() {
    const contracts = contractInputs.map((input) =>
      Schema.decodeUnknownSync(OntosModuleDeploymentContractSchema)(input),
    );
    const composition = sealComposition(
      Schema.decodeUnknownSync(ApplicationCompositionSchema)({
        modules: contracts.map(compositionModule),
        revision: '0'.repeat(64),
        schemaVersion: ONTOS_APPLICATION_COMPOSITION_SCHEMA_VERSION,
        shell: {
          contributionAbi: ONTOS_SHELL_CONTRIBUTION_ABI,
          coreCapabilities: [],
          deployment: shellDeployment,
          federationManifest: {
            sha256: contentDigest(shellFederationManifestDocument),
            url: new URL('mf-manifest.json', shellReleaseUrl).href,
          },
          runtimeContract: {
            sha256: contentDigest(shellRuntimeContractDocument),
            url: new URL(ONTOS_SHELL_RUNTIME_CONTRACT_PATH.slice(1), shellReleaseUrl).href,
          },
          sharedSingletons: [],
        },
      }),
    );
    const observedAt = yield* DateTime.now;
    return { composition, observedAt, validUntil: DateTime.add(observedAt, { milliseconds: validityMs }) };
  });
