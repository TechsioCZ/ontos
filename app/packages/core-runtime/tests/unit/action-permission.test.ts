// @effect-diagnostics asyncFunction:off missingEffectError:off
import assert from 'node:assert/strict';
import test from 'node:test';
import { v1 } from '@authzed/authzed-node';
import { Effect } from 'effect';
import {
  SPICEDB_ROOT_ENV_PATH,
  loadSpiceDbConfig,
  parseSpiceDbConfig,
} from '../../src/permissions/config.ts';
import {
  SPICEDB_ACTION_OBJECT_TYPE,
  SPICEDB_CHECK_TIMEOUT_MS,
  SPICEDB_EXECUTE_PERMISSION,
  SPICEDB_PRINCIPAL_OBJECT_TYPE,
  SPICEDB_RESTRICTION_PERMISSION,
  acquirePermissionClientResource,
  makeActionPermissionLive,
  makeActionPermissionService,
  toSpiceDbActionObjectId,
} from '../../src/permissions/service.ts';
import type { PermissionCheckClient } from '../../src/permissions/service.ts';

const input = {
  actionKey: 'inventory.stock.reserve',
  correlationId: 'correlation-permission-test',
  principalId: '00000000-0000-4000-8000-000000000003',
} as const;

const response = (permissionship: v1.CheckPermissionResponse_Permissionship) =>
  v1.CheckPermissionResponse.create({ permissionship });

const makeClient = (
  responses: readonly (v1.CheckPermissionResponse | Error | undefined)[],
  requests: v1.CheckPermissionRequest[] = [],
): PermissionCheckClient => {
  let index = 0;
  return {
    checkPermission: (request) => {
      requests.push(request);
      const result = responses[index];
      index += 1;
      if (result instanceof Error) {
        return Promise.reject(result);
      }
      return Promise.resolve(result);
    },
    close: () => {},
  };
};

test('loads the root SpiceDB environment independently of the invocation directory', async () => {
  const originalDirectory = process.cwd();
  const rootExamplePath = SPICEDB_ROOT_ENV_PATH.replace(/\.env$/u, '.env.example');

  try {
    process.chdir('/');
    const configuration = await Effect.runPromise(
      loadSpiceDbConfig({ envPath: rootExamplePath, environment: {} }),
    );

    assert.equal(SPICEDB_ROOT_ENV_PATH.endsWith('/app/.env'), true);
    assert.deepEqual(configuration, {
      endpoint: 'localhost:50051',
      insecureLocal: true,
      preSharedKey: 'ontos-local-development-key',
    });
  } finally {
    process.chdir(originalDirectory);
  }
});

test('requires complete configuration and explicit secure or localhost-insecure transport', async () => {
  const validSecure = await Effect.runPromise(
    parseSpiceDbConfig({
      SPICEDB_ENDPOINT: 'spicedb.internal.example:443',
      SPICEDB_INSECURE: 'false',
      SPICEDB_PRESHARED_KEY: 'test-key',
    }),
  );
  const failures = await Promise.all(
    [
      {},
      {
        SPICEDB_ENDPOINT: 'localhost:50051',
        SPICEDB_PRESHARED_KEY: 'test-key',
      },
      {
        SPICEDB_ENDPOINT: 'spicedb.internal.example:50051',
        SPICEDB_INSECURE: 'true',
        SPICEDB_PRESHARED_KEY: 'test-key',
      },
      {
        SPICEDB_ENDPOINT: 'https://spicedb.internal.example/path',
        SPICEDB_INSECURE: 'false',
        SPICEDB_PRESHARED_KEY: 'test-key',
      },
      {
        SPICEDB_ENDPOINT: 'spicedb.internal.example:443?credential=test-key',
        SPICEDB_INSECURE: 'false',
        SPICEDB_PRESHARED_KEY: 'test-key',
      },
      {
        SPICEDB_ENDPOINT: 'localhost:50051#fragment',
        SPICEDB_INSECURE: 'true',
        SPICEDB_PRESHARED_KEY: 'test-key',
      },
      {
        SPICEDB_ENDPOINT: 'localhost:50051',
        SPICEDB_INSECURE: 'true',
        SPICEDB_PRESHARED_KEY: '   ',
      },
    ].map((environment) => Effect.runPromise(Effect.flip(parseSpiceDbConfig(environment)))),
  );

  assert.deepEqual(validSecure, {
    endpoint: 'spicedb.internal.example:443',
    insecureLocal: false,
    preSharedKey: 'test-key',
  });
  assert.deepEqual(
    failures.map((failure) => failure._tag),
    failures.map(() => 'SpiceDbConfigError'),
  );
  assert.equal(
    failures.some((failure) => failure.reason.includes('test-key')),
    false,
  );
});

