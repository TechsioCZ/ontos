import { expect, it } from 'effect-rstest';
import { Array as EffectArray, Order } from 'effect';
import { assortmentManifest } from '../../vertical.manifest.ts';

const expectedPermissions = [
  ['assortment.configuration.read', 'assortment_configuration'],
  ['assortment.decision.explain', 'assortment_decision'],
  ['assortment.rule.create', 'assortment_rule'],
  ['assortment.rule.revision.create', 'assortment_rule'],
  ['assortment.rule.retire', 'assortment_rule'],
  ['assortment.binding.create', 'assortment_binding'],
  ['assortment.binding.end', 'assortment_binding'],
  ['assortment.boundary.create', 'assortment_boundary'],
  ['assortment.boundary.end', 'assortment_boundary'],
] as const;
const sortPermissionPairs = (pairs: readonly (readonly [string, string])[]) =>
  EffectArray.sort(
    pairs,
    Order.mapInput(Order.String, (pair: readonly [string, string]) => pair[0]),
  );

it('publishes exactly the approved fail-closed Assortment permissions', () => {
  const permissions = assortmentManifest.publicSurface.businessPermissions ?? [];

  expect(
    sortPermissionPairs(permissions.map(({ allowedScopeKinds, key }) => [key, allowedScopeKinds[0]] as const)),
  ).toEqual(sortPermissionPairs(expectedPermissions));
  expect(permissions).toHaveLength(expectedPermissions.length);

  for (const permission of permissions) {
    expect(permission.auditSensitivity).toBe('sensitive');
    expect(permission.authorityGroups).toEqual([]);
    expect(permission.customerDelegable).toBe(false);
    expect(permission.internalGrantable).toBe(false);
    expect(permission.protectedEntrypoints).toEqual([]);
    expect(permission.owningCapability).toBe('commerce.assortment');
    expect(permission.schemaVersion).toBe('1');
  }

  expect(permissions.some(({ key }) => /(?:manage|admin|assignment|replace)/u.test(key))).toBe(false);
});
