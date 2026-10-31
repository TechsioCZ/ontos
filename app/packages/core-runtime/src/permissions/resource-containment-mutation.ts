import {
  ObjectReference,
  Relationship,
  RelationshipUpdate,
  RelationshipUpdate_Operation,
  SubjectReference,
} from '@authzed/authzed-node/v1/core';
import { WriteRelationshipsRequest } from '@authzed/authzed-node/v1/permissions';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import type { Scope } from 'effect';

import { SPICEDB_CHECK_TIMEOUT_MS } from './client.ts';
import { loadSpiceDbConfig } from './config.ts';
import type { SpiceDbConfigValue } from './config.ts';
import type { SpiceDbConfigError } from './config-error.ts';
import { BusinessPermissionCodeSchema } from './business-permission.ts';
import type { BusinessPermissionCode } from './business-permission.ts';
import {
  PricingAuthorizationResourceIdSchema,
  toBusinessPermissionAccessObjectId,
  toModuleAccessObjectId,
  toResourceAccessObjectId,
} from './context-access.ts';
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

type OwnerResourceReference = Readonly<SpiceDbResourceReference & { readonly objectType: 'resource' }>;

type OwnerModuleAccessReference = Readonly<SpiceDbResourceReference & { readonly objectType: 'module_access' }>;

/**
 * The only topology mutations exposed to owner workers are exact Pricing scope and catalog-containment edges, and
 * the `resource#module` edge that places one owner resource in its own module's exact Legal Entity scope.
 */
export type ResourceContainmentRelationship =
  | Readonly<{
      readonly container: OwnerModuleAccessReference;
      readonly relation: 'module';
      readonly resource: OwnerResourceReference;
    }>
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
const isLegalEntityId = Schema.is(Schema.String.check(Schema.isUUID()));

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

const decodeScopedObjectParts = (
  reference: SpiceDbResourceReference,
  objectType: 'module_access' | 'resource',
  length: number,
): readonly string[] | undefined => {
  if (
    reference.objectType !== objectType ||
    reference.objectId.length > 1024 ||
    !reference.objectId.startsWith('ctx_')
  ) {
    return undefined;
  }
  const serialized = Buffer.from(reference.objectId.slice(4), 'base64url').toString('utf-8');
  const parts = decodeContextAccessObjectIdParts(serialized).pipe(Option.getOrUndefined);
  return parts !== undefined && parts.length === length && parts.every((part) => part.length > 0) ? parts : undefined;
};

/** A resource joins only its own module's access object in the same Tenant and Legal Entity. */
const validModuleContainmentRelationship = ({ container, resource }: ResourceContainmentRelationship): boolean => {
  const resourceParts = decodeScopedObjectParts(resource, 'resource', 5);
  const moduleParts = decodeScopedObjectParts(container, 'module_access', 3);
  if (resourceParts === undefined || moduleParts === undefined) {
    return false;
  }
  const [tenantId, legalEntityId, moduleId, resourceType, resourceId] = resourceParts;
  if (
    tenantId === undefined ||
    legalEntityId === undefined ||
    moduleId === undefined ||
    resourceType === undefined ||
    resourceId === undefined ||
    !Schema.is(TenantIdSchema)(tenantId) ||
    !isLegalEntityId(legalEntityId) ||
    !resourceType.startsWith(`${moduleId}.`)
  ) {
    return false;
  }
  return (
    toResourceAccessObjectId(tenantId, legalEntityId, { moduleId, resourceId, resourceType }) === resource.objectId &&
    toModuleAccessObjectId(tenantId, legalEntityId, moduleId) === container.objectId &&
    moduleParts[0] === tenantId &&
    moduleParts[1] === legalEntityId &&
    moduleParts[2] === moduleId
  );
};

const validContainmentRelationship = (relationship: ResourceContainmentRelationship): boolean => {
  if (relationship.relation === 'module') {
    return validModuleContainmentRelationship(relationship);
  }
  if (relationship.relation === 'tenant') {
    return validTenantRelationship(relationship);
  }
  return relationship.relation === 'containing_catalog' && validCatalogContainmentRelationship(relationship);
};

/**
 * The exact `resource#module` edge for one owner resource. Undefined when an identity part is empty or the resource
 * type is not namespaced under its module.
 */
export const ownerResourceModuleContainment = (
  tenantId: string,
  legalEntityId: string,
  resource: Readonly<{ moduleId: string; resourceId: string; resourceType: string }>,
): ResourceContainmentRelationship | undefined => {
  const resourceObjectId = toResourceAccessObjectId(tenantId, legalEntityId, resource);
  const moduleObjectId = toModuleAccessObjectId(tenantId, legalEntityId, resource.moduleId);
  if (resourceObjectId === undefined || moduleObjectId === undefined) {
    return undefined;
  }
  const relationship: ResourceContainmentRelationship = {
    container: { objectId: moduleObjectId, objectType: 'module_access' },
    relation: 'module',
    resource: { objectId: resourceObjectId, objectType: 'resource' },
  };
  return validModuleContainmentRelationship(relationship) ? relationship : undefined;
};

const relationshipKey = ({ container, relation, resource }: ResourceContainmentRelationship): string =>
  `${resource.objectType}:${resource.objectId}#${relation}@${container.objectType}:${container.objectId}`;

const membershipKey = ({ relation, resource }: ResourceContainmentRelationship): string =>
  `${resource.objectType}:${resource.objectId}#${relation}`;

const validRelationships = (relationships: readonly ResourceContainmentRelationship[]): boolean =>
  relationships.length > 0 &&
  relationships.length <= 100 &&
  relationships.every(validContainmentRelationship) &&
  new Set(relationships.map(relationshipKey)).size === relationships.length &&
  new Set(relationships.map(membershipKey)).size === relationships.length;

const objectReference = ({ objectId, objectType }: SpiceDbResourceReference) =>
  ObjectReference.create({ objectId, objectType });

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
        RelationshipUpdate.create({
          operation: RelationshipUpdate_Operation.TOUCH,
          relationship: Relationship.create({
            relation,
            resource: objectReference(resource),
            subject: SubjectReference.create({ object: objectReference(container) }),
          }),
        }),
      );
      return yield* client.writeRelationships(WriteRelationshipsRequest.create({ updates })).pipe(Effect.asVoid);
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
