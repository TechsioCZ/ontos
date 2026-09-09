import { expect, it } from 'effect-rstest';
import { Schema } from 'effect';
import {
  BusinessPermissionCodeSchema,
  defineBusinessPermission,
  defineBusinessPermissionCatalog,
} from '../../src/permissions/business-permission.ts';
import { canTransitionAuthorizationMutation } from '../../src/permissions/authorization-mutation.ts';

const readPermission = defineBusinessPermission({
  allowedScopeKinds: ['counterparty', 'counterparty_storefront'],
  auditSensitivity: 'sensitive',
  authorityGroups: ['Counterparty Buyer'],
  customerDelegable: true,
  internalGrantable: true,
  key: 'counterparty.profile.read',
  meaning: 'Read the current counterparty purchasing profile.',
  owningCapability: 'commerce.customer-context',
  protectedEntrypoints: ['commerce.customer-context.profile.read'],
  schemaVersion: '1',
});

it('builds an immutable, reciprocal and versioned permission catalog', () => {
  expect(Schema.decodeSync(BusinessPermissionCodeSchema)('retail.repeat_order')).toBe(
    'retail.repeat_order',
  );
  const catalog = defineBusinessPermissionCatalog({
    authorityGroups: {
      'Counterparty Buyer': [
        Schema.decodeSync(BusinessPermissionCodeSchema)('counterparty.profile.read'),
      ],
    },
    catalogVersion: '1',
    permissions: [readPermission],
  });
  expect(catalog.permissions).toEqual([readPermission]);
  expect(Object.isFrozen(catalog)).toBe(true);
  expect(Object.isFrozen(catalog.permissions)).toBe(true);
  expect(Object.isFrozen(catalog.authorityGroups['Counterparty Buyer'])).toBe(true);
});

it('rejects invalid codes, duplicate catalog entries, and one-sided group membership', () => {
  expect(() => defineBusinessPermission({ ...readPermission, key: 'generic.manage' })).toThrow();
  expect(() =>
    defineBusinessPermissionCatalog({
      authorityGroups: {
        'Counterparty Buyer': [
          Schema.decodeSync(BusinessPermissionCodeSchema)('counterparty.profile.read'),
        ],
      },
      catalogVersion: '1',
      permissions: [readPermission, readPermission],
    }),
  ).toThrow(/duplicate permission/u);
  expect(() =>
    defineBusinessPermissionCatalog({
      authorityGroups: {},
      catalogVersion: '1',
      permissions: [readPermission],
    }),
  ).toThrow(/undeclared authority group/u);
});

it('allows only explicit authorization projection state transitions', () => {
  expect(canTransitionAuthorizationMutation('PENDING_GRANT', 'ACTIVE')).toBe(true);
  expect(canTransitionAuthorizationMutation('ACTIVE', 'REVOKED')).toBe(false);
  expect(canTransitionAuthorizationMutation('PENDING_REVOKE', 'REVOKED')).toBe(true);
  expect(canTransitionAuthorizationMutation('RECONCILIATION_REQUIRED', 'ACTIVE')).toBe(true);
});
