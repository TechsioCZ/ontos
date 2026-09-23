import { commerceMarketCatalogApi } from '../shared/api.ts';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';

export const backendFederationContract = {
  compatibility: {
    build: ultramodernApiMarker.build,
    contractVersion: 'microvertical-server-effect-v1',
    nodeAdapterVersion: 'backend-mf-effect-v1',
    packageName: '@app/commerce-market-catalog',
    sourceRevision: ultramodernApiMarker.sourceRevision,
    unitId: ultramodernApiMarker.unitId,
  },
  executionSurfaces: ['node-mf-runtime'],
  exposes: ['./effect-api'],
  name: 'verticalCommerceMarketCatalogBackend',
  openapiPath: '/commerce-market-catalog-api/openapi.json',
  readinessPath: '/commerce-market-catalog-api/commerce-market-catalog/readiness',
  role: 'microvertical-server',
  runtimeFramework: 'effect',
  strictEffectApproach: true,
} as const;

export { default, default as runtime } from './index.ts';
export {
  commerceMarketCatalogApiContract as contract,
  commerceMarketCatalogOperationContexts as operationContexts,
} from '../shared/api.ts';
export const api: unknown = commerceMarketCatalogApi;
