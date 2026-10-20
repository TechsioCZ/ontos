import { ContextAccess } from '@app/core-runtime';
import type { ContextAccessDecision, OperationalScope } from '@app/core-runtime';
import { Effect } from 'effect';
import type { LookupAccess } from '../../shared/apis/records.ts';

const lookupModules = {
  customers: 'party.registry',
  employees: 'demo.workforce',
  opportunities: 'demo.sales-pipeline',
  properties: 'siampark.property',
  contracts: 'siampark.agreements',
} as const;

const combine = (decisions: readonly ContextAccessDecision[]): ContextAccessDecision =>
  decisions.includes('denied')
    ? 'denied'
    : decisions.every((decision) => decision === 'allowed')
      ? 'allowed'
      : 'unavailable';

/** Presentation hints only. Owning BFFs still authorize every lookup and mutation independently. */
export const taskLookupAccess = Effect.fn('Work.taskLookupAccess')(function* taskLookupAccess(scope: OperationalScope) {
  const access = yield* ContextAccess;
  const unavailable: LookupAccess = {
    customers: 'unavailable',
    employees: 'unavailable',
    opportunities: 'unavailable',
    properties: 'unavailable',
    contracts: 'unavailable',
  };
  if (scope.legalEntityId === undefined || access.contextPermissions === undefined) return unavailable;
  const input = { legalEntityId: scope.legalEntityId, principalId: scope.principalId, tenantId: scope.tenantId };
  const modules = Object.values(lookupModules);
  const [entrypoints, moduleAccess, customerAccess] = yield* Effect.all([
    access.contextPermissions({
      ...input,
      targets: modules.map((moduleId) => ({ moduleId, permission: 'module.access' })),
    }),
    access.modules({ ...input, moduleIds: modules }),
    access.legalEntities({
      principalId: scope.principalId,
      tenantId: scope.tenantId,
      legalEntityIds: [scope.legalEntityId],
      permission: 'read_counterparty',
    }),
  ]);
  const decision = (name: keyof LookupAccess): ContextAccessDecision => {
    const moduleId = lookupModules[name];
    return combine([
      entrypoints.find((item) => item.key === `${moduleId}:module.access`)?.decision ?? 'unavailable',
      // CustomerList uses a legal-entity permission target instead of a module target.
      ...(name === 'customers'
        ? [customerAccess.find((item) => item.key === scope.legalEntityId)?.decision ?? 'unavailable']
        : [moduleAccess.find((item) => item.key === moduleId)?.decision ?? 'unavailable']),
    ]);
  };
  return {
    customers: decision('customers'),
    employees: decision('employees'),
    opportunities: decision('opportunities'),
    properties: decision('properties'),
    contracts: decision('contracts'),
  };
});
