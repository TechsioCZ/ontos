import { v1 } from '@authzed/authzed-node';
import { Context, Effect, Layer, Result, Schema } from 'effect';
import type { Scope } from 'effect';

import {
  SPICEDB_CHECK_TIMEOUT_MS,
  acquireSpiceDbClientResource,
  createSpiceDbPermissionClient,
  fullyConsistent,
  spiceDbPermissionClientError,
} from './client.ts';
import type { SpiceDbPermissionClient } from './client.ts';
import type { SpiceDbConfigError } from './config-error.ts';
import { loadSpiceDbConfig } from './config.ts';
import type { SpiceDbConfigValue } from './config.ts';
import { BusinessPermissionDescriptorSchema } from './business-permission.ts';
import type { BusinessPermissionDescriptor } from './business-permission.ts';
import type { PrincipalRef } from './principal-ref.ts';
import type {
  IdentityNamespacePermissionKey,
  LegalEntityPermissionKey,
  TenantPermissionKey,
} from './context-permissions.ts';

const ContextAccessDecisionSchema = Schema.Literals(['allowed', 'denied', 'unavailable']);
export type ContextAccessDecision = typeof ContextAccessDecisionSchema.Type;

export interface ContextAccessResult {
  readonly decision: ContextAccessDecision;
  readonly key: string;
}

export interface ResourceAccessTarget {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
}

export interface ContextPermissionAccessTarget {
  readonly moduleId: string;
  readonly permission: string;
}

/** Owner declarations choose exact business meanings; Core enforces only these neutral scopes. */
export type OwnerPermissionScope =
  | Readonly<{ readonly kind: 'tenant'; readonly tenantId: string }>
  | Readonly<{ readonly kind: 'legal_entity'; readonly legalEntityId: string; readonly tenantId: string }>;

export interface OwnerPermissionContract {
  readonly ownerStateRequired?: boolean;
  readonly owningModuleKey: string;
  readonly permissions: readonly BusinessPermissionDescriptor[];
  readonly schemaVersion: '1';
  readonly targetResourceType: string;
}

export interface OwnerPermissionAccessTarget {
  readonly alternativeObjectIds?: readonly string[];
  readonly contract: OwnerPermissionContract;
  readonly definition: BusinessPermissionDescriptor;
  readonly key: string;
  readonly objectId: string;
  readonly requiredStorefrontId?: string;
  readonly scope: OwnerPermissionScope;
  readonly scopeKind: string;
  /** Owner-local decoded meaning, forwarded only to the same owner's transaction overlay. */
  readonly target: object;
  readonly transportModuleKey: string;
  readonly transportObjectId: string;
  readonly transportResourceType?: string;
}

const ownerPermissionIdentifier = Schema.String.check(Schema.isMinLength(1));
const OwnerPermissionObjectIdSchema = ownerPermissionIdentifier.pipe(Schema.brand('OwnerPermissionObjectId'));
const OwnerPermissionStorefrontIdSchema = ownerPermissionIdentifier.pipe(Schema.brand('OwnerPermissionStorefrontId'));
const OwnerPermissionTenantIdSchema = ownerPermissionIdentifier.pipe(Schema.brand('OwnerPermissionTenantId'));
const OwnerPermissionLegalEntityIdSchema = ownerPermissionIdentifier.pipe(Schema.brand('OwnerPermissionLegalEntityId'));
const OwnerPermissionTransportModuleKeySchema = ownerPermissionIdentifier.pipe(
  Schema.brand('OwnerPermissionTransportModuleKey'),
);
const OwnerPermissionContractSchema = Schema.Struct({
  ownerStateRequired: Schema.optionalKey(Schema.Boolean),
  owningModuleKey: ownerPermissionIdentifier.pipe(Schema.brand('OwnerPermissionModuleKey')),
  permissions: Schema.Array(BusinessPermissionDescriptorSchema).check(Schema.isMinLength(1)),
  schemaVersion: Schema.Literal('1'),
  targetResourceType: ownerPermissionIdentifier,
});
const OwnerPermissionTargetMetadataSchema = Schema.Struct({
  alternativeObjectIds: Schema.optionalKey(Schema.Array(OwnerPermissionObjectIdSchema)),
  contract: OwnerPermissionContractSchema,
  definition: BusinessPermissionDescriptorSchema,
  key: ownerPermissionIdentifier,
  objectId: OwnerPermissionObjectIdSchema,
  requiredStorefrontId: Schema.optionalKey(OwnerPermissionStorefrontIdSchema),
  scope: Schema.Union([
    Schema.Struct({ kind: Schema.Literal('tenant'), tenantId: OwnerPermissionTenantIdSchema }),
    Schema.Struct({
      kind: Schema.Literal('legal_entity'),
      legalEntityId: OwnerPermissionLegalEntityIdSchema,
      tenantId: OwnerPermissionTenantIdSchema,
    }),
  ]),
  scopeKind: ownerPermissionIdentifier,
  transportModuleKey: OwnerPermissionTransportModuleKeySchema,
  transportObjectId: OwnerPermissionObjectIdSchema,
  transportResourceType: Schema.optionalKey(ownerPermissionIdentifier),
});