test('allows insecure transport only for the exact Zerops stage private endpoint', async () => {
  const stage = await Effect.runPromise(
    parseSpiceDbConfig({
      SPICEDB_ENDPOINT: 'spicedb:50051',
      SPICEDB_INSECURE: 'true',
      SPICEDB_PRESHARED_KEY: 'test-key',
      ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
    }),
  );
  const rejected = await Promise.all(
    [
      {
        SPICEDB_ENDPOINT: 'spicedb:50051',
        SPICEDB_INSECURE: 'true',
        SPICEDB_PRESHARED_KEY: 'test-key',
      },
      {
        SPICEDB_ENDPOINT: 'spicedb:50052',
        SPICEDB_INSECURE: 'true',
        SPICEDB_PRESHARED_KEY: 'test-key',
        ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
      },
      {
        SPICEDB_ENDPOINT: 'spicedb:50051',
        SPICEDB_INSECURE: 'true',
        SPICEDB_PRESHARED_KEY: 'test-key',
        ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'production',
      },
    ].map((environment) => Effect.runPromise(Effect.flip(parseSpiceDbConfig(environment)))),
  );

  assert.deepEqual(stage, {
    deploymentEnvironment: 'stage',
    endpoint: 'spicedb:50051',
    insecureLocal: true,
    preSharedKey: 'test-key',
  });
  assert.deepEqual(
    rejected.map((failure) => failure._tag),
    ['SpiceDbConfigError', 'SpiceDbConfigError', 'SpiceDbConfigError'],
  );
});

test('losslessly maps Action keys and exact principal identities using fully consistent requests', async () => {
  const requests: v1.CheckPermissionRequest[] = [];
  const service = makeActionPermissionService(
    makeClient([response(v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION)], requests),
  );

  const decision = await Effect.runPromise(service.checkActionPermission(input));

  assert.equal(decision, 'allowed');
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0]?.resource, {
    objectId: toSpiceDbActionObjectId(input.actionKey),
    objectType: SPICEDB_ACTION_OBJECT_TYPE,
  });
  assert.equal(toSpiceDbActionObjectId(input.actionKey), 'ak_aW52ZW50b3J5LnN0b2NrLnJlc2VydmU');
  assert.notEqual(
    toSpiceDbActionObjectId('inventory.stock.reserve'),
    toSpiceDbActionObjectId('inventory-stock-reserve'),
  );
  assert.deepEqual(requests[0]?.subject?.object, {
    objectId: input.principalId,
    objectType: SPICEDB_PRINCIPAL_OBJECT_TYPE,
  });
  assert.equal(requests[0]?.permission, SPICEDB_EXECUTE_PERMISSION);
  for (const request of requests) {
    assert.deepEqual(request.consistency?.requirement, {
      fullyConsistent: true,
      oneofKind: 'fullyConsistent',
    });
  }
});

test('classifies fully consistent execute permission as allowed or denied with one check', async () => {
  const deniedRequests: v1.CheckPermissionRequest[] = [];
  const allowed = makeActionPermissionService(
    makeClient([response(v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION)]),
  );
  const denied = makeActionPermissionService(
    makeClient([response(v1.CheckPermissionResponse_Permissionship.NO_PERMISSION)], deniedRequests),
  );

  assert.equal(await Effect.runPromise(allowed.checkActionPermission(input)), 'allowed');
  assert.equal(await Effect.runPromise(denied.checkActionPermission(input)), 'denied');
  assert.equal(deniedRequests.length, 1);
});

