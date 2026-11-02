import { remainingPermissionBaselines } from './owner-permission-baseline.ts';
import { ownerPermissionTarget } from '../support/owner-permission-target.ts';
import { v1 } from '@authzed/authzed-node';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { spiceDbPermissionClientError } from '../../src/permissions/client.ts';
import type { SpiceDbPermissionClient } from '../../src/permissions/client.ts';
import {
  makeContextAccess,
  toBusinessPermissionAccessKey,
  toBusinessPermissionAccessObjectId,
  toContextPermissionAccessKey,
  toContextPermissionAccessObjectId,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
  toResourceAccessObjectId,
} from '../../src/permissions/context-access.ts';
import { LEGAL_ENTITY_PERMISSION_KEYS, TENANT_PERMISSION_KEYS } from '../../src/permissions/context-permissions.ts';
import { BusinessPermissionCodeSchema } from '../../src/permissions/business-permission.ts';

interface BaselineCurrentState {
  decision: 'allowed' | 'denied' | 'unavailable';
}

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const principalId = '30000000-0000-4000-8000-000000000001';
const pricingCatalogId = '50000000-0000-4000-8000-000000000001';
const priceGroupId = '60000000-0000-4000-8000-000000000001';
const otherPriceGroupId = '60000000-0000-4000-8000-000000000002';
const inventoryResourceId = '70000000-0000-4000-8000-000000000001';

const responseFor = (
  request: v1.CheckBulkPermissionsRequest,
  permissionships: readonly v1.CheckPermissionResponse_Permissionship[],
) =>
  v1.CheckBulkPermissionsResponse.create({
    pairs: request.items.map((item, index) =>
      v1.CheckBulkPermissionsPair.create({
        request: item,
        response: {
          item: v1.CheckBulkPermissionsResponseItem.create({
            permissionship: permissionships[index] ?? v1.CheckPermissionResponse_Permissionship.UNSPECIFIED,
          }),
          oneofKind: 'item',
        },
      }),
    ),
  });

const makeClient = (handle: SpiceDbPermissionClient['checkBulkPermissions']): SpiceDbPermissionClient => ({
  checkBulkPermissions: handle,
  checkPermission: () => Effect.die(new Error('Action check must not run')),
  close: () => {},
});

const requireBusinessPermissions = (
  access: ReturnType<typeof makeContextAccess>,
): NonNullable<ReturnType<typeof makeContextAccess>['businessPermissions']> => {
  const check = access.businessPermissions;
  if (check === undefined) {
    throw new Error('Expected business permission access');
  }
  return check;
};

const requireContextPermissions = (
  access: ReturnType<typeof makeContextAccess>,
): NonNullable<ReturnType<typeof makeContextAccess>['contextPermissions']> => {
  const check = access.contextPermissions;
  if (check === undefined) {
    throw new Error('Expected context permission access');
  }
  return check;
};

const requireOwnerPermissions = (
  access: ReturnType<typeof makeContextAccess>,
): NonNullable<ReturnType<typeof makeContextAccess>['ownerPermissions']> => {
  const check = access.ownerPermissions;
  if (check === undefined) {
    throw new Error('Expected owner permission access');
  }
  return check;
};

it.effect('uses one fully consistent batch and correlates allowed and denied module decisions', () =>
  Effect.gen(function* correlatesModuleDecisions() {
    const requests: v1.CheckBulkPermissionsRequest[] = [];
    const access = makeContextAccess(
      makeClient((request) =>
        Effect.sync(() => {
          requests.push(request);
          return responseFor(request, [
            v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION,
            v1.CheckPermissionResponse_Permissionship.NO_PERMISSION,
          ]);
        }),
      ),
    );

    const result = yield* access.modules({
      legalEntityId,
      moduleIds: ['property.registry', 'billing.core'],
      principalId,
      tenantId,
    });
    expect(result).toEqual([
      { decision: 'allowed', key: 'property.registry' },
      { decision: 'denied', key: 'billing.core' },
    ]);
    expect(requests.length).toBe(1);
    expect(requests[0]?.consistency?.requirement).toEqual({
      fullyConsistent: true,
      oneofKind: 'fullyConsistent',
    });
    expect(requests[0]?.items[0]?.resource?.objectType).toBe('module_access');
    expect(requests[0]?.items[0]?.permission).toBe('access');
    expect(requests[0]?.items[0]?.subject?.object?.objectId).toBe(principalId);
  }),
);

