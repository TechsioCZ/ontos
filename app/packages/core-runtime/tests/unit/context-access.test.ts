/* oxlint-disable typescript/return-await, unicorn/no-useless-promise-resolve-reject */
/* eslint-disable no-await-in-loop, typescript/no-non-null-assertion -- Sequential scoped-client cases verify finalization independently. */
import assert from 'node:assert/strict';
// @effect-diagnostics asyncFunction:off
import test from 'node:test';
import { v1 } from '@authzed/authzed-node';
import { Effect } from 'effect';
import {
  LEGAL_ENTITY_PERMISSION_KEYS,
  TENANT_PERMISSION_KEYS,
  makeContextAccess,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
  toResourceAccessObjectId,
} from '../../src/permissions/context-access.ts';
import type { SpiceDbPermissionClient } from '../../src/permissions/client.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const principalId = '30000000-0000-4000-8000-000000000001';

const responseFor = (
  request: v1.CheckBulkPermissionsRequest,
  permissionships: readonly v1.CheckPermissionResponse_Permissionship[],
) =>
  v1.CheckBulkPermissionsResponse.create({
    pairs: request.items.map((item, index) =>
      v1.CheckBulkPermissionsPair.create({
        request: item,
        response: {
          item: v1.CheckBulkPermissionsResponseItem.create({
            permissionship:
              permissionships[index] ?? v1.CheckPermissionResponse_Permissionship.UNSPECIFIED,
          }),
          oneofKind: 'item',
        },
      }),
    ),
  });

const makeClient = (
  handle: (request: v1.CheckBulkPermissionsRequest) => Promise<v1.CheckBulkPermissionsResponse>,
): SpiceDbPermissionClient => ({
  checkBulkPermissions: handle,
  checkPermission: async () => {
    throw new Error('Action check must not run');
  },
  close: () => {},
});

void test('uses one fully consistent batch and correlates allowed and denied module decisions', async () => {
  const requests: v1.CheckBulkPermissionsRequest[] = [];
  const access = makeContextAccess(
    makeClient(async (request) => {
      requests.push(request);
      return responseFor(request, [
        v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION,
        v1.CheckPermissionResponse_Permissionship.NO_PERMISSION,
      ]);
    }),
  );

  assert.deepEqual(
    await Effect.runPromise(
      access.modules({
        legalEntityId,
        moduleIds: ['property.registry', 'billing.core'],
        principalId,
        tenantId,
      }),
    ),
    [
      { decision: 'allowed', key: 'property.registry' },
      { decision: 'denied', key: 'billing.core' },
    ],
  );
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0]?.consistency?.requirement, {
    fullyConsistent: true,
    oneofKind: 'fullyConsistent',
  });
  assert.equal(requests[0]?.items[0]?.resource?.objectType, 'module_access');
  assert.equal(requests[0]?.items[0]?.permission, 'access');
  assert.equal(requests[0]?.items[0]?.subject?.object?.objectId, principalId);
});

void test('checks resource writes independently from resource reads', async () => {
  const permissions: string[] = [];
  const service = makeContextAccess(
    makeClient(async (request) => {
      permissions.push(...request.items.map(({ permission }) => permission));
      return responseFor(request, [v1.CheckPermissionResponse_Permissionship.NO_PERMISSION]);
    }),
  );
  const target = { moduleId: 'property.registry', resourceId: 'unit-1', resourceType: 'unit' };
  assert.deepEqual(
    await Effect.runPromise(
      service.resources({
        legalEntityId: 'entity-1',
        permission: 'write',
        principalId: 'principal-1',
        resources: [target],
        tenantId: 'tenant-1',
      }),
    ),
    [{ decision: 'denied', key: 'property.registry:unit:unit-1' }],
  );
  assert.deepEqual(permissions, ['write']);
});

test('forwards every closed tenant permission key without widening it', async () => {
  const observed: string[] = [];
  const service = makeContextAccess(
    makeClient(async (request) => {
      observed.push(...request.items.map(({ permission }) => permission));
      return Promise.resolve(
        responseFor(
          request,
          request.items.map(() => v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION),
        ),
      );
    }),
  );

  for (const permission of TENANT_PERMISSION_KEYS) {
    assert.deepEqual(
      await Effect.runPromise(service.tenants({ permission, principalId, tenantIds: [tenantId] })),
      [{ decision: 'allowed', key: tenantId }],
    );
  }
  assert.deepEqual(observed, TENANT_PERMISSION_KEYS);
});