export const isOwnerPermissionContract = (contract: OwnerPermissionContract): boolean =>
  Schema.is(OwnerPermissionContractSchema)(contract) &&
  Object.isFrozen(contract) &&
  Object.isFrozen(contract.permissions) &&
  contract.permissions.every((definition) => Object.isFrozen(definition));

export const createOwnerPermissionAccessTarget = (
  contract: OwnerPermissionContract,
  input: Omit<OwnerPermissionAccessTarget, 'contract'>,
): OwnerPermissionAccessTarget => {
  const { alternativeObjectIds, ...target } = input;
  const scopedTarget = { ...target, contract, scope: Object.freeze({ ...input.scope }) };
  return alternativeObjectIds === undefined
    ? Object.freeze(scopedTarget)
    : Object.freeze({ ...scopedTarget, alternativeObjectIds: Object.freeze([...alternativeObjectIds]) });
};

export const isOwnerPermissionAccessTargetMetadataValid = (target: OwnerPermissionAccessTarget): boolean =>
  Schema.is(OwnerPermissionTargetMetadataSchema)(target) &&
  Object.isFrozen(target) &&
  Object.isFrozen(target.scope) &&
  isOwnerPermissionContract(target.contract) &&
  target.contract.schemaVersion === '1' &&
  target.contract.permissions.includes(target.definition) &&
  target.definition.allowedScopeKinds.includes(target.scopeKind) &&
  target.key.length > 0 &&
  target.objectId.length > 0 &&
  target.objectId.length <= 1024 &&
  (target.alternativeObjectIds === undefined ||
    (Object.isFrozen(target.alternativeObjectIds) &&
      target.alternativeObjectIds.every(
        (objectId) => objectId.length > 0 && objectId.length <= 1024 && objectId !== target.objectId,
      ) &&
      new Set(target.alternativeObjectIds).size === target.alternativeObjectIds.length)) &&
  target.transportObjectId.length > 0 &&
  target.contract.targetResourceType.length > 0;

export const isOwnerPermissionAccessTargetValid = (
  target: OwnerPermissionAccessTarget,
  scope: Readonly<{
    readonly legalEntityId?: string;
    readonly tenantId: string;
    readonly trustedStorefrontId?: string;
  }>,
  owningModuleKey?: string,
): boolean =>
  isOwnerPermissionAccessTargetMetadataValid(target) &&
  (owningModuleKey === undefined || target.contract.owningModuleKey === owningModuleKey) &&
  target.scope.tenantId === scope.tenantId &&
  scope.tenantId.length > 0 &&
  (target.scope.kind === 'tenant' ||
    (target.scope.kind === 'legal_entity' &&
      target.scope.legalEntityId.length > 0 &&
      target.scope.legalEntityId === scope.legalEntityId)) &&
  (target.requiredStorefrontId === undefined || target.requiredStorefrontId === scope.trustedStorefrontId);

