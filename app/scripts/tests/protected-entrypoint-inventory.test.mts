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
    authorization: { kind: 'protected' as const },
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

it('accepts the v2 protected classification and refuses legacy classification data', () => {
  const inventory = makeProtectedEntrypointInventory('revision', [
    {
      authorization: { kind: 'protected' as const },
      deployment: 'contacts',
      entrypointKey: 'contacts.contacts-page',
      owner: 'contacts',
      surface: 'route' as const,
    },
  ]);
  expect(inventory.entries[0]?.authorization).toStrictEqual({ kind: 'protected' });
  // The v2 union no longer admits the legacy protected kinds (O62); excess classification data is
  // refused at decode, so a stale `action_execution{provisioning}` payload cannot pass silently.
  const legacyPayload = { kind: 'protected' as const, provisioning: 'tenant_membership_default' };
  expect(() =>
    makeProtectedEntrypointInventory('revision', [
      {
        authorization: legacyPayload,
        deployment: 'contacts',
        entrypointKey: 'contacts.contacts-page',
        owner: 'contacts',
        surface: 'route' as const,
      },
    ]),
  ).toThrow(/classification is invalid/u);
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
  const credentialWithExcessData = {
    credential: 'api_key' as const,
    kind: 'capability_issuance' as const,
    provisioning: 'explicit',
  };
  expect(() =>
    makeProtectedEntrypointInventory('revision', [
      {
        ...entries[0],
        authorization: credentialWithExcessData,
      },
    ]),
  ).toThrow(/classification is invalid/u);
});
