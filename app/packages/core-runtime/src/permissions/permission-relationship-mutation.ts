import {
  ObjectReference,
  Relationship,
  RelationshipUpdate,
  RelationshipUpdate_Operation,
  SubjectReference,
} from '@authzed/authzed-node/v1/core';
import { WriteRelationshipsRequest } from '@authzed/authzed-node/v1/permissions';
import type { WriteRelationshipsResponse } from '@authzed/authzed-node/v1/permissions';
import { openSpiceDbRpc } from './spicedb-transaction-guard.ts';
import { Effect } from 'effect';
import type { Scope } from 'effect';

import { SPICEDB_CHECK_TIMEOUT_MS, acquireSpiceDbClientResource } from './client.ts';
import type { SpiceDbConfigValue } from './config.ts';
import type { SpiceDbConfigError } from './config-error.ts';

export interface PermissionRelationshipMutationClient<Failure> {
  readonly close: () => void;
  readonly writeRelationships: (
    request: WriteRelationshipsRequest,
  ) => Effect.Effect<WriteRelationshipsResponse, Failure>;
}

// oxlint-disable-next-line effect-native/no-wide-factory-signature -- The public generic constructor keeps configuration, deadline, and failure mapping explicit for existing cross-file adapters.
export const createPermissionRelationshipMutationClient = <Failure>(
  configuration: SpiceDbConfigValue,
  timeoutMilliseconds: number,
  unavailable: (cause?: unknown) => Failure,
): PermissionRelationshipMutationClient<Failure> => {
  const rpc = openSpiceDbRpc(configuration, timeoutMilliseconds);
  return {
    close: rpc.close,
    writeRelationships: (request) =>
      rpc.writeRelationships(request).pipe(Effect.mapError(({ cause }) => unavailable(cause))),
  };
};

interface PermissionRelationshipMutationInput {
  readonly operation: 'grant' | 'revoke';
}

interface PermissionRelationshipDefinition {
  readonly relation: string;
  readonly subjectId: string;
  readonly subjectType: string;
}

export interface PermissionRelationshipMutationPreparation {
  readonly granteeId: string;
  readonly granteeRelation: 'grantee' | 'self_service_grantee';
  readonly resourceId: string;
  readonly scopeRelationships: readonly PermissionRelationshipDefinition[];
}

interface PermissionRelationshipMutationDefinition<Input extends PermissionRelationshipMutationInput, Failure> {
  readonly mutationName: string;
  readonly prepare: (input: Input) => PermissionRelationshipMutationPreparation | undefined;
  readonly resourceType: string;
  readonly unavailable: (cause?: unknown) => Failure;
}

const objectReference = (objectType: string, objectId: string) => ObjectReference.create({ objectId, objectType });

const relationship = (resourceType: string, resourceId: string, definition: PermissionRelationshipDefinition) =>
  Relationship.create({
    relation: definition.relation,
    resource: objectReference(resourceType, resourceId),
    subject: SubjectReference.create({
      object: objectReference(definition.subjectType, definition.subjectId),
    }),
  });

// oxlint-disable-next-line effect-native/require-context-service-for-service-interface -- This generic factory result is embedded in owner-specific services and has no single runtime Context identity of its own.
export interface PermissionRelationshipMutationService<Input, Failure> {
  readonly mutate: (input: Input) => Effect.Effect<void, Failure>;
}

export const makePermissionRelationshipMutation = <Input extends PermissionRelationshipMutationInput, Failure>(
  client: Pick<PermissionRelationshipMutationClient<Failure>, 'writeRelationships'>,
  definition: PermissionRelationshipMutationDefinition<Input, Failure>,
): PermissionRelationshipMutationService<Input, Failure> =>
  Object.freeze({
    mutate: Effect.fn(definition.mutationName)(function* mutatePermissionRelationship(input: Input) {
      const prepared = definition.prepare(input);
      if (prepared === undefined) {
        return yield* Effect.fail(definition.unavailable());
      }
      const operation =
        input.operation === 'grant' ? RelationshipUpdate_Operation.TOUCH : RelationshipUpdate_Operation.DELETE;
      const updates = [
        ...(input.operation === 'grant'
          ? prepared.scopeRelationships.map((scopeRelationship) =>
              RelationshipUpdate.create({
                operation: RelationshipUpdate_Operation.TOUCH,
                relationship: relationship(definition.resourceType, prepared.resourceId, scopeRelationship),
              }),
            )
          : []),
        RelationshipUpdate.create({
          operation,
          relationship: relationship(definition.resourceType, prepared.resourceId, {
            relation: prepared.granteeRelation,
            subjectId: prepared.granteeId,
            subjectType: 'principal',
          }),
        }),
      ];
      return yield* client.writeRelationships(WriteRelationshipsRequest.create({ updates })).pipe(Effect.asVoid);
    }),
  });

export const makePermissionRelationshipMutationLive = <Failure, Service>({
  clientFactory,
  loadConfiguration,
  makeService,
  unavailable,
  unavailableService,
}: {
  readonly clientFactory: (
    configuration: SpiceDbConfigValue,
    timeoutMilliseconds: number,
  ) => PermissionRelationshipMutationClient<Failure>;
  readonly loadConfiguration: () => Effect.Effect<SpiceDbConfigValue, SpiceDbConfigError>;
  readonly makeService: (client: Pick<PermissionRelationshipMutationClient<Failure>, 'writeRelationships'>) => Service;
  readonly unavailable: (cause?: unknown) => Failure;
  readonly unavailableService: (cause?: unknown) => Service;
}): Effect.Effect<Service, never, Scope.Scope> =>
  Effect.matchEffect(loadConfiguration(), {
    onFailure: (cause) => Effect.succeed(unavailableService(cause)),
    onSuccess: (configuration) =>
      acquireSpiceDbClientResource(() => clientFactory(configuration, SPICEDB_CHECK_TIMEOUT_MS), unavailable).pipe(
        Effect.map(makeService),
        // oxlint-disable-next-line promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- Effect.catch handles the typed Effect failure channel; this is not Promise chaining or callback-based Promise control flow.
        Effect.catch((error) => Effect.succeed(unavailableService(error))),
      ),
  });
