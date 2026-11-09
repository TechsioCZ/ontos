import { symmyIntegrationApi } from '../shared/api.ts';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';

export const backendFederationContract = {
  compatibility: {
    build: ultramodernApiMarker.build,
    contractVersion: 'microvertical-server-effect-v1',
    nodeAdapterVersion: 'backend-mf-effect-v2',
    packageName: '@app/symmy-integration',
    sourceRevision: ultramodernApiMarker.sourceRevision,
    unitId: ultramodernApiMarker.unitId,
  },
  executionSurfaces: ['node-mf-runtime'],
  exposes: ['./effect-api'],
  name: 'verticalSymmyIntegrationBackend',
  openapiPath: '/symmy-integration-api/openapi.json',
  readinessPath: '/symmy-integration-api/symmy-integration/readiness',
  role: 'microvertical-server',
  runtimeFramework: 'effect',
  strictEffectApproach: true,
} as const;

export { default, default as runtime } from './index.ts';
export {
  symmyIntegrationApiContract as contract,
  symmyIntegrationOperationContexts as operationContexts,
} from '../shared/api.ts';
export const api: unknown = symmyIntegrationApi;
