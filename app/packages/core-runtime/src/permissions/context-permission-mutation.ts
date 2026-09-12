import type { v1 } from '@authzed/authzed-node';
import { Context, Effect, Layer } from 'effect';
import type { Scope } from 'effect';
import {
  createPermissionRelationshipMutationClient,
  // eslint-disable-next-line anti-slop-effect/no-service-constructor-imports -- Generic synchronous implementation factory; the contextual service is owned by this module.
  makePermissionRelationshipMutation,
  // eslint-disable-next-line anti-slop-effect/no-service-constructor-imports -- Generic scoped implementation factory consumed by this module's owning Layer.
  makePermissionRelationshipMutationLive,
} from './permission-relationship-mutation.ts';
import type { PermissionRelationshipMutationPreparation } from './permission-relationship-mutation.ts';
import { SPICEDB_CHECK_TIMEOUT_MS } from './client.ts';
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
>()('@app/core-runtime/permissions/context-permission-mutation/ContextPermissionRelationshipMutation') {}

/** Private test seam. Provisioning callers depend only on the typed mutation service. */
export interface ContextPermissionRelationshipMutationClient {
  readonly close: () => void;
  readonly writeRelationships: (
    request: v1.WriteRelationshipsRequest,
  ) => Effect.Effect<v1.WriteRelationshipsResponse, ContextPermissionMutationUnavailable>;
}

export const createContextPermissionRelationshipMutationClient = (
  configuration: SpiceDbConfigValue,
  timeoutMilliseconds = SPICEDB_CHECK_TIMEOUT_MS,
): ContextPermissionRelationshipMutationClient =>
  createPermissionRelationshipMutationClient(configuration, timeoutMilliseconds, unavailable);

const prepare = (
  input: ContextPermissionRelationshipMutationInput,
): PermissionRelationshipMutationPreparation | undefined => {
  const invalidScope =
    input.principal.tenantId !== input.tenantId ||
    input.principal.principalId.length === 0 ||
    input.tenantId.length === 0 ||
    input.target.moduleId.length === 0 ||
    input.target.permission.length === 0 ||
    input.legalEntityId?.length === 0;
  if (invalidScope) {
    return undefined;
  }
  const resourceId = toContextPermissionAccessObjectId(input.tenantId, input.legalEntityId, input.target);
  if (resourceId === undefined) {
    return undefined;
  }
  return {
    granteeId: input.principal.principalId,
    resourceId,
    scopeRelationship: {
      relation: 'tenant',
      subjectId: input.tenantId,
      subjectType: 'tenant',
    },
  };
};

export const makeContextPermissionRelationshipMutation = (
  client: Pick<ContextPermissionRelationshipMutationClient, 'writeRelationships'>,
): ContextPermissionRelationshipMutationService =>
  makePermissionRelationshipMutation(client, {
    mutationName: 'ContextPermissionRelationshipMutation.mutate',
    prepare,
    resourceType: 'context_permission',
    unavailable,
  });

const unavailableService = (cause?: unknown): ContextPermissionRelationshipMutationService =>
  Object.freeze({ mutate: () => Effect.fail(unavailable(cause)) });

export const makeContextPermissionRelationshipMutationLive = (
  clientFactory: (
    configuration: SpiceDbConfigValue,
    timeoutMilliseconds: number,
  ) => ContextPermissionRelationshipMutationClient = createContextPermissionRelationshipMutationClient,
  loadConfiguration: () => Effect.Effect<SpiceDbConfigValue, SpiceDbConfigError> = loadSpiceDbConfig,
): Effect.Effect<ContextPermissionRelationshipMutationService, never, Scope.Scope> =>
  makePermissionRelationshipMutationLive({
    clientFactory,
    loadConfiguration,
    makeService: makeContextPermissionRelationshipMutation,
    unavailable,
    unavailableService,
  });

export const ContextPermissionRelationshipMutationLive = Layer.effect(
  ContextPermissionRelationshipMutation,
  makeContextPermissionRelationshipMutationLive(),
);