export interface ContextAccessService {
  /**
   * Checks an exact named entrypoint permission in trusted Tenant/Legal Entity scope.
   * Optional for compatibility with older adapters; runtimes must treat absence as unavailable.
   */
  readonly contextPermissions?: (input: {
    readonly legalEntityId?: string;
    readonly principalId: string;
    readonly targets: readonly ContextPermissionAccessTarget[];
    readonly tenantId: string;
  }) => Effect.Effect<readonly ContextAccessResult[]>;
  /**
   * Checks the explicit provisioning capability for exact Tenant/namespace pairs.
   * Optional for compatibility with older adapters; identity Actions must treat
   * an absent implementation as unavailable.
   */
  readonly identityNamespaces?: (input: {
    readonly authenticationNamespaceIds: readonly string[];
    readonly permission?: IdentityNamespacePermissionKey;
    readonly principalId: string;
    readonly tenantId: string;
  }) => Effect.Effect<readonly ContextAccessResult[]>;
  readonly legalEntities: (input: {
    readonly legalEntityIds: readonly string[];
    readonly permission?: LegalEntityPermissionKey;
    readonly principalId: string;
    readonly tenantId: string;
  }) => Effect.Effect<readonly ContextAccessResult[]>;
  readonly modules: (input: {
    readonly legalEntityId: string;
    readonly moduleIds: readonly string[];
    readonly principalId: string;
    readonly tenantId: string;
  }) => Effect.Effect<readonly ContextAccessResult[]>;
  readonly ownerPermissions?: (input: {
    readonly legalEntityId?: string;
    readonly principal: PrincipalRef;
    readonly targets: readonly Readonly<{ readonly target: OwnerPermissionAccessTarget }>[];
    /** Storefront identity resolved by a trusted application boundary, never raw client input. */
    readonly trustedStorefrontId?: string;
  }) => Effect.Effect<readonly ContextAccessResult[]>;
  readonly resources: (input: {
    readonly legalEntityId: string;
    readonly permission?: 'read' | 'write';
    readonly principalId: string;
    readonly resources: readonly ResourceAccessTarget[];
    readonly tenantId: string;
  }) => Effect.Effect<readonly ContextAccessResult[]>;
  /** Exact Tenant-owned resource permissions; no implicit Legal Entity or tenant-access grant. */
  readonly tenantResources?: (input: {
    readonly permission: 'assign' | 'read' | 'write';
    readonly principalId: string;
    readonly resources: readonly ResourceAccessTarget[];
    readonly tenantId: string;
  }) => Effect.Effect<readonly ContextAccessResult[]>;
  readonly tenants: (input: {
    readonly permission: TenantPermissionKey;
    readonly principalId: string;
    readonly tenantIds: readonly string[];
  }) => Effect.Effect<readonly ContextAccessResult[]>;
}

export class ContextAccess extends Context.Service<ContextAccess, ContextAccessService>()(
  '@app/core-runtime/permissions/context-access/ContextAccess',
) {}

export type ContextAccessClientFactory = (
  configuration: SpiceDbConfigValue,
  timeoutMilliseconds: number,
) => SpiceDbPermissionClient;

interface BatchItem {
  readonly key: string;
  readonly permission: string;
  readonly resourceId: string;
  readonly resourceType: string;
}

const ContextAccessObjectIdParts = Schema.fromJsonString(Schema.Array(Schema.String));
const encodeContextAccessObjectIdParts = Schema.encodeResult(ContextAccessObjectIdParts);
const principalReference = (principalId: string) =>
  v1.SubjectReference.create({
    object: v1.ObjectReference.create({
      objectId: principalId,
      objectType: 'principal',
    }),
  });

const encodeObjectId = (parts: readonly string[]): string | undefined => {
  if (parts.some((part) => part.length === 0)) {
    return undefined;
  }
  const encodedParts = Result.getOrThrow(encodeContextAccessObjectIdParts(parts));
  const encoded = `ctx_${Buffer.from(encodedParts, 'utf-8').toString('base64url')}`;
  return encoded.length <= 1024 ? encoded : undefined;
};