it.effect('checks exact owner targets only in their trusted tenant and Legal Entity scope', () =>
  Effect.gen(function* checksOwnerScope() {
    const requests: v1.CheckBulkPermissionsRequest[] = [];
    const access = makeContextAccess(
      makeClient((request) =>
        Effect.sync(() => {
          requests.push(request);
          return responseFor(request, [v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION]);
        }),
      ),
    );
    const target = ownerPermissionTarget({ legalEntityId, tenantId });
    const check = requireOwnerPermissions(access);
    expect(yield* check({ legalEntityId, principal: { principalId, tenantId }, targets: [{ target }] })).toEqual([
      { decision: 'allowed', key: target.key },
    ]);
    expect(requests[0]?.items[0]?.resource?.objectId).toBe(target.objectId);
    expect(requests[0]?.items[0]?.resource?.objectType).toBe('business_permission');
    expect(requests[0]?.items[0]?.permission).toBe('use');
    expect(requests[0]?.items[0]?.subject?.object?.objectId).toBe(principalId);
    for (const principalScope of [
      { legalEntityId, principal: { principalId, tenantId: 'other-tenant' } },
      { legalEntityId: 'other-entity', principal: { principalId, tenantId } },
      { principal: { principalId, tenantId } },
    ]) {
      expect(yield* check({ ...principalScope, targets: [{ target }] })).toEqual([
        { decision: 'unavailable', key: target.key },
      ]);
    }
    expect(requests).toHaveLength(1);
    const tenantTarget = ownerPermissionTarget({ tenantId }, 'tenant-owned');
    expect(yield* check({ principal: { principalId, tenantId }, targets: [{ target: tenantTarget }] })).toEqual([
      { decision: 'allowed', key: tenantTarget.key },
    ]);
    const storefrontTarget = ownerPermissionTarget({ legalEntityId, tenantId }, 'storefront-owned', {
      requiredStorefrontId: 'storefront-a',
    });
    expect(
      yield* check({
        legalEntityId,
        principal: { principalId, tenantId },
        targets: [{ target: storefrontTarget }],
        trustedStorefrontId: 'storefront-b',
      }),
    ).toEqual([{ decision: 'unavailable', key: storefrontTarget.key }]);
    expect(requests).toHaveLength(2);
  }),
);

it.effect('checks resource writes independently from resource reads', () =>
  Effect.gen(function* checksResourceWrites() {
    const permissions: string[] = [];
    const service = makeContextAccess(
      makeClient((request) =>
        Effect.sync(() => {
          permissions.push(...request.items.map(({ permission }) => permission));
          return responseFor(request, [v1.CheckPermissionResponse_Permissionship.NO_PERMISSION]);
        }),
      ),
    );
    const target = {
      moduleId: 'property.registry',
      resourceId: 'unit-1',
      resourceType: 'unit',
    };
    const result = yield* service.resources({
      legalEntityId: 'entity-1',
      permission: 'write',
      principalId: 'principal-1',
      resources: [target],
      tenantId: 'tenant-1',
    });
    expect(result).toEqual([{ decision: 'denied', key: 'property.registry:unit:unit-1' }]);
    expect(permissions).toEqual(['write']);
  }),
);

const makeAllowedPermissionRecorder = () => {
  const observed: string[] = [];
  const service = makeContextAccess(
    makeClient((request) =>
      Effect.sync(() => {
        observed.push(...request.items.map(({ permission }) => permission));
        return responseFor(
          request,
          request.items.map(() => v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION),
        );
      }),
    ),
  );
  return { observed, service };
};

it.effect('forwards every closed tenant permission key without widening it', () =>
  Effect.gen(function* forwardsTenantPermissionKeys() {
    const { observed, service } = makeAllowedPermissionRecorder();

    yield* Effect.forEach(
      TENANT_PERMISSION_KEYS,
      (permission) =>
        service
          .tenants({ permission, principalId, tenantIds: [tenantId] })
          .pipe(Effect.map((result) => expect(result).toEqual([{ decision: 'allowed', key: tenantId }]))),
      { concurrency: 1 },
    );
    expect(observed).toEqual(TENANT_PERMISSION_KEYS);
  }),
);

