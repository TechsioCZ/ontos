import { deadlineInterceptor, v1 } from '@authzed/authzed-node';
import { Cause, Duration, Effect } from 'effect';
import type { Scope } from 'effect';

import { SPICEDB_CHECK_TIMEOUT_MS, acquireSpiceDbClientResource, spiceDbClientSecurity } from './client.ts';
import type { SpiceDbConfigValue } from './config.ts';
import type { SpiceDbConfigError } from './config-error.ts';

export interface PermissionRelationshipMutationClient<Failure> {
  readonly close: () => void;
  readonly writeRelationships: (
    request: v1.WriteRelationshipsRequest,
  ) => Effect.Effect<v1.WriteRelationshipsResponse, Failure>;
}

// oxlint-disable-next-line effect-native/no-wide-factory-signature -- The public generic constructor keeps configuration, deadline, and failure mapping explicit for existing cross-file adapters.
export const createPermissionRelationshipMutationClient = <Failure>(
  configuration: SpiceDbConfigValue,
  timeoutMilliseconds: number,
  unavailable: (cause?: unknown) => Failure,
): PermissionRelationshipMutationClient<Failure> => {
  const client = v1.NewClient(
    configuration.preSharedKey,
    configuration.endpoint,
    spiceDbClientSecurity(configuration),
    undefined,
    { interceptors: [deadlineInterceptor(timeoutMilliseconds)] },
  );
  return {
    close: () => client.close(),
    writeRelationships: (request) =>
      Effect.tryPromise({
        catch: unavailable,
        // oxlint-disable-next-line typescript/promise-function-async -- Effect owns this foreign SDK Promise boundary.
        try: () => client.promises.writeRelationships(request),
      }).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(SPICEDB_CHECK_TIMEOUT_MS),
          orElse: () => Effect.fail(unavailable(new Cause.TimeoutError('SpiceDB relationship mutation timed out'))),
        }),
      ),
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
  readonly resourceId: string;
  readonly scopeRelationship: PermissionRelationshipDefinition;
}

interface PermissionRelationshipMutationDefinition<Input extends PermissionRelationshipMutationInput, Failure> {
  readonly mutationName: string;
  readonly prepare: (input: Input) => PermissionRelationshipMutationPreparation | undefined;
  readonly resourceType: string;
  readonly unavailable: (cause?: unknown) => Failure;
}

const objectReference = (objectType: string, objectId: string) => v1.ObjectReference.create({ objectId, objectType });

const relationship = (resourceType: string, resourceId: string, definition: PermissionRelationshipDefinition) =>
  v1.Relationship.create({
    relation: definition.relation,
    resource: objectReference(resourceType, resourceId),
    subject: v1.SubjectReference.create({
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
        input.operation === 'grant' ? v1.RelationshipUpdate_Operation.TOUCH : v1.RelationshipUpdate_Operation.DELETE;
      const updates = [
        ...(input.operation === 'grant'
          ? [
              v1.RelationshipUpdate.create({
                operation: v1.RelationshipUpdate_Operation.TOUCH,
                relationship: relationship(definition.resourceType, prepared.resourceId, prepared.scopeRelationship),
              }),
            ]
          : []),
        v1.RelationshipUpdate.create({
          operation,
          relationship: relationship(definition.resourceType, prepared.resourceId, {
            relation: 'grantee',
            subjectId: prepared.granteeId,
            subjectType: 'principal',
          }),
        }),
      ];
      return yield* client.writeRelationships(v1.WriteRelationshipsRequest.create({ updates })).pipe(Effect.asVoid);
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
