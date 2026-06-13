import { defineVerticalRegistration } from '@mvp/shared-contracts';
import type {
  ModuleFederationComponentLocator,
  TenantModuleState,
  VerticalRuntimeRegistration,
} from '@mvp/shared-contracts';
import { propertyRegistryManifest } from '@mvp/property-registry/vertical.manifest';
import { accountingCoreManifest } from '@mvp/accounting-core/vertical.manifest';

export const DEMO_TENANT_ID = 'tenant.demo' as const;
export const DEMO_LEGAL_ENTITY_ID = 'tenant.demo.main-legal-entity' as const;

const propertyRegistryRouteLocator = {
  exportName: 'default',
  exposedModule: './Route',
  kind: 'module-federation',
  remote: 'propertyRegistry',
} as const satisfies ModuleFederationComponentLocator;

const accountingCoreRouteLocator = {
  exportName: 'default',
  exposedModule: './Route',
  kind: 'module-federation',
  remote: 'accountingCore',
} as const satisfies ModuleFederationComponentLocator;

export const installedVerticalRegistrations = [
  defineVerticalRegistration({
    boundaryMarker: 'verticalPropertyRegistry',
    handlers: {},
    manifest: propertyRegistryManifest,
    navigation: {
      label: 'Property Registry',
      route: '/property-registry',
    },
    routes: [
      {
        label: 'Property Registry',
        moduleFederation: propertyRegistryRouteLocator,
        path: '/property-registry',
      },
    ],
  } satisfies VerticalRuntimeRegistration),
  defineVerticalRegistration({
    boundaryMarker: 'verticalAccountingCore',
    handlers: {},
    manifest: accountingCoreManifest,
    navigation: {
      label: 'Accounting Core',
      route: '/accounting-core',
    },
    routes: [
      {
        label: 'Accounting Core',
        moduleFederation: accountingCoreRouteLocator,
        path: '/accounting-core',
      },
    ],
  } satisfies VerticalRuntimeRegistration),
] as const;

export const CORE_TENANT_MODULE_STATES = [
  {
    moduleId: 'property.registry',
    state: 'active',
    tenantId: DEMO_TENANT_ID,
  },
  {
    moduleId: 'accounting.core',
    state: 'active',
    tenantId: DEMO_TENANT_ID,
  },
] as const satisfies readonly TenantModuleState[];

export const moduleStateVisibilityMatrix = [
  { hiddenFromShell: true, state: 'inactive' },
  { hiddenFromShell: false, state: 'active' },
  { hiddenFromShell: false, state: 'read_only' },
  { hiddenFromShell: true, state: 'suspended' },
  { hiddenFromShell: true, state: 'quarantined' },
  { hiddenFromShell: false, state: 'deprecated' },
  { hiddenFromShell: true, state: 'archived' },
] as const;

export const shellVerticalWidgetSurfaces = {
  'accounting.core': {
    exportName: 'default',
    exposedModule: './Widget',
    kind: 'module-federation',
    remote: 'accountingCore',
  },
  'property.registry': {
    exportName: 'default',
    exposedModule: './Widget',
    kind: 'module-federation',
    remote: 'propertyRegistry',
  },
} as const satisfies Record<string, ModuleFederationComponentLocator>;