export const toLegalEntityAccessObjectId = (tenantId: string, legalEntityId: string): string | undefined =>
  encodeObjectId([tenantId, legalEntityId]);

export const toModuleAccessObjectId = (tenantId: string, legalEntityId: string, moduleId: string): string | undefined =>
  encodeObjectId([tenantId, legalEntityId, moduleId]);

export const toResourceAccessObjectId = (
  tenantId: string,
  legalEntityId: string,
  resource: ResourceAccessTarget,
): string | undefined =>
  encodeObjectId([tenantId, legalEntityId, resource.moduleId, resource.resourceType, resource.resourceId]);

export const toTenantResourceAccessObjectId = (tenantId: string, resource: ResourceAccessTarget): string | undefined =>
  encodeObjectId([tenantId, resource.moduleId, resource.resourceType, resource.resourceId]);

export const toContextPermissionAccessKey = ({ moduleId, permission }: ContextPermissionAccessTarget): string =>
  `${moduleId}:${permission}`;

export const toContextPermissionAccessObjectId = (
  tenantId: string,
  legalEntityId: string | undefined,
  target: ContextPermissionAccessTarget,
): string | undefined =>
  encodeObjectId([
    tenantId,
    legalEntityId === undefined ? 'tenant' : 'legal_entity',
    legalEntityId ?? tenantId,
    target.moduleId,
    target.permission,
  ]);

export const toIdentityNamespaceAccessObjectId = (
  tenantId: string,
  authenticationNamespaceId: string,
): string | undefined => encodeObjectId([tenantId, authenticationNamespaceId]);

const unavailable = (keys: readonly string[]): readonly ContextAccessResult[] =>
  keys.map((key) => ({ decision: 'unavailable' as const, key }));

const classifyPair = (pair: v1.CheckBulkPermissionsPair): ContextAccessDecision => {
  if (pair.response.oneofKind !== 'item') {
    return 'unavailable';
  }
  const { permissionship } = pair.response.item;
  if (permissionship === v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION) {
    return 'allowed';
  }
  if (permissionship === v1.CheckPermissionResponse_Permissionship.NO_PERMISSION) {
    return 'denied';
  }
  return 'unavailable';
};

const foldAlternativeDecisions = (decisions: readonly ContextAccessDecision[]): ContextAccessDecision => {
  if (decisions.includes('allowed')) {
    return 'allowed';
  }
  return decisions.includes('unavailable') ? 'unavailable' : 'denied';
};

const contextAccessDecisions = (results: readonly ContextAccessResult[]): readonly ContextAccessDecision[] =>
  results.map(({ decision }) => decision);

const resultsForBatchItems = (
  items: readonly BatchItem[],
  resultsByKey: ReadonlyMap<string, ContextAccessResult>,
): readonly ContextAccessResult[] =>
  items.flatMap((item) => {
    const result = resultsByKey.get(item.key);
    return result === undefined ? [] : [result];
  });

const makeRequestItem = (item: BatchItem, principalId: string) =>
  v1.CheckBulkPermissionsRequestItem.create({
    permission: item.permission,
    resource: v1.ObjectReference.create({
      objectId: item.resourceId,
      objectType: item.resourceType,
    }),
    subject: principalReference(principalId),
  });

const sameObjectReference = (
  expected: v1.ObjectReference | undefined,
  actual: v1.ObjectReference | undefined,
): boolean => actual?.objectId === expected?.objectId && actual?.objectType === expected?.objectType;

const sameRequest = (
  expected: v1.CheckBulkPermissionsRequestItem,
  actual: v1.CheckBulkPermissionsRequestItem | undefined,
): boolean =>
  actual?.permission === expected.permission &&
  sameObjectReference(expected.resource, actual.resource) &&
  sameObjectReference(expected.subject?.object, actual.subject?.object);

