import { isOwnerPermissionAccessTargetValid } from '@app/core-runtime';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { priceGroupOwnerPermissionTarget } from '../../src/permissions/authorization.ts';
import { preparePriceGroupContainment } from '../../src/permissions/containment-preparation.ts';
import { priceGroupContainmentRelationships } from '../../src/workers/reconcile-price-group-containment-projection.worker.ts';

const tenantId = '00000000-0000-4000-8000-000000000001';
const pricingCatalogId = '50000000-0000-4000-8000-000000000001';
const priceGroupId = '60000000-0000-4000-8000-000000000001';
const target = { kind: 'price_group' as const, priceGroupId, pricingCatalogId, tenantId };

it('preserves the frozen catalog grant, ordered key and Action/Read history projections', () => {
  const request = {
    permission: 'pricing.price_group.create',
    target: { kind: 'pricing_catalog' as const, pricingCatalogId, tenantId },
  };
  const action = priceGroupOwnerPermissionTarget(request, 'action');
  const read = priceGroupOwnerPermissionTarget(request, 'read');
  expect(action.objectId).toBe(
    'ctx_WyJwcmljaW5nLnByaWNlX2dyb3VwLmNyZWF0ZSIsIjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMSIsInByaWNpbmdfY2F0YWxvZyIsIjUwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMSJd',
  );
  expect(action.key).toBe(
    'pricing.price_group.create:00000000-0000-4000-8000-000000000001:pricing_catalog:50000000-0000-4000-8000-000000000001',
  );
  expect(action.transportModuleKey).toBe('pricing.price-group-catalog');
  expect(action.transportObjectId).toBe('50000000-0000-4000-8000-000000000001');
  expect(action.transportResourceType).toBe('pricing_catalog:pricing.price_group.create');
  expect(read.transportModuleKey).toBe('pricing.price_group.create');
  expect(read.transportObjectId).toBe('50000000-0000-4000-8000-000000000001');
  expect(read.transportResourceType).toBe('pricing_catalog');
});

it('preserves frozen ctx bytes and distinct Action/Read history projections', () => {
  const action = priceGroupOwnerPermissionTarget({ permission: 'pricing.price_group.read', target }, 'action');
  const read = priceGroupOwnerPermissionTarget({ permission: 'pricing.price_group.read', target }, 'read');
  expect(action.objectId).toBe(
    'ctx_WyJwcmljaW5nLnByaWNlX2dyb3VwLnJlYWQiLCIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDEiLCJwcmljZV9ncm91cCIsIjUwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMSIsIjYwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMSJd',
  );
  expect(read.objectId).toBe(action.objectId);
  expect(action.key).toBe(
    'pricing.price_group.read:00000000-0000-4000-8000-000000000001:price_group:50000000-0000-4000-8000-000000000001:60000000-0000-4000-8000-000000000001',
  );
  expect(action.transportObjectId).toBe('50000000-0000-4000-8000-000000000001:60000000-0000-4000-8000-000000000001');
  expect(read.transportObjectId).toBe(action.transportObjectId);
  expect(action.transportModuleKey).toBe('pricing.price-group-catalog');
  expect(action.transportResourceType).toBe('price_group:pricing.price_group.read');
  expect(read.transportModuleKey).toBe('pricing.price_group.read');
  expect(read.transportResourceType).toBe('price_group');
  expect(Object.isFrozen(action)).toBe(true);
  expect(isOwnerPermissionAccessTargetValid(action, { tenantId })).toBe(true);
  expect(isOwnerPermissionAccessTargetValid(action, { tenantId: pricingCatalogId })).toBe(false);
});

it('rejects unknown permissions, incompatible meanings and noncanonical resource identities', () => {
  expect(() =>
    priceGroupOwnerPermissionTarget({ permission: 'pricing.price_group.unknown', target }, 'read'),
  ).toThrow();
  expect(() =>
    priceGroupOwnerPermissionTarget({ permission: 'pricing.price_group.create', target }, 'action'),
  ).toThrow();
  expect(() =>
    priceGroupOwnerPermissionTarget(
      { permission: 'pricing.price_group.read', target: { ...target, priceGroupId: 'display-code' } },
      'read',
    ),
  ).toThrow();
});

it.effect(
  'qualifies the actual six containment relationships and rejects changed permission or catalog endpoints',
  () =>
    Effect.gen(function* containmentQualification() {
      const relationships = yield* priceGroupContainmentRelationships({
        catalogVersion: '1',
        mutationId: '70000000-0000-4000-8000-000000000001',
        operation: 'touch_containment',
        priceGroupRef: {
          moduleId: 'pricing.price-group-catalog',
          resourceId: priceGroupId,
          resourceType: 'pricing.price-group-catalog.price-group',
          tenantId,
        },
        pricingCatalogRef: {
          moduleId: 'pricing.price-group-catalog',
          resourceId: tenantId,
          resourceType: 'pricing.price-group-catalog.price-group-catalog-root',
          tenantId,
        },
        schemaVersion: '1',
      });
      expect(preparePriceGroupContainment({ relationships })).toHaveLength(9);
      const [tenant, inheritance] = relationships;
      if (tenant.relation === 'tenant') {
        expect(
          preparePriceGroupContainment({
            relationships: [{ ...tenant, container: { objectId: pricingCatalogId, objectType: 'tenant' } }],
          }),
        ).toBeUndefined();
      }
      if (inheritance?.relation === 'containing_catalog') {
        const wrongPermission = priceGroupOwnerPermissionTarget(
          {
            permission: 'pricing.price_group.retire',
            target: { kind: 'pricing_catalog', pricingCatalogId: tenantId, tenantId },
          },
          'action',
        );
        expect(
          preparePriceGroupContainment({
            relationships: [
              { ...inheritance, container: { objectId: wrongPermission.objectId, objectType: 'business_permission' } },
            ],
          }),
        ).toBeUndefined();
        expect(
          preparePriceGroupContainment({
            relationships: [
              {
                ...inheritance,
                container: { ...inheritance.container, objectId: `${inheritance.container.objectId}=` },
              },
            ],
          }),
        ).toBeUndefined();
      }
    }),
);
