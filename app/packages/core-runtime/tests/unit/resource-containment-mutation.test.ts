import { v1 } from '@authzed/authzed-node';
import { Effect, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { BusinessPermissionCodeSchema } from '../../src/permissions/business-permission.ts';
import {
  toBusinessPermissionAccessObjectId,
  toModuleAccessObjectId,
  toResourceAccessObjectId,
} from '../../src/permissions/context-access.ts';
import {
  makeResourceContainmentRelationshipMutation,
  ownerResourceModuleContainment,
  ResourceContainmentMutationUnavailable,
} from '../../src/permissions/resource-containment-mutation.ts';
import type { ResourceContainmentRelationship } from '../../src/permissions/resource-containment-mutation.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const otherTenantId = '10000000-0000-4000-8000-000000000002';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const pricingCatalogId = '50000000-0000-4000-8000-000000000001';
const otherPricingCatalogId = '50000000-0000-4000-8000-000000000002';
const priceGroupId = '60000000-0000-4000-8000-000000000001';

const permission = (operation: string) =>
  Schema.decodeSync(BusinessPermissionCodeSchema)(`pricing.price_group.${operation}`);

const permissionObjectId = (
  operation: string,
  target:
    | Readonly<{ kind: 'pricing_catalog'; pricingCatalogId: string; tenantId: string }>
    | Readonly<{ kind: 'price_group'; priceGroupId: string; pricingCatalogId: string; tenantId: string }>,
): string => {
  const objectId = toBusinessPermissionAccessObjectId(permission(operation), target);
  if (objectId === undefined) {
    throw new Error('Expected a valid Pricing permission object ID');
  }
  return objectId;
};

const catalogReference = (operation = 'read', targetTenantId = tenantId, catalogId = pricingCatalogId) => ({
  objectId: permissionObjectId(operation, {
    kind: 'pricing_catalog',
    pricingCatalogId: catalogId,
    tenantId: targetTenantId,
  }),
  objectType: 'business_permission' as const,
});

const groupReference = (operation = 'read', targetTenantId = tenantId, catalogId = pricingCatalogId) => ({
  objectId: permissionObjectId(operation, {
    kind: 'price_group',
    priceGroupId,
    pricingCatalogId: catalogId,
    tenantId: targetTenantId,
  }),
  objectType: 'business_permission' as const,
});

const tenantRelationship = (
  operation = 'read',
  encodedTenantId = tenantId,
  relatedTenantId = encodedTenantId,
): Extract<ResourceContainmentRelationship, { readonly relation: 'tenant' }> => ({
  container: { objectId: relatedTenantId, objectType: 'tenant' },
  relation: 'tenant',
  resource: groupReference(operation, encodedTenantId),
});

const containmentRelationship = (
  groupOperation = 'read',
  catalogOperation = groupOperation,
  groupTenantId = tenantId,
  catalogTenantId = groupTenantId,
  catalogId = pricingCatalogId,
): Extract<ResourceContainmentRelationship, { readonly relation: 'containing_catalog' }> => ({
  container: catalogReference(catalogOperation, catalogTenantId, catalogId),
  relation: 'containing_catalog',
  resource: groupReference(groupOperation, groupTenantId, catalogId),
});

const makeHarness = () => {
  const requests: v1.WriteRelationshipsRequest[] = [];
  const service = makeResourceContainmentRelationshipMutation({
    writeRelationships: (request) =>
      Effect.sync(() => {
        requests.push(request);
        return v1.WriteRelationshipsResponse.create({});
      }),
  });
  return { requests, service };
};

it.effect('touches an exact Pricing tenant and containment set atomically', () =>
  Effect.gen(function* touchAtomicContainmentSet() {
    const { requests, service } = makeHarness();
    const tenant = tenantRelationship();
    const containment = containmentRelationship();
    yield* service.touch({ relationships: [tenant, containment] });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.updates).toHaveLength(2);
    expect(requests[0]?.updates.every(({ operation }) => operation === v1.RelationshipUpdate_Operation.TOUCH)).toBe(
      true,
    );
    expect(
      requests[0]?.updates.map(({ relationship: written }) => ({
        relation: written?.relation,
        resource: written?.resource,
        subject: written?.subject?.object,
      })),
    ).toEqual([
      {
        relation: 'tenant',
        resource: v1.ObjectReference.create(tenant.resource),
        subject: v1.ObjectReference.create(tenant.container),
      },
      {
        relation: 'containing_catalog',
        resource: v1.ObjectReference.create(containment.resource),
        subject: v1.ObjectReference.create(containment.container),
      },
    ]);
  }),
);

