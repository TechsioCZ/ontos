import assert from 'node:assert/strict';
import test from 'node:test';

import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
import { v1 } from '@authzed/authzed-node';
import { Effect, flow } from 'effect';

import { spiceDbPermissionClientError } from '../../src/permissions/client.ts';
import type { SpiceDbPermissionClient } from '../../src/permissions/client.ts';
import {
  LEGAL_ENTITY_PERMISSION_KEYS,
  TENANT_PERMISSION_KEYS,
  makeContextAccess,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
  toResourceAccessObjectId,
} from '../../src/permissions/context-access.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const principalId = '30000000-0000-4000-8000-000000000001';
const effectTest = <Value, Failure>(
  name: string,
  effect: Effect.Effect<Value, Failure>
): void => {
  test(
    name,
    flow(() => Effect.asVoid(effect), runEffectTestPromise)
  );
};

const responseFor = (
  request: v1.CheckBulkPermissionsRequest,
  permissionships: readonly v1.CheckPermissionResponse_Permissionship[]
) =>
  v1.CheckBulkPermissionsResponse.create({
    pairs: request.items.map((item, index) =>
      v1.CheckBulkPermissionsPair.create({
        request: item,
        response: {
          item: v1.CheckBulkPermissionsResponseItem.create({
            permissionship:
              permissionships[index] ??
              v1.CheckPermissionResponse_Permissionship.UNSPECIFIED,
          }),
          oneofKind: 'item',
        },
      })
    ),
  });

const makeClient = (
  handle: SpiceDbPermissionClient['checkBulkPermissions']
): SpiceDbPermissionClient => ({
  checkBulkPermissions: handle,
  checkPermission: () => Effect.die(new Error('Action check must not run')),
  close: () => {},
});

effectTest(
  'uses one fully consistent batch and correlates allowed and denied module decisions',
  Effect.gen(function* correlatesModuleDecisions() {
    const requests: v1.CheckBulkPermissionsRequest[] = [];
    const access = makeContextAccess(
      makeClient((request) =>
        Effect.sync(() => {
          requests.push(request);
          return responseFor(request, [
            v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION,
            v1.CheckPermissionResponse_Permissionship.NO_PERMISSION,
          ]);
        })
      )
    );

    const result = yield* access.modules({
      legalEntityId,
      moduleIds: ['property.registry', 'billing.core'],
      principalId,
      tenantId,
    });
    assert.deepEqual(result, [
      { decision: 'allowed', key: 'property.registry' },
      { decision: 'denied', key: 'billing.core' },
    ]);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0]?.consistency?.requirement, {
      fullyConsistent: true,
      oneofKind: 'fullyConsistent',
    });
    assert.equal(requests[0]?.items[0]?.resource?.objectType, 'module_access');
    assert.equal(requests[0]?.items[0]?.permission, 'access');
    assert.equal(requests[0]?.items[0]?.subject?.object?.objectId, principalId);
  })
);

effectTest(
  'checks resource writes independently from resource reads',
  Effect.gen(function* checksResourceWrites() {
    const permissions: string[] = [];
    const service = makeContextAccess(
      makeClient((request) =>
        Effect.sync(() => {
          permissions.push(
            ...request.items.map(({ permission }) => permission)
          );
          return responseFor(request, [
            v1.CheckPermissionResponse_Permissionship.NO_PERMISSION,
          ]);
        })
      )
    );
    const target = {
      moduleId: 'property.registry',
      resourceId: 'unit-1',
      resourceType: 'unit',
    };
    const result = yield* service.resources({
      legalEntityId: 'entity-1',
      permission: 'write',
      principalId: 'principal-1',
      resources: [target],
      tenantId: 'tenant-1',
    });
    assert.deepEqual(result, [
      { decision: 'denied', key: 'property.registry:unit:unit-1' },
    ]);
    assert.deepEqual(permissions, ['write']);
  })
);

const makeAllowedPermissionRecorder = () => {
  const observed: string[] = [];
  const service = makeContextAccess(
    makeClient((request) =>
      Effect.sync(() => {
        observed.push(...request.items.map(({ permission }) => permission));
        return responseFor(
          request,
          request.items.map(
            () => v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION
          )
        );
      })
    )
  );
  return { observed, service };
};

effectTest(
  'forwards every closed tenant permission key without widening it',
  Effect.gen(function* forwardsTenantPermissionKeys() {
    const { observed, service } = makeAllowedPermissionRecorder();

    yield* Effect.all(
      TENANT_PERMISSION_KEYS.map((permission) =>
        service
          .tenants({ permission, principalId, tenantIds: [tenantId] })
          .pipe(
            Effect.map((result) =>
              assert.deepEqual(result, [{ decision: 'allowed', key: tenantId }])
            )
          )
      )
    );
    assert.deepEqual(observed, TENANT_PERMISSION_KEYS);
  })
);

