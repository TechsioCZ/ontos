import { deadlineInterceptor, v1 } from '@authzed/authzed-node';
import { Cause, Context, Duration, Effect, Layer } from 'effect';
import type { Scope } from 'effect';
import {
  SPICEDB_CHECK_TIMEOUT_MS,
  acquireSpiceDbClientResource,
  spiceDbClientSecurity,
} from './client.ts';
import { loadSpiceDbConfig } from './config.ts';
import type { SpiceDbConfigValue } from './config.ts';
import type { SpiceDbConfigError } from './config-error.ts';
import type { ContextPermissionAccessTarget } from './context-access.ts';
import { toContextPermissionAccessObjectId } from './context-access.ts';
import { ContextPermissionMutationUnavailable } from './context-permission-mutation-error.ts';
import type { PrincipalRef } from './principal-ref.ts';

export { ContextPermissionMutationUnavailable } from './context-permission-mutation-error.ts';

const unavailable = (cause?: unknown): ContextPermissionMutationUnavailable => {
  const failure = new ContextPermissionMutationUnavailable({
    reason: 'The context permission relationship mutation could not be completed safely',
  });
  return cause === undefined
    ? failure
    : Object.defineProperty(failure, 'cause', {
        configurable: true,
        value: cause,
      });
};

export interface ContextPermissionRelationshipMutationInput {
  readonly legalEntityId?: string;
  readonly operation: 'grant' | 'revoke';
  readonly principal: PrincipalRef;
  readonly target: ContextPermissionAccessTarget;
  readonly tenantId: string;
}

export interface ContextPermissionRelationshipMutationService {
  readonly mutate: (
    input: ContextPermissionRelationshipMutationInput,
  ) => Effect.Effect<void, ContextPermissionMutationUnavailable>;
}

export class ContextPermissionRelationshipMutation extends Context.Service<
  ContextPermissionRelationshipMutation,
  ContextPermissionRelationshipMutationService
>()(
  '@app/core-runtime/permissions/context-permission-mutation/ContextPermissionRelationshipMutation',
) {}

/** Private test seam. Provisioning callers depend only on the typed mutation service. */
export interface ContextPermissionRelationshipMutationClient {
  readonly close: () => void;
  readonly writeRelationships: (
    request: v1.WriteRelationshipsRequest,
  ) => Effect.Effect<v1.WriteRelationshipsResponse, ContextPermissionMutationUnavailable>;
}

const mutationTimeout = Effect.timeoutOrElse({
  duration: Duration.millis(SPICEDB_CHECK_TIMEOUT_MS),
  orElse: () =>
    Effect.fail(unavailable(new Cause.TimeoutError('SpiceDB relationship mutation timed out'))),
});

export const createContextPermissionRelationshipMutationClient = (
  configuration: SpiceDbConfigValue,
  timeoutMilliseconds = SPICEDB_CHECK_TIMEOUT_MS,
): ContextPermissionRelationshipMutationClient => {
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
      }).pipe(mutationTimeout),
  };
};

const objectReference = (objectType: string, objectId: string) =>
  v1.ObjectReference.create({ objectId, objectType });

const relationship = (input: {
  readonly relation: 'grantee' | 'tenant';
  readonly resourceId: string;
  readonly subjectId: string;
  readonly subjectType: 'principal' | 'tenant';
}) =>
  v1.Relationship.create({
    relation: input.relation,
    resource: objectReference('context_permission', input.resourceId),
    subject: v1.SubjectReference.create({
      object: objectReference(input.subjectType, input.subjectId),
    }),
  });

const invalidScope = (input: ContextPermissionRelationshipMutationInput): boolean =>
  input.principal.tenantId !== input.tenantId ||
  input.principal.principalId.length === 0 ||
  input.tenantId.length === 0 ||
  input.target.moduleId.length === 0 ||
  input.target.permission.length === 0 ||
  input.legalEntityId?.length === 0;

export const makeContextPermissionRelationshipMutation = (
  client: Pick<ContextPermissionRelationshipMutationClient, 'writeRelationships'>,
): ContextPermissionRelationshipMutationService =>
  Object.freeze({
    mutate: Effect.fn('ContextPermissionRelationshipMutation.mutate')(
      function* mutateContextPermissionRelationship(
        input: ContextPermissionRelationshipMutationInput,
      ) {
        if (invalidScope(input)) {
          return yield* unavailable();
        }
        const resourceId = toContextPermissionAccessObjectId(
          input.tenantId,
          input.legalEntityId,
          input.target,
        );
        if (resourceId === undefined) {
          return yield* unavailable();
        }
        const operation =
          input.operation === 'grant'
            ? v1.RelationshipUpdate_Operation.TOUCH
            : v1.RelationshipUpdate_Operation.DELETE;
        const updates = [
          ...(input.operation === 'grant'
            ? [
                v1.RelationshipUpdate.create({
                  operation: v1.RelationshipUpdate_Operation.TOUCH,
                  relationship: relationship({
                    relation: 'tenant',
                    resourceId,
                    subjectId: input.tenantId,
                    subjectType: 'tenant',
                  }),
                }),
              ]
            : []),
          v1.RelationshipUpdate.create({
            operation,
            relationship: relationship({
              relation: 'grantee',
              resourceId,
              subjectId: input.principal.principalId,
              subjectType: 'principal',
            }),
          }),
        ];
        return yield* client
          .writeRelationships(v1.WriteRelationshipsRequest.create({ updates }))
          .pipe(Effect.asVoid);
      },
    ),
  });

const unavailableService = (cause?: unknown): ContextPermissionRelationshipMutationService =>
  Object.freeze({ mutate: () => Effect.fail(unavailable(cause)) });

export const makeContextPermissionRelationshipMutationLive = (
  clientFactory: (
    configuration: SpiceDbConfigValue,
    timeoutMilliseconds: number,
  ) => ContextPermissionRelationshipMutationClient = createContextPermissionRelationshipMutationClient,
  loadConfiguration: () => Effect.Effect<
    SpiceDbConfigValue,
    SpiceDbConfigError
  > = loadSpiceDbConfig,
): Effect.Effect<ContextPermissionRelationshipMutationService, never, Scope.Scope> =>
  Effect.matchEffect(loadConfiguration(), {
    onFailure: (cause) => Effect.succeed(unavailableService(cause)),
    onSuccess: (configuration) =>
      acquireSpiceDbClientResource(
        () => clientFactory(configuration, SPICEDB_CHECK_TIMEOUT_MS),
        unavailable,
      ).pipe(
        Effect.map(makeContextPermissionRelationshipMutation),
        Effect.catchTag('ContextPermissionMutationUnavailable', (cause) =>
          Effect.succeed(unavailableService(cause)),
        ),
      ),
  });

export const ContextPermissionRelationshipMutationLive = Layer.effect(
  ContextPermissionRelationshipMutation,
  makeContextPermissionRelationshipMutationLive(),
);
