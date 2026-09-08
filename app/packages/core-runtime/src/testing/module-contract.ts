import type { OntosModuleDeploymentContract } from '../modules/manifest.ts';

interface ModuleContractFixtureOptions<Subscription extends object> {
  readonly appId: string;
  readonly buildMarker?: string;
  readonly description?: string;
  readonly displayName?: string;
  readonly moduleId: string;
  readonly outboxSubscriptions?: readonly Subscription[];
  readonly supportedStates?: OntosModuleDeploymentContract['manifest']['activation']['supportedStates'];
}

export const makeModuleContractFixture = <Subscription extends object = never>({
  appId,
  buildMarker = `${appId}-build`,
  moduleId,
  description = `${moduleId} module`,
  displayName = moduleId,
  outboxSubscriptions = [],
  supportedStates = ['inactive', 'active'],
}: ModuleContractFixtureOptions<Subscription>) => ({
  deployment: { appId, buildMarker },
  manifest: {
    activation: {
      defaultState: 'inactive' as const,
      preservesHistoryWhenInactive: true as const,
      scope: 'tenant' as const,
      supportedStates,
    },
    module: {
      description,
      displayName,
      id: moduleId,
      implementedAs: 'ultramodern_microvertical' as const,
      kind: 'business_module' as const,
    },
    publicSurface: {
      actions: [],
      api: [],
      components: [],
      events: [],
      reports: [],
      resourceTypes: [],
      search: [],
      shellContributions: {
        mediaAttachments: [],
        navigation: [],
        pages: [],
        publicComponents: [],
        reports: [],
        resourceDetails: [],
        search: [],
        timelines: [],
      },
    },
  },
  runtime: { outboxSubscriptions },
  schemaVersion: '2' as const,
});
