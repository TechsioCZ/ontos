import { RelationshipUpdate, RelationshipUpdate_Operation } from '@authzed/authzed-node/v1/core';
import {
  Precondition,
  Precondition_Operation,
  ReadRelationshipsRequest,
  RelationshipFilter,
  SubjectFilter,
  WriteRelationshipsRequest,
} from '@authzed/authzed-node/v1/permissions';
import type { WriteRelationshipsResponse } from '@authzed/authzed-node/v1/permissions';
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
import {
  hasCanonicalInventoryAuthorizationTarget,
  hasCanonicalPricingAuthorizationTargetIds,
  isBusinessPermissionTargetCompatible,
  toBusinessPermissionAccessObjectId,
  toLegalEntityAccessObjectId,
} from './context-access.ts';
import type { BusinessAccessTarget } from './context-access.ts';
import type { BusinessPermissionCode } from './business-permission.ts';
import { BusinessPermissionMutationUnavailable } from './business-permission-mutation-error.ts';
import type { PrincipalRef } from './principal-ref.ts';

export { BusinessPermissionMutationUnavailable } from './business-permission-mutation-error.ts';

const unavailable = (cause?: unknown): BusinessPermissionMutationUnavailable =>
  new BusinessPermissionMutationUnavailable({
    cause,
    reason: 'The business permission relationship mutation could not be completed safely',
  });

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
    request: WriteRelationshipsRequest,
  ) => Effect.Effect<WriteRelationshipsResponse, BusinessPermissionMutationUnavailable>;
}

export const createBusinessPermissionRelationshipMutationClient = (
  configuration: SpiceDbConfigValue,
  timeoutMilliseconds = SPICEDB_CHECK_TIMEOUT_MS,
): BusinessPermissionRelationshipMutationClient =>
  createPermissionRelationshipMutationClient(configuration, timeoutMilliseconds, unavailable);

const prepare = (
  input: BusinessPermissionRelationshipMutationInput,
): PermissionRelationshipMutationPreparation | undefined => {
  const targetRequiresLegalEntity =
    input.target.kind === 'retail_profile' ||
    input.target.kind === 'counterparty' ||
    input.target.kind === 'counterparty_storefront' ||
    input.target.kind === 'tax_selling_legal_entity';
  const invalidScope =
    !isBusinessPermissionTargetCompatible({ permission: input.permission, target: input.target }) ||
    !hasCanonicalPricingAuthorizationTargetIds(input.target) ||
    !hasCanonicalInventoryAuthorizationTarget(input.target) ||
    input.principal.tenantId !== input.target.tenantId ||
    input.principal.principalId.length === 0 ||
    (targetRequiresLegalEntity && input.target.legalEntityId.length === 0) ||
    (input.target.kind === 'counterparty_storefront' &&
      (input.trustedStorefrontId === undefined || input.trustedStorefrontId !== input.target.storefrontId));
  if (invalidScope) {
    return undefined;
  }
  const resourceId = toBusinessPermissionAccessObjectId(input.permission, input.target);
  if (resourceId === undefined) {
    return undefined;
  }
  const scopeRelationships: PermissionRelationshipMutationPreparation['scopeRelationships'] = targetRequiresLegalEntity
    ? [
        {
          relation: 'legal_entity',
          subjectId: toLegalEntityAccessObjectId(input.target.tenantId, input.target.legalEntityId) ?? '',
          subjectType: 'legal_entity',
        },
      ]
    : [
        {
          relation: 'tenant',
          subjectId: input.target.tenantId,
          subjectType: 'tenant',
        },
      ];
  if (scopeRelationships.some(({ subjectId }) => subjectId.length === 0)) {
    return undefined;
  }
  return {
    granteeId: input.principal.principalId,
    granteeRelation: input.target.kind === 'retail_profile' ? 'self_service_grantee' : 'grantee',
    resourceId,
    scopeRelationships,
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

/** One-time authorization graph migration; never creates a grant absent its exact native predecessor. */
export const migrateRetailSelfServiceGrant = Effect.fn(
  'BusinessPermissionRelationshipMutation.migrateRetailSelfServiceGrant',
)(function* migrateRetailSelfServiceGrantEffect(
  client: Pick<v1.ZedClientInterface['promises'], 'readRelationships' | 'writeRelationships'>,
  input: BusinessPermissionRelationshipMutationInput,
  apply: boolean,
) {
  const prepared = prepare(input);
  if (prepared === undefined || input.operation !== 'grant' || input.target.kind !== 'retail_profile') {
    return yield* unavailable();
  }
  const filter = RelationshipFilter.create({
    optionalRelation: 'grantee',
    optionalResourceId: prepared.resourceId,
    optionalSubjectFilter: SubjectFilter.create({
      optionalSubjectId: prepared.granteeId,
      subjectType: 'principal',
    }),
    resourceType: 'business_permission',
  });
  const rows = yield* Effect.tryPromise(() =>
    client.readRelationships(
      ReadRelationshipsRequest.create({
        consistency: { requirement: { fullyConsistent: true, oneofKind: 'fullyConsistent' } },
        relationshipFilter: filter,
      }),
    ),
  ).pipe(
    Effect.timeoutOrElse({ duration: SPICEDB_CHECK_TIMEOUT_MS, orElse: () => Effect.fail(unavailable()) }),
    Effect.mapError(unavailable),
  );
  if (rows.length === 0) {
    return { existing: 0, migrated: 0 };
  }
  const previous = rows[0]?.relationship;
  if (
    rows.length !== 1 ||
    previous === undefined ||
    previous.optionalCaveat !== undefined ||
    previous.optionalExpiresAt !== undefined ||
    previous.resource?.objectType !== 'business_permission' ||
    previous.resource.objectId !== prepared.resourceId ||
    previous.relation !== 'grantee' ||
    previous.subject?.object?.objectType !== 'principal' ||
    previous.subject.object.objectId !== prepared.granteeId ||
    previous.subject.optionalRelation !== ''
  ) {
    return yield* unavailable();
  }
  if (!apply) {
    return { existing: 1, migrated: 0 };
  }
  yield* Effect.tryPromise(() =>
    client.writeRelationships(
      WriteRelationshipsRequest.create({
        optionalPreconditions: [Precondition.create({ filter, operation: Precondition_Operation.MUST_MATCH })],
        updates: [
          RelationshipUpdate.create({
            operation: RelationshipUpdate_Operation.TOUCH,
            relationship: { ...previous, relation: 'self_service_grantee' },
          }),
          RelationshipUpdate.create({ operation: RelationshipUpdate_Operation.DELETE, relationship: previous }),
        ],
      }),
    ),
  ).pipe(
    Effect.timeoutOrElse({ duration: SPICEDB_CHECK_TIMEOUT_MS, orElse: () => Effect.fail(unavailable()) }),
    Effect.mapError(unavailable),
  );
  return { existing: 1, migrated: 1 };
});
