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
import { toBusinessPermissionAccessObjectId, toLegalEntityAccessObjectId } from './context-access.ts';
import type { BusinessAccessTarget } from './context-access.ts';
import type { BusinessPermissionCode } from './business-permission.ts';
import { BusinessPermissionMutationUnavailable } from './business-permission-mutation-error.ts';
import type { PrincipalRef } from './principal-ref.ts';

export { BusinessPermissionMutationUnavailable } from './business-permission-mutation-error.ts';

const unavailable = (cause?: unknown): BusinessPermissionMutationUnavailable => {
  const failure = new BusinessPermissionMutationUnavailable({
    reason: 'The business permission relationship mutation could not be completed safely',
  });
  return cause === undefined ? failure : Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
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
>()('@app/core-runtime/permissions/business-permission-mutation/BusinessPermissionRelationshipMutation') {}

/** Private test seam. Actions and owner modules depend only on the typed mutation service. */
export interface BusinessPermissionRelationshipMutationClient {
  readonly close: () => void;
  readonly writeRelationships: (
    request: v1.WriteRelationshipsRequest,
  ) => Effect.Effect<v1.WriteRelationshipsResponse, BusinessPermissionMutationUnavailable>;
}

export const createBusinessPermissionRelationshipMutationClient = (
  configuration: SpiceDbConfigValue,
  timeoutMilliseconds = SPICEDB_CHECK_TIMEOUT_MS,
): BusinessPermissionRelationshipMutationClient =>
  createPermissionRelationshipMutationClient(configuration, timeoutMilliseconds, unavailable);

const prepare = (
  input: BusinessPermissionRelationshipMutationInput,
): PermissionRelationshipMutationPreparation | undefined => {
  const invalidScope =
    input.principal.tenantId !== input.target.tenantId ||
    input.principal.principalId.length === 0 ||
    input.target.legalEntityId.length === 0 ||
    (input.target.kind === 'counterparty_storefront' &&
      (input.trustedStorefrontId === undefined || input.trustedStorefrontId !== input.target.storefrontId));
  if (invalidScope) {
    return undefined;
  }
  const resourceId = toBusinessPermissionAccessObjectId(input.permission, input.target);
  const legalEntityId = toLegalEntityAccessObjectId(input.target.tenantId, input.target.legalEntityId);
  if (resourceId === undefined || legalEntityId === undefined) {
    return undefined;
  }
  return {
    granteeId: input.principal.principalId,
    resourceId,
    scopeRelationship: {
      relation: 'legal_entity',
      subjectId: legalEntityId,
      subjectType: 'legal_entity',
    },
  };
};

export const makeBusinessPermissionRelationshipMutation = (
  client: Pick<BusinessPermissionRelationshipMutationClient, 'writeRelationships'>,
): BusinessPermissionRelationshipMutationService =>
  makePermissionRelationshipMutation(client, {
    mutationName: 'BusinessPermissionRelationshipMutation.mutate',
    prepare,
    resourceType: 'business_permission',
    unavailable,
  });

const unavailableService = (cause?: unknown): BusinessPermissionRelationshipMutationService =>
  Object.freeze({ mutate: () => Effect.fail(unavailable(cause)) });

export const makeBusinessPermissionRelationshipMutationLive = (
  clientFactory: (
    configuration: SpiceDbConfigValue,
    timeoutMilliseconds: number,
  ) => BusinessPermissionRelationshipMutationClient = createBusinessPermissionRelationshipMutationClient,
  loadConfiguration: () => Effect.Effect<SpiceDbConfigValue, SpiceDbConfigError> = loadSpiceDbConfig,
): Effect.Effect<BusinessPermissionRelationshipMutationService, never, Scope.Scope> =>
  makePermissionRelationshipMutationLive({
    clientFactory,
    loadConfiguration,
    makeService: makeBusinessPermissionRelationshipMutation,
    unavailable,
    unavailableService,
  });

export const BusinessPermissionRelationshipMutationLive = Layer.effect(
  BusinessPermissionRelationshipMutation,
  makeBusinessPermissionRelationshipMutationLive(),
);
