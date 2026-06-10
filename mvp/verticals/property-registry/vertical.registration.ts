import { defineVerticalRegistration } from '@mvp/shared-contracts';
import { createUnitHandler } from './src/actions/create-unit.handler.ts';
import { propertyRegistryBoundaryMarker } from './src/boundary-marker.ts';
import { propertyRegistryManifest } from './vertical.manifest.ts';

const notImplemented = () => {
  throw new Error('property.registry runtime implementation is not available in Day 1/2.');
};

export const propertyRegistryRegistration = defineVerticalRegistration({
  actions: {
    'property.registry.createUnit': createUnitHandler,
  },
  handlers: {},
  manifest: propertyRegistryManifest,
  migrations: [],
  reportHandlers: {
    'property.unit.inventory': notImplemented,
  },
  route: {
    boundaryMarker: propertyRegistryBoundaryMarker,
    navigationLabel: 'Property Registry',
    path: '/property-registry',
  },
  searchHandlers: {
    'property.unit.search_result': notImplemented,
  },
});
