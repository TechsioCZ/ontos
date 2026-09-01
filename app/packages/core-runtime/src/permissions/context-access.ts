/* eslint-disable promise/prefer-await-to-callbacks -- Effect owns typed Promise adaptation. */
import { v1 } from '@authzed/authzed-node';
import { Context, Effect, Layer } from 'effect';
import type { Scope } from 'effect';
import {
  SPICEDB_CHECK_TIMEOUT_MS,
  acquireSpiceDbClientResource,
  createSpiceDbPermissionClient,
  fullyConsistent,
} from './client.ts';
import type { SpiceDbPermissionClient } from './client.ts';
import { loadSpiceDbConfig } from './config.ts';
import type { SpiceDbConfigValue } from './config.ts';
import type { SpiceDbConfigError } from './config-error.ts';

export type ContextAccessDecision = 'allowed' | 'denied' | 'unavailable';

export interface ContextAccessResult {
  readonly decision: ContextAccessDecision;
  readonly key: string;
}

export interface ResourceAccessTarget {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
}

export interface ContextAccessService {
  readonly tenants: (input: {
    readonly permission: 'access' | 'impersonate' | 'manage_identity';
    readonly principalId: string;
    readonly tenantIds: readonly string[];
  }) => Effect.Effect<readonly ContextAccessResult[]>;
  readonly legalEntities: (input: {
    readonly legalEntityIds: readonly string[];
    readonly principalId: string;
    readonly tenantId: string;
  }) => Effect.Effect<readonly ContextAccessResult[]>;
  readonly modules: (input: {
    readonly legalEntityId: string;
    readonly moduleIds: readonly string[];
    readonly principalId: string;
    readonly tenantId: string;
  }) => Effect.Effect<readonly ContextAccessResult[]>;
  readonly resources: (input: {
    readonly permission?: 'read' | 'write';
    readonly legalEntityId: string;
    readonly principalId: string;
    readonly resources: readonly ResourceAccessTarget[];
    readonly tenantId: string;
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

const principalReference = (principalId: string) =>
  v1.SubjectReference.create({
    object: v1.ObjectReference.create({ objectId: principalId, objectType: 'principal' }),
  });

const encodeObjectId = (parts: readonly string[]): string | undefined => {
  if (parts.some((part) => part.length === 0)) {
    return undefined;
  }
  const encoded = `ctx_${Buffer.from(JSON.stringify(parts), 'utf-8').toString('base64url')}`;
  return encoded.length <= 1024 ? encoded : undefined;
};

export const toLegalEntityAccessObjectId = (
  tenantId: string,
  legalEntityId: string,
): string | undefined => encodeObjectId([tenantId, legalEntityId]);

export const toModuleAccessObjectId = (
  tenantId: string,
  legalEntityId: string,
  moduleId: string,
): string | undefined => encodeObjectId([tenantId, legalEntityId, moduleId]);

export const toResourceAccessObjectId = (
  tenantId: string,
  legalEntityId: string,
  resource: ResourceAccessTarget,
): string | undefined =>
  encodeObjectId([
    tenantId,
    legalEntityId,
    resource.moduleId,
    resource.resourceType,
    resource.resourceId,
  ]);

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

const makeRequestItem = (item: BatchItem, principalId: string) =>
  v1.CheckBulkPermissionsRequestItem.create({
    permission: item.permission,
    resource: v1.ObjectReference.create({
      objectId: item.resourceId,
      objectType: item.resourceType,
    }),
    subject: principalReference(principalId),
  });

const sameRequest = (
  expected: v1.CheckBulkPermissionsRequestItem,
  actual: v1.CheckBulkPermissionsRequestItem | undefined,
): boolean =>
  actual?.permission === expected.permission &&
  actual.resource?.objectId === expected.resource?.objectId &&
  actual.resource?.objectType === expected.resource?.objectType &&
  actual.subject?.object?.objectId === expected.subject?.object?.objectId &&
  actual.subject?.object?.objectType === expected.subject?.object?.objectType;

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
    return Effect.tryPromise({
      catch: () => null,
      try: () =>
        client.checkBulkPermissions(
          v1.CheckBulkPermissionsRequest.create({
            consistency: fullyConsistent,
            items: requests,
            withTracing: false,
          }),
        ),
    }).pipe(
      Effect.match({
        onFailure: () => unavailable(keys),
        onSuccess: (response) => {
          if (response.pairs.length !== requests.length) {
            return unavailable(keys);
          }
          const seen = new Set<string>();
          const decisions = response.pairs.map((pair, index) => {
            const expected = requests[index];
            const key = keys[index];
            if (
              expected === undefined ||
              key === undefined ||
              !sameRequest(expected, pair.request) ||
              seen.has(key)
            ) {
              return null;
            }
            seen.add(key);
            return { decision: classifyPair(pair), key };
          });
          return decisions.every((decision): decision is ContextAccessResult => decision !== null)
            ? decisions
            : unavailable(keys);
        },
      }),
    );
  };

  const service: ContextAccessService = {
    legalEntities: ({ legalEntityIds, principalId, tenantId }) =>
      checkBatch(
        legalEntityIds.map((legalEntityId) => ({
          key: legalEntityId,
          permission: 'access',
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
    legalEntities: ({ legalEntityIds }) => Effect.succeed(unavailable(legalEntityIds)),
    modules: ({ moduleIds }) => Effect.succeed(unavailable(moduleIds)),
    resources: ({ resources }) =>
      Effect.succeed(
        unavailable(
          resources.map(
            ({ moduleId, resourceId, resourceType }) => `${moduleId}:${resourceType}:${resourceId}`,
          ),
        ),
      ),
    tenants: ({ tenantIds }) => Effect.succeed(unavailable(tenantIds)),
  };
  return Object.freeze(service);
};

export const makeContextAccessLive = (
  clientFactory: ContextAccessClientFactory = createSpiceDbPermissionClient,
  loadConfiguration: () => Effect.Effect<
    SpiceDbConfigValue,
    SpiceDbConfigError
  > = loadSpiceDbConfig,
): Effect.Effect<ContextAccessService, never, Scope.Scope> =>
  Effect.matchEffect(loadConfiguration(), {
    onFailure: () => Effect.succeed(unavailableContextAccess()),
    onSuccess: (configuration) =>
      acquireSpiceDbClientResource(
        () => clientFactory(configuration, SPICEDB_CHECK_TIMEOUT_MS),
        () => null,
      ).pipe(
        Effect.map(makeContextAccess),
        Effect.orElseSucceed(() => unavailableContextAccess()),
      ),
  });

export const ContextAccessLive = Layer.effect(ContextAccess, makeContextAccessLive());
