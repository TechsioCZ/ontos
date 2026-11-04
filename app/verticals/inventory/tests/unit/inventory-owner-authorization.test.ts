import { isOwnerPermissionAccessTargetValid } from '@app/core-runtime';
import { expect, it } from 'effect-rstest';
import { inventoryAuthorizationContract } from '../../shared/permissions/authorization-contract.ts';
import { inventoryOwnerPermissionTarget } from '../../src/permissions/authorization.ts';

const request = {
  permission: 'inventory.stock.correct',
  target: {
    kind: 'inventory_resource' as const,
    resource: {
      moduleId: 'commerce.inventory',
      resourceId: '70000000-0000-4000-8000-000000000001',
      resourceType: 'commerce.inventory.stock-position',
    },
    tenantId: '00000000-0000-4000-8000-000000000001',
  },
};

it('preserves the frozen baseline grant and raw ResourceRef history independently', () => {
  const target = inventoryOwnerPermissionTarget(request);
  expect(target.objectId).toBe(
    'ctx_WyJpbnZlbnRvcnkuc3RvY2suY29ycmVjdCIsIjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMSIsImludmVudG9yeV9yZXNvdXJjZSIsImNvbW1lcmNlLmludmVudG9yeSIsImNvbW1lcmNlLmludmVudG9yeS5zdG9jay1wb3NpdGlvbiIsIjcwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMSJd',
  );
  expect(target.key).toBe(
    'inventory.stock.correct:00000000-0000-4000-8000-000000000001:inventory_resource:commerce.inventory:commerce.inventory.stock-position:70000000-0000-4000-8000-000000000001',
  );
  expect(target.transportModuleKey).toBe('commerce.inventory');
  expect(target.transportObjectId).toBe('70000000-0000-4000-8000-000000000001');
  expect(target.transportResourceType).toBe('commerce.inventory.stock-position');
  expect(Object.isFrozen(target)).toBe(true);
  expect(Object.isFrozen(target.target)).toBe(true);
});

it('binds every original member definition without enabling owner-state bypass', () => {
  expect(inventoryAuthorizationContract.permissions).toHaveLength(13);
  expect(inventoryAuthorizationContract).not.toHaveProperty('ownerStateRequired', false);
  for (const definition of inventoryAuthorizationContract.permissions) {
    const target = inventoryOwnerPermissionTarget({ ...request, permission: definition.key });
    expect(target.definition).toBe(definition);
    expect(
      isOwnerPermissionAccessTargetValid(target, { tenantId: request.target.tenantId }, 'commerce.inventory'),
    ).toBe(true);
  }
});

it('fails closed for unknown permissions, noncanonical resources and foreign Tenant', () => {
  expect(() => inventoryOwnerPermissionTarget({ ...request, permission: 'inventory.unknown' })).toThrow();
  for (const resource of [
    { ...request.target.resource, moduleId: 'foreign.owner' },
    { ...request.target.resource, resourceId: 'display-key' },
    { ...request.target.resource, resourceType: 'commerce.inventory.not_valid' },
  ]) {
    const target = inventoryOwnerPermissionTarget({ ...request, target: { ...request.target, resource } });
    expect(
      isOwnerPermissionAccessTargetValid(target, { tenantId: request.target.tenantId }, 'commerce.inventory'),
    ).toBe(false);
  }
  expect(
    isOwnerPermissionAccessTargetValid(
      inventoryOwnerPermissionTarget(request),
      {
        tenantId: '00000000-0000-4000-8000-000000000099',
      },
      'commerce.inventory',
    ),
  ).toBe(false);
});
