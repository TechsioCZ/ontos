import type { InstalledModuleKey } from '@mvp2/shared-contracts';

export interface ShellInstalledModule {
  readonly gatewayAudience: InstalledModuleKey;
  readonly label: string;
  readonly moduleKey: InstalledModuleKey;
  readonly routePath?: string;
  readonly routeRemote?: string;
  readonly widgetRemote: string;
}

export const shellInstalledModules: readonly ShellInstalledModule[] = [
  {
    gatewayAudience: 'properties',
    label: 'Properties',
    moduleKey: 'properties',
    routePath: '/properties/units',
    routeRemote: 'properties/Route',
    widgetRemote: 'properties/Widget',
  },
  {
    gatewayAudience: 'accounting',
    label: 'Accounting',
    moduleKey: 'accounting',
    widgetRemote: 'accounting/Widget',
  },
];
