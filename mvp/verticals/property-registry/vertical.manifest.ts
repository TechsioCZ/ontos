import { defineVerticalManifest, moduleFederationRemoteSpecifier } from '@mvp/shared-contracts';
import type { ModuleFederationComponentLocator, VerticalManifest } from '@mvp/shared-contracts';
import { createUnitAction } from './src/actions/create-unit.action.ts';

export const propertyUnitCardLocator = {
  exportName: 'PropertyUnitCard',
  exposedModule: './PropertyUnitCard',
  kind: 'module-federation',
  remote: 'propertyRegistry',
} satisfies ModuleFederationComponentLocator;

export const propertyUnitCardRemoteSpecifier =
  moduleFederationRemoteSpecifier(propertyUnitCardLocator);

export const propertyRegistryManifest = defineVerticalManifest({
  actions: [createUnitAction],
  displayName: 'Property Registry',
  folder: 'property-registry',
  moduleId: 'property.registry',
  publicComponents: [
    {
      key: 'PropertyUnitCard',
      label: 'Property unit card',
      moduleFederation: propertyUnitCardLocator,
      resourceKey: 'property.unit',
    },
  ],
  reports: [
    {
      key: 'property.unit.inventory',
      label: 'Property unit inventory',
      resourceKey: 'property.unit',
    },
  ],
  resources: [
    {
      key: 'property.unit',
      label: 'Property unit',
      ownedByModuleId: 'property.registry',
    },
  ],
  search: [
    {
      key: 'property.unit.search_result',
      label: 'Property unit search result',
      resourceKey: 'property.unit',
    },
  ],
} satisfies VerticalManifest);

export default propertyRegistryManifest;
