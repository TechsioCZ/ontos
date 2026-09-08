import assert from 'node:assert/strict';
import test from 'node:test';

import {
  makeProtectedEntrypointInventory,
  serializeProtectedEntrypointInventory,
} from '../authorization/protected-entrypoint-inventory.mts';

const entries = [
  {
    authorization: { kind: 'public' as const },
    deployment: 'shell-super-app',
    entrypointKey: 'core.shell.page.home',
    owner: 'core.shell',
    surface: 'route' as const,
  },
  {
    authorization: {
      kind: 'action_execution' as const,
      provisioning: 'tenant_membership_default' as const,
    },
    deployment: 'contacts',
    entrypointKey: 'contacts.create-contact',
    owner: 'contacts',
    surface: 'action' as const,
  },
];

void test('inventory normalization, hashing, and serialization are deterministic', () => {
  const left = makeProtectedEntrypointInventory('revision', entries);
  const right = makeProtectedEntrypointInventory('revision', [
    entries[1],
    entries[0],
  ]);
  assert.equal(
    serializeProtectedEntrypointInventory(left),
    serializeProtectedEntrypointInventory(right)
  );
  assert.match(left.inventoryHash, /^[a-f0-9]{64}$/u);
  assert.deepEqual(
    left.entries.map((entry) => entry.surface),
    ['action', 'route']
  );
});

void test('inventory rejects duplicate and unsafe entrypoint identities', () => {
  assert.throws(
    () =>
      makeProtectedEntrypointInventory('revision', [...entries, entries[0]]),
    /duplicate protected entrypoint/u
  );
  assert.throws(
    () =>
      makeProtectedEntrypointInventory('revision', [
        { ...entries[0], entrypointKey: 'tenant@example.com' },
      ]),
    /stable, non-sensitive identifier/u
  );
});

void test('inventory rejects malformed and excess authorization classification data', () => {
  const authorizationWithExcessData = {
    kind: 'public' as const,
    permission: 'tenant.access',
  };
  assert.throws(
    () =>
      makeProtectedEntrypointInventory('revision', [
        {
          ...entries[0],
          authorization: authorizationWithExcessData,
        },
      ]),
    /classification is invalid/u
  );
  assert.throws(
    () =>
      makeProtectedEntrypointInventory('revision', [
        {
          ...entries[0],
          authorization: {
            kind: 'context_permission',
            permission: 'tenant@example.com',
          },
        },
      ]),
    /classification is invalid/u
  );
});
