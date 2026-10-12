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
  name: 'verticalSiamparkBillingFinanceBackend',
  nodeAdapterVersion: 'backend-mf-effect-v2',
  openapiPath: '/siampark-billing-finance-api/openapi.json',
  readinessPath: '/siampark-billing-finance-api/siampark-billing-finance/readiness',
  role: 'microvertical-server',
  runtimeFramework: 'effect',
  strictEffectApproach: true,
} as const;

export { default, default as runtime } from './index.ts';
export {
  siamparkBillingFinanceApi as api,
  siamparkBillingFinanceApiContract as contract,
  siamparkBillingFinanceOperationContexts as operationContexts,
} from '../shared/api.ts';
