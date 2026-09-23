import { v1 } from '@authzed/authzed-node';
import { Context, Effect, Layer } from 'effect';
import type { Scope } from 'effect';

import { SPICEDB_CHECK_TIMEOUT_MS } from './client.ts';
import { loadSpiceDbConfig } from './config.ts';
import type { SpiceDbConfigValue } from './config.ts';
import type { SpiceDbConfigError } from './config-error.ts';
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

export interface ResourceContainmentRelationship {
  readonly container: SpiceDbResourceReference;
  readonly relation: string;
  readonly resource: SpiceDbResourceReference;
}

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

const unavailable = (cause?: unknown): ResourceContainmentMutationUnavailable => {
  const failure = new ResourceContainmentMutationUnavailable({
    reason: 'The resource containment relationship mutation could not be completed safely',
  });
  return cause === undefined
    ? failure
    : Object.defineProperty(failure, 'cause', {
        configurable: false,
        enumerable: false,
        value: cause,
      });
};

const objectTypePattern = /^[a-z][a-z0-9_]{0,63}$/u;
const relationPattern = /^[a-z][a-z0-9_]{0,63}$/u;
const objectIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:/=-]{0,299}$/u;

const validReference = ({ objectId, objectType }: SpiceDbResourceReference): boolean =>
  objectTypePattern.test(objectType) && objectIdPattern.test(objectId);

const relationshipKey = ({ container, relation, resource }: ResourceContainmentRelationship): string =>
  `${resource.objectType}:${resource.objectId}#${relation}@${container.objectType}:${container.objectId}`;

const validRelationships = (relationships: readonly ResourceContainmentRelationship[]): boolean =>
  relationships.length > 0 &&
  relationships.length <= 100 &&
  relationships.every(
    ({ container, relation, resource }) =>
      validReference(container) &&
      validReference(resource) &&
      container.objectType !== 'principal' &&
      resource.objectType !== 'principal' &&
      relation !== 'grantee' &&
      relationPattern.test(relation),
  ) &&
  new Set(relationships.map(relationshipKey)).size === relationships.length;

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
