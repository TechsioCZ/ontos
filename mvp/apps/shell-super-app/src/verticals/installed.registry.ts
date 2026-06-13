import type { ModuleFederationComponentLocator, TenantModuleState } from '@mvp/shared-contracts';
import { propertyRegistryRegistration } from '@mvp/property-registry/vertical.registration';
import { accountingCoreRegistration } from '@mvp/accounting-core/vertical.registration';

export const DEMO_TENANT_ID = 'tenant.demo' as const;
export const DEMO_LEGAL_ENTITY_ID = 'tenant.demo.main-legal-entity' as const;

export const installedVerticalRegistrations = [
  propertyRegistryRegistration,
  accountingCoreRegistration,
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
