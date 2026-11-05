import { expect, it } from 'effect-rstest';

import { changeTenantModuleStateAction } from '../../src/modules/actions/change-tenant-module-state.action.ts';

/**
 * `core.modules.tenant-module.change-state` is tenant configuration administration (O37): it carries its
 * own `admin` capability on the one gate, so neither a tenant member nor an agent reaches it through a
 * membership default, and no legacy tenant-role stopgap remains on the descriptor.
 */
it('declares its own admin capability and keeps no tenant-role gate', () => {
  const { descriptor } = changeTenantModuleStateAction;
  expect(descriptor.entrypoint.authorization).toEqual({ kind: 'protected' });
  expect(descriptor.accessDeclaration).toMatchObject({
    key: 'core.modules.tenant-module.change-state',
    kind: 'admin',
    modes: ['run'],
    placement: { group: 'modules', level: 'manage' },
    risk: 'critical',
    selectors: [],
  });
  // A tenant-wide, irreversible state change is human-only: an agent policy of `never` is derived.
  expect('tenantPermission' in descriptor).toBe(false);
  expect(descriptor.accessWorkload).toBeUndefined();
});
