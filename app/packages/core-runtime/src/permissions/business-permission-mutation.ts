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
import {
  toBusinessPermissionAccessObjectId,
  toLegalEntityAccessObjectId,
} from './context-access.ts';
import type { BusinessAccessTarget } from './context-access.ts';
import type { BusinessPermissionCode } from './business-permission.ts';
import { BusinessPermissionMutationUnavailable } from './business-permission-mutation-error.ts';
import type { PrincipalRef } from './principal-ref.ts';

export { BusinessPermissionMutationUnavailable } from './business-permission-mutation-error.ts';

const unavailable = (cause?: unknown): BusinessPermissionMutationUnavailable => {
  const failure = new BusinessPermissionMutationUnavailable({
    reason: 'The business permission relationship mutation could not be completed safely',
  });
  return cause === undefined
    ? failure
    : Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
};

export interface BusinessPermissionRelationshipMutationInput {
  readonly operation: 'grant' | 'revoke';
  readonly permission: BusinessPermissionCode;
  readonly principal: PrincipalRef;
  readonly target: BusinessAccessTarget;
  /** Storefront identity resolved by the trusted application boundary, never raw transport data. */
  readonly trustedStorefrontId?: string;
}

export interface BusinessPermissionRelationshipMutationService {
  readonly mutate: (
    input: BusinessPermissionRelationshipMutationInput,
  ) => Effect.Effect<void, BusinessPermissionMutationUnavailable>;
}

export class BusinessPermissionRelationshipMutation extends Context.Service<
  BusinessPermissionRelationshipMutation,
  BusinessPermissionRelationshipMutationService
>()(
  '@app/core-runtime/permissions/business-permission-mutation/BusinessPermissionRelationshipMutation',
) {}

/** Private test seam. Actions and owner modules depend only on the typed mutation service. */
export interface BusinessPermissionRelationshipMutationClient {
  readonly close: () => void;
  readonly writeRelationships: (
    request: v1.WriteRelationshipsRequest,
  ) => Effect.Effect<v1.WriteRelationshipsResponse, BusinessPermissionMutationUnavailable>;
}

const mutationTimeout = Effect.timeoutOrElse({
  duration: Duration.millis(SPICEDB_CHECK_TIMEOUT_MS),
  orElse: () =>
    Effect.fail(unavailable(new Cause.TimeoutError('SpiceDB relationship mutation timed out'))),
});

export const createBusinessPermissionRelationshipMutationClient = (
  configuration: SpiceDbConfigValue,
  timeoutMilliseconds = SPICEDB_CHECK_TIMEOUT_MS,
): BusinessPermissionRelationshipMutationClient => {
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
  readonly relation: 'grantee' | 'legal_entity';
  readonly resourceId: string;
  readonly subjectId: string;
  readonly subjectType: 'legal_entity' | 'principal';
}) =>
  v1.Relationship.create({
    relation: input.relation,
    resource: objectReference('business_permission', input.resourceId),
    subject: v1.SubjectReference.create({
      object: objectReference(input.subjectType, input.subjectId),
    }),
  });

const invalidScope = (input: BusinessPermissionRelationshipMutationInput): boolean =>
  input.principal.tenantId !== input.target.tenantId ||
  input.principal.principalId.length === 0 ||
  input.target.legalEntityId.length === 0 ||
  (input.target.kind === 'counterparty_storefront' &&
    (input.trustedStorefrontId === undefined ||
      input.trustedStorefrontId !== input.target.storefrontId));

export const makeBusinessPermissionRelationshipMutation = (
  client: Pick<BusinessPermissionRelationshipMutationClient, 'writeRelationships'>,
): BusinessPermissionRelationshipMutationService =>
  Object.freeze({
    mutate: Effect.fn('BusinessPermissionRelationshipMutation.mutate')(
      function* mutateBusinessPermissionRelationship(
        input: BusinessPermissionRelationshipMutationInput,
      ) {
        if (invalidScope(input)) {
          return yield* unavailable();
        }
        const resourceId = toBusinessPermissionAccessObjectId(input.permission, input.target);
        const legalEntityId = toLegalEntityAccessObjectId(
          input.target.tenantId,
          input.target.legalEntityId,
        );
        if (resourceId === undefined || legalEntityId === undefined) {
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
                    relation: 'legal_entity',
                    resourceId,
                    subjectId: legalEntityId,
                    subjectType: 'legal_entity',
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

const unavailableService = (cause?: unknown): BusinessPermissionRelationshipMutationService =>
  Object.freeze({ mutate: () => Effect.fail(unavailable(cause)) });

export const makeBusinessPermissionRelationshipMutationLive = (
  clientFactory: (
    configuration: SpiceDbConfigValue,
    timeoutMilliseconds: number,
  ) => BusinessPermissionRelationshipMutationClient = createBusinessPermissionRelationshipMutationClient,
  loadConfiguration: () => Effect.Effect<
    SpiceDbConfigValue,
    SpiceDbConfigError
  > = loadSpiceDbConfig,
): Effect.Effect<BusinessPermissionRelationshipMutationService, never, Scope.Scope> =>
  Effect.matchEffect(loadConfiguration(), {
    onFailure: (cause) => Effect.succeed(unavailableService(cause)),
    onSuccess: (configuration) =>
      acquireSpiceDbClientResource(
        () => clientFactory(configuration, SPICEDB_CHECK_TIMEOUT_MS),
        unavailable,
      ).pipe(
        Effect.map(makeBusinessPermissionRelationshipMutation),
        Effect.catchTag('BusinessPermissionMutationUnavailable', (cause) =>
          Effect.succeed(unavailableService(cause)),
        ),
      ),
  });

export const BusinessPermissionRelationshipMutationLive = Layer.effect(
  BusinessPermissionRelationshipMutation,
  makeBusinessPermissionRelationshipMutationLive(),
);
