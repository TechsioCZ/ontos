import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  EntrypointAuthorizationSchema,
  decodeEntrypointAuthorization,
} from '../../src/authorization/entrypoint-classification.ts';
import { defineSystemModuleEntrypoint, defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';

it('decodes every closed authorization classification', () => {
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
    expect(decodeEntrypointAuthorization(classification)).toEqual(classification);
  }
});

it('rejects omitted, unknown, excessive, and incompatible authorization fields', () => {
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
    expect(() =>
      Schema.decodeUnknownSync(EntrypointAuthorizationSchema, {
        onExcessProperty: 'error',
      })(value),
    ).toThrow();
  }
});

it('requires role-compatible authorization and freezes nested classification', () => {
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

  expect(Object.isFrozen(action.authorization)).toBe(true);
  expect(Object.isFrozen(route.authorization)).toBe(true);
  expect(() =>
    defineTenantModuleEntrypoint({
      access: 'write',
      authorization: { kind: 'authenticated_principal' },
      entrypointKey: 'inventory.stock.reserve',
      moduleKey: 'inventory.stock',
      role: 'action',
    }),
  ).toThrow();
  expect(() =>
    defineTenantModuleEntrypoint({
      access: 'background',
      authorization: { kind: 'action_execution', provisioning: 'explicit' },
      entrypointKey: 'inventory.stock.project',
      moduleKey: 'inventory.stock',
      role: 'worker',
    }),
  ).toThrow();
});

it('keeps discovery metadata independent from authorization', () => {
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

  expect(route.entrypoint.authorization.kind).toBe('public');
  expect(route.public).toBe(false);
  expect(route.indexable).toBe(false);
});
