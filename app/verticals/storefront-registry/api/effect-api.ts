import { storefrontRegistryApi } from '../shared/api.ts';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';

export const backendFederationContract = {
  compatibility: {
    build: ultramodernApiMarker.build,
    contractVersion: 'microvertical-server-effect-v1',
    nodeAdapterVersion: 'backend-mf-effect-v1',
    packageName: '@app/storefront-registry',
    sourceRevision: ultramodernApiMarker.sourceRevision,
    unitId: ultramodernApiMarker.unitId,
  },
  executionSurfaces: ['node-mf-runtime'],
  exposes: ['./effect-api'],
  name: 'verticalStorefrontRegistryBackend',
  openapiPath: '/storefront-registry-api/openapi.json',
  readinessPath: '/storefront-registry-api/storefront-registry/readiness',
  role: 'microvertical-server',
  runtimeFramework: 'effect',
  strictEffectApproach: true,
} as const;

export { default, default as runtime } from './index.ts';
export {
  storefrontRegistryApiContract as contract,
  storefrontRegistryOperationContexts as operationContexts,
} from '../shared/api.ts';
export const api: unknown = storefrontRegistryApi;
