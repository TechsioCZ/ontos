import { Option } from 'effect';
import type { Effect } from 'effect';

import { defineOntosModuleManifest } from '../../src/modules/manifest.ts';
import type { OntosModuleRequirements, OntosOperationContract } from '../../src/modules/manifest.ts';
import {
  defineVerticalRuntimeRegistration,
  extractVerticalRuntimeSafeDescriptors,
} from '../../src/modules/runtime-registration.ts';
import { extractOutboxWorkerSubscriptions } from '../../src/outbox/definition.ts';
import type { AnyOutboxWorkerRegistration } from '../../src/outbox/definition.ts';
import { withWorkerRuntimeBinding } from '../../src/outbox/worker-runtime-binding.ts';
import { freshOutboxWorkerCompositionSnapshot } from './outbox-worker-composition.ts';
import {
  buildNativeOutboxWorkerContracts,
  buildNativeOutboxWorkerComposition,
} from './outbox-worker-native-composition.ts';
import type { NativeOutboxWorkerModuleMetadata } from './outbox-worker-native-composition.ts';

interface AdditionalNativeModule {
  readonly moduleId: string;
  readonly operationContracts?: readonly OntosOperationContract[];
  readonly requirements?: OntosModuleRequirements;
}
interface NativeWorkerCompositionOptions {
  readonly additionalModules?: readonly AdditionalNativeModule[];
  readonly buildSuffix?: string;
  readonly requirements?: Readonly<Record<string, OntosModuleRequirements>>;
}

/** Core synthetic owners only: actual worker values stay outside the pure metadata boundary. */
export const makeNativeOutboxWorkerFixture = (
  registrations: readonly AnyOutboxWorkerRegistration[],
  options: NativeWorkerCompositionOptions = {},
) => {
  const consumerIds = [...new Set(registrations.map(({ descriptor }) => descriptor.consumerModuleKey))].toSorted();
  const ownerMetadata: readonly NativeOutboxWorkerModuleMetadata[] = consumerIds.map((moduleId) => {
    const appId = moduleId.replaceAll('.', '-');
    return {
      appId,
      buildMarker: `${appId}-${options.buildSuffix ?? 'original'}`,
      moduleId,
      requirements: options.requirements?.[moduleId],
      subscriptions: extractOutboxWorkerSubscriptions(
        registrations.filter(({ descriptor }) => descriptor.consumerModuleKey === moduleId),
      ),
    };
  });
  const baseContracts = buildNativeOutboxWorkerContracts(ownerMetadata);
  const owners = baseContracts.map((contract) => {
    const workers = registrations.filter(
      ({ descriptor }) => descriptor.consumerModuleKey === contract.manifest.module.id,
    );
    const manifest = defineOntosModuleManifest({
      ...contract.manifest,
      publicSurface: {
        ...contract.manifest.publicSurface,
        actions: [],
        api: {},
        components: {},
        events: [],
        operationContracts: [],
      },
    });
    const registration = defineVerticalRuntimeRegistration({ actions: [], manifest, outboxWorkers: workers });
    const descriptors = extractVerticalRuntimeSafeDescriptors(registration);
    const metadata: NativeOutboxWorkerModuleMetadata = {
      appId: contract.deployment.appId,
      buildMarker: contract.deployment.buildMarker,
      moduleId: contract.manifest.module.id,
      requirements: descriptors.requirements,
      subscriptions: descriptors.outboxSubscriptions,
    };
    return {
      contract,
      manifest,
      metadata,
      workerKeys: new Set(workers.map(({ descriptor }) => descriptor.workerKey)),
      workers,
    };
  });
  const additionalMetadata: readonly NativeOutboxWorkerModuleMetadata[] = (options.additionalModules ?? []).map(
    ({ moduleId, operationContracts = [], requirements }) => {
      const appId = moduleId.replaceAll('.', '-');
      return {
        appId,
        buildMarker: `${appId}-${options.buildSuffix ?? 'original'}`,
        moduleId,
        operationContracts,
        requirements,
        subscriptions: [],
      };
    },
  );
  const contracts = buildNativeOutboxWorkerContracts([
    ...owners.map(({ metadata }) => metadata),
    ...additionalMetadata,
  ]);
  const composition = buildNativeOutboxWorkerComposition(
    contracts,
    `native-worker-fixture-shell-${options.buildSuffix ?? 'original'}`,
  );
  const authority = { load: freshOutboxWorkerCompositionSnapshot(composition) };
  const bind = <Value, Failure, Requirements>(
    actual: readonly AnyOutboxWorkerRegistration[],
    effect: Effect.Effect<Value, Failure, Requirements>,
  ) => {
    const owner = Option.getOrThrow(
      Option.fromNullishOr(
        owners.find(
          ({ contract, workerKeys }) =>
            actual.length > 0 &&
            actual.every(
              ({ descriptor }) =>
                descriptor.consumerModuleKey === contract.manifest.module.id && workerKeys.has(descriptor.workerKey),
            ),
        ),
      ),
    );
    // Runtime-only handler/lease changes do not change the schema-free published subscription bytes.
    const currentWorkers = owner.workers.map(
      (worker) => actual.find(({ descriptor }) => descriptor.workerKey === worker.descriptor.workerKey) ?? worker,
    );
    const currentOwner = defineVerticalRuntimeRegistration({
      actions: [],
      manifest: owner.manifest,
      outboxWorkers: currentWorkers,
    });
    return withWorkerRuntimeBinding(
      {
        authority,
        expectedDeployment: owner.contract.deployment,
        ownerRegistration: currentOwner,
        registrations: currentWorkers,
      },
      effect,
    );
  };
  return { authority, bind, composition, registrations, revision: composition.revision };
};
