import { APP_ENV_PATH, APP_WORKSPACE_ROOT } from '@app/core-runtime/workspace-environment';
import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import { Config, ConfigProvider, Effect, FileSystem, Path, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ActionPermissionCheckError } from '../../src/actions/errors.ts';
import type { SpiceDbPermissionClient, SpiceDbPermissionClientError } from '../../src/permissions/client.ts';
import { spiceDbPermissionClientError } from '../../src/permissions/client.ts';
import { SPICEDB_ROOT_ENV_PATH, loadSpiceDbConfig, parseSpiceDbConfig } from '../../src/permissions/config.ts';
import {
  SPICEDB_ACTION_OBJECT_TYPE,
  SPICEDB_CHECK_TIMEOUT_MS,
  SPICEDB_EXECUTE_PERMISSION,
  SPICEDB_PRINCIPAL_OBJECT_TYPE,
  SPICEDB_PROPOSE_PERMISSION,
  acquirePermissionClientResource,
  makeActionPermissionLive,
  makeActionPermissionService,
  toSpiceDbActionObjectId,
} from '../../src/permissions/service.ts';
import { makeActionAuthorityService } from '../../src/permissions/action-authority.ts';
import { SPICEDB_TEST_CERTIFICATE } from '../support/spicedb-test-certificate.ts';

const input = {
  actionKey: 'inventory.stock.reserve',
  correlationId: 'correlation-permission-test',
  legalEntityId: '00000000-0000-4000-8000-000000000002',
  principalId: '00000000-0000-4000-8000-000000000003',
  tenantId: '00000000-0000-4000-8000-000000000001',
} as const;

const response = (permissionship: v1.CheckPermissionResponse_Permissionship) =>
  Effect.succeed(v1.CheckPermissionResponse.create({ permissionship }));

const makeClient = (
  responses: readonly Effect.Effect<v1.CheckPermissionResponse, SpiceDbPermissionClientError>[],
  requests: v1.CheckPermissionRequest[] = [],
): SpiceDbPermissionClient => {
  let index = 0;
  return {
    checkBulkPermissions: () => Effect.die('Unexpected bulk permission request'),
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

it.layer(NodeServices.layer)((suite) => {
  suite.effect('loads the root SpiceDB environment independently of the invocation directory', () =>
    Effect.scoped(
      Effect.gen(function* loadsTheRootSpiceDBEnvironmentIndependentlyOfThe() {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const configuredEnvPath = yield* Config.String('APP_ENV_PATH')
          .pipe(Config.withDefault('.env'))
          .parse(ConfigProvider.fromEnv());
        const originalDirectory = process.cwd();
        const fixtureDirectory = yield* fileSystem.makeTempDirectoryScoped({ prefix: 'ontos-spicedb-config-' });
        const fixturePath = path.join(fixtureDirectory, 'spicedb-config.fixture');
        yield* fileSystem.writeFileString(
          fixturePath,
          'SPICEDB_ENDPOINT=localhost:50051\nSPICEDB_PRESHARED_KEY=spicedb-config-test-key\n',
        );

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            process.chdir(originalDirectory);
          }),
        );
        process.chdir('/');
        const configuration = yield* loadSpiceDbConfig({
          environment: {},
          envPath: fixturePath,
        });

        expect(SPICEDB_ROOT_ENV_PATH).toBe(APP_ENV_PATH);
        expect(APP_ENV_PATH).toBe(path.resolve(APP_WORKSPACE_ROOT, configuredEnvPath));
        expect(configuration).toEqual({
          endpoint: 'localhost:50051',
          preSharedKey: 'spicedb-config-test-key',
        });
      }),
    ),
  );
});

