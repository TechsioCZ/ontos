/* eslint-disable max-classes-per-file -- Catalog validation and access failures are separate public contracts. */
import { Context, Schema } from 'effect';
import type { Effect } from 'effect';
import type {
  OntosDeploymentAppId,
  OntosModuleDeploymentContract,
  OntosModuleId,
  OntosOutboxSubscriptionContract,
} from './manifest.ts';
import { decodeOntosModuleDeploymentContract } from './manifest.ts';
import type { TenantModuleStateValidationUnavailableError } from './tenant-module-state-errors.ts';

export class OntosModuleCatalogValidationError extends Schema.TaggedErrorClass<OntosModuleCatalogValidationError>()(
  'OntosModuleCatalogValidationError',
  {
    code: Schema.Literal('ontos_module_catalog_invalid'),
    reason: Schema.String,
  },
) {}

export interface InstalledDeploymentContractInput {
  readonly contract: unknown;
  readonly expectedAppId: OntosDeploymentAppId;
}

export interface InstalledModuleCatalog {
  readonly contracts: readonly OntosModuleDeploymentContract[];
  readonly deploymentAppIds: readonly OntosDeploymentAppId[];
  readonly moduleIds: readonly OntosModuleId[];
  readonly outboxSubscriptions: readonly OntosOutboxSubscriptionContract[];
  readonly getByDeploymentAppId: (
    appId: OntosDeploymentAppId,
  ) => OntosModuleDeploymentContract | undefined;
  readonly getByModuleId: (moduleId: OntosModuleId) => OntosModuleDeploymentContract | undefined;
}

export interface InstalledModuleCatalogServiceShape {
  readonly load: Effect.Effect<InstalledModuleCatalog, TenantModuleStateValidationUnavailableError>;
}

export class InstalledModuleCatalogService extends Context.Service<
  InstalledModuleCatalogService,
  InstalledModuleCatalogServiceShape
>()('@app/core-runtime/modules/catalog/InstalledModuleCatalogService') {}

const invalid = (reason: string): OntosModuleCatalogValidationError =>
  new OntosModuleCatalogValidationError({
    code: 'ontos_module_catalog_invalid',
    reason,
  });

const decodeContract = (input: InstalledDeploymentContractInput): OntosModuleDeploymentContract => {
  let contract: OntosModuleDeploymentContract;
  try {
    contract = decodeOntosModuleDeploymentContract(input.contract);
  } catch {
    throw invalid('an installed deployment returned an invalid or unsupported module contract');
  }
  if (contract.deployment.appId !== input.expectedAppId) {
    throw invalid('deployment contract app ID does not match its allowlisted topology app ID');
  }
  if (contract.manifest.module.kind !== 'business_module') {
    throw invalid('V0 deployments may claim only one business module');
  }
  return contract;
};

/** Pure, all-or-nothing aggregation of already fetched deployment documents. */
export const buildInstalledModuleCatalog = (
  inputs: readonly InstalledDeploymentContractInput[],
): InstalledModuleCatalog => {
  const byAppId = new Map<string, OntosModuleDeploymentContract>();
  const byModuleId = new Map<string, OntosModuleDeploymentContract>();
  for (const input of inputs) {
    const contract = decodeContract(input);
    const {
      deployment: { appId },
      manifest: {
        module: { id: moduleId },
      },
    } = contract;
    if (byAppId.has(appId)) {
      throw invalid('one deployment app ID may appear only once in the installed catalog');
    }
    if (byModuleId.has(moduleId)) {
      throw invalid('one OntOS module ID may be claimed by only one deployment');
    }
    byAppId.set(appId, contract);
    byModuleId.set(moduleId, contract);
  }
  const workerKeys = new Set<string>();
  const outboxSubscriptions = Object.freeze(
    [...byModuleId.entries()]
      .flatMap(([moduleId, contract]) =>
        contract.runtime.outboxSubscriptions.map((subscription) => {
          if (subscription.consumerModuleKey !== moduleId) {
            throw invalid('an Outbox subscription consumer must match its deployment module');
          }
          if (
            subscription.entrypoint.moduleKey !== moduleId ||
            subscription.entrypoint.entrypointKey !== subscription.workerKey
          ) {
            throw invalid('an Outbox subscription entrypoint must match its consumer and worker');
          }
          if (workerKeys.has(subscription.workerKey)) {
            throw invalid('an Outbox worker key may appear only once in the installed catalog');
          }
          workerKeys.add(subscription.workerKey);
          return subscription;
        }),
      )
      .toSorted((left, right) => left.workerKey.localeCompare(right.workerKey)),
  );

  const contracts = Object.freeze(
    [...byModuleId.values()].toSorted((left, right) =>
      left.manifest.module.id.localeCompare(right.manifest.module.id),
    ),
  );
  const deploymentAppIds = Object.freeze(
    [...byAppId.keys()].toSorted((left, right) => left.localeCompare(right)),
  );
  const moduleIds = Object.freeze(
    [...byModuleId.keys()].toSorted((left, right) => left.localeCompare(right)),
  );
  return Object.freeze({
    contracts,
    deploymentAppIds,
    getByDeploymentAppId: (appId: OntosDeploymentAppId) => byAppId.get(appId),
    getByModuleId: (moduleId: OntosModuleId) => byModuleId.get(moduleId),
    moduleIds,
    outboxSubscriptions,
  });
};
