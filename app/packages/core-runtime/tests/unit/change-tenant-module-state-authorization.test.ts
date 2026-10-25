import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { changeTenantModuleStateAction } from '../../src/modules/actions/change-tenant-module-state.action.ts';

/**
 * `core.modules.change-tenant-module-state` is provisioned to every tenant member as a
 * `tenant_membership_default` action, so the tenant-permission gate is the only thing separating a member from
 * tenant-wide module administration: quarantine, archive, suspend, and activating a module the tenant never
 * enabled.
 */

it.effect('requires tenant administration to change tenant module state', () =>
  Effect.gen(function* moduleStateRequiresAdministration() {
    const payload = yield* Schema.decodeEffect(changeTenantModuleStateAction.descriptor.payloadSchema)({
      moduleKey: 'commerce.inventory',
      newState: 'suspended',
      reason: 'Probe',
    });
    expect(changeTenantModuleStateAction.descriptor.tenantPermission?.(payload)).toBe('manage_identity');
  }),
);