it.effect('requires a complete configuration and accepts only a PEM certificate as SPICEDB_CA_CERT', () =>
  Effect.gen(function* requiresACompleteConfigurationAndAPemCaCertificate() {
    const valid = yield* parseSpiceDbConfig({
      SPICEDB_CA_CERT: `\n${SPICEDB_TEST_CERTIFICATE}\n`,
      SPICEDB_ENDPOINT: 'spicedb:50051',
      SPICEDB_PRESHARED_KEY: 'test-key',
      ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
    });
    const withoutCertificate = yield* parseSpiceDbConfig({
      SPICEDB_CA_CERT: '  ',
      SPICEDB_ENDPOINT: 'spicedb.internal.example:443',
      SPICEDB_PRESHARED_KEY: 'test-key',
    });
    const failures = yield* Effect.forEach(
      [
        {},
        {
          SPICEDB_ENDPOINT: 'https://spicedb.internal.example/path',
          SPICEDB_PRESHARED_KEY: 'test-key',
        },
        {
          SPICEDB_ENDPOINT: 'spicedb.internal.example:443?credential=test-key',
          SPICEDB_PRESHARED_KEY: 'test-key',
        },
        {
          SPICEDB_ENDPOINT: 'localhost:50051#fragment',
          SPICEDB_PRESHARED_KEY: 'test-key',
        },
        {
          SPICEDB_ENDPOINT: 'localhost:50051',
          SPICEDB_PRESHARED_KEY: '   ',
        },
        {
          SPICEDB_CA_CERT: 'not a certificate',
          SPICEDB_ENDPOINT: 'localhost:50051',
          SPICEDB_PRESHARED_KEY: 'test-key',
        },
      ],
      (environment) => Effect.flip(parseSpiceDbConfig(environment)),
    );

    expect(valid).toEqual({
      caCertificate: SPICEDB_TEST_CERTIFICATE,
      deploymentEnvironment: 'stage',
      endpoint: 'spicedb:50051',
      preSharedKey: 'test-key',
    });
    expect(withoutCertificate).toEqual({ endpoint: 'spicedb.internal.example:443', preSharedKey: 'test-key' });
    expect(failures.every((failure) => Predicate.isTagged(failure, 'SpiceDbConfigError'))).toBe(true);
    expect(failures.some((failure) => failure.reason.includes('test-key'))).toBe(false);
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
      objectId: toSpiceDbActionObjectId(input),
      objectType: SPICEDB_ACTION_OBJECT_TYPE,
    });
    expect(Buffer.from(toSpiceDbActionObjectId(input).slice(3), 'base64url').toString('utf-8')).toBe(
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))([
        input.tenantId,
        input.legalEntityId,
        input.actionKey,
      ]),
    );
    expect(toSpiceDbActionObjectId(input)).not.toBe(
      toSpiceDbActionObjectId({ ...input, actionKey: 'inventory-stock-reserve' }),
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

it.effect('checks a distinct graph object for each tenant and company with no global fallback', () =>
  Effect.gen(function* checksExactScope() {
    const requests: v1.CheckPermissionRequest[] = [];
    const service = makeActionPermissionService(
      makeClient(
        Array.from({ length: 4 }, () => response(v1.CheckPermissionResponse_Permissionship.NO_PERMISSION)),
        requests,
      ),
    );
    const { legalEntityId, ...tenantScope } = input;
    const scopes = [
      input,
      { ...input, legalEntityId: '00000000-0000-4000-8000-000000000004' },
      { ...input, tenantId: '00000000-0000-4000-8000-000000000005' },
      tenantScope,
    ];
    for (const scope of scopes) {
      expect(yield* service.checkActionPermission(scope)).toBe('denied');
    }
    expect(new Set(requests.map((request) => request.resource?.objectId)).size).toBe(4);
    expect(requests.every(({ permission }) => permission === SPICEDB_EXECUTE_PERMISSION)).toBe(true);
    expect(requests.length).toBe(scopes.length);
    expect(legalEntityId).toBeDefined();
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

it.effect('checks propose once on each exact scope without falling back to execute', () =>
  Effect.gen(function* checksExactProposalScope() {
    const requests: v1.CheckPermissionRequest[] = [];
    const scopes = [
      input,
      { ...input, legalEntityId: 'another-company' },
      { ...input, tenantId: 'another-tenant' },
      { actionKey: input.actionKey, principalId: input.principalId, tenantId: input.tenantId },
    ];
    const service = makeActionAuthorityService(
      makeClient(
        [
          response(v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION),
          ...scopes.slice(1).map(() => response(v1.CheckPermissionResponse_Permissionship.NO_PERMISSION)),
        ],
        requests,
      ),
    );
    const decisions = yield* Effect.forEach(scopes, (scope) => service.checkActionProposalPermission(scope), {
      concurrency: 1,
    });

    expect(decisions).toEqual(['allowed', 'denied', 'denied', 'denied']);
    expect(requests).toHaveLength(scopes.length);
    expect(new Set(requests.map(({ resource }) => resource?.objectId)).size).toBe(scopes.length);
    for (const [index, request] of requests.entries()) {
      expect(request.permission).toBe(SPICEDB_PROPOSE_PERMISSION);
      expect(request.resource).toEqual({
        objectId: toSpiceDbActionObjectId(scopes[index] ?? input),
        objectType: SPICEDB_ACTION_OBJECT_TYPE,
      });
      expect(request.subject?.object).toEqual({
        objectId: input.principalId,
        objectType: SPICEDB_PRINCIPAL_OBJECT_TYPE,
      });
      expect(request.consistency?.requirement).toEqual({ fullyConsistent: true, oneofKind: 'fullyConsistent' });
    }
  }),
);

it.effect('fails proposal checks closed for conditional, unspecified, and client failures without another check', () =>
  Effect.gen(function* failsProposalChecksClosed() {
    for (const result of [
      response(v1.CheckPermissionResponse_Permissionship.CONDITIONAL_PERMISSION),
      response(v1.CheckPermissionResponse_Permissionship.UNSPECIFIED),
      Effect.fail(spiceDbPermissionClientError(new Error('private connection evidence'))),
    ]) {
      const requests: v1.CheckPermissionRequest[] = [];
      const failure = yield* Effect.flip(
        makeActionAuthorityService(makeClient([result], requests)).checkActionProposalPermission(input),
      );
      expect(Schema.is(ActionPermissionCheckError)(failure)).toBe(true);
      expect(failure.reason).not.toContain('private connection evidence');
      expect(requests).toHaveLength(1);
      expect(requests[0]?.permission).toBe(SPICEDB_PROPOSE_PERMISSION);
    }
  }),
);

const bulkResponse = (request: v1.CheckBulkPermissionsRequest): v1.CheckBulkPermissionsResponse =>
  v1.CheckBulkPermissionsResponse.create({
    pairs: request.items.map((item) => ({
      request: item,
      response: {
        item: {
          permissionship:
            item.permission === SPICEDB_PROPOSE_PERMISSION
              ? v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION
              : v1.CheckPermissionResponse_Permissionship.NO_PERMISSION,
        },
        oneofKind: 'item',
      },
    })),
  });

it.effect('projects exact propose and execute authority in serial batches of at most 200 graph checks', () =>
  Effect.gen(function* boundedBulkActionAuthority() {
    const requests: v1.CheckBulkPermissionsRequest[] = [];
    const client: SpiceDbPermissionClient = {
      checkBulkPermissions: (request) =>
        Effect.sync(() => {
          requests.push(request);
          return bulkResponse(request);
        }),
      checkPermission: () => Effect.die('Unexpected single permission request'),
      close: () => {},
    };
    const targets = Array.from({ length: 201 }, (_, index) => ({ ...input, actionKey: `work.tasks.action-${index}` }));
    const service = makeActionAuthorityService(client);
    expect(yield* service.checkActionAuthorities([])).toEqual([]);
    expect(requests).toHaveLength(0);
    const decisions = yield* service.checkActionAuthorities(targets);
    expect(requests.map(({ items }) => items.length)).toEqual([200, 200, 2]);
    expect(decisions).toEqual(targets.map((target) => ({ ...target, execute: 'denied', propose: 'allowed' })));
    for (const request of requests) {
      expect(request.consistency?.requirement).toEqual({ fullyConsistent: true, oneofKind: 'fullyConsistent' });
      for (const item of request.items) {
        expect(item.resource?.objectType).toBe(SPICEDB_ACTION_OBJECT_TYPE);
        expect(item.subject?.object?.objectId).toBe(input.principalId);
        expect(item.subject?.optionalRelation).toBe('');
      }
    }
  }),
);

it.effect(
  'fails bulk Action authority closed on missing, mismatched, conditional, error, or failed graph responses',
  () =>
    Effect.gen(function* malformedBulkAuthority() {
      const mutations = [
        () => v1.CheckBulkPermissionsResponse.create(),
        (request: v1.CheckBulkPermissionsRequest) => {
          const result = bulkResponse(request);
          const [first] = result.pairs;
          if (first?.request?.subject !== undefined) {
            first.request.subject.optionalRelation = 'unexpected-userset';
          }
          return result;
        },
        (request: v1.CheckBulkPermissionsRequest) => {
          const result = bulkResponse(request);
          const [first] = result.pairs;
          if (first?.response.oneofKind === 'item') {
            first.response.item.permissionship = v1.CheckPermissionResponse_Permissionship.CONDITIONAL_PERMISSION;
          }
          return result;
        },
        (request: v1.CheckBulkPermissionsRequest) => {
          const result = bulkResponse(request);
          const [first] = result.pairs;
          if (first !== undefined) {
            first.response = {
              error: { code: 13, details: [], message: 'private graph evidence' },
              oneofKind: 'error',
            };
          }
          return result;
        },
      ];
      for (const mutate of mutations) {
        const client: SpiceDbPermissionClient = {
          checkBulkPermissions: (request) => Effect.succeed(mutate(v1.CheckBulkPermissionsRequest.clone(request))),
          checkPermission: () => Effect.die('Unexpected single permission request'),
          close: () => {},
        };
        const failure = yield* Effect.flip(makeActionAuthorityService(client).checkActionAuthorities([input]));
        expect(Schema.is(ActionPermissionCheckError)(failure)).toBe(true);
        expect(failure.reason).not.toContain('private graph evidence');
      }
      const failed: SpiceDbPermissionClient = {
        checkBulkPermissions: () => Effect.fail(spiceDbPermissionClientError()),
        checkPermission: () => Effect.die('Unexpected single permission request'),
        close: () => {},
      };
      expect(
        Schema.is(ActionPermissionCheckError)(
          yield* Effect.flip(makeActionAuthorityService(failed).checkActionAuthorities([input])),
        ),
      ).toBe(true);
    }),
);

it.effect('constructs the live client with a bounded deadline and finalizes it with the scope', () =>
  Effect.gen(function* constructsTheLiveClientWithABoundedDeadline() {
    let finalized = false;
    let observedTimeout = 0;
    const configuration = {
      caCertificate: SPICEDB_TEST_CERTIFICATE,
      endpoint: 'localhost:50051',
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
