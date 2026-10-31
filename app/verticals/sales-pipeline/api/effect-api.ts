import { salesPipelineApi } from '../shared/api.ts';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';

export const backendFederationContract = {
  compatibility: {
    build: ultramodernApiMarker.build,
    contractVersion: 'microvertical-server-effect-v1',
    nodeAdapterVersion: 'backend-mf-effect-v2',
    packageName: '@app/sales-pipeline',
    sourceRevision: ultramodernApiMarker.sourceRevision,
    unitId: ultramodernApiMarker.unitId,
  },
  executionSurfaces: ['node-mf-runtime'],
  exposes: ['./effect-api'],
  name: 'verticalSalesPipelineBackend',
  openapiPath: '/sales-pipeline-api/openapi.json',
  readinessPath: '/sales-pipeline-api/sales-pipeline/readiness',
  role: 'microvertical-server',
  runtimeFramework: 'effect',
  strictEffectApproach: true,
} as const;

export { default, default as runtime } from './index.ts';
export {
  salesPipelineApiContract as contract,
  salesPipelineOperationContexts as operationContexts,
} from '../shared/api.ts';
export const api: unknown = salesPipelineApi;
