import { siamparkBillingFinanceApi } from '../shared/api.ts';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';

export const backendFederationContract = {
  compatibility: {
    build: ultramodernApiMarker.build,
    contractVersion: 'microvertical-server-effect-v1',
    nodeAdapterVersion: 'backend-mf-effect-v2',
    packageName: '@app/siampark-billing-finance',
    sourceRevision: ultramodernApiMarker.sourceRevision,
    unitId: ultramodernApiMarker.unitId,
  },
  executionSurfaces: ['node-mf-runtime'],
  exposes: ['./effect-api'],
  name: 'verticalSiamparkBillingFinanceBackend',
  openapiPath: '/siampark-billing-finance-api/openapi.json',
  readinessPath: '/siampark-billing-finance-api/siampark-billing-finance/readiness',
  role: 'microvertical-server',
  runtimeFramework: 'effect',
  strictEffectApproach: true,
} as const;

export { default, default as runtime } from './index.ts';
export {
  siamparkBillingFinanceApiContract as contract,
  siamparkBillingFinanceOperationContexts as operationContexts,
} from '../shared/api.ts';
export const api: unknown = siamparkBillingFinanceApi;
