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
import { validateShellContributions } from './shell-contribution.ts';
import type { TenantModuleStateValidationUnavailableError } from './tenant-module-state-errors.ts';

export class OntosModuleCatalogValidationError extends Schema.TaggedError<OntosModuleCatalogValidationError>()(
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

export type InstalledDeploymentFailureReason = 'incompatible' | 'timeout' | 'unavailable';

export type InstalledDeploymentStatus =
  | {
      readonly appId: OntosDeploymentAppId;
      readonly moduleId: OntosModuleId;
      readonly status: 'available';
    }
  | {
      readonly appId: OntosDeploymentAppId;
      readonly reason: InstalledDeploymentFailureReason;
      readonly status: 'unavailable';
    }
  | {
      readonly appId: OntosDeploymentAppId;
      readonly status: 'disabled' | 'revoked';
    };

type AuthoritativeInstalledDeploymentStatus = Extract<
  InstalledDeploymentStatus,
  { readonly status: 'disabled' | 'revoked' }
>;

export type InstalledDeploymentResolutionInput =
  | ({ readonly outcome: 'fetched' } & InstalledDeploymentContractInput)
  | {
      readonly expectedAppId: OntosDeploymentAppId;
      readonly outcome: 'failed';
      readonly reason: InstalledDeploymentFailureReason;
    }
  | {
      readonly expectedAppId: OntosDeploymentAppId;
      readonly outcome: 'disabled' | 'revoked';
    };

export interface InstalledModuleCatalog {
  readonly contracts: readonly OntosModuleDeploymentContract[];
  readonly deploymentAppIds: readonly OntosDeploymentAppId[];
  readonly deploymentStatuses: readonly InstalledDeploymentStatus[];
  readonly getByDeploymentAppId: (
    appId: OntosDeploymentAppId,
  ) => OntosModuleDeploymentContract | undefined;
  readonly getByModuleId: (moduleId: OntosModuleId) => OntosModuleDeploymentContract | undefined;
  readonly moduleIds: readonly OntosModuleId[];
  readonly outboxSubscriptions: readonly OntosOutboxSubscriptionContract[];
}

export interface InstalledModuleCatalogServiceContract {
  readonly load: Effect.Effect<InstalledModuleCatalog, TenantModuleStateValidationUnavailableError>;
}

export class InstalledModuleCatalogService extends Context.Service<
  InstalledModuleCatalogService,
  InstalledModuleCatalogServiceContract
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
  const { publicSurface } = contract.manifest;
  try {
    validateShellContributions(publicSurface.shellContributions, {
      actionKeys: new Set(publicSurface.actions.map(({ actionKey }) => actionKey)),
      apiKeys: new Set(publicSurface.api.map(({ key }) => key)),
      componentKeys: new Set(publicSurface.components.map(({ key }) => key)),
      moduleId: contract.manifest.module.id,
      reportKeys: new Set(publicSurface.reports.map(({ key }) => key)),
      resourceTypeKeys: new Set(publicSurface.resourceTypes.map(({ key }) => key)),
      searchKeys: new Set(publicSurface.search.map(({ key }) => key)),
    });
  } catch {
    throw invalid('deployment contract contains invalid Shell contribution references');
  }
  return contract;
};

const validateOwnedOutboxSubscriptions = (contract: OntosModuleDeploymentContract): void => {
  const moduleId = contract.manifest.module.id;
  const workerKeys = new Set<string>();
  for (const subscription of contract.runtime.outboxSubscriptions) {
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
  }
};

const assembleInstalledModuleCatalog = (
  contractsInput: readonly OntosModuleDeploymentContract[],
  deploymentStatuses: readonly InstalledDeploymentStatus[],
): InstalledModuleCatalog => {
  const byAppId = new Map(
    contractsInput.map((contract) => [contract.deployment.appId, contract] as const),
  );
  const byModuleId = new Map(
    contractsInput.map((contract) => [contract.manifest.module.id, contract] as const),
  );
  const outboxSubscriptions = Object.freeze(
    contractsInput
      .flatMap(({ runtime }) => runtime.outboxSubscriptions)
      .toSorted((left, right) => left.workerKey.localeCompare(right.workerKey)),
  );
  const contracts = Object.freeze(
    [...contractsInput].toSorted((left, right) =>
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
    deploymentStatuses: Object.freeze(
      deploymentStatuses
        .map((status) => Object.freeze({ ...status }))
        .toSorted((left, right) => left.appId.localeCompare(right.appId)),
    ),
    getByDeploymentAppId: (appId: OntosDeploymentAppId) => byAppId.get(appId),
    getByModuleId: (moduleId: OntosModuleId) => byModuleId.get(moduleId),
    moduleIds,
    outboxSubscriptions,
  });
};

