import { v1 } from '@authzed/authzed-node';
import { Context, Effect } from 'effect';
import type { Scope } from 'effect';

import { SPICEDB_CHECK_TIMEOUT_MS } from './client.ts';
import { loadSpiceDbConfig } from './config.ts';
import type { SpiceDbConfigValue } from './config.ts';
import type { SpiceDbConfigError } from './config-error.ts';
import { isOwnerPermissionAccessTargetMetadataValid } from './context-access.ts';
import type { OwnerPermissionAccessTarget } from './context-access.ts';
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

type BusinessPermissionReference = Readonly<SpiceDbResourceReference & { readonly objectType: 'business_permission' }>;

type TenantReference = Readonly<SpiceDbResourceReference & { readonly objectType: 'tenant' }>;

/** Existing bounded provider relations; owner preparation supplies their exact qualified endpoint meanings. */
export type ResourceContainmentRelationship =
  | Readonly<{
      readonly container: TenantReference;
      readonly relation: 'tenant';
      readonly resource: BusinessPermissionReference;
    }>
  | Readonly<{
      readonly container: BusinessPermissionReference;
      readonly relation: 'containing_catalog';
      readonly resource: BusinessPermissionReference;
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

/** Installed by the owner runtime, never selected by an input descriptor. */
export type ResourceContainmentPreparation = (
  input: ResourceContainmentRelationshipMutationInput,
) => readonly OwnerPermissionAccessTarget[] | undefined;

const validRelationships = (
  relationships: ResourceContainmentRelationshipMutationInput['relationships'],
  targets: readonly OwnerPermissionAccessTarget[],
): boolean => {
  if (
    relationships.length === 0 ||
    targets.length === 0 ||
    targets.some((target) => !isOwnerPermissionAccessTargetMetadataValid(target))
  ) {
    return false;
  }
  const [first] = targets;
  if (
    first === undefined ||
    targets.some(
      (target) =>
        target.contract !== first.contract ||
        target.scope.tenantId !== first.scope.tenantId ||
        target.scope.kind !== first.scope.kind ||
        (target.scope.kind === 'legal_entity' &&
          (first.scope.kind !== 'legal_entity' || target.scope.legalEntityId !== first.scope.legalEntityId)),
    )
  ) {
    return false;
  }
  const seen = new Set<string>();
  return relationships.every(({ container, relation, resource }) => {
    const key = `${resource.objectType}:${resource.objectId}:${relation}:${container.objectType}:${container.objectId}`;
    if (seen.has(key) || resource.objectType !== 'business_permission') {
      return false;
    }
    seen.add(key);
    const target = targets.find((candidate) => candidate.objectId === resource.objectId);
    if (target === undefined) {
      return false;
    }
    if (relation === 'tenant') {
      return container.objectType === 'tenant' && container.objectId === target.scope.tenantId;
    }
    return (
      relation === 'containing_catalog' &&
      container.objectType === 'business_permission' &&
      container.objectId !== resource.objectId &&
      targets.some(
        (candidate) => candidate.objectId === container.objectId && candidate.definition === target.definition,
      ) &&
      relationships.some(
        (candidate) =>
          candidate.resource.objectId === resource.objectId &&
          candidate.relation === 'tenant' &&
          candidate.container.objectId === target.scope.tenantId,
      )
    );
  });
};

const objectReference = ({ objectId, objectType }: SpiceDbResourceReference) =>
  v1.ObjectReference.create({ objectId, objectType });

export const makeResourceContainmentRelationshipMutation = (
  client: Pick<ResourceContainmentRelationshipMutationClient, 'writeRelationships'>,
  prepare: ResourceContainmentPreparation,
): ResourceContainmentRelationshipMutationService =>
  Object.freeze({
    touch: Effect.fn('ResourceContainmentRelationshipMutation.touch')(function* touchResourceContainment(
      input: ResourceContainmentRelationshipMutationInput,
    ) {
      const targets = yield* Effect.try({ catch: unavailable, try: () => prepare(input) });
      if (targets === undefined || !validRelationships(input.relationships, targets)) {
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
  prepare: ResourceContainmentPreparation,
  options: Readonly<{
    clientFactory?: (
      configuration: SpiceDbConfigValue,
      timeoutMilliseconds: number,
    ) => ResourceContainmentRelationshipMutationClient;
    loadConfiguration?: () => Effect.Effect<SpiceDbConfigValue, SpiceDbConfigError>;
  }> = {},
): Effect.Effect<ResourceContainmentRelationshipMutationService, never, Scope.Scope> =>
  makePermissionRelationshipMutationLive({
    clientFactory: options.clientFactory ?? createResourceContainmentRelationshipMutationClient,
    loadConfiguration: options.loadConfiguration ?? loadSpiceDbConfig,
    makeService: (client) => makeResourceContainmentRelationshipMutation(client, prepare),
    unavailable,
    unavailableService,
  });
