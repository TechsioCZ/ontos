export const moduleActivationStates = [
  'inactive',
  'active',
  'read_only',
  'suspended',
  'quarantined',
  'deprecated',
  'archived',
] as const;

export type ModuleActivationState = (typeof moduleActivationStates)[number];

export const installedModuleKeys = ['ticketing'] as const;

export type InstalledModuleKey = (typeof installedModuleKeys)[number];

export const moduleStateAccessKinds = ['load', 'read', 'mutate'] as const;

export type ModuleStateAccessKind = (typeof moduleStateAccessKinds)[number];

export interface TenantModuleState {
  readonly moduleKey: InstalledModuleKey;
  readonly state: ModuleActivationState;
}

export const moduleStateAccessMatrix = {
  active: {
    load: true,
    mutate: true,
    read: true,
  },
  archived: {
    load: false,
    mutate: false,
    read: false,
  },
  deprecated: {
    load: true,
    mutate: true,
    read: true,
  },
  inactive: {
    load: false,
    mutate: false,
    read: false,
  },
  quarantined: {
    load: false,
    mutate: false,
    read: false,
  },
  read_only: {
    load: true,
    mutate: false,
    read: true,
  },
  suspended: {
    load: false,
    mutate: false,
    read: false,
  },
} as const satisfies Record<ModuleActivationState, Record<ModuleStateAccessKind, boolean>>;

export const isInstalledModuleKey = (value: string): value is InstalledModuleKey =>
  installedModuleKeys.includes(value as InstalledModuleKey);

export const isModuleActivationState = (value: string): value is ModuleActivationState =>
  moduleActivationStates.includes(value as ModuleActivationState);

export const isModuleStateAccessAllowed = ({
  accessKind,
  state,
}: {
  readonly accessKind: ModuleStateAccessKind;
  readonly state: ModuleActivationState;
}): boolean => moduleStateAccessMatrix[state][accessKind];
