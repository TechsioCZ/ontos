import type { TenantIntentLoaderService } from '@app/core-runtime/access/intent/tenant-intent-loader';
import { CapabilityKeySchema, ModuleKeySchema, TenantIdSchema } from '@app/core-runtime/access/ids';
import { Effect } from 'effect';

const entries = [
  ['contracts', 'legal.agreements', 'legal.agreements.api-records.read'],
  ['customers', 'party.registry', 'party.registry.customer.list'],
  ['opportunities', 'demo.sales-pipeline', 'demo.sales-pipeline.api-records.read'],
  ['properties', 'property.portfolio', 'property.portfolio.api-records.read'],
] as const;
const unused = () => Effect.die('Unexpected lookup intent query');

export const lookupCatalog = (missing?: string): TenantIntentLoaderService => ({
  loadAuthorityCells: unused,
  loadAuthorityCellsMany: unused,
  loadConfigureBases: unused,
  loadConnection: unused,
  loadProjection: (scope) =>
    Effect.succeed({
      catalogEntries: entries
        .filter(([name]) => name !== missing)
        .map(([, moduleKey, key]) => ({
          key: CapabilityKeySchema.make(key),
          kind: 'read' as const,
          modes: ['run'] as const,
          moduleKey: ModuleKeySchema.make(moduleKey),
          placement: { group: 'lookup', level: 'basic' as const },
          risk: 'sensitive' as const,
          selectors: ['all'] as const,
        })),
      coverage: 'complete',
      legalEntities: [],
      members: [],
      owners: [],
      principals: [],
      scopes: [],
      suspended: [],
      tenantId: TenantIdSchema.make(scope.tenantId),
    }),
  loadScope: unused,
  loadTeamIds: unused,
  loadTenantContextScopeId: unused,
});
