import type { InstalledModuleKey, ModuleStateAccessKind } from '@app/shared-contracts';

export type ShellModuleEntrypointKind = 'component' | 'page';

export interface ShellModuleEntrypoint {
  readonly accessKind: Extract<ModuleStateAccessKind, 'load'>;
  readonly id: string;
  readonly kind: ShellModuleEntrypointKind;
  readonly moduleKey: InstalledModuleKey;
  readonly remoteSpecifier: string;
}

export const shellModuleEntrypoints = {
  ticketingPage: {
    accessKind: 'load',
    id: 'ticketing.page',
    kind: 'page',
    moduleKey: 'ticketing',
    remoteSpecifier: 'ticketing/Route',
  },
  ticketingWidget: {
    accessKind: 'load',
    id: 'ticketing.widget',
    kind: 'component',
    moduleKey: 'ticketing',
    remoteSpecifier: 'ticketing/Widget',
  },
} as const satisfies Record<string, ShellModuleEntrypoint>;
