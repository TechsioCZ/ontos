import { ContextAccess } from '@app/core-runtime';
import type { ContextAccessDecision, OperationalScope } from '@app/core-runtime';
import { Effect } from 'effect';
import type { LookupAccess } from '../../shared/apis/records.ts';

const lookupModules = {
  contracts: 'legal.agreements',
  customers: 'party.registry',
  opportunities: 'demo.sales-pipeline',
  properties: 'property.portfolio',
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
    contracts: 'unavailable',
    customers: 'unavailable',
    opportunities: 'unavailable',
    properties: 'unavailable',
  };
  if (scope.legalEntityId === undefined) {
    return unavailable;
  }
  const input = { legalEntityId: scope.legalEntityId, principalId: scope.principalId, tenantId: scope.tenantId };
  const modules = Object.values(lookupModules);
  // Core's read runtime resolves the special `module.access` entrypoint permission through modules(),
  // not through a named context_permission relationship. Mirror that alias exactly.
  const [moduleAccess, customerAccess] = yield* Effect.all([
    access.modules({ ...input, moduleIds: modules }),
    access.legalEntities({
      legalEntityIds: [scope.legalEntityId],
      permission: 'read_counterparty',
      principalId: scope.principalId,
      tenantId: scope.tenantId,
    }),
  ]);
  const decision = (name: keyof LookupAccess): ContextAccessDecision => {
    const moduleId = lookupModules[name];
    return combine([
      moduleAccess.find((item) => item.key === moduleId)?.decision ?? 'unavailable',
      // CustomerList additionally requires the Legal Entity's read_counterparty permission.
      ...(name === 'customers'
        ? [customerAccess.find((item) => item.key === scope.legalEntityId)?.decision ?? 'unavailable']
        : []),
    ]);
  };
  return {
    contracts: decision('contracts'),
    customers: decision('customers'),
    opportunities: decision('opportunities'),
    properties: decision('properties'),
  };
});