const collectAuthoritativeDeploymentStatuses = (
  inputs: readonly InstalledDeploymentResolutionInput[],
): ReadonlyMap<OntosDeploymentAppId, AuthoritativeInstalledDeploymentStatus> => {
  const statuses = new Map<OntosDeploymentAppId, AuthoritativeInstalledDeploymentStatus>();
  for (const input of inputs) {
    if (input.outcome === 'revoked') {
      statuses.set(input.expectedAppId, { appId: input.expectedAppId, status: 'revoked' });
    } else if (
      input.outcome === 'disabled' &&
      statuses.get(input.expectedAppId)?.status !== 'revoked'
    ) {
      statuses.set(input.expectedAppId, { appId: input.expectedAppId, status: 'disabled' });
    }
  }
  return statuses;
};

/** Pure, all-or-nothing aggregation of already fetched deployment documents. */
export const buildInstalledModuleCatalog = (
  inputs: readonly InstalledDeploymentContractInput[],
): InstalledModuleCatalog => {
  const byAppId = new Map<string, OntosModuleDeploymentContract>();
  const byModuleId = new Map<string, OntosModuleDeploymentContract>();
  for (const input of inputs) {
    const contract = decodeContract(input);
    validateOwnedOutboxSubscriptions(contract);
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
  for (const contract of byModuleId.values()) {
    for (const { workerKey } of contract.runtime.outboxSubscriptions) {
      if (workerKeys.has(workerKey)) {
        throw invalid('an Outbox worker key may appear only once in the installed catalog');
      }
      workerKeys.add(workerKey);
    }
  }
  return assembleInstalledModuleCatalog(
    [...byModuleId.values()],
    [...byAppId.values()].map((contract) => ({
      appId: contract.deployment.appId,
      moduleId: contract.manifest.module.id,
      status: 'available',
    })),
  );
};

/** Resolves each installed deployment independently while excluding contradictory candidates. */
export const resolveInstalledModuleCatalog = (
  inputs: readonly InstalledDeploymentResolutionInput[],
): InstalledModuleCatalog => {
  const authoritativeStatuses = collectAuthoritativeDeploymentStatuses(inputs);
  const statuses = new Map<OntosDeploymentAppId, InstalledDeploymentStatus>();
  const candidates: OntosModuleDeploymentContract[] = [];
  for (const input of inputs) {
    const authoritative = authoritativeStatuses.get(input.expectedAppId);
    if (authoritative !== undefined) {
      statuses.set(input.expectedAppId, authoritative);
    } else if (input.outcome === 'fetched') {
      try {
        const contract = decodeContract(input);
        validateOwnedOutboxSubscriptions(contract);
        candidates.push(contract);
      } catch {
        statuses.set(input.expectedAppId, {
          appId: input.expectedAppId,
          reason: 'incompatible',
          status: 'unavailable',
        });
      }
    } else {
      statuses.set(
        input.expectedAppId,
        input.outcome === 'failed'
          ? {
              appId: input.expectedAppId,
              reason: input.reason,
              status: 'unavailable',
            }
          : { appId: input.expectedAppId, status: input.outcome },
      );
    }
  }

  const conflictingAppIds = new Set<OntosDeploymentAppId>();
  const byAppId = new Map<OntosDeploymentAppId, OntosModuleDeploymentContract[]>();
  const byModuleId = new Map<OntosModuleId, OntosModuleDeploymentContract[]>();
  const byWorkerKey = new Map<string, OntosModuleDeploymentContract[]>();
  for (const contract of candidates) {
    const {
      deployment: { appId },
      manifest: {
        module: { id: moduleId },
      },
    } = contract;
    byAppId.set(appId, [...(byAppId.get(appId) ?? []), contract]);
    byModuleId.set(moduleId, [...(byModuleId.get(moduleId) ?? []), contract]);
    for (const { workerKey } of contract.runtime.outboxSubscriptions) {
      byWorkerKey.set(workerKey, [...(byWorkerKey.get(workerKey) ?? []), contract]);
    }
  }
  for (const conflicts of [...byAppId.values(), ...byModuleId.values(), ...byWorkerKey.values()]) {
    if (conflicts.length > 1) {
      for (const contract of conflicts) {
        conflictingAppIds.add(contract.deployment.appId);
      }
    }
  }

  const healthy = candidates.filter(
    (contract) => !conflictingAppIds.has(contract.deployment.appId),
  );
  for (const contract of candidates) {
    const {
      deployment: { appId },
    } = contract;
    statuses.set(
      appId,
      conflictingAppIds.has(appId)
        ? { appId, reason: 'incompatible', status: 'unavailable' }
        : { appId, moduleId: contract.manifest.module.id, status: 'available' },
    );
  }
  return assembleInstalledModuleCatalog(healthy, [...statuses.values()]);
};
