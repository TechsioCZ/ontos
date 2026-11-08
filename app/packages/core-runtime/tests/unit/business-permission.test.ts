import { expect, it } from 'effect-rstest';
import { Schema } from 'effect';
import {
  BusinessPermissionCodeSchema,
  BusinessPermissionScopeKindSchema,
  defineBusinessPermission,
  defineBusinessPermissionCatalog,
} from '../../src/permissions/business-permission.ts';

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
  expect(Schema.decodeSync(BusinessPermissionCodeSchema)('retail.repeat_order')).toBe('retail.repeat_order');
  expect(Schema.decodeSync(BusinessPermissionCodeSchema)('pricing.price_group.read')).toBe('pricing.price_group.read');
  expect(Schema.decodeSync(BusinessPermissionCodeSchema)('fixture.read')).toBe('fixture.read');
  expect(Schema.decodeSync(BusinessPermissionScopeKindSchema)('fixture_target')).toBe('fixture_target');
  expect(Schema.decodeSync(BusinessPermissionCodeSchema)('pricing.currency_support.read')).toBe(
    'pricing.currency_support.read',
  );
  const catalog = defineBusinessPermissionCatalog({
    authorityGroups: {
      'Counterparty Buyer': [Schema.decodeSync(BusinessPermissionCodeSchema)('counterparty.profile.read')],
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
  expect(() => defineBusinessPermission({ ...readPermission, key: 'generic.manage' })).not.toThrow();
  for (const permission of ['invalid permission', 'UPPERCASE.code', 'invalid..code']) {
    expect(() => Schema.decodeSync(BusinessPermissionCodeSchema)(permission)).toThrow();
  }
  expect(() =>
    defineBusinessPermissionCatalog({
      authorityGroups: {
        'Counterparty Buyer': [Schema.decodeSync(BusinessPermissionCodeSchema)('counterparty.profile.read')],
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

it('accepts explicit owner scope vocabulary without interpreting permission families', () => {
  const descriptor = defineBusinessPermission({
    ...readPermission,
    allowedScopeKinds: ['fixture_parent', 'fixture_child'],
    key: 'fixture.operation',
  });
  expect(descriptor.allowedScopeKinds).toEqual(['fixture_parent', 'fixture_child']);
  expect(Object.isFrozen(descriptor.allowedScopeKinds)).toBe(true);
});

it('rejects empty, repeated and malformed scope declarations', () => {
  for (const allowedScopeKinds of [[], ['fixture_parent', 'fixture_parent'], ['invalid scope']]) {
    expect(() => defineBusinessPermission({ ...readPermission, allowedScopeKinds })).toThrow();
  }
});
