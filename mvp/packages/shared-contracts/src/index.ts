export const ultramodernWorkspaceContract = {
  ownership: 'topology/ownership.json',
  preset: 'presetUltramodern',
  topology: 'topology/reference-topology.json',
} as const;

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

export const visibleModuleActivationStates = [
  'active',
  'read_only',
  'deprecated',
] as const satisfies readonly ModuleActivationState[];

export type VisibleModuleActivationState = (typeof visibleModuleActivationStates)[number];

export interface TenantModuleState {
  readonly moduleId: string;
  readonly state: ModuleActivationState;
}

export interface PublicResourceDescriptor {
  readonly id: string;
  readonly displayName: string;
}

export interface PublicComponentDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly locator?: PublicComponentLocator;
}

export interface ModuleFederationComponentLocator {
  readonly kind: 'module-federation';
  readonly remote: string;
  readonly exposedModule: `./${string}`;
  readonly exportName: string;
}

export type PublicComponentLocator = ModuleFederationComponentLocator;

export interface PublicActionDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly inputSchema: unknown;
  readonly outputSchema: unknown;
}

export interface PublicSearchDescriptor {
  readonly id: string;
  readonly displayName: string;
}

export interface PublicReportDescriptor {
  readonly id: string;
  readonly displayName: string;
}

export interface VerticalManifest {
  readonly id: string;
  readonly kind: 'microvertical';
  readonly displayName: string;
  readonly activationDefault: ModuleActivationState;
  readonly dependencies: readonly string[];
  readonly resources: readonly PublicResourceDescriptor[];
  readonly components: readonly PublicComponentDescriptor[];
  readonly actions: readonly PublicActionDescriptor[];
  readonly search: readonly PublicSearchDescriptor[];
  readonly reports: readonly PublicReportDescriptor[];
}

export interface VerticalRouteRegistration {
  readonly path: string;
  readonly navigationLabel: string;
  readonly boundaryMarker: {
    readonly moduleId: string;
    readonly folderName: string;
    readonly renderedFrom: string;
  };
}

export interface VerticalRuntimeRegistration<
  TManifest extends VerticalManifest = VerticalManifest,
> {
  readonly manifest: TManifest;
  readonly route: VerticalRouteRegistration;
  readonly actions: Readonly<Record<string, () => never>>;
  readonly migrations: readonly never[];
  readonly handlers: Readonly<Record<string, () => never>>;
  readonly searchHandlers: Readonly<Record<string, () => never>>;
  readonly reportHandlers: Readonly<Record<string, () => never>>;
}

export const defineVerticalManifest = <const TManifest extends VerticalManifest>(
  manifest: TManifest,
) => manifest;

export const defineVerticalAction = <const TAction extends PublicActionDescriptor>(
  action: TAction,
) => action;

export const defineVerticalRegistration = <const TRegistration extends VerticalRuntimeRegistration>(
  registration: TRegistration,
) => registration;

export const moduleFederationRemoteSpecifier = (locator: ModuleFederationComponentLocator) =>
  `${locator.remote}/${locator.exposedModule.replace(/^\.\//u, '')}`;

export const isVisibleModuleState = (
  state: ModuleActivationState,
): state is VisibleModuleActivationState =>
  visibleModuleActivationStates.includes(state as VisibleModuleActivationState);

export const resolveVisibleVerticals = <const TRegistration extends VerticalRuntimeRegistration>({
  registrations,
  tenantModuleStates,
}: {
  readonly registrations: readonly TRegistration[];
  readonly tenantModuleStates: readonly TenantModuleState[];
}) =>
  registrations.flatMap((registration) => {
    const tenantState = tenantModuleStates.find(
      (moduleState) => moduleState.moduleId === registration.manifest.id,
    );

    if (tenantState === undefined || !isVisibleModuleState(tenantState.state)) {
      return [];
    }

    return [{ ...registration, tenantState }];
  });