it.effect('forwards every closed Legal Entity permission key without widening it', () =>
  Effect.gen(function* forwardsLegalEntityPermissionKeys() {
    const { observed, service } = makeAllowedPermissionRecorder();

    yield* Effect.forEach(
      LEGAL_ENTITY_PERMISSION_KEYS,
      (permission) =>
        service
          .legalEntities({
            legalEntityIds: [legalEntityId],
            permission,
            principalId,
            tenantId,
          })
          .pipe(Effect.map((result) => expect(result).toEqual([{ decision: 'allowed', key: legalEntityId }]))),
      { concurrency: 1 },
    );
    expect(observed).toEqual(LEGAL_ENTITY_PERMISSION_KEYS);
  }),
);

it('creates lossless tenant and legal-entity-qualified object identities', () => {
  const resource = {
    moduleId: 'property.registry',
    resourceId: 'unit:with/slashes',
    resourceType: 'property.unit',
  };
  expect(toLegalEntityAccessObjectId(tenantId, legalEntityId)).not.toBe(
    toLegalEntityAccessObjectId('10000000-0000-4000-8000-000000000002', legalEntityId),
  );
  expect(toModuleAccessObjectId(tenantId, legalEntityId, 'property.registry')).not.toBe(
    toModuleAccessObjectId(tenantId, legalEntityId, 'property-registry'),
  );
  expect(toResourceAccessObjectId(tenantId, legalEntityId, resource)).not.toBe(
    toResourceAccessObjectId(tenantId, legalEntityId, {
      ...resource,
      resourceId: 'unit-with/slashes',
    }),
  );
});

it.effect('checks exact business permissions and rejects untrusted storefront scope', () =>
  Effect.gen(function* checksBusinessPermissionScope() {
    const requests: v1.CheckBulkPermissionsRequest[] = [];
    const access = makeContextAccess(
      makeClient((request) =>
        Effect.sync(() => {
          requests.push(request);
          return responseFor(request, [v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION]);
        }),
      ),
    );
    const permission = yield* Schema.decodeEffect(BusinessPermissionCodeSchema)('counterparty.purchase.submit');
    const businessTarget = {
      permission,
      target: {
        counterpartyId: 'counterparty-1',
        kind: 'counterparty_storefront' as const,
        legalEntityId,
        storefrontId: 'storefront-1',
        tenantId,
      },
    };
    const checkBusinessPermissions = requireBusinessPermissions(access);
    const allowed = yield* checkBusinessPermissions({
      principal: { principalId, tenantId },
      targets: [businessTarget],
      trustedStorefrontId: 'storefront-1',
    });
    expect(allowed).toEqual([
      {
        decision: 'allowed',
        key: toBusinessPermissionAccessKey(businessTarget),
      },
    ]);
    expect(requests[0]?.items[0]?.permission).toBe('use');
    expect(requests[0]?.items[0]?.resource?.objectType).toBe('business_permission');
    expect(requests[0]?.items[0]?.resource?.objectId).toBe(
      toBusinessPermissionAccessObjectId(permission, businessTarget.target),
    );

    const unavailable = yield* checkBusinessPermissions({
      principal: { principalId, tenantId },
      targets: [businessTarget],
      trustedStorefrontId: 'storefront-2',
    });
    expect(unavailable).toEqual([
      {
        decision: 'unavailable',
        key: toBusinessPermissionAccessKey(businessTarget),
      },
    ]);
    expect(requests).toHaveLength(1);
  }),
);

it.effect('checks one exact tenant-qualified Inventory Resource and rejects another owner or identity', () =>
  Effect.gen(function* checksInventoryResourcePermission() {
    const requests: v1.CheckBulkPermissionsRequest[] = [];
    const access = makeContextAccess(
      makeClient((request) =>
        Effect.sync(() => {
          requests.push(request);
          return responseFor(request, [v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION]);
        }),
      ),
    );
    const permission = yield* Schema.decodeEffect(BusinessPermissionCodeSchema)('inventory.stock.correct');
    const target = {
      permission,
      target: {
        kind: 'inventory_resource' as const,
        resource: {
          moduleId: 'commerce.inventory' as const,
          resourceId: inventoryResourceId,
          resourceType: 'commerce.inventory.stock-position',
        },
        tenantId,
      },
    };
    const check = requireBusinessPermissions(access);
    expect(yield* check({ principal: { principalId, tenantId }, targets: [target] })).toEqual([
      { decision: 'allowed', key: toBusinessPermissionAccessKey(target) },
    ]);
    expect(requests[0]?.items[0]?.resource?.objectId).toBe(
      toBusinessPermissionAccessObjectId(permission, target.target),
    );

    for (const invalidTarget of [
      {
        ...target.target,
        resource: { ...target.target.resource, resourceType: 'commerce.catalog.stock-position' },
      },
      { ...target.target, resource: { ...target.target.resource, resourceId: 'position-by-location' } },
    ]) {
      expect(
        yield* check({ principal: { principalId, tenantId }, targets: [{ permission, target: invalidTarget }] }),
      ).toEqual([
        {
          decision: 'unavailable',
          key: toBusinessPermissionAccessKey({ permission, target: invalidTarget }),
        },
      ]);
    }
    expect(requests).toHaveLength(1);
  }),
);