it.effect('rejects malformed, duplicate, or unsupported topology before transport', () =>
  Effect.gen(function* rejectInvalidTopology() {
    const { requests, service } = makeHarness();
    const duplicate = containmentRelationship();
    const invalidRelation = containmentRelationship();
    Reflect.set(invalidRelation, 'relation', 'Invalid relation');
    const unsupportedPrincipalRelationship = tenantRelationship();
    Reflect.set(unsupportedPrincipalRelationship, 'container', {
      objectId: 'principal_one',
      objectType: 'principal',
    });
    Reflect.set(unsupportedPrincipalRelationship, 'relation', 'grantee');
    const failures = [
      yield* Effect.flip(service.touch({ relationships: [duplicate, duplicate] })),
      yield* Effect.flip(service.touch({ relationships: [invalidRelation] })),
      yield* Effect.flip(
        service.touch({
          relationships: [
            {
              container: { objectId: tenantId, objectType: 'tenant' },
              relation: 'tenant',
              resource: { objectId: 'ctx_not-a-canonical-identity', objectType: 'business_permission' },
            },
          ],
        }),
      ),
      yield* Effect.flip(service.touch({ relationships: [unsupportedPrincipalRelationship] })),
    ];
    expect(failures.every((failure) => Predicate.isTagged(failure, 'ResourceContainmentMutationUnavailable'))).toBe(
      true,
    );
    expect(requests).toHaveLength(0);
  }),
);

it.effect('rejects tenant injection into a legacy business permission object', () =>
  Effect.gen(function* rejectLegacyPermissionTenantInjection() {
    const { requests, service } = makeHarness();
    const legacyPermission = yield* Schema.decodeEffect(BusinessPermissionCodeSchema)('counterparty.purchase.submit');
    const legacyObjectId = toBusinessPermissionAccessObjectId(legacyPermission, {
      counterpartyId: 'counterparty-one',
      kind: 'counterparty',
      legalEntityId,
      tenantId,
    });
    if (legacyObjectId === undefined) {
      throw new Error('Expected a valid legacy permission object ID');
    }
    const failure = yield* Effect.flip(
      service.touch({
        relationships: [
          {
            container: { objectId: tenantId, objectType: 'tenant' },
            relation: 'tenant',
            resource: { objectId: legacyObjectId, objectType: 'business_permission' },
          },
        ],
      }),
    );
    expect(failure).toBeInstanceOf(ResourceContainmentMutationUnavailable);
    expect(requests).toHaveLength(0);
  }),
);

it.effect('rejects a tenant relationship that disagrees with the encoded Pricing tenant', () =>
  Effect.gen(function* rejectTenantMismatch() {
    const { requests, service } = makeHarness();
    const failure = yield* Effect.flip(
      service.touch({ relationships: [tenantRelationship('read', tenantId, otherTenantId)] }),
    );
    expect(failure).toBeInstanceOf(ResourceContainmentMutationUnavailable);
    expect(requests).toHaveLength(0);
  }),
);

it.effect('rejects containment between different Pricing permissions', () =>
  Effect.gen(function* rejectPermissionMismatch() {
    const { requests, service } = makeHarness();
    const failure = yield* Effect.flip(service.touch({ relationships: [containmentRelationship('read', 'revise')] }));
    expect(failure).toBeInstanceOf(ResourceContainmentMutationUnavailable);
    expect(requests).toHaveLength(0);
  }),
);

