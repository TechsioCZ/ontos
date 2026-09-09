import { v1 } from '@authzed/authzed-node';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ActionPermissionCheckError } from '../../src/actions/errors.ts';
import type { SpiceDbPermissionClientError } from '../../src/permissions/client.ts';
import { spiceDbPermissionClientError } from '../../src/permissions/client.ts';
import { SpiceDbConfigError } from '../../src/permissions/config-error.ts';
import { SPICEDB_ROOT_ENV_PATH, loadSpiceDbConfig, parseSpiceDbConfig } from '../../src/permissions/config.ts';
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
  Effect.succeed(v1.CheckPermissionResponse.create({ permissionship }));

const makeClient = (
  responses: readonly Effect.Effect<v1.CheckPermissionResponse, SpiceDbPermissionClientError>[],
  requests: v1.CheckPermissionRequest[] = [],
): PermissionCheckClient => {
  let index = 0;
  return {
    checkPermission: (request) =>
      Effect.suspend(() => {
        requests.push(request);
        const result = responses[index];
        index += 1;
        return result ?? Effect.fail(spiceDbPermissionClientError());
      }),
    close: () => {},
  };
};

it.effect('loads the root SpiceDB environment independently of the invocation directory', () =>
  Effect.gen(function* loadsTheRootSpiceDBEnvironmentIndependentlyOfThe() {
    const originalDirectory = process.cwd();
    const rootExamplePath = SPICEDB_ROOT_ENV_PATH.replace(/\.env$/u, '.env.example');

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        process.chdir(originalDirectory);
      }),
    );
    process.chdir('/');
    const configuration = yield* loadSpiceDbConfig({
      environment: {},
      envPath: rootExamplePath,
    });

    expect(SPICEDB_ROOT_ENV_PATH.endsWith('/app/.env')).toBe(true);
    expect(configuration).toEqual({
      endpoint: 'localhost:50051',
      insecureLocal: true,
      preSharedKey: 'ontos-local-development-key',
    });
  }),
);

it.effect('requires complete configuration and explicit secure or localhost-insecure transport', () =>
  Effect.gen(function* requiresCompleteConfigurationAndExplicitSecureOrLocalhostinsecure() {
    const validSecure = yield* parseSpiceDbConfig({
      SPICEDB_ENDPOINT: 'spicedb.internal.example:443',
      SPICEDB_INSECURE: 'false',
      SPICEDB_PRESHARED_KEY: 'test-key',
    });
    const failures = yield* Effect.forEach(
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
      ],
      (environment) => Effect.flip(parseSpiceDbConfig(environment)),
    );

    expect(validSecure).toEqual({
      endpoint: 'spicedb.internal.example:443',
      insecureLocal: false,
      preSharedKey: 'test-key',
    });
    expect(failures.every(Schema.is(SpiceDbConfigError))).toBe(true);
    expect(failures.some((failure) => failure.reason.includes('test-key'))).toBe(false);
  }),
);

it.effect('allows insecure transport only for the exact Zerops stage private endpoint', () =>
  Effect.gen(function* allowsInsecureTransportOnlyForTheExactZerops() {
    const stage = yield* parseSpiceDbConfig({
      SPICEDB_ENDPOINT: 'spicedb:50051',
      SPICEDB_INSECURE: 'true',
      SPICEDB_PRESHARED_KEY: 'test-key',
      ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
    });
    const rejected = yield* Effect.forEach(
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
      ],
      (environment) => Effect.flip(parseSpiceDbConfig(environment)),
    );

    expect(stage).toEqual({
      deploymentEnvironment: 'stage',
      endpoint: 'spicedb:50051',
      insecureLocal: true,
      preSharedKey: 'test-key',
    });
    expect(rejected.every(Schema.is(SpiceDbConfigError))).toBe(true);
  }),
);

it.effect('losslessly maps Action keys and exact principal identities using fully consistent requests', () =>
  Effect.gen(function* losslesslyMapsActionKeysAndExactPrincipalIdentities() {
    const requests: v1.CheckPermissionRequest[] = [];
    const service = makeActionPermissionService(
      makeClient([response(v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION)], requests),
    );

    const decision = yield* service.checkActionPermission(input);

    expect(decision).toBe('allowed');
    expect(requests.length).toBe(1);
    expect(requests[0]?.resource).toEqual({
      objectId: toSpiceDbActionObjectId(input.actionKey),
      objectType: SPICEDB_ACTION_OBJECT_TYPE,
    });
    expect(toSpiceDbActionObjectId(input.actionKey)).toBe('ak_aW52ZW50b3J5LnN0b2NrLnJlc2VydmU');
    expect(toSpiceDbActionObjectId('inventory.stock.reserve')).not.toBe(
      toSpiceDbActionObjectId('inventory-stock-reserve'),
    );
    expect(requests[0]?.subject?.object).toEqual({
      objectId: input.principalId,
      objectType: SPICEDB_PRINCIPAL_OBJECT_TYPE,
    });
    expect(requests[0]?.permission).toBe(SPICEDB_EXECUTE_PERMISSION);
    for (const request of requests) {
      expect(request.consistency?.requirement).toEqual({
        fullyConsistent: true,
        oneofKind: 'fullyConsistent',
      });
    }
  }),
);

