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
  name: 'verticalPaymentTermCatalogBackend',
  nodeAdapterVersion: 'backend-mf-effect-v1',
  openapiPath: '/payment-term-catalog-api/openapi.json',
  readinessPath: '/payment-term-catalog-api/payment-term-catalog/readiness',
  role: 'microvertical-server',
  runtimeFramework: 'effect',
  strictEffectApproach: true,
} as const;

export { default, default as runtime } from './index.ts';
export {
  paymentTermCatalogApi as api,
  paymentTermCatalogApiContract as contract,
  paymentTermCatalogOperationContexts as operationContexts,
} from '../shared/api.ts';
