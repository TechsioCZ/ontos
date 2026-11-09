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
  name: 'verticalSymmyIntegrationBackend',
  nodeAdapterVersion: 'backend-mf-effect-v2',
  openapiPath: '/symmy-integration-api/openapi.json',
  readinessPath: '/symmy-integration-api/symmy-integration/readiness',
  role: 'microvertical-server',
  runtimeFramework: 'effect',
  strictEffectApproach: true,
} as const;

export { default, default as runtime } from './index.ts';
export {
  symmyIntegrationApi as api,
  symmyIntegrationApiContract as contract,
  symmyIntegrationOperationContexts as operationContexts,
} from '../shared/api.ts';
