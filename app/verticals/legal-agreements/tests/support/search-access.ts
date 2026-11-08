import { Effect } from 'effect';
import type { ContextAccessService } from '@app/core-runtime';
import type { AccessDecisionService } from '@app/core-runtime/access/enforcement';
import type { ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import { RecordKeySchema } from '@app/core-runtime/access/ids';
import { makeTestBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import { contractsRead } from '../../src/search/contracts.provider.ts';

export const allRecords: ListAccessPredicate = { groups: [] };
export const searchAuthorization = {
  deniedFieldPaths: [],
  listAccess: allRecords,
  parentRead: contractsRead,
};
export const recordKeys = (first: string, ...rest: readonly string[]): ListAccessPredicate => ({
  groups: [
    {
      clauses: [
        {
          conditions: [
            {
              _tag: 'RecordKeyIn',
              recordKeys: [RecordKeySchema.make(first), ...rest.map((key) => RecordKeySchema.make(key))],
            },
          ],
        },
      ],
    },
  ],
});
export const gateAnswer = (
  outcome: 'ALLOWED' | 'DENIED' | 'UNAVAILABLE' | 'NEEDS_APPROVAL' = 'ALLOWED',
  predicate = allRecords,
) => makeTestBoundAccessGate({ defaultAnswer: { outcome, predicate } }).accessDecision;

export const gateWithList = (list: AccessDecisionService['list']): AccessDecisionService => ({
  ...gateAnswer(),
  list,
});
export const retiredAccess: ContextAccessService = {
  legalEntities: () => Effect.die('Retired Legal company authority must not run'),
  modules: () => Effect.die('Retired Legal module authority must not run'),
  resources: () => Effect.die('Retired Legal resource authority must not run'),
  tenants: () => Effect.die('Retired Legal tenant authority must not run'),
};
