export type ModuleActivationState =
  | 'inactive'
  | 'active'
  | 'read_only'
  | 'suspended'
  | 'quarantined'
  | 'deprecated'
  | 'archived';

export const moduleActivationStates = [
  'inactive',
  'active',
  'read_only',
  'suspended',
  'quarantined',
  'deprecated',
  'archived',
] as const satisfies readonly ModuleActivationState[];

export const visibleModuleActivationStates = [
  'active',
  'read_only',
  'deprecated',
] as const satisfies readonly ModuleActivationState[];

export interface TenantModuleState {
  readonly moduleId: string;
  readonly state: ModuleActivationState;
  readonly tenantId: string;
}

export interface ModuleFederationComponentLocator {
  readonly exposedModule: `./${string}`;
  readonly exportName?: string;
  readonly kind: 'module-federation';
  readonly remote: string;
}

export interface VerticalResourceDescriptor {
  readonly key: string;
  readonly label: string;
  readonly ownedByModuleId: string;
}

export interface VerticalPublicComponentDescriptor {
  readonly key: string;
  readonly label: string;
  readonly moduleFederation: ModuleFederationComponentLocator;
  readonly resourceKey?: string;
}

export interface VerticalActionDescriptor<TRequestSchema = unknown, TResponseSchema = unknown> {
  readonly auditProfile?: 'minimal' | 'standard' | 'sensitive';
  readonly key: string;
  readonly label: string;
  readonly requestSchema: TRequestSchema;
  readonly responseSchema: TResponseSchema;
  readonly targetModuleId: string;
  readonly writesCanonicalRows: boolean;
}

export interface VerticalSearchDescriptor {
  readonly key: string;
  readonly label: string;
  readonly resourceKey: string;
}

export interface VerticalReportDescriptor {
  readonly key: string;
  readonly label: string;
  readonly resourceKey: string;
}

export interface VerticalManifest {
  readonly actions: readonly VerticalActionDescriptor[];
  readonly dependencies?: readonly string[];
  readonly displayName: string;
  readonly folder: string;
  readonly moduleId: string;
  readonly publicComponents: readonly VerticalPublicComponentDescriptor[];
  readonly reports: readonly VerticalReportDescriptor[];
  readonly resources: readonly VerticalResourceDescriptor[];
  readonly search: readonly VerticalSearchDescriptor[];
}

export interface VerticalRouteContribution {
  readonly label: string;
  readonly moduleFederation: ModuleFederationComponentLocator;
  readonly path: `/${string}`;
}

export interface VerticalRuntimeRegistration {
  readonly boundaryMarker: string;
  readonly handlers: Readonly<Record<string, unknown>>;
  readonly manifest: VerticalManifest;
  readonly navigation: {
    readonly label: string;
    readonly route: `/${string}`;
  };
  readonly routes: readonly VerticalRouteContribution[];
}

export const defineVerticalManifest = <const TManifest extends VerticalManifest>(
  manifest: TManifest,
) => manifest;

export const defineVerticalAction = <const TAction extends VerticalActionDescriptor>(
  action: TAction,
) => action;

export const defineVerticalRegistration = <const TRegistration extends VerticalRuntimeRegistration>(
  registration: TRegistration,
) => registration;

export const moduleFederationRemoteSpecifier = (locator: ModuleFederationComponentLocator) =>
  `${locator.remote}/${locator.exposedModule.replace(/^\.\//u, '')}`;

export const isVisibleModuleState = (state: ModuleActivationState) =>
  visibleModuleActivationStates.includes(state as (typeof visibleModuleActivationStates)[number]);

export const resolveVisibleVerticals = <TRegistration extends VerticalRuntimeRegistration>(
  registrations: readonly TRegistration[],
  tenantModuleStates: readonly TenantModuleState[],
) =>
  registrations.filter((registration) => {
    const tenantState = tenantModuleStates.find(
      (item) => item.moduleId === registration.manifest.moduleId,
    );
    return tenantState !== undefined && isVisibleModuleState(tenantState.state);
  });

export type LocaleResource = string | { readonly [key: string]: LocaleResource };

export const flattenLocaleResource = (
  resource: LocaleResource,
  prefix = '',
): Record<string, string> => {
  if (typeof resource === 'string') {
    return prefix.length > 0 ? { [prefix]: resource } : {};
  }

  return Object.fromEntries(
    Object.entries(resource).flatMap(([key, value]) => {
      const nextKey = prefix.length > 0 ? `${prefix}.${key}` : key;
      return typeof value === 'string'
        ? [[nextKey, value]]
        : Object.entries(flattenLocaleResource(value, nextKey));
    }),
  );
};

export const ultramodernWorkspaceContract = {
  ownership: 'topology/ownership.json',
  preset: 'presetUltramodern',
  topology: 'topology/reference-topology.json',
} as const;