test('forwards every closed Legal Entity permission key without widening it', async () => {
  const observed: string[] = [];
  const service = makeContextAccess(
    makeClient(async (request) => {
      observed.push(...request.items.map(({ permission }) => permission));
      return Promise.resolve(
        responseFor(
          request,
          request.items.map(() => v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION),
        ),
      );
    }),
  );

  for (const permission of LEGAL_ENTITY_PERMISSION_KEYS) {
    assert.deepEqual(
      await Effect.runPromise(
        service.legalEntities({
          legalEntityIds: [legalEntityId],
          permission,
          principalId,
          tenantId,
        }),
      ),
      [{ decision: 'allowed', key: legalEntityId }],
    );
  }
  assert.deepEqual(observed, LEGAL_ENTITY_PERMISSION_KEYS);
});

test('creates lossless tenant and legal-entity-qualified object identities', () => {
  const resource = {
    moduleId: 'property.registry',
    resourceId: 'unit:with/slashes',
    resourceType: 'property.unit',
  };
  assert.notEqual(
    toLegalEntityAccessObjectId(tenantId, legalEntityId),
    toLegalEntityAccessObjectId('10000000-0000-4000-8000-000000000002', legalEntityId),
  );
  assert.notEqual(
    toModuleAccessObjectId(tenantId, legalEntityId, 'property.registry'),
    toModuleAccessObjectId(tenantId, legalEntityId, 'property-registry'),
  );
  assert.notEqual(
    toResourceAccessObjectId(tenantId, legalEntityId, resource),
    toResourceAccessObjectId(tenantId, legalEntityId, {
      ...resource,
      resourceId: 'unit-with/slashes',
    }),
  );
});

void test('supports empty batches and exact resource filtering', async () => {
  let requests = 0;
  const access = makeContextAccess(
    makeClient(async (request) => {
      requests += 1;
      return responseFor(request, [
        v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION,
        v1.CheckPermissionResponse_Permissionship.NO_PERMISSION,
      ]);
    }),
  );
  assert.deepEqual(
    await Effect.runPromise(access.legalEntities({ legalEntityIds: [], principalId, tenantId })),
    [],
  );
  assert.deepEqual(
    await Effect.runPromise(
      access.resources({
        legalEntityId,
        principalId,
        resources: [
          { moduleId: 'property.registry', resourceId: 'unit-1', resourceType: 'property.unit' },
          { moduleId: 'property.registry', resourceId: 'unit-2', resourceType: 'property.unit' },
        ],
        tenantId,
      }),
    ),
    [
      { decision: 'allowed', key: 'property.registry:property.unit:unit-1' },
      { decision: 'denied', key: 'property.registry:property.unit:unit-2' },
    ],
  );
  assert.equal(requests, 1);
});

void test('classifies client, partial, duplicate, malformed, and conditional results as unavailable', async () => {
  const input = { legalEntityIds: [legalEntityId], principalId, tenantId };
  const failures = [
    makeClient(async () => {
      throw new Error('secret SpiceDB diagnostic');
    }),
    makeClient(async () => v1.CheckBulkPermissionsResponse.create({ pairs: [] })),
    makeClient(async (request) =>
      responseFor(request, [v1.CheckPermissionResponse_Permissionship.CONDITIONAL_PERMISSION]),
    ),
    makeClient(async (request) => {
      const response = responseFor(request, [
        v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION,
      ]);
      const [pair] = response.pairs;
      return v1.CheckBulkPermissionsResponse.create({
        pairs: pair === undefined ? [] : [{ response: pair.response }],
      });
    }),
  ];
  for (const client of failures) {
    assert.deepEqual(await Effect.runPromise(makeContextAccess(client).legalEntities(input)), [
      { decision: 'unavailable', key: legalEntityId },
    ]);
  }
  assert.deepEqual(
    await Effect.runPromise(
      makeContextAccess(failures[0]!).legalEntities({
        ...input,
        legalEntityIds: [legalEntityId, legalEntityId],
      }),
    ),
    [
      { decision: 'unavailable', key: legalEntityId },
      { decision: 'unavailable', key: legalEntityId },
    ],
  );
});
