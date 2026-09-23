import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';

export const backendFederationContract = {
  compatibility: {
    build: ultramodernApiMarker.build,
    contractVersion: 'microvertical-server-effect-v1',
    nodeAdapterVersion: 'backend-mf-effect-v1',
    packageName: ultramodernApiMarker.packageName,
    sourceRevision: ultramodernApiMarker.sourceRevision,
    unitId: ultramodernApiMarker.unitId,
  },
  contractVersion: 'microvertical-server-effect-v1',
  executionSurfaces: ['node-mf-runtime'],
  exposes: ['./effect-api'],
  name: 'verticalCommerceMarketCatalogBackend',
  nodeAdapterVersion: 'backend-mf-effect-v1',
  openapiPath: '/commerce-market-catalog-api/openapi.json',
  readinessPath: '/commerce-market-catalog-api/commerce-market-catalog/readiness',
  role: 'microvertical-server',
  runtimeFramework: 'effect',
  strictEffectApproach: true,
} as const;

export { default, default as runtime } from './index.ts';
export {
  commerceMarketCatalogApi as api,
  commerceMarketCatalogApiContract as contract,
  commerceMarketCatalogOperationContexts as operationContexts,
} from '../shared/api.ts';
