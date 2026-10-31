import { salesInsightsApi } from '../shared/api.ts';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';

export const backendFederationContract = {
  compatibility: {
    build: ultramodernApiMarker.build,
    contractVersion: 'microvertical-server-effect-v1',
    nodeAdapterVersion: 'backend-mf-effect-v2',
    packageName: '@app/sales-insights',
    sourceRevision: ultramodernApiMarker.sourceRevision,
    unitId: ultramodernApiMarker.unitId,
  },
  executionSurfaces: ['node-mf-runtime'],
  exposes: ['./effect-api'],
  name: 'verticalSalesInsightsBackend',
  openapiPath: '/sales-insights-api/openapi.json',
  readinessPath: '/sales-insights-api/sales-insights/readiness',
  role: 'microvertical-server',
  runtimeFramework: 'effect',
  strictEffectApproach: true,
} as const;

export { default, default as runtime } from './index.ts';
export {
  salesInsightsApiContract as contract,
  salesInsightsOperationContexts as operationContexts,
} from '../shared/api.ts';
export const api: unknown = salesInsightsApi;
