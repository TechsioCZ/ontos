import { assortmentApi } from '../shared/api.ts';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';

export const backendFederationContract = {
  compatibility: {
    build: ultramodernApiMarker.build,
    contractVersion: 'microvertical-server-effect-v1',
    nodeAdapterVersion: 'backend-mf-effect-v1',
    packageName: '@app/assortment',
    sourceRevision: ultramodernApiMarker.sourceRevision,
    unitId: ultramodernApiMarker.unitId,
  },
  executionSurfaces: ['node-mf-runtime'],
  exposes: ['./effect-api'],
  name: 'verticalAssortmentBackend',
  openapiPath: '/assortment-api/openapi.json',
  readinessPath: '/assortment-api/assortment/readiness',
  role: 'microvertical-server',
  runtimeFramework: 'effect',
  strictEffectApproach: true,
} as const;

export { default, default as runtime } from './index.ts';
export { assortmentApiContract as contract, assortmentOperationContexts as operationContexts } from '../shared/api.ts';
export const api: unknown = assortmentApi;
