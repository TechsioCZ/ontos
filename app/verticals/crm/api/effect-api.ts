import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';
import { crmApi } from '../shared/api.ts';

export const backendFederationContract = {
  compatibility: {
    build: ultramodernApiMarker.build,
    contractVersion: 'microvertical-server-effect-v1',
    nodeAdapterVersion: 'backend-mf-effect-v1',
    packageName: '@app/crm',
    sourceRevision: ultramodernApiMarker.sourceRevision,
    unitId: ultramodernApiMarker.unitId,
  },
  executionSurfaces: ['node-mf-runtime'],
  exposes: ['./effect-api'],
  name: 'verticalCrmBackend',
  openapiPath: '/crm-api/openapi.json',
  readinessPath: '/crm-api/crm/readiness',
  role: 'microvertical-server',
  runtimeFramework: 'effect',
  strictEffectApproach: true,
} as const;

export { default, default as runtime } from './index.ts';
export {
  crmApiContract as contract,
  crmOperationContexts as operationContexts,
} from '../shared/api.ts';
export const api: unknown = crmApi;