it.effect('classifies fully consistent execute permission as allowed or denied with one check', () =>
  Effect.gen(function* classifiesFullyConsistentExecutePermissionAsAllowedOr() {
    const deniedRequests: v1.CheckPermissionRequest[] = [];
    const allowed = makeActionPermissionService(
      makeClient([response(v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION)]),
    );
    const denied = makeActionPermissionService(
      makeClient([response(v1.CheckPermissionResponse_Permissionship.NO_PERMISSION)], deniedRequests),
    );

    expect(yield* allowed.checkActionPermission(input)).toBe('allowed');
    expect(yield* denied.checkActionPermission(input)).toBe('denied');
    expect(deniedRequests.length).toBe(1);
  }),
);

it.effect('report-only compatibility distinguishes missing policy from an explicit restriction', () =>
  Effect.gen(function* reportonlyCompatibilityDistinguishesMissingPolicyFromAnExplicit() {
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
      {
        emit: (event) => {
          events.push(event);
        },
        nowEpochMs: () => nowEpochMs,
        rollout,
      },
    );
    expect(yield* missing.checkActionPermission(input)).toBe('allowed');
    expect(missingRequests.map(({ permission }) => permission)).toEqual([
      SPICEDB_EXECUTE_PERMISSION,
      SPICEDB_RESTRICTION_PERMISSION,
    ]);
    expect(events.length).toBe(1);

    const restricted = makeActionPermissionService(
      makeClient([
        response(v1.CheckPermissionResponse_Permissionship.NO_PERMISSION),
        response(v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION),
      ]),
      {
        emit: () => expect.unreachable(),
        nowEpochMs: () => nowEpochMs,
        rollout,
      },
    );
    expect(yield* restricted.checkActionPermission(input)).toBe('denied');
  }),
);

it.effect('fails closed for conditional, unspecified, malformed, and client failures', () =>
  Effect.gen(function* failsClosedForConditionalUnspecifiedMalformedAndClient() {
    const failures = yield* Effect.forEach(
      [
        makeClient([response(v1.CheckPermissionResponse_Permissionship.CONDITIONAL_PERMISSION)]),
        makeClient([response(v1.CheckPermissionResponse_Permissionship.UNSPECIFIED)]),
        makeClient([Effect.fail(spiceDbPermissionClientError())]),
        makeClient([
          Effect.fail(
            spiceDbPermissionClientError(new Error('ontos-local-development-key unavailable at internal host')),
          ),
        ]),
      ],
      (client) => Effect.flip(makeActionPermissionService(client).checkActionPermission(input)),
    );

    for (const failure of failures) {
      expect(Schema.is(ActionPermissionCheckError)(failure)).toBe(true);
      expect(failure.code).toBe('action_permission_check_failed');
      expect(failure.reason.includes('ontos-local-development-key')).toBe(false);
      expect(failure.reason.includes('internal host')).toBe(false);
    }
  }),
);

it.effect('constructs the live client with a bounded deadline and finalizes it with the scope', () =>
  Effect.gen(function* constructsTheLiveClientWithABoundedDeadline() {
    let finalized = false;
    let observedTimeout = 0;
    const configuration = {
      endpoint: 'localhost:50051',
      insecureLocal: true,
      preSharedKey: 'test-key',
    } as const;

    yield* Effect.scoped(
      makeActionPermissionLive(
        (_configuration, timeoutMilliseconds) => {
          observedTimeout = timeoutMilliseconds;
          return {
            checkPermission: () => response(v1.CheckPermissionResponse_Permissionship.NO_PERMISSION),
            close: () => {
              finalized = true;
            },
          };
        },
        () => Effect.succeed(configuration),
      ).pipe(Effect.flatMap((service) => service.checkActionPermission(input))),
    );

    expect(observedTimeout).toBe(SPICEDB_CHECK_TIMEOUT_MS);
    expect(finalized).toBe(true);
  }),
);

it.effect('turns missing live configuration into a fail-closed permission service', () =>
  Effect.gen(function* turnsMissingLiveConfigurationIntoAFailclosedPermission() {
    const failure = yield* Effect.scoped(
      makeActionPermissionLive(
        () => {
          throw new Error('the client must not be constructed');
        },
        () => parseSpiceDbConfig({}),
      ).pipe(
        Effect.flatMap((service) => service.checkActionPermission(input)),
        Effect.flip,
      ),
    );

    expect(Schema.is(ActionPermissionCheckError)(failure)).toBe(true);
    expect(failure.code).toBe('action_permission_check_failed');
  }),
);

it.effect('finalizes an acquired client even when its scoped use fails', () =>
  Effect.gen(function* finalizesAnAcquiredClientEvenWhenItsScoped() {
    let finalized = false;
    const failure = yield* Effect.flip(
      Effect.scoped(
        acquirePermissionClientResource(() => ({
          checkPermission: () => Effect.fail(spiceDbPermissionClientError(new Error('unavailable'))),
          close: () => {
            finalized = true;
          },
        })).pipe(Effect.flatMap(() => Effect.fail('test-failure'))),
      ),
    );

    expect(failure).toBe('test-failure');
    expect(finalized).toBe(true);
  }),
);