it.effect('checks TAX management on one exact Selling Legal Entity and keeps other sellers distinct', () =>
  Effect.gen(function* checksTaxSellingLegalEntityPermission() {
    const requests: v1.CheckBulkPermissionsRequest[] = [];
    const access = makeContextAccess(
      makeClient((request) =>
        Effect.sync(() => {
          requests.push(request);
          return responseFor(request, [v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION]);
        }),
      ),
    );
    const permission = yield* Schema.decodeEffect(BusinessPermissionCodeSchema)('tax.rule.manage');
    const target = {
      permission,
      target: { kind: 'tax_selling_legal_entity' as const, legalEntityId, tenantId },
    };
    const check = requireBusinessPermissions(access);
    expect(yield* check({ principal: { principalId, tenantId }, targets: [target] })).toEqual([
      { decision: 'allowed', key: toBusinessPermissionAccessKey(target) },
    ]);
    expect(requests[0]?.items[0]?.resource?.objectId).toBe(
      toBusinessPermissionAccessObjectId(permission, target.target),
    );
    const otherSeller = { ...target.target, legalEntityId: '20000000-0000-4000-8000-000000000002' };
    expect(toBusinessPermissionAccessObjectId(permission, otherSeller)).not.toBe(
      toBusinessPermissionAccessObjectId(permission, target.target),
    );
    const readPermission = yield* Schema.decodeEffect(BusinessPermissionCodeSchema)('tax.governed.read');
    for (const invalid of [
      { permission: readPermission, target: target.target },
      {
        permission,
        target: { counterpartyId: 'counterparty-1', kind: 'counterparty' as const, legalEntityId, tenantId },
      },
    ]) {
      expect(yield* check({ principal: { principalId, tenantId }, targets: [invalid] })).toEqual([
        { decision: 'unavailable', key: toBusinessPermissionAccessKey(invalid) },
      ]);
    }
    expect(requests).toHaveLength(1);
  }),
);

it.effect('accepts either an exact Storefront or exact Counterparty-wide positive grant', () =>
  Effect.gen(function* acceptsBusinessPermissionAlternatives() {
    const observedObjectIds: string[][] = [];
    const permission = yield* Schema.decodeEffect(BusinessPermissionCodeSchema)('counterparty.purchase.submit');
    const target = {
      permission,
      target: {
        counterpartyId: 'counterparty-1',
        kind: 'counterparty_storefront' as const,
        legalEntityId,
        storefrontId: 'storefront-1',
        tenantId,
      },
    };
    const decisions = [
      [
        v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION,
        v1.CheckPermissionResponse_Permissionship.NO_PERMISSION,
      ],
      [
        v1.CheckPermissionResponse_Permissionship.NO_PERMISSION,
        v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION,
      ],
      [v1.CheckPermissionResponse_Permissionship.NO_PERMISSION, v1.CheckPermissionResponse_Permissionship.UNSPECIFIED],
      [
        v1.CheckPermissionResponse_Permissionship.NO_PERMISSION,
        v1.CheckPermissionResponse_Permissionship.NO_PERMISSION,
      ],
    ] as const;
    let invocation = 0;
    const access = makeContextAccess(
      makeClient((request) =>
        Effect.sync(() => {
          observedObjectIds.push(request.items.map(({ resource }) => resource?.objectId ?? ''));
          const response = responseFor(request, decisions[invocation] ?? []);
          invocation += 1;
          return response;
        }),
      ),
    );
    const check = requireBusinessPermissions(access);
    const run = () =>
      check({
        principal: { principalId, tenantId },
        targets: [target],
        trustedStorefrontId: 'storefront-1',
      });

    expect(yield* run()).toEqual([{ decision: 'allowed', key: toBusinessPermissionAccessKey(target) }]);
    expect(yield* run()).toEqual([{ decision: 'allowed', key: toBusinessPermissionAccessKey(target) }]);
    expect(yield* run()).toEqual([{ decision: 'unavailable', key: toBusinessPermissionAccessKey(target) }]);
    expect(yield* run()).toEqual([{ decision: 'denied', key: toBusinessPermissionAccessKey(target) }]);
    expect(observedObjectIds[0]).toEqual([
      toBusinessPermissionAccessObjectId(permission, target.target),
      toBusinessPermissionAccessObjectId(permission, {
        counterpartyId: 'counterparty-1',
        kind: 'counterparty',
        legalEntityId,
        tenantId,
      }),
    ]);
  }),
);

