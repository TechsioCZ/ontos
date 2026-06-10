import { defineVerticalManifest } from '@mvp/shared-contracts';
import { createUnitAction } from './src/actions/create-unit.action.ts';

export const propertyRegistryManifest = defineVerticalManifest({
  actions: [createUnitAction],
  activationDefault: 'inactive',
  components: [
    {
      displayName: 'Property unit card',
      id: 'PropertyUnitCard',
      locator: {
        exportName: 'PropertyUnitCard',
        exposedModule: './PropertyUnitCard',
        kind: 'module-federation',
        remote: 'propertyRegistry',
      },
    },
  ],
  dependencies: [],
  displayName: 'Property Registry',
  id: 'property.registry',
  kind: 'microvertical',
  reports: [
    {
      displayName: 'Property unit inventory',
      id: 'property.unit.inventory',
    },
  ],
  resources: [
    {
      displayName: 'Property unit',
      id: 'property.unit',
    },
  ],
  search: [
    {
      displayName: 'Property unit search result',
      id: 'property.unit.search_result',
    },
  ],
});
