import { randomUUID } from 'node:crypto';

import { makeContextAccessLive, toContextPermissionAccessKey } from '@app/core-runtime';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { catalogPublicOperationContracts } from '../../shared/api.ts';

const tenantId = randomUUID();
const foreignTenantId = randomUUID();
const principalId = randomUUID();
const readTargets = Object.values(catalogPublicOperationContracts)
  .filter((contract) => contract.permissionKind === 'context_permission')
  .map((contract) => ({ moduleId: 'commerce.catalog', permission: contract.permission }));

it.live('never allows Catalog governed reads without a verified grant', () =>
  Effect.scoped(
    Effect.gen(function* checkCatalogReadPermissions() {
      expect(readTargets.length).toBeGreaterThan(0);
      const access = yield* makeContextAccessLive();
      const check = access.contextPermissions;
      if (check === undefined) {
        throw new Error('The Core context-permission adapter is unavailable');
      }

      const local = yield* check({ principalId, targets: readTargets, tenantId });
      expect(local.map(({ key }) => key)).toEqual(readTargets.map(toContextPermissionAccessKey));
      expect(local.every(({ decision }) => decision === 'denied' || decision === 'unavailable')).toBe(true);

      const foreign = yield* check({ principalId, targets: readTargets, tenantId: foreignTenantId });
      expect(foreign.map(({ key }) => key)).toEqual(readTargets.map(toContextPermissionAccessKey));
      expect(foreign.every(({ decision }) => decision === 'denied' || decision === 'unavailable')).toBe(true);
    }),
  ),
);
