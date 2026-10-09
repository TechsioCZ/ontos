import { createHash } from 'node:crypto';

import { DateTime, Effect, Layer, Schema } from 'effect';

import {
  ActiveApplicationCompositionService,
  validateActiveApplicationCompositionSnapshot,
} from '../../src/modules/active-application-composition.ts';
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
import type { OutboxWorkerSubscription } from '../../src/outbox/definition.ts';
import { makeModuleContractFixture } from '../../src/testing/module-contract.ts';

interface OutboxWorkerCompositionModuleFixture {
  readonly appId: string;
  readonly buildMarker?: string;
  readonly dependencies?: readonly string[];
  readonly moduleId: string;
  readonly subscriptions?: readonly OutboxWorkerSubscription[];
}

const digest = (document: string): string => createHash('sha256').update(document, 'utf-8').digest('hex');
const decodeContract = Schema.decodeUnknownSync(OntosModuleDeploymentContractSchema, { onExcessProperty: 'error' });
const encodeContract = Schema.encodeSync(Schema.fromJsonString(OntosModuleDeploymentContractSchema));

/** Construct exact embedded contracts and the content-addressed revision used by worker startup. */
export const makeOutboxWorkerComposition = (
  modules: readonly OutboxWorkerCompositionModuleFixture[] = [],
): ApplicationComposition => {
  const approvedModules = modules.map(
    ({ appId, buildMarker = `${appId}-build`, dependencies = [], moduleId, subscriptions = [] }) => {
      const contract = decodeContract(
        makeModuleContractFixture({
          appId,
          buildMarker,
          moduleId,
          outboxSubscriptions: subscriptions.map(
            ({ consumerModuleKey, entrypoint, producerModuleKey, topic, workerKey }) => ({
              consumerModuleKey,
              entrypoint,
              producerModuleKey,
              topic,
              workerKey,
            }),
          ),
        }),
      );
      const contractDocument = encodeContract(contract);
      const sha256 = digest(contractDocument);
      return {
        allowedContributions: [],
        backend: { baseUrl: `https://${appId}.example/`, transport: 'node-http' },
        contract: { sha256, url: `https://${appId}.example/.well-known/ontos-module-manifest.json` },
        contractDocument,
        dependencies,
        deployment: contract.deployment,
        federation: { execution: 'server' },
        moduleId,
        publicContract: { id: moduleId, sha256, version: contract.schemaVersion },
        requiredCoreCapabilities: [],
        requiredShellAbi: ONTOS_SHELL_CONTRIBUTION_ABI,
        sharedSingletons: [],
      } satisfies ApplicationCompositionModule;
    },
  );
  const composition: ApplicationComposition = {
    modules: approvedModules,
    revision: '0'.repeat(64),
    schemaVersion: '2',
    shell: {
      contributionAbi: ONTOS_SHELL_CONTRIBUTION_ABI,
      coreCapabilities: [],
      deployment: { appId: 'shell-super-app', buildMarker: 'worker-fixture-shell-build' },
      federationManifest: {
        sha256: 'a'.repeat(64),
        url: 'https://shell.example/releases/worker-fixture-shell-build/mf-manifest.json',
      },
      runtimeContract: {
        sha256: 'b'.repeat(64),
        url: 'https://shell.example/releases/worker-fixture-shell-build/ontos-shell-runtime.json',
      },
      sharedSingletons: [],
    },
  };
  return freezeApplicationCompositionArtifact({
    ...composition,
    revision: digest(canonicalizeApplicationComposition(composition)),
  });
};

/** TestClock and live subprocess fixtures both receive a fresh, fully verified observation. */
export const freshOutboxWorkerCompositionSnapshot = (composition: ApplicationComposition) =>
  DateTime.now.pipe(
    Effect.flatMap((observedAt) =>
      validateActiveApplicationCompositionSnapshot({
        composition,
        observedAt,
        validUntil: DateTime.add(observedAt, { hours: 1 }),
      }),
    ),
  );

export const outboxWorkerCompositionLayer = (composition: ApplicationComposition = makeOutboxWorkerComposition()) =>
  Layer.succeed(ActiveApplicationCompositionService, { load: freshOutboxWorkerCompositionSnapshot(composition) });
