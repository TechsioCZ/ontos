import { v1 } from '@authzed/authzed-node';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import type { Scope } from 'effect';

import { SPICEDB_CHECK_TIMEOUT_MS } from './client.ts';
import { loadSpiceDbConfig } from './config.ts';
import type { SpiceDbConfigValue } from './config.ts';
import type { SpiceDbConfigError } from './config-error.ts';
import { BusinessPermissionCodeSchema } from './business-permission.ts';
import type { BusinessPermissionCode } from './business-permission.ts';
import { PricingAuthorizationResourceIdSchema, toBusinessPermissionAccessObjectId } from './context-access.ts';
import {
  createPermissionRelationshipMutationClient,
  // eslint-disable-next-line anti-slop-effect/no-service-constructor-imports -- Generic scoped factory consumed by this owning Layer.
  makePermissionRelationshipMutationLive,
} from './permission-relationship-mutation.ts';
import type { PermissionRelationshipMutationClient } from './permission-relationship-mutation.ts';
import { ResourceContainmentMutationUnavailable } from './resource-containment-mutation-error.ts';

export { ResourceContainmentMutationUnavailable } from './resource-containment-mutation-error.ts';

export interface SpiceDbResourceReference {
  readonly objectId: string;
  readonly objectType: string;
}

type PricingBusinessPermissionReference = Readonly<
  SpiceDbResourceReference & { readonly objectType: 'business_permission' }
>;

type PricingTenantReference = Readonly<SpiceDbResourceReference & { readonly objectType: 'tenant' }>;

/** The only topology mutations exposed to owner workers are exact Pricing scope and catalog-containment edges. */
export type ResourceContainmentRelationship =
  | Readonly<{
      readonly container: PricingTenantReference;
      readonly relation: 'tenant';
      readonly resource: PricingBusinessPermissionReference;
    }>
  | Readonly<{
      readonly container: PricingBusinessPermissionReference;
      readonly relation: 'containing_catalog';
      readonly resource: PricingBusinessPermissionReference;
    }>;

export interface ResourceContainmentRelationshipMutationInput {
  /** One non-empty atomic set. Every relationship is applied with SpiceDB TOUCH semantics. */
  readonly relationships: readonly [ResourceContainmentRelationship, ...ResourceContainmentRelationship[]];
}

export interface ResourceContainmentRelationshipMutationService {
  readonly touch: (
    input: ResourceContainmentRelationshipMutationInput,
  ) => Effect.Effect<void, ResourceContainmentMutationUnavailable>;
}

export class ResourceContainmentRelationshipMutation extends Context.Service<
  ResourceContainmentRelationshipMutation,
  ResourceContainmentRelationshipMutationService
>()('@app/core-runtime/permissions/resource-containment-mutation/ResourceContainmentRelationshipMutation') {}

export interface ResourceContainmentRelationshipMutationClient {
  readonly close: () => void;
  readonly writeRelationships: PermissionRelationshipMutationClient<ResourceContainmentMutationUnavailable>['writeRelationships'];
}

const unavailable = (cause?: unknown): ResourceContainmentMutationUnavailable =>
  new ResourceContainmentMutationUnavailable({
    cause,
    reason: 'The resource containment relationship mutation could not be completed safely',
  });

const ContextAccessObjectIdParts = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeContextAccessObjectIdParts = Schema.decodeUnknownOption(ContextAccessObjectIdParts);
const TenantIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('TenantId'));
type TenantId = typeof TenantIdSchema.Type;

type PricingPermissionObjectIdentity =
  | Readonly<{
      kind: 'pricing_catalog';
      permission: BusinessPermissionCode;
      pricingCatalogId: string;
      tenantId: TenantId;
    }>
  | Readonly<{
      kind: 'price_group';
      permission: BusinessPermissionCode;
      priceGroupId: string;
      pricingCatalogId: string;
      tenantId: TenantId;
    }>;

const decodePricingPermissionObjectIdentity = (
  reference: SpiceDbResourceReference,
): PricingPermissionObjectIdentity | undefined => {
  if (
    reference.objectType !== 'business_permission' ||
    reference.objectId.length > 1024 ||
    !reference.objectId.startsWith('ctx_')
  ) {
    return undefined;
  }
  const serialized = Buffer.from(reference.objectId.slice(4), 'base64url').toString('utf-8');
  const parts = decodeContextAccessObjectIdParts(serialized).pipe(Option.getOrUndefined);
  if (parts === undefined) {
    return undefined;
  }
  const [permission, tenantId, kind, pricingCatalogId, priceGroupId] = parts;
  if (
    permission === undefined ||
    tenantId === undefined ||
    pricingCatalogId === undefined ||
    !Schema.is(BusinessPermissionCodeSchema)(permission) ||
    !permission.startsWith('pricing.price_group.') ||
    !Schema.is(TenantIdSchema)(tenantId) ||
    !Schema.is(PricingAuthorizationResourceIdSchema)(pricingCatalogId)
  ) {
    return undefined;
  }
  if (kind === 'pricing_catalog' && parts.length === 4) {
    const identity = { kind, permission, pricingCatalogId, tenantId } as const;
    return toBusinessPermissionAccessObjectId(permission, identity) === reference.objectId ? identity : undefined;
  }
  if (
    kind === 'price_group' &&
    parts.length === 5 &&
    priceGroupId !== undefined &&
    Schema.is(PricingAuthorizationResourceIdSchema)(priceGroupId)
  ) {
    const identity = { kind, permission, priceGroupId, pricingCatalogId, tenantId } as const;
    return toBusinessPermissionAccessObjectId(permission, identity) === reference.objectId ? identity : undefined;
  }
  return undefined;
};