export const makeContextAccess = (client: SpiceDbPermissionClient): ContextAccessService => {
  const checkBatch = (
    items: readonly BatchItem[],
    principalId: string,
  ): Effect.Effect<readonly ContextAccessResult[]> => {
    const keys = items.map(({ key }) => key);
    if (
      principalId.length === 0 ||
      new Set(keys).size !== keys.length ||
      items.some(({ resourceId }) => resourceId.length === 0)
    ) {
      return Effect.succeed(unavailable(keys));
    }
    if (items.length === 0) {
      return Effect.succeed([]);
    }
    const requests = items.map((item) => makeRequestItem(item, principalId));
    return client
      .checkBulkPermissions(
        v1.CheckBulkPermissionsRequest.create({
          consistency: fullyConsistent,
          items: requests,
          withTracing: false,
        }),
      )
      .pipe(
        Effect.map((response) => {
          if (response.pairs.length !== requests.length) {
            return unavailable(keys);
          }
          const seen = new Set<string>();
          const decisions = response.pairs.map((pair, index) => {
            const expected = requests[index];
            const key = keys[index];
            if (expected === undefined || key === undefined || !sameRequest(expected, pair.request) || seen.has(key)) {
              return null;
            }
            seen.add(key);
            return { decision: classifyPair(pair), key };
          });
          return decisions.every((decision): decision is ContextAccessResult => decision !== null)
            ? decisions
            : unavailable(keys);
        }),
        Effect.catchTag('SpiceDbPermissionClientError', () => Effect.succeed(unavailable(keys))),
      );
  };

  const service: ContextAccessService = {
    contextPermissions: ({ legalEntityId, principalId, targets, tenantId }) =>
      checkBatch(
        targets.map((target) => ({
          key: toContextPermissionAccessKey(target),
          permission: 'access',
          resourceId: toContextPermissionAccessObjectId(tenantId, legalEntityId, target) ?? '',
          resourceType: 'context_permission',
        })),
        principalId,
      ),
    identityNamespaces: ({ authenticationNamespaceIds, permission = 'provision', principalId, tenantId }) =>
      checkBatch(
        authenticationNamespaceIds.map((authenticationNamespaceId) => ({
          key: authenticationNamespaceId,
          permission,
          resourceId: toIdentityNamespaceAccessObjectId(tenantId, authenticationNamespaceId) ?? '',
          resourceType: 'identity_namespace',
        })),
        principalId,
      ),
    legalEntities: ({ legalEntityIds, permission = 'access', principalId, tenantId }) =>
      checkBatch(
        legalEntityIds.map((legalEntityId) => ({
          key: legalEntityId,
          permission,
          resourceId: toLegalEntityAccessObjectId(tenantId, legalEntityId) ?? '',
          resourceType: 'legal_entity',
        })),
        principalId,
      ),
    modules: ({ legalEntityId, moduleIds, principalId, tenantId }) =>
      checkBatch(
        moduleIds.map((moduleId) => ({
          key: moduleId,
          permission: 'access',
          resourceId: toModuleAccessObjectId(tenantId, legalEntityId, moduleId) ?? '',
          resourceType: 'module_access',
        })),
        principalId,
      ),
    ownerPermissions: ({ legalEntityId, principal, targets, trustedStorefrontId }) => {
      const tenantScope = { tenantId: principal.tenantId };
      const legalEntityScope = legalEntityId === undefined ? tenantScope : { ...tenantScope, legalEntityId };
      const scope = trustedStorefrontId === undefined ? legalEntityScope : { ...legalEntityScope, trustedStorefrontId };
      const keys = targets.map(({ target }) => target.key);
      if (
        principal.principalId.length === 0 ||
        targets.some(({ target }) => !isOwnerPermissionAccessTargetValid(target, scope))
      ) {
        return Effect.succeed(unavailable(keys));
      }
      const alternatives = targets.map(({ target }) => ({
        items: [target.objectId, ...(target.alternativeObjectIds ?? [])].map((objectId): BatchItem => ({
          key: objectId,
          permission: 'use',
          resourceId: objectId,
          resourceType: 'business_permission',
        })),
        requestedKey: target.key,
      }));
      const batchItems = alternatives.flatMap(({ items }) => items);
      const uniqueBatchItems = [...new Map(batchItems.map((item) => [item.key, item])).values()];
      return checkBatch(uniqueBatchItems, principal.principalId).pipe(
        Effect.map((results) => {
          const resultsByKey = new Map(results.map((result) => [result.key, result]));
          return alternatives.map(({ items, requestedKey }) => ({
            decision: foldAlternativeDecisions(contextAccessDecisions(resultsForBatchItems(items, resultsByKey))),
            key: requestedKey,
          }));
        }),
      );
    },
    resources: ({ legalEntityId, permission = 'read', principalId, resources, tenantId }) =>
      checkBatch(
        resources.map((resource) => ({
          key: `${resource.moduleId}:${resource.resourceType}:${resource.resourceId}`,
          permission,
          resourceId: toResourceAccessObjectId(tenantId, legalEntityId, resource) ?? '',
          resourceType: 'resource',
        })),
        principalId,
      ),
    tenantResources: ({ permission, principalId, resources, tenantId }) =>
      checkBatch(
        resources.map((resource) => ({
          key: `${resource.moduleId}:${resource.resourceType}:${resource.resourceId}`,
          permission,
          resourceId: toTenantResourceAccessObjectId(tenantId, resource) ?? '',
          resourceType: 'tenant_resource',
        })),
        principalId,
      ),
    tenants: ({ permission, principalId, tenantIds }) =>
      checkBatch(
        tenantIds.map((tenantId) => ({
          key: tenantId,
          permission,
          resourceId: tenantId,
          resourceType: 'tenant',
        })),
        principalId,
      ),
  };
  return Object.freeze(service);
};