it.effect('checks one exact Price Group target and leaves containing-catalog traversal to SpiceDB', () =>
  Effect.gen(function* checksPriceGroupPermission() {
    const requests: v1.CheckBulkPermissionsRequest[] = [];
    const access = makeContextAccess(
      makeClient((request) =>
        Effect.sync(() => {
          requests.push(request);
          return responseFor(request, [v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION]);
        }),
      ),
    );
    const permission = yield* Schema.decodeEffect(BusinessPermissionCodeSchema)('pricing.price_group.read');
    const target = {
      permission,
      target: {
        kind: 'price_group' as const,
        priceGroupId,
        pricingCatalogId,
        tenantId,
      },
    };

    expect(
      yield* requireBusinessPermissions(access)({
        principal: { principalId, tenantId },
        targets: [target],
      }),
    ).toEqual([{ decision: 'allowed', key: toBusinessPermissionAccessKey(target) }]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.items).toHaveLength(1);
    expect(requests[0]?.items[0]?.resource?.objectId).toBe(
      toBusinessPermissionAccessObjectId(permission, target.target),
    );
    expect(toBusinessPermissionAccessObjectId(permission, target.target)).not.toBe(
      toBusinessPermissionAccessObjectId(permission, {
        ...target.target,
        priceGroupId: otherPriceGroupId,
      }),
    );
  }),
);

it.effect('rejects incompatible permission families and noncanonical Pricing identifiers before SpiceDB', () =>
  Effect.gen(function* rejectsInvalidPricingTargets() {
    let requests = 0;
    const access = makeContextAccess(
      makeClient((request) => {
        requests += 1;
        return Effect.succeed(responseFor(request, []));
      }),
    );
    const pricingPermission = yield* Schema.decodeEffect(BusinessPermissionCodeSchema)('pricing.price_group.read');
    const counterpartyPermission =
      yield* Schema.decodeEffect(BusinessPermissionCodeSchema)('counterparty.purchase.submit');
    const targets = [
      {
        permission: pricingPermission,
        target: { counterpartyId: 'counterparty-1', kind: 'counterparty' as const, legalEntityId, tenantId },
      },
      {
        permission: counterpartyPermission,
        target: { kind: 'price_group' as const, priceGroupId, pricingCatalogId, tenantId },
      },
      {
        permission: pricingPermission,
        target: { kind: 'price_group' as const, priceGroupId: 'DEALER', pricingCatalogId, tenantId },
      },
      {
        permission: pricingPermission,
        target: { kind: 'pricing_catalog' as const, pricingCatalogId: 'DEALER', tenantId },
      },
    ];

    expect(
      yield* requireBusinessPermissions(access)({
        principal: { principalId, tenantId },
        targets,
      }),
    ).toEqual(targets.map((target) => ({ decision: 'unavailable', key: toBusinessPermissionAccessKey(target) })));
    for (const target of targets) {
      expect(toBusinessPermissionAccessObjectId(target.permission, target.target)).toBeUndefined();
    }
    expect(requests).toBe(0);
  }),
);