test('report-only compatibility distinguishes missing policy from an explicit restriction', async () => {
  const nowEpochMs = Date.parse('2026-09-10T00:00:00.000Z');
  const events: unknown[] = [];
  const rollout = {
    activatedAtEpochMs: nowEpochMs - 1000,
    compatibilityEntrypoints: new Set([input.actionKey]),
    expiresAtEpochMs: nowEpochMs + 1000,
    inventoryHash: 'inventory',
    mode: 'report_only' as const,
    sourceRevision: 'revision',
  };
  const missingRequests: v1.CheckPermissionRequest[] = [];
  const missing = makeActionPermissionService(
    makeClient(
      [
        response(v1.CheckPermissionResponse_Permissionship.NO_PERMISSION),
        response(v1.CheckPermissionResponse_Permissionship.NO_PERMISSION),
      ],
      missingRequests,
    ),
    { emit: (event) => events.push(event), nowEpochMs: () => nowEpochMs, rollout },
  );
  assert.equal(await Effect.runPromise(missing.checkActionPermission(input)), 'allowed');
  assert.deepEqual(
    missingRequests.map(({ permission }) => permission),
    [SPICEDB_EXECUTE_PERMISSION, SPICEDB_RESTRICTION_PERMISSION],
  );
  assert.equal(events.length, 1);

  const restricted = makeActionPermissionService(
    makeClient([
      response(v1.CheckPermissionResponse_Permissionship.NO_PERMISSION),
      response(v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION),
    ]),
    { emit: () => assert.fail(), nowEpochMs: () => nowEpochMs, rollout },
  );
  assert.equal(await Effect.runPromise(restricted.checkActionPermission(input)), 'denied');
});

test('fails closed for conditional, unspecified, malformed, and client failures', async () => {
  const failures = await Promise.all(
    [
      makeClient([response(v1.CheckPermissionResponse_Permissionship.CONDITIONAL_PERMISSION)]),
      makeClient([response(v1.CheckPermissionResponse_Permissionship.UNSPECIFIED)]),
      makeClient([undefined]),
      makeClient([new Error('ontos-local-development-key unavailable at internal host')]),
    ].map((client) =>
      Effect.runPromise(
        Effect.flip(makeActionPermissionService(client).checkActionPermission(input)),
      ),
    ),
  );

  for (const failure of failures) {
    assert.equal(failure._tag, 'ActionPermissionCheckError');
    assert.equal(failure.code, 'action_permission_check_failed');
    assert.equal(failure.reason.includes('ontos-local-development-key'), false);
    assert.equal(failure.reason.includes('internal host'), false);
  }
});

test('constructs the live client with a bounded deadline and finalizes it with the scope', async () => {
  let finalized = false;
  let observedTimeout = 0;
  const configuration = {
    endpoint: 'localhost:50051',
    insecureLocal: true,
    preSharedKey: 'test-key',
  } as const;

  await Effect.runPromise(
    Effect.scoped(
      makeActionPermissionLive(
        (_configuration, timeoutMilliseconds) => {
          observedTimeout = timeoutMilliseconds;
          return {
            checkPermission: () =>
              Promise.resolve(response(v1.CheckPermissionResponse_Permissionship.NO_PERMISSION)),
            close: () => {
              finalized = true;
            },
          };
        },
        () => Effect.succeed(configuration),
      ).pipe(Effect.flatMap((service) => service.checkActionPermission(input))),
    ),
  );

  assert.equal(observedTimeout, SPICEDB_CHECK_TIMEOUT_MS);
  assert.equal(finalized, true);
});

test('turns missing live configuration into a fail-closed permission service', async () => {
  const failure = await Effect.runPromise(
    Effect.scoped(
      makeActionPermissionLive(
        () => {
          throw new Error('the client must not be constructed');
        },
        () => parseSpiceDbConfig({}),
      ).pipe(
        Effect.flatMap((service) => service.checkActionPermission(input)),
        Effect.flip,
      ),
    ),
  );

  assert.equal(failure._tag, 'ActionPermissionCheckError');
  assert.equal(failure.code, 'action_permission_check_failed');
});

test('finalizes an acquired client even when its scoped use fails', async () => {
  let finalized = false;
  const failure = await Effect.runPromise(
    Effect.flip(
      Effect.scoped(
        acquirePermissionClientResource(() => ({
          checkPermission: () => Promise.reject(new Error('unavailable')),
          close: () => {
            finalized = true;
          },
        })).pipe(Effect.flatMap(() => Effect.fail('test-failure'))),
      ),
    ),
  );

  assert.equal(failure, 'test-failure');
  assert.equal(finalized, true);
});
