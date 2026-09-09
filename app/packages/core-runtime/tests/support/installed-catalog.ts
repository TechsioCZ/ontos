import type { InstalledModuleCatalog, OntosModuleDeploymentContract } from '../../src/index.ts';

export const makeInstalledCatalogFixture = (
  ...contracts: readonly OntosModuleDeploymentContract[]
): InstalledModuleCatalog => {
  const byModuleId = new Map(contracts.map((item) => [item.manifest.module.id, item]));
  return Object.freeze({
    contracts: Object.freeze([...contracts]),
    deploymentAppIds: Object.freeze(contracts.map(({ deployment }) => deployment.appId)),
    deploymentStatuses: Object.freeze(
      contracts.map((contract) => ({
        appId: contract.deployment.appId,
        moduleId: contract.manifest.module.id,
        status: 'available' as const,
      })),
    ),
    getByDeploymentAppId: (appId: string) => contracts.find(({ deployment }) => deployment.appId === appId),
    getByModuleId: (moduleId: string) => byModuleId.get(moduleId),
    moduleIds: Object.freeze(contracts.map(({ manifest }) => manifest.module.id)),
    outboxSubscriptions: Object.freeze([]),
  });
};