it.effect('reuses exact and Counterparty-wide alternatives across repeated Storefront targets', () =>
  Effect.gen(function* reusesBusinessPermissionAlternative() {
    const permission = yield* Schema.decodeEffect(BusinessPermissionCodeSchema)('counterparty.purchase.submit');
    const target = {
      permission,
      target: {
        counterpartyId: 'counterparty-1',
        kind: 'counterparty_storefront' as const,
        legalEntityId,
        storefrontId: 'storefront-1',
        tenantId,
      },
    };
    const targets = [target, target];
    const access = makeContextAccess(
      makeClient((request) =>
        Effect.sync(() => {
          expect(request.items).toHaveLength(2);
          return responseFor(request, [
            v1.CheckPermissionResponse_Permissionship.NO_PERMISSION,
            v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION,
          ]);
        }),
      ),
    );

    expect(
      yield* requireBusinessPermissions(access)({
        principal: { principalId, tenantId },
        targets,
        trustedStorefrontId: 'storefront-1',
      }),
    ).toEqual([
      {
        decision: 'allowed',
        key: toBusinessPermissionAccessKey(target),
      },
      {
        decision: 'allowed',
        key: toBusinessPermissionAccessKey(target),
      },
    ]);
  }),
);

it.effect('checks exact named context permissions in tenant-qualified scope', () =>
  Effect.gen(function* checksContextPermission() {
    const requests: v1.CheckBulkPermissionsRequest[] = [];
    const access = makeContextAccess(
      makeClient((request) =>
        Effect.sync(() => {
          requests.push(request);
          return responseFor(request, [v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION]);
        }),
      ),
    );
    const target = {
      moduleId: 'commerce.customer-context',
      permission: 'customer.group.history.read',
    };
    const result = yield* requireContextPermissions(access)({
      legalEntityId,
      principalId,
      targets: [target],
      tenantId,
    });
    expect(result).toEqual([{ decision: 'allowed', key: toContextPermissionAccessKey(target) }]);
    expect(requests[0]?.items[0]?.permission).toBe('access');
    expect(requests[0]?.items[0]?.resource?.objectType).toBe('context_permission');
    expect(requests[0]?.items[0]?.resource?.objectId).toBe(
      toContextPermissionAccessObjectId(tenantId, legalEntityId, target),
    );
    expect(toContextPermissionAccessObjectId(tenantId, legalEntityId, target)).not.toBe(
      toContextPermissionAccessObjectId('other-tenant', legalEntityId, target),
    );
  }),
);

it.effect('rejects cross-tenant business permission checks before calling SpiceDB', () =>
  Effect.gen(function* rejectsCrossTenantBusinessTarget() {
    let requests = 0;
    const access = makeContextAccess(
      makeClient((request) =>
        Effect.sync(() => {
          requests += 1;
          return responseFor(request, [v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION]);
        }),
      ),
    );
    const target = {
      permission: yield* Schema.decodeEffect(BusinessPermissionCodeSchema)('retail.profile.read'),
      target: {
        kind: 'retail_profile' as const,
        legalEntityId,
        profileId: 'profile-1',
        tenantId: '10000000-0000-4000-8000-000000000002',
      },
    };
    const checkBusinessPermissions = requireBusinessPermissions(access);
    expect(
      yield* checkBusinessPermissions({
        principal: { principalId, tenantId },
        targets: [target],
      }),
    ).toEqual([{ decision: 'unavailable', key: toBusinessPermissionAccessKey(target) }]);
    expect(requests).toBe(0);
  }),
);

it.effect('rejects cross-tenant Pricing permission checks before calling SpiceDB', () =>
  Effect.gen(function* rejectsCrossTenantPricingTarget() {
    let requests = 0;
    const access = makeContextAccess(
      makeClient((request) =>
        Effect.sync(() => {
          requests += 1;
          return responseFor(request, [v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION]);
        }),
      ),
    );
    const target = {
      permission: yield* Schema.decodeEffect(BusinessPermissionCodeSchema)('pricing.price_group.read'),
      target: {
        kind: 'pricing_catalog' as const,
        pricingCatalogId,
        tenantId: '10000000-0000-4000-8000-000000000002',
      },
    };
    expect(
      yield* requireBusinessPermissions(access)({
        principal: { principalId, tenantId },
        targets: [target],
      }),
    ).toEqual([{ decision: 'unavailable', key: toBusinessPermissionAccessKey(target) }]);
    expect(requests).toBe(0);
  }),
);