const validTenantRelationship = ({ container, resource }: ResourceContainmentRelationship): boolean => {
  const pricingResource = decodePricingPermissionObjectIdentity(resource);
  return (
    container.objectType === 'tenant' &&
    Schema.is(TenantIdSchema)(container.objectId) &&
    pricingResource !== undefined &&
    pricingResource.tenantId === container.objectId
  );
};

const validCatalogContainmentRelationship = ({ container, resource }: ResourceContainmentRelationship): boolean => {
  const catalog = decodePricingPermissionObjectIdentity(container);
  const group = decodePricingPermissionObjectIdentity(resource);
  return (
    catalog?.kind === 'pricing_catalog' &&
    group?.kind === 'price_group' &&
    catalog.tenantId === group.tenantId &&
    catalog.permission === group.permission &&
    catalog.pricingCatalogId === group.pricingCatalogId
  );
};

const validPricingRelationship = (relationship: ResourceContainmentRelationship): boolean => {
  if (relationship.relation === 'tenant') {
    return validTenantRelationship(relationship);
  }
  return relationship.relation === 'containing_catalog' && validCatalogContainmentRelationship(relationship);
};

const relationshipKey = ({ container, relation, resource }: ResourceContainmentRelationship): string =>
  `${resource.objectType}:${resource.objectId}#${relation}@${container.objectType}:${container.objectId}`;

const membershipKey = ({ relation, resource }: ResourceContainmentRelationship): string =>
  `${resource.objectType}:${resource.objectId}#${relation}`;

const validRelationships = (relationships: readonly ResourceContainmentRelationship[]): boolean =>
  relationships.length > 0 &&
  relationships.length <= 100 &&
  relationships.every(validPricingRelationship) &&
  new Set(relationships.map(relationshipKey)).size === relationships.length &&
  new Set(relationships.map(membershipKey)).size === relationships.length;

const objectReference = ({ objectId, objectType }: SpiceDbResourceReference) =>
  v1.ObjectReference.create({ objectId, objectType });

export const makeResourceContainmentRelationshipMutation = (
  client: Pick<ResourceContainmentRelationshipMutationClient, 'writeRelationships'>,
): ResourceContainmentRelationshipMutationService =>
  Object.freeze({
    touch: Effect.fn('ResourceContainmentRelationshipMutation.touch')(function* touchResourceContainment(
      input: ResourceContainmentRelationshipMutationInput,
    ) {
      if (!validRelationships(input.relationships)) {
        return yield* unavailable();
      }
      const updates = input.relationships.map(({ container, relation, resource }) =>
        v1.RelationshipUpdate.create({
          operation: v1.RelationshipUpdate_Operation.TOUCH,
          relationship: v1.Relationship.create({
            relation,
            resource: objectReference(resource),
            subject: v1.SubjectReference.create({ object: objectReference(container) }),
          }),
        }),
      );
      return yield* client.writeRelationships(v1.WriteRelationshipsRequest.create({ updates })).pipe(Effect.asVoid);
    }),
  });

export const createResourceContainmentRelationshipMutationClient = (
  configuration: SpiceDbConfigValue,
  timeoutMilliseconds = SPICEDB_CHECK_TIMEOUT_MS,
): ResourceContainmentRelationshipMutationClient =>
  createPermissionRelationshipMutationClient(configuration, timeoutMilliseconds, unavailable);

const unavailableService = (cause?: unknown): ResourceContainmentRelationshipMutationService =>
  Object.freeze({ touch: () => Effect.fail(unavailable(cause)) });

export const makeResourceContainmentRelationshipMutationLive = (
  clientFactory: (
    configuration: SpiceDbConfigValue,
    timeoutMilliseconds: number,
  ) => ResourceContainmentRelationshipMutationClient = createResourceContainmentRelationshipMutationClient,
  loadConfiguration: () => Effect.Effect<SpiceDbConfigValue, SpiceDbConfigError> = loadSpiceDbConfig,
): Effect.Effect<ResourceContainmentRelationshipMutationService, never, Scope.Scope> =>
  makePermissionRelationshipMutationLive({
    clientFactory,
    loadConfiguration,
    makeService: makeResourceContainmentRelationshipMutation,
    unavailable,
    unavailableService,
  });

export const ResourceContainmentRelationshipMutationLive = Layer.effect(
  ResourceContainmentRelationshipMutation,
  makeResourceContainmentRelationshipMutationLive(),
);
