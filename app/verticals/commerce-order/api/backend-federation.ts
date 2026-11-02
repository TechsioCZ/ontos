import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';

export const backendFederationContract = {
  compatibility: {
    build: ultramodernApiMarker.build,
    contractVersion: 'microvertical-server-effect-v1',
    nodeAdapterVersion: 'backend-mf-effect-v2',
    packageName: ultramodernApiMarker.packageName,
    sourceRevision: ultramodernApiMarker.sourceRevision,
    unitId: ultramodernApiMarker.unitId,
  },
  contractVersion: 'microvertical-server-effect-v1',
  executionSurfaces: ['node-mf-runtime'],
  exposes: ['./effect-api'],
  name: 'verticalCommerceOrderBackend',
  nodeAdapterVersion: 'backend-mf-effect-v2',
  openapiPath: '/commerce-order-api/openapi.json',
  readinessPath: '/commerce-order-api/commerce-order/readiness',
  role: 'microvertical-server',
  runtimeFramework: 'effect',
  strictEffectApproach: true,
} as const;

export { default, default as runtime } from './index.ts';
export {
  commerceOrderApi as api,
  commerceOrderApiContract as contract,
  commerceOrderOperationContexts as operationContexts,
} from '../shared/api.ts';
