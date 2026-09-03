import assert from 'node:assert/strict';
import test from 'node:test';
import { Schema } from 'effect';
import {
  EntrypointAuthorizationSchema,
  decodeEntrypointAuthorization,
} from '../../src/authorization/entrypoint-classification.ts';
import {
  defineSystemModuleEntrypoint,
  defineTenantModuleEntrypoint,
} from '../../src/modules/module-entrypoint.ts';

test('decodes every closed authorization classification', () => {
  const classifications = [
    { kind: 'public' },
    { kind: 'authenticated_principal' },
    { kind: 'context_permission', permission: 'module.access' },
    { kind: 'action_execution', provisioning: 'tenant_membership_default' },
    { kind: 'action_execution', provisioning: 'explicit' },
    { kind: 'owner_local_background' },
    { credential: 'session', kind: 'capability_issuance' },
    { credential: 'api_key', kind: 'capability_issuance' },
  ] as const;

  for (const classification of classifications) {
    assert.deepEqual(decodeEntrypointAuthorization(classification), classification);
  }
});

test('rejects omitted, unknown, excessive, and incompatible authorization fields', () => {
  const invalid = [
    undefined,
    { kind: 'unknown' },
    { kind: 'public', provisioning: 'explicit' },
    { kind: 'context_permission' },
    { kind: 'action_execution' },
    { kind: 'action_execution', provisioning: 'everyone' },
    { kind: 'owner_local_background', permission: 'module.access' },
  ];

  for (const value of invalid) {
    assert.throws(() =>
      Schema.decodeUnknownSync(EntrypointAuthorizationSchema, {
        onExcessProperty: 'error',
      })(value),
    );
  }
});

test('requires role-compatible authorization and freezes nested classification', () => {
  const action = defineTenantModuleEntrypoint({
    access: 'write',
    authorization: {
      kind: 'action_execution',
      provisioning: 'tenant_membership_default',
    },
    entrypointKey: 'inventory.stock.reserve',
    moduleKey: 'inventory.stock',
    role: 'action',
  });
  const route = defineSystemModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'public' },
    entrypointKey: 'shell.page.login',
    moduleKey: 'core.shell',
    role: 'page',
  });

  assert.equal(Object.isFrozen(action.authorization), true);
  assert.equal(Object.isFrozen(route.authorization), true);
  assert.throws(() =>
    defineTenantModuleEntrypoint({
      access: 'write',
      authorization: { kind: 'authenticated_principal' },
      entrypointKey: 'inventory.stock.reserve',
      moduleKey: 'inventory.stock',
      role: 'action',
    }),
  );
  assert.throws(() =>
    defineTenantModuleEntrypoint({
      access: 'background',
      authorization: { kind: 'action_execution', provisioning: 'explicit' },
      entrypointKey: 'inventory.stock.project',
      moduleKey: 'inventory.stock',
      role: 'worker',
    }),
  );
});

test('keeps discovery metadata independent from authorization', () => {
  const route = {
    entrypoint: defineSystemModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'public' },
      entrypointKey: 'shell.page.login',
      moduleKey: 'core.shell',
      role: 'page',
    }),
    indexable: false,
    public: false,
  } as const;

  assert.equal(route.entrypoint.authorization.kind, 'public');
  assert.equal(route.public, false);
  assert.equal(route.indexable, false);
});
