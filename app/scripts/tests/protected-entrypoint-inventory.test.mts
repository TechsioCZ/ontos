import { expect, it } from 'effect-rstest';

import {
  makeProtectedEntrypointInventory,
  normalizeBusinessPermissionInventory,
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
const pricingOwner = 'pricing.price-group-catalog';
const pricingReadPermission = 'pricing.price_group.read';
const pricingRetirePermission = 'pricing.price_group.retire';

it('inventory normalization, hashing, and serialization are deterministic', () => {
  const permissions = [
    { key: pricingRetirePermission, owner: pricingOwner },
    { key: pricingReadPermission, owner: pricingOwner },
  ] as const;
  const left = makeProtectedEntrypointInventory('revision', entries, permissions);
  const right = makeProtectedEntrypointInventory(
    'revision',
    [entries[1], entries[0]],
    [permissions[1], permissions[0]],
  );
  expect(serializeProtectedEntrypointInventory(left)).toBe(serializeProtectedEntrypointInventory(right));
  expect(left.inventoryHash).toMatch(/^[a-f0-9]{64}$/u);
  expect(left.inventoryHash).not.toBe(makeProtectedEntrypointInventory('revision', entries).inventoryHash);
  expect(left.entries.map((entry) => entry.surface)).toEqual(['action', 'route']);
  expect(left.businessPermissions.map(({ key }) => key)).toEqual([pricingReadPermission, pricingRetirePermission]);
});

it('business permission inventory rejects duplicate and unsafe permission identities', () => {
  expect(() =>
    normalizeBusinessPermissionInventory([
      { key: pricingReadPermission, owner: pricingOwner },
      { key: pricingReadPermission, owner: pricingOwner },
    ]),
  ).toThrow(/duplicate business permission/u);
  expect(() =>
    normalizeBusinessPermissionInventory([{ key: 'pricing.price_group.read@example.com', owner: 'pricing' }]),
  ).toThrow(/invalid or unsafe/u);
});

it('inventory rejects duplicate and unsafe entrypoint identities', () => {
  expect(() => makeProtectedEntrypointInventory('revision', [...entries, entries[0]])).toThrow(
    /duplicate protected entrypoint/u,
  );
  expect(() =>
    makeProtectedEntrypointInventory('revision', [{ ...entries[0], entrypointKey: 'tenant@example.com' }]),
  ).toThrow(/stable, non-sensitive identifier/u);
});

it('inventory rejects malformed and excess authorization classification data', () => {
  const authorizationWithExcessData = {
    kind: 'public' as const,
    permission: 'tenant.access',
  };
  expect(() =>
    makeProtectedEntrypointInventory('revision', [
      {
        ...entries[0],
        authorization: authorizationWithExcessData,
      },
    ]),
  ).toThrow(/classification is invalid/u);
  expect(() =>
    makeProtectedEntrypointInventory('revision', [
      {
        ...entries[0],
        authorization: {
          kind: 'context_permission',
          permission: 'tenant@example.com',
        },
      },
    ]),
  ).toThrow(/classification is invalid/u);
});
