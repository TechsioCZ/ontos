import type { ContextAccessService } from '@app/core-runtime';
import { Effect } from 'effect';

export const makeContextAccessDouble = (
  decision: 'allowed' | 'unavailable'
): ContextAccessService => ({
  legalEntities: ({ legalEntityIds }) =>
    Effect.succeed(legalEntityIds.map((key) => ({ decision, key }))),
  modules: ({ moduleIds }) =>
    Effect.succeed(moduleIds.map((key) => ({ decision, key }))),
  resources: ({ resources }) =>
    Effect.succeed(
      resources.map(({ moduleId, resourceId, resourceType }) => ({
        decision,
        key: `${moduleId}:${resourceType}:${resourceId}`,
      }))
    ),
  tenants: ({ tenantIds }) =>
    Effect.succeed(tenantIds.map((key) => ({ decision, key }))),
});