effectTest(
  'forwards every closed Legal Entity permission key without widening it',
  Effect.gen(function* forwardsLegalEntityPermissionKeys() {
    const { observed, service } = makeAllowedPermissionRecorder();

    yield* Effect.all(
      LEGAL_ENTITY_PERMISSION_KEYS.map((permission) =>
        service
          .legalEntities({
            legalEntityIds: [legalEntityId],
            permission,
            principalId,
            tenantId,
          })
          .pipe(
            Effect.map((result) =>
              assert.deepEqual(result, [
                { decision: 'allowed', key: legalEntityId },
              ])
            )
          )
      )
    );
    assert.deepEqual(observed, LEGAL_ENTITY_PERMISSION_KEYS);
  })
);

test('creates lossless tenant and legal-entity-qualified object identities', () => {
  const resource = {
    moduleId: 'property.registry',
    resourceId: 'unit:with/slashes',
    resourceType: 'property.unit',
  };
  assert.notEqual(
    toLegalEntityAccessObjectId(tenantId, legalEntityId),
    toLegalEntityAccessObjectId(
      '10000000-0000-4000-8000-000000000002',
      legalEntityId
    )
  );
  assert.notEqual(
    toModuleAccessObjectId(tenantId, legalEntityId, 'property.registry'),
    toModuleAccessObjectId(tenantId, legalEntityId, 'property-registry')
  );
  assert.notEqual(
    toResourceAccessObjectId(tenantId, legalEntityId, resource),
    toResourceAccessObjectId(tenantId, legalEntityId, {
      ...resource,
      resourceId: 'unit-with/slashes',
    })
  );
});

effectTest(
  'supports empty batches and exact resource filtering',
  Effect.gen(function* supportsEmptyBatches() {
    let requests = 0;
    const access = makeContextAccess(
      makeClient((request) =>
        Effect.sync(() => {
          requests += 1;
          return responseFor(request, [
            v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION,
            v1.CheckPermissionResponse_Permissionship.NO_PERMISSION,
          ]);
        })
      )
    );
    assert.deepEqual(
      yield* access.legalEntities({
        legalEntityIds: [],
        principalId,
        tenantId,
      }),
      []
    );
    assert.deepEqual(
      yield* access.resources({
        legalEntityId,
        principalId,
        resources: [
          {
            moduleId: 'property.registry',
            resourceId: 'unit-1',
            resourceType: 'property.unit',
          },
          {
            moduleId: 'property.registry',
            resourceId: 'unit-2',
            resourceType: 'property.unit',
          },
        ],
        tenantId,
      }),
      [
        { decision: 'allowed', key: 'property.registry:property.unit:unit-1' },
        { decision: 'denied', key: 'property.registry:property.unit:unit-2' },
      ]
    );
    assert.equal(requests, 1);
  })
);

effectTest(
  'classifies client, partial, duplicate, malformed, and conditional results as unavailable',
  Effect.gen(function* classifiesUnavailableResults() {
    const input = { legalEntityIds: [legalEntityId], principalId, tenantId };
    const failures = [
      makeClient(() =>
        Effect.fail(
          spiceDbPermissionClientError(new Error('secret SpiceDB diagnostic'))
        )
      ),
      makeClient(() =>
        Effect.succeed(v1.CheckBulkPermissionsResponse.create({ pairs: [] }))
      ),
      makeClient((request) =>
        Effect.succeed(
          responseFor(request, [
            v1.CheckPermissionResponse_Permissionship.CONDITIONAL_PERMISSION,
          ])
        )
      ),
      makeClient((request) =>
        Effect.sync(() => {
          const response = responseFor(request, [
            v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION,
          ]);
          const [pair] = response.pairs;
          return v1.CheckBulkPermissionsResponse.create({
            pairs: pair === undefined ? [] : [{ response: pair.response }],
          });
        })
      ),
    ];
    const [failingClient] = failures;
    assert.ok(failingClient);
    yield* Effect.forEach(
      failures,
      (client) =>
        makeContextAccess(client)
          .legalEntities(input)
          .pipe(
            Effect.map((result) =>
              assert.deepEqual(result, [
                { decision: 'unavailable', key: legalEntityId },
              ])
            )
          ),
      { concurrency: 1 }
    );
    assert.deepEqual(
      yield* makeContextAccess(failingClient).legalEntities({
        ...input,
        legalEntityIds: [legalEntityId, legalEntityId],
      }),
      [
        { decision: 'unavailable', key: legalEntityId },
        { decision: 'unavailable', key: legalEntityId },
      ]
    );
  })
);