const unavailableContextAccess = (): ContextAccessService => {
  const service: ContextAccessService = {
    contextPermissions: ({ targets }) => Effect.succeed(unavailable(targets.map(toContextPermissionAccessKey))),
    identityNamespaces: ({ authenticationNamespaceIds }) => Effect.succeed(unavailable(authenticationNamespaceIds)),
    legalEntities: ({ legalEntityIds }) => Effect.succeed(unavailable(legalEntityIds)),
    modules: ({ moduleIds }) => Effect.succeed(unavailable(moduleIds)),
    ownerPermissions: ({ targets }) => Effect.succeed(unavailable(targets.map(({ target }) => target.key))),
    resources: ({ resources }) =>
      Effect.succeed(
        unavailable(
          resources.map(({ moduleId, resourceId, resourceType }) => `${moduleId}:${resourceType}:${resourceId}`),
        ),
      ),
    tenantResources: ({ resources }) =>
      Effect.succeed(
        unavailable(
          resources.map((resource) => `${resource.moduleId}:${resource.resourceType}:${resource.resourceId}`),
        ),
      ),
    tenants: ({ tenantIds }) => Effect.succeed(unavailable(tenantIds)),
  };
  return Object.freeze(service);
};

export const makeContextAccessLive = (
  clientFactory: ContextAccessClientFactory = createSpiceDbPermissionClient,
  loadConfiguration: () => Effect.Effect<SpiceDbConfigValue, SpiceDbConfigError> = loadSpiceDbConfig,
): Effect.Effect<ContextAccessService, never, Scope.Scope> =>
  loadConfiguration().pipe(
    Effect.flatMap((configuration) =>
      acquireSpiceDbClientResource(
        () => clientFactory(configuration, SPICEDB_CHECK_TIMEOUT_MS),
        spiceDbPermissionClientError,
      ).pipe(
        Effect.map(makeContextAccess),
        Effect.catchTag('SpiceDbPermissionClientError', () => Effect.succeed(unavailableContextAccess())),
      ),
    ),
    Effect.catchTag('SpiceDbConfigError', () => Effect.succeed(unavailableContextAccess())),
  );

export const ContextAccessLive = Layer.effect(ContextAccess, makeContextAccessLive());
