import { defineVerticalRegistration, resolveVisibleVerticals } from '@mvp/shared-contracts';
import type {
  ModuleFederationComponentLocator,
  TenantModuleState,
  VerticalRuntimeRegistration,
} from '@mvp/shared-contracts';
import { createUnitAction } from './actions/create-unit.action';
import { createUnitHandler } from './actions/create-unit.handler';
import { propertyRegistryBoundaryMarker } from './boundary-marker';
import { propertyRegistryManifest } from './vertical.manifest';

const propertyUnitSearchHandler = () => ({
  items: [],
  reason: 'Day 3 placeholder: no property search index is queried.',
  status: 'not_implemented',
});

const propertyUnitInventoryHandler = () => ({
  canonicalRowsWritten: false,
  reason: 'Day 3 placeholder: no property inventory rows are read or written.',
  status: 'not_implemented',
});

export const propertyRegistryRouteLocator = {
  exportName: 'default',
  exposedModule: './Route',
  kind: 'module-federation',
  remote: 'propertyRegistry',
} satisfies ModuleFederationComponentLocator;

export const propertyRegistryRegistration = defineVerticalRegistration({
  boundaryMarker: propertyRegistryBoundaryMarker,
  handlers: {
    [createUnitAction.key]: createUnitHandler,
    'property.unit.inventory': propertyUnitInventoryHandler,
    'property.unit.search_result': propertyUnitSearchHandler,
  },
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
} satisfies VerticalRuntimeRegistration);

export const propertyRegistryTenantModuleState = {
  moduleId: 'property.registry',
  state: 'active',
  tenantId: 'tenant.demo',
} satisfies TenantModuleState;

export const propertyRegistryVisibleRegistrations = resolveVisibleVerticals(
  [propertyRegistryRegistration],
  [propertyRegistryTenantModuleState],
);

export default propertyRegistryRegistration;