it.effect('supports empty batches and exact resource filtering', () =>
  Effect.gen(function* supportsEmptyBatches() {
    let requests = 0;
    const access = makeContextAccess(
      makeClient((request) =>
        Effect.sync(() => {
          requests += 1;
          return responseFor(request, [
            v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION,
            v1.CheckPermissionResponse_Permissionship.NO_PERMISSION,
          ]);
        }),
      ),
    );
    expect(
      yield* access.legalEntities({
        legalEntityIds: [],
        principalId,
        tenantId,
      }),
    ).toEqual([]);
    expect(
      yield* access.resources({
        legalEntityId,
        principalId,
        resources: [
          {
            moduleId: 'property.registry',
            resourceId: 'unit-1',
            resourceType: 'property.unit',
          },
          {
            moduleId: 'property.registry',
            resourceId: 'unit-2',
            resourceType: 'property.unit',
          },
        ],
        tenantId,
      }),
    ).toEqual([
      { decision: 'allowed', key: 'property.registry:property.unit:unit-1' },
      { decision: 'denied', key: 'property.registry:property.unit:unit-2' },
    ]);
    expect(requests).toBe(1);
  }),
);

it.effect('classifies client, partial, duplicate, malformed, and conditional results as unavailable', () =>
  Effect.gen(function* classifiesUnavailableResults() {
    const input = { legalEntityIds: [legalEntityId], principalId, tenantId };
    const failures = [
      makeClient(() => Effect.fail(spiceDbPermissionClientError(new Error('secret SpiceDB diagnostic')))),
      makeClient(() => Effect.succeed(v1.CheckBulkPermissionsResponse.create({ pairs: [] }))),
      makeClient((request) =>
        Effect.succeed(responseFor(request, [v1.CheckPermissionResponse_Permissionship.CONDITIONAL_PERMISSION])),
      ),
      makeClient((request) =>
        Effect.sync(() => {
          const response = responseFor(request, [v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION]);
          const [pair] = response.pairs;
          return v1.CheckBulkPermissionsResponse.create({
            pairs: pair === undefined ? [] : [{ response: pair.response }],
          });
        }),
      ),
    ];
    const [failingClient] = failures;
    expect(failingClient).toBeDefined();
    if (failingClient === undefined) {
      throw new Error('Missing failingClient');
    }
    yield* Effect.forEach(
      failures,
      (client) =>
        makeContextAccess(client)
          .legalEntities(input)
          .pipe(Effect.map((result) => expect(result).toEqual([{ decision: 'unavailable', key: legalEntityId }]))),
      { concurrency: 1 },
    );
    expect(
      yield* makeContextAccess(failingClient).legalEntities({
        ...input,
        legalEntityIds: [legalEntityId, legalEntityId],
      }),
    ).toEqual([
      { decision: 'unavailable', key: legalEntityId },
      { decision: 'unavailable', key: legalEntityId },
    ]);
  }),
);

it.effect('keeps Tenant resource assignment grants exact and independent of Legal Entity resources', () =>
  Effect.gen(function* tenantResourceAssignments() {
    const targets = [
      { moduleId: 'projects.core', resourceId: 'ONE', resourceType: 'projects.project-owner-eligibility' },
      { moduleId: 'projects.core', resourceId: 'TWO', resourceType: 'projects.project-owner-eligibility' },
    ];
    const access = makeContextAccess(
      makeClient((request) => {
        expect(request.items.map((item) => item.resource?.objectType)).toEqual(['tenant_resource', 'tenant_resource']);
        expect(request.items.map((item) => item.permission)).toEqual(['assign', 'assign']);
        expect(request.items[0]?.resource?.objectId).not.toBe(request.items[1]?.resource?.objectId);
        return Effect.succeed(
          responseFor(request, [
            v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION,
            v1.CheckPermissionResponse_Permissionship.NO_PERMISSION,
          ]),
        );
      }),
    );
    const decisions = yield* access.tenantResources === undefined
      ? Effect.die(new Error('Expected tenant resource adapter'))
      : access.tenantResources({ permission: 'assign', principalId, resources: targets, tenantId });
    expect(decisions.map(({ decision }) => decision)).toEqual(['allowed', 'denied']);
  }),
);

