import { defineVerticalRegistration, resolveVisibleVerticals } from '@mvp/shared-contracts';
import type {
  ModuleFederationComponentLocator,
  TenantModuleState,
  VerticalRuntimeRegistration,
} from '@mvp/shared-contracts';
import { createUnitHandler } from './src/actions/create-unit.handler.ts';
import { propertyRegistryBoundaryMarker } from './src/boundary-marker.ts';
import { propertyRegistryManifest } from './vertical.manifest.ts';

const notImplemented = () => {
  throw new Error('property.registry runtime implementation is not available in Day 1/2.');
};

export const propertyRegistryRouteLocator = {
  exportName: 'default',
  exposedModule: './Route',
  kind: 'module-federation',
  remote: 'propertyRegistry',
} satisfies ModuleFederationComponentLocator;

export const propertyRegistryRegistration = defineVerticalRegistration({
  boundaryMarker: propertyRegistryBoundaryMarker,
  handlers: {
    'property.registry.createUnit': createUnitHandler,
    'property.unit.inventory': notImplemented,
    'property.unit.search_result': notImplemented,
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

export const propertyRegistryPreviewTenantState = {
  moduleId: 'property.registry',
  state: 'active',
  tenantId: 'tenant.fixture',
} satisfies TenantModuleState;

export const propertyRegistryVisiblePreview = resolveVisibleVerticals(
  [propertyRegistryRegistration],
  [propertyRegistryPreviewTenantState],
);

export default propertyRegistryRegistration;
