import { v1 } from '@authzed/authzed-node';
import { Effect, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { BusinessPermissionCodeSchema } from '../../src/permissions/business-permission.ts';
import { createOwnerPermissionAccessTarget } from '../../src/permissions/context-access.ts';
import type { OwnerPermissionAccessTarget } from '../../src/permissions/context-access.ts';
import { historicalOwnerContract, historicalOwnerTarget } from '../support/historical-owner-targets.ts';
import {
  makeResourceContainmentRelationshipMutation,
  ResourceContainmentMutationUnavailable,
} from '../../src/permissions/resource-containment-mutation.ts';
import type {
  ResourceContainmentRelationship,
  ResourceContainmentRelationshipMutationInput,
  ResourceContainmentPreparation,
} from '../../src/permissions/resource-containment-mutation.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const otherTenantId = '10000000-0000-4000-8000-000000000002';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const pricingCatalogId = '50000000-0000-4000-8000-000000000001';
const otherPricingCatalogId = '50000000-0000-4000-8000-000000000002';
const priceGroupId = '60000000-0000-4000-8000-000000000001';

const declaredPricingTargets = new Map<string, OwnerPermissionAccessTarget>();
const pricingContract = Object.freeze({
  ...historicalOwnerContract('pricing.price_group.read'),
  permissions: Object.freeze(
    ['read', 'revision.create', 'retire'].flatMap(
      (operation) => historicalOwnerContract(`pricing.price_group.${operation}`).permissions,
    ),
  ),
});

const permission = (operation: string) =>
  Schema.decodeSync(BusinessPermissionCodeSchema)(`pricing.price_group.${operation}`);

const permissionObjectId = (
  operation: string,
  target:
    | Readonly<{ kind: 'pricing_catalog'; pricingCatalogId: string; tenantId: string }>
    | Readonly<{ kind: 'price_group'; priceGroupId: string; pricingCatalogId: string; tenantId: string }>,
): string => {
  const qualified = createOwnerPermissionAccessTarget(
    pricingContract,
    historicalOwnerTarget(permission(operation), target),
  );
  declaredPricingTargets.set(qualified.objectId, qualified);
  return qualified.objectId;
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

const FixturePricingCatalogIdSchema = Schema.String.pipe(Schema.brand('FixturePricingCatalogId'));
const PricingCatalogMeaningSchema = Schema.Struct({
  kind: Schema.Literal('pricing_catalog'),
  pricingCatalogId: FixturePricingCatalogIdSchema,
});
const PriceGroupMeaningSchema = Schema.Struct({
  kind: Schema.Literal('price_group'),
  pricingCatalogId: FixturePricingCatalogIdSchema,
});

const preparePricingRelationships = (
  input: ResourceContainmentRelationshipMutationInput,
): readonly OwnerPermissionAccessTarget[] | undefined => {
  const prepared = new Map<string, OwnerPermissionAccessTarget>();
  for (const relationship of input.relationships) {
    const group = declaredPricingTargets.get(relationship.resource.objectId);
    if (group === undefined || !Schema.is(PriceGroupMeaningSchema)(group.target)) {
      return undefined;
    }
    prepared.set(group.objectId, group);
    if (relationship.relation === 'containing_catalog') {
      const catalog = declaredPricingTargets.get(relationship.container.objectId);
      if (
        catalog === undefined ||
        !Schema.is(PricingCatalogMeaningSchema)(catalog.target) ||
        catalog.target.pricingCatalogId !== group.target.pricingCatalogId
      ) {
        return undefined;
      }
      prepared.set(catalog.objectId, catalog);
    }
  }
  return [...prepared.values()];
};

const makeHarness = (prepare: ResourceContainmentPreparation = preparePricingRelationships) => {
  const requests: v1.WriteRelationshipsRequest[] = [];
  const service = makeResourceContainmentRelationshipMutation(
    {
      writeRelationships: (request) =>
        Effect.sync(() => {
          requests.push(request);
          return v1.WriteRelationshipsResponse.create({});
        }),
    },
    prepare,
  );
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

it.effect('touches multiple permissions from one owner contract in one atomic write', () =>
  Effect.gen(function* touchMultiplePermissions() {
    const { requests, service } = makeHarness();
    yield* service.touch({
      relationships: [
        tenantRelationship(),
        containmentRelationship(),
        tenantRelationship('revision.create'),
        containmentRelationship('revision.create'),
        tenantRelationship('retire'),
        containmentRelationship('retire'),
      ],
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.updates).toHaveLength(6);
    expect(requests[0]?.updates.every(({ operation }) => operation === v1.RelationshipUpdate_Operation.TOUCH)).toBe(
      true,
    );
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
      yield* Effect.flip(service.touch({ relationships: [containmentRelationship()] })),
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
    const legacyObjectId = historicalOwnerTarget(legacyPermission, {
      counterpartyId: 'counterparty-one',
      kind: 'counterparty',
      legalEntityId,
      tenantId,
    }).objectId;
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
    const failure = yield* Effect.flip(
      service.touch({
        relationships: [tenantRelationship(), containmentRelationship('read', 'revision.create')],
      }),
    );
    expect(failure).toBeInstanceOf(ResourceContainmentMutationUnavailable);
    expect(requests).toHaveLength(0);
  }),
);

it.effect('rejects mixed owner contracts, tenants, and scopes before transport', () =>
  Effect.gen(function* rejectMixedPreparedTargets() {
    const tenant = tenantRelationship();
    const containment = containmentRelationship();
    const input = { relationships: [tenant, containment] } satisfies ResourceContainmentRelationshipMutationInput;
    const targets = preparePricingRelationships(input) ?? [];
    expect(targets).toHaveLength(2);
    const parent = targets.find((target) => target.objectId === containment.container.objectId);
    expect(parent).toBeDefined();
    if (parent === undefined) {
      return;
    }
    const invalidParents = [
      createOwnerPermissionAccessTarget(
        Object.freeze({ ...pricingContract, owningModuleKey: 'foreign.owner' }),
        parent,
      ),
      createOwnerPermissionAccessTarget(Object.freeze({ ...pricingContract }), parent),
      createOwnerPermissionAccessTarget(pricingContract, {
        ...parent,
        scope: { kind: 'tenant', tenantId: otherTenantId },
      }),
      createOwnerPermissionAccessTarget(pricingContract, {
        ...parent,
        scope: { kind: 'legal_entity', legalEntityId, tenantId },
      }),
    ];
    for (const invalidParent of invalidParents) {
      const { requests, service } = makeHarness(() =>
        targets.map((target) => (target.objectId === parent.objectId ? invalidParent : target)),
      );
      const failure = yield* Effect.flip(service.touch(input));
      expect(failure).toBeInstanceOf(ResourceContainmentMutationUnavailable);
      expect(requests).toHaveLength(0);
    }
    const { requests, service } = makeHarness(() =>
      targets.map((target) =>
        createOwnerPermissionAccessTarget(pricingContract, {
          ...target,
          scope: {
            kind: 'legal_entity',
            legalEntityId: target.objectId === parent.objectId ? legalEntityId : '20000000-0000-4000-8000-000000000002',
            tenantId,
          },
        }),
      ),
    );
    const failure = yield* Effect.flip(service.touch(input));
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