it.effect('freezes every remaining family identity and independent Current outcomes without broad scope', () =>
  Effect.gen(function* remainingFamilyGrantBaselines() {
    for (const row of remainingPermissionBaselines) {
      const permission = yield* Schema.decodeEffect(BusinessPermissionCodeSchema)(row.permission);
      expect(toBusinessPermissionAccessObjectId(permission, row.target)).toBe(row.objectId);
      expect(toBusinessPermissionAccessKey({ permission, target: row.target })).toBe(row.key);
      const requests: v1.CheckBulkPermissionsRequest[] = [];
      const current: BaselineCurrentState = { decision: 'allowed' };
      const access = makeContextAccess(
        makeClient((request) =>
          Effect.sync(() => {
            requests.push(request);
            return responseFor(
              request,
              request.items.map((item) => {
                if (item.subject?.object?.objectId !== principalId || current.decision === 'denied') {
                  return v1.CheckPermissionResponse_Permissionship.NO_PERMISSION;
                }
                if (current.decision === 'unavailable') {
                  return v1.CheckPermissionResponse_Permissionship.UNSPECIFIED;
                }
                return v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION;
              }),
            );
          }),
        ),
      );
      const check = requireBusinessPermissions(access);
      const input = {
        principal: { principalId, tenantId: row.target.tenantId },
        targets: [{ permission, target: row.target }],
        trustedStorefrontId: 'storefront-a',
      };
      expect(yield* check(input)).toEqual([{ decision: 'allowed', key: row.key }]);
      expect(requests[0]?.items[0]?.resource).toEqual({ objectId: row.objectId, objectType: 'business_permission' });
      expect(requests[0]?.items[0]?.subject?.object).toEqual({ objectId: principalId, objectType: 'principal' });
      expect(
        yield* check({
          ...input,
          principal: { ...input.principal, principalId: '30000000-0000-4000-8000-000000000002' },
        }),
      ).toEqual([{ decision: 'denied', key: row.key }]);
      expect(requests[1]?.items[0]?.subject?.object?.objectId).toBe('30000000-0000-4000-8000-000000000002');
      current.decision = 'denied';
      expect(yield* check(input)).toEqual([{ decision: 'denied', key: row.key }]);
      current.decision = 'unavailable';
      expect(yield* check(input)).toEqual([{ decision: 'unavailable', key: row.key }]);
      const checked = requests.length;
      expect(
        yield* check({ ...input, principal: { principalId, tenantId: '00000000-0000-4000-8000-000000000099' } }),
      ).toEqual([{ decision: 'unavailable', key: row.key }]);
      const unknown = yield* Schema.decodeEffect(BusinessPermissionCodeSchema)('undeclared.permission');
      expect(yield* check({ ...input, targets: [{ permission: unknown, target: row.target }] })).toEqual([
        { decision: 'unavailable', key: row.unknownKey },
      ]);
      expect(requests).toHaveLength(checked);
    }
  }),
);

it('keeps the existing 1024-byte grant identity limit without truncation', () => {
  const [row] = remainingPermissionBaselines;
  const permission = Schema.decodeSync(BusinessPermissionCodeSchema)(row.permission);
  expect(toBusinessPermissionAccessObjectId(permission, { ...row.target, profileId: 'x'.repeat(644) })?.length).toBe(
    1024,
  );
  expect(toBusinessPermissionAccessObjectId(permission, { ...row.target, profileId: 'x'.repeat(645) })).toBeUndefined();
});

it.effect('freezes exact-first Counterparty inheritance order and repeated-target deduplication', () =>
  Effect.gen(function* freezesInheritedGrantOrder() {
    const { 2: row } = remainingPermissionBaselines;
    const permission = yield* Schema.decodeEffect(BusinessPermissionCodeSchema)(row.permission);
    const requests: v1.CheckBulkPermissionsRequest[] = [];
    const access = makeContextAccess(
      makeClient((request) =>
        Effect.sync(() => {
          requests.push(request);
          return responseFor(
            request,
            request.items.map(() => v1.CheckPermissionResponse_Permissionship.NO_PERMISSION),
          );
        }),
      ),
    );
    expect(
      yield* requireBusinessPermissions(access)({
        principal: { principalId, tenantId: row.target.tenantId },
        targets: [
          { permission, target: row.target },
          { permission, target: row.target },
        ],
        trustedStorefrontId: row.target.storefrontId,
      }),
    ).toEqual([
      { decision: 'denied', key: row.key },
      { decision: 'denied', key: row.key },
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.items.map((item) => item.resource?.objectId)).toEqual([
      row.objectId,
      remainingPermissionBaselines[1].objectId,
    ]);
  }),
);