it.effect('rejects cross-tenant and dual-catalog containment relationships', () =>
  Effect.gen(function* rejectCrossTenantContainment() {
    const { requests, service } = makeHarness();
    const failures = [
      yield* Effect.flip(
        service.touch({ relationships: [containmentRelationship('read', 'read', tenantId, otherTenantId)] }),
      ),
      yield* Effect.flip(
        service.touch({
          relationships: [
            containmentRelationship(),
            {
              ...containmentRelationship(),
              container: catalogReference('read', tenantId, otherPricingCatalogId),
            },
          ],
        }),
      ),
    ];
    expect(failures.every((failure) => Predicate.isTagged(failure, 'ResourceContainmentMutationUnavailable'))).toBe(
      true,
    );
    expect(requests).toHaveLength(0);
  }),
);

const marketResource = {
  moduleId: 'commerce.market-catalog',
  resourceId: '74000000-0000-4000-8000-000000000001',
  resourceType: 'commerce.market-catalog.market',
} as const;
const otherLegalEntityId = '20000000-0000-4000-8000-000000000002';

const moduleEdge = (
  resourceObjectId: string | undefined,
  moduleObjectId: string | undefined,
): Extract<ResourceContainmentRelationship, { readonly relation: 'module' }> => {
  if (resourceObjectId === undefined || moduleObjectId === undefined) {
    throw new Error('Expected canonical resource and module access object IDs');
  }
  return {
    container: { objectId: moduleObjectId, objectType: 'module_access' },
    relation: 'module',
    resource: { objectId: resourceObjectId, objectType: 'resource' },
  };
};

it.effect('touches the exact resource#module edge of an owner resource', () =>
  Effect.gen(function* touchOwnerResourceModuleEdge() {
    const { requests, service } = makeHarness();
    const relationship = ownerResourceModuleContainment(tenantId, legalEntityId, marketResource);
    if (relationship === undefined) {
      throw new Error('Expected a module containment relationship');
    }
    expect(relationship).toEqual(
      moduleEdge(
        toResourceAccessObjectId(tenantId, legalEntityId, marketResource),
        toModuleAccessObjectId(tenantId, legalEntityId, marketResource.moduleId),
      ),
    );
    yield* service.touch({ relationships: [relationship] });
    expect(requests[0]?.updates.map(({ operation, relationship: written }) => [operation, written?.relation])).toEqual([
      [v1.RelationshipUpdate_Operation.TOUCH, 'module'],
    ]);
  }),
);

it.effect('rejects module edges across Legal Entity, module, or namespace boundaries', () =>
  Effect.gen(function* rejectForeignModuleEdges() {
    const { requests, service } = makeHarness();
    const resourceObjectId = toResourceAccessObjectId(tenantId, legalEntityId, marketResource);
    const foreignNamespace = toResourceAccessObjectId(tenantId, legalEntityId, {
      ...marketResource,
      resourceType: 'demo.merchandise.product',
    });
    const candidates = [
      moduleEdge(resourceObjectId, toModuleAccessObjectId(tenantId, otherLegalEntityId, marketResource.moduleId)),
      moduleEdge(resourceObjectId, toModuleAccessObjectId(otherTenantId, legalEntityId, marketResource.moduleId)),
      moduleEdge(resourceObjectId, toModuleAccessObjectId(tenantId, legalEntityId, 'demo.merchandise')),
      moduleEdge(foreignNamespace, toModuleAccessObjectId(tenantId, legalEntityId, marketResource.moduleId)),
      moduleEdge(toModuleAccessObjectId(tenantId, legalEntityId, marketResource.moduleId), resourceObjectId),
    ];
    const failures = yield* Effect.all(
      candidates.map((relationship) => Effect.flip(service.touch({ relationships: [relationship] }))),
    );
    expect(failures.every((failure) => Predicate.isTagged(failure, 'ResourceContainmentMutationUnavailable'))).toBe(
      true,
    );
    expect(
      ownerResourceModuleContainment(tenantId, legalEntityId, { ...marketResource, resourceType: 'other.market' }),
    ).toBeUndefined();
    expect(requests).toHaveLength(0);
  }),
);
