import { priceGroupCatalogApi } from '../shared/api.ts';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';

export const backendFederationContract = {
  compatibility: {
    build: ultramodernApiMarker.build,
    contractVersion: 'microvertical-server-effect-v1',
    nodeAdapterVersion: 'backend-mf-effect-v1',
    packageName: '@app/price-group-catalog',
    sourceRevision: ultramodernApiMarker.sourceRevision,
    unitId: ultramodernApiMarker.unitId,
  },
  executionSurfaces: ['node-mf-runtime'],
  exposes: ['./effect-api'],
  name: 'verticalPriceGroupCatalogBackend',
  openapiPath: '/price-group-catalog-api/openapi.json',
  readinessPath: '/price-group-catalog-api/price-group-catalog/readiness',
  role: 'microvertical-server',
  runtimeFramework: 'effect',
  strictEffectApproach: true,
} as const;

export { default, default as runtime } from './index.ts';
export {
  priceGroupCatalogApiContract as contract,
  priceGroupCatalogOperationContexts as operationContexts,
} from '../shared/api.ts';
export const api: unknown = priceGroupCatalogApi;
