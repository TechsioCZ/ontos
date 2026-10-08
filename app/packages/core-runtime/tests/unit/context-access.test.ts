import { v1 } from '@authzed/authzed-node';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { spiceDbPermissionClientError } from '../../src/permissions/client.ts';
import type { SpiceDbPermissionClient } from '../../src/permissions/client.ts';
import {
  makeContextAccess,
  toAssortmentPermissionAccessKey,
  toAssortmentPermissionAccessObjectId,
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

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const principalId = '30000000-0000-4000-8000-000000000001';
const pricingCatalogId = '50000000-0000-4000-8000-000000000001';
const priceGroupId = '60000000-0000-4000-8000-000000000001';
const otherPriceGroupId = '60000000-0000-4000-8000-000000000002';
const inventoryResourceId = '70000000-0000-4000-8000-000000000001';

const assortmentEndTarget = {
  binding: {
    moduleId: 'commerce.assortment',
    resourceId: 'binding-1',
    resourceType: 'commerce.assortment.applicability-binding',
  },
  kind: 'assortment_binding' as const,
  mode: 'end' as const,
  permission: 'assortment.binding.end' as const,
};

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

const requireAssortmentPermissions = (
  access: ReturnType<typeof makeContextAccess>,
): NonNullable<ReturnType<typeof makeContextAccess>['assortmentPermissions']> => {
  const check = access.assortmentPermissions;
  if (check === undefined) {
    throw new Error('Expected Assortment permission access');
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

it.effect('scopes Assortment keys and object IDs by trusted tenant and Legal Entity', () =>
  Effect.gen(function* scopesAssortmentTargets() {
    const requests: v1.CheckBulkPermissionsRequest[] = [];
    const service = makeContextAccess(
      makeClient((request) =>
        Effect.sync(() => {
          requests.push(request);
          return responseFor(request, [v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION]);
        }),
      ),
    );
    const result = yield* requireAssortmentPermissions(service)({
      legalEntityId,
      principal: { principalId, tenantId },
      targets: [{ target: assortmentEndTarget }],
    });
    const otherKey = toAssortmentPermissionAccessKey(
      '10000000-0000-4000-8000-000000000009',
      legalEntityId,
      assortmentEndTarget,
    );
    const objectId = toAssortmentPermissionAccessObjectId(tenantId, legalEntityId, assortmentEndTarget);
    expect(result).toEqual([
      { decision: 'allowed', key: toAssortmentPermissionAccessKey(tenantId, legalEntityId, assortmentEndTarget) },
    ]);
    expect(result?.[0]?.key).not.toBe(otherKey);
    expect(requests[0]?.items[0]?.permission).toBe('use');
    expect(requests[0]?.items[0]?.resource?.objectType).toBe('business_permission');
    expect(requests[0]?.items[0]?.resource?.objectId).toBe(objectId);
    expect(requests[0]?.items[0]?.resource?.objectId).not.toContain('binding-1');
  }),
);

it('uses tenant scope for Rule lineage and requires Legal Entity scope for binding lineage', () => {
  const ruleTarget = {
    effect: 'ALLOW' as const,
    kind: 'assortment_rule' as const,
    mode: 'create' as const,
    permission: 'assortment.rule.create' as const,
    purpose: 'PURCHASE' as const,
    selector: { kind: 'ALL' as const },
    stableCode: 'rule-1',
  };
  expect(toAssortmentPermissionAccessKey(tenantId, undefined, ruleTarget)).toBeDefined();
  expect(toAssortmentPermissionAccessObjectId(tenantId, undefined, ruleTarget)).toBeDefined();
  expect(toAssortmentPermissionAccessKey(tenantId, undefined, assortmentEndTarget)).toBeUndefined();
  expect(toAssortmentPermissionAccessObjectId(tenantId, undefined, assortmentEndTarget)).toBeUndefined();
});

it.effect('derives configuration scope from the exact canonical resource type and rejects unknown types', () =>
  Effect.gen(function* derivesConfigurationScope() {
    const requests: v1.CheckBulkPermissionsRequest[] = [];
    const service = makeContextAccess(
      makeClient((request) =>
        Effect.sync(() => {
          requests.push(request);
          return responseFor(
            request,
            request.items.map(() => v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION),
          );
        }),
      ),
    );
    const stableRuleTarget = {
      kind: 'assortment_configuration' as const,
      permission: 'assortment.configuration.read' as const,
      resource: {
        moduleId: 'commerce.assortment',
        resourceId: 'stable-rule-1',
        resourceType: 'commerce.assortment.stable-rule',
      },
    };
    const ruleRevisionTarget = {
      ...stableRuleTarget,
      resource: {
        ...stableRuleTarget.resource,
        resourceId: 'rule-revision-1',
        resourceType: 'commerce.assortment.rule-revision',
      },
    };
    const bindingTarget = {
      ...stableRuleTarget,
      resource: {
        ...stableRuleTarget.resource,
        resourceId: 'binding-1',
        resourceType: 'commerce.assortment.applicability-binding',
      },
    };
    const boundaryTarget = {
      ...stableRuleTarget,
      resource: {
        ...stableRuleTarget.resource,
        resourceId: 'boundary-1',
        resourceType: 'commerce.assortment.closed-assortment-boundary',
      },
    };
    const unknownTarget = {
      ...stableRuleTarget,
      resource: { ...stableRuleTarget.resource, resourceType: 'commerce.assortment.configuration' },
    };

    expect(toAssortmentPermissionAccessKey(tenantId, undefined, stableRuleTarget)).toBeDefined();
    expect(toAssortmentPermissionAccessKey(tenantId, undefined, ruleRevisionTarget)).toBeDefined();
    expect(toAssortmentPermissionAccessObjectId(tenantId, legalEntityId, stableRuleTarget)).toBe(
      toAssortmentPermissionAccessObjectId(tenantId, undefined, stableRuleTarget),
    );
    expect(toAssortmentPermissionAccessObjectId(tenantId, legalEntityId, ruleRevisionTarget)).toBe(
      toAssortmentPermissionAccessObjectId(tenantId, undefined, ruleRevisionTarget),
    );
    expect(toAssortmentPermissionAccessKey(tenantId, undefined, bindingTarget)).toBeUndefined();
    expect(toAssortmentPermissionAccessObjectId(tenantId, undefined, bindingTarget)).toBeUndefined();
    expect(toAssortmentPermissionAccessKey(tenantId, legalEntityId, bindingTarget)).toBeDefined();
    expect(toAssortmentPermissionAccessKey(tenantId, undefined, boundaryTarget)).toBeUndefined();
    expect(toAssortmentPermissionAccessObjectId(tenantId, undefined, boundaryTarget)).toBeUndefined();
    expect(toAssortmentPermissionAccessKey(tenantId, legalEntityId, boundaryTarget)).toBeDefined();
    expect(toAssortmentPermissionAccessKey(tenantId, legalEntityId, unknownTarget)).toBeUndefined();
    expect(toAssortmentPermissionAccessObjectId(tenantId, legalEntityId, unknownTarget)).toBeUndefined();

    const tenantResults = yield* requireAssortmentPermissions(service)({
      principal: { principalId, tenantId },
      targets: [{ target: stableRuleTarget }, { target: ruleRevisionTarget }],
    });
    expect(tenantResults.map(({ decision }) => decision)).toEqual(['allowed', 'allowed']);
    const legalEntityResults = yield* requireAssortmentPermissions(service)({
      legalEntityId,
      principal: { principalId, tenantId },
      targets: [{ target: bindingTarget }, { target: boundaryTarget }],
    });
    expect(legalEntityResults.map(({ decision }) => decision)).toEqual(['allowed', 'allowed']);
    const unavailableResults = yield* requireAssortmentPermissions(service)({
      principal: { principalId, tenantId },
      targets: [{ target: bindingTarget }, { target: boundaryTarget }, { target: unknownTarget }],
    });
    expect(unavailableResults).toEqual([
      { decision: 'unavailable', key: 'assortment.configuration.read:assortment_configuration' },
      { decision: 'unavailable', key: 'assortment.configuration.read:assortment_configuration' },
      { decision: 'unavailable', key: 'assortment.configuration.read:assortment_configuration' },
    ]);
    expect(requests).toHaveLength(2);
  }),
);

it.effect('keeps complete Admission Set digest semantics exact and distinguishes storefront trust', () =>
  Effect.gen(function* checksAdmissionSetAndStorefront() {
    const requests: v1.CheckBulkPermissionsRequest[] = [];
    const service = makeContextAccess(
      makeClient((request) =>
        Effect.sync(() => {
          requests.push(request);
          return responseFor(
            request,
            request.items.map(() => v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION),
          );
        }),
      ),
    );
    const target = {
      admissionSet: {
        collectionRevision: {
          moduleId: 'catalog.core',
          resourceId: 'collection-revision-1',
          resourceType: 'catalog.collection-revision',
        },
        contentHash: 'a'.repeat(64),
        entries: [],
        memberCount: 0,
        setKind: 'EMPTY' as const,
      },
      commercialScope: {
        channel: { moduleId: 'commerce.channel', resourceId: 'web', resourceType: 'commerce.channel' },
      },
      effectiveFrom: '2026-09-22T00:00:00.000Z',
      kind: 'assortment_boundary' as const,
      mode: 'create' as const,
      permission: 'assortment.boundary.create' as const,
      purpose: 'PURCHASE' as const,
      subject: {
        kind: 'COUNTERPARTY' as const,
        ref: { moduleId: 'party.registry', resourceId: 'counterparty-1', resourceType: 'party.registry.counterparty' },
      },
    } as const;
    const result = yield* requireAssortmentPermissions(service)({
      legalEntityId,
      principal: { principalId, tenantId },
      targets: [{ target }],
    });
    expect(result?.[0]?.decision).toBe('allowed');
    const sameMeaning = toAssortmentPermissionAccessObjectId(tenantId, legalEntityId, target);
    const changedMeaning = toAssortmentPermissionAccessObjectId(tenantId, legalEntityId, {
      ...target,
      admissionSet: {
        contentHash: 'a'.repeat(64),
        entries: [
          {
            kind: 'PRODUCT',
            target: { moduleId: 'commerce.catalog', resourceId: 'product-a', resourceType: 'commerce.catalog.product' },
          },
        ],
        memberCount: 1,
        setKind: 'ENTRIES',
      },
    });
    const categoryMeaning = toAssortmentPermissionAccessObjectId(tenantId, legalEntityId, {
      ...target,
      admissionSet: {
        contentHash: 'a'.repeat(64),
        entries: [
          {
            kind: 'CATEGORY',
            target: {
              moduleId: 'commerce.catalog',
              resourceId: 'category-c',
              resourceType: 'commerce.catalog.product-category',
            },
          },
        ],
        memberCount: 1,
        setKind: 'ENTRIES',
      },
    });
    const allMeaning = toAssortmentPermissionAccessObjectId(tenantId, legalEntityId, {
      ...target,
      admissionSet: { contentHash: 'a'.repeat(64), entries: [{ kind: 'ALL' }], memberCount: 1, setKind: 'ENTRIES' },
    });
    const otherProductMeaning = toAssortmentPermissionAccessObjectId(tenantId, legalEntityId, {
      ...target,
      admissionSet: {
        contentHash: 'a'.repeat(64),
        entries: [
          {
            kind: 'PRODUCT',
            target: { moduleId: 'commerce.catalog', resourceId: 'product-b', resourceType: 'commerce.catalog.product' },
          },
        ],
        memberCount: 1,
        setKind: 'ENTRIES',
      },
    });
    expect(sameMeaning).toBeDefined();
    expect(sameMeaning).not.toBe(changedMeaning);
    expect(new Set([sameMeaning, changedMeaning, categoryMeaning, allMeaning, otherProductMeaning]).size).toBe(5);
    expect(
      toAssortmentPermissionAccessObjectId(tenantId, legalEntityId, {
        ...target,
        admissionSet: { contentHash: 'a'.repeat(64), entries: [], memberCount: 1, setKind: 'ENTRIES' },
      }),
    ).toBeUndefined();
    expect(requests[0]?.items[0]?.resource?.objectId).not.toContain('a'.repeat(64));
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
    const contractPermission = yield* Schema.decodeEffect(BusinessPermissionCodeSchema)(
      'tax.authority_contract.manage',
    );
    expect(toBusinessPermissionAccessObjectId(contractPermission, target.target)).not.toBe(
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
