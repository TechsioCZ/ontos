import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import { Config, ConfigProvider, Crypto, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import type { HttpClient } from 'effect/unstable/http';
import { expect, it } from 'effect-rstest';

import { loadDotEnvProvider } from '../../src/environment/dotenv-provider.ts';
import { SPICEDB_CHECK_TIMEOUT_MS } from '../../src/permissions/client.ts';
import { SpiceDbConfigError } from '../../src/permissions/config-error.ts';
import { SPICEDB_ROOT_ENV_PATH, loadSpiceDbConfig } from '../../src/permissions/config.ts';
import type { SpiceDbConfigValue } from '../../src/permissions/config.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../src/permissions/schema.ts';
import { openSpiceDbGrpcRpc } from '../../src/permissions/spicedb-grpc-rpc.ts';
import { spiceDbHttpRpc } from '../../src/permissions/spicedb-http-rpc.ts';
import type { SpiceDbHttpRpc } from '../../src/permissions/spicedb-http-rpc.ts';
import type { SpiceDbRpcError } from '../../src/permissions/spicedb-rpc.ts';

// Both transports run against the same SpiceDB (`serve --http-enabled`, the image stage runs), so
// every response must be identical once the per-call revision tokens are cleared.
const loadHttpOrigin = (configuration: SpiceDbConfigValue) =>
  loadDotEnvProvider(SPICEDB_ROOT_ENV_PATH, (reason, cause) => new SpiceDbConfigError({ cause, reason })).pipe(
    Effect.flatMap((fileProvider) =>
      Config.schema(Schema.FiniteFromString, 'SPICEDB_HTTP_PORT').parse(
        ConfigProvider.orElse(ConfigProvider.fromEnv(), fileProvider),
      ),
    ),
    Effect.map((port) => {
      const { hostname } = new URL(`http://${configuration.endpoint}`);
      return new URL(`http://${hostname}:${port}`);
    }),
  );

const makeTransports = Effect.gen(function* makeBothTransports() {
  const configuration = yield* loadSpiceDbConfig();
  const origin = yield* loadHttpOrigin(configuration);
  const wrongKey = `${configuration.preSharedKey}-wrong`;
  const httpWith = (preSharedKey: string) =>
    spiceDbHttpRpc({
      origin,
      preSharedKey: Redacted.make(preSharedKey),
      timeoutMilliseconds: SPICEDB_CHECK_TIMEOUT_MS,
    });
  const grpcWith = (preSharedKey: string) =>
    Effect.acquireRelease(
      Effect.sync(() => openSpiceDbGrpcRpc({ ...configuration, preSharedKey }, SPICEDB_CHECK_TIMEOUT_MS)),
      (rpc) => Effect.sync(() => rpc.close()),
    );
  return {
    grpc: yield* grpcWith(configuration.preSharedKey),
    http: httpWith(configuration.preSharedKey),
    wrongKeyGrpc: yield* grpcWith(wrongKey),
    wrongKeyHttp: httpWith(wrongKey),
  };
});

type Outcome =
  | { readonly code: Option.Option<number>; readonly status: 'failed' }
  | { readonly json: Schema.Json; readonly status: 'ok' };

// The gRPC port needs nothing; the gateway port needs the HttpClient this suite provides.
type ParityRpc = SpiceDbHttpRpc;

const outcome = <Response>(
  effect: Effect.Effect<Response, SpiceDbRpcError, HttpClient.HttpClient>,
  toJson: (response: Response) => Schema.Json,
): Effect.Effect<Outcome, never, HttpClient.HttpClient> =>
  Effect.match(effect, {
    onFailure: ({ code }): Outcome => ({ code, status: 'failed' }),
    onSuccess: (response): Outcome => ({ json: toJson(response), status: 'ok' }),
  });

interface Transports {
  readonly grpc: ParityRpc;
  readonly http: ParityRpc;
}

/** Runs one call through both transports and requires identical outcomes. */
const parity = <Response>(
  transports: Transports,
  call: (rpc: ParityRpc) => Effect.Effect<Response, SpiceDbRpcError, HttpClient.HttpClient>,
  toJson: (response: Response) => Schema.Json,
): Effect.Effect<Outcome, never, HttpClient.HttpClient> =>
  Effect.all({ grpc: outcome(call(transports.grpc), toJson), http: outcome(call(transports.http), toJson) }).pipe(
    Effect.map(({ grpc, http }) => {
      expect(http).toStrictEqual(grpc);
      return grpc;
    }),
  );

const objectReference = (objectType: string, objectId: string) => v1.ObjectReference.create({ objectId, objectType });
const principal = (principalId: string) =>
  v1.SubjectReference.create({ object: objectReference('principal', principalId) });

const membership = (tenantId: string, principalId: string) =>
  v1.Relationship.create({
    relation: 'member',
    resource: objectReference('tenant', tenantId),
    subject: principal(principalId),
  });

const update = (operation: v1.RelationshipUpdate_Operation, relationship: v1.Relationship) =>
  v1.WriteRelationshipsRequest.create({ updates: [v1.RelationshipUpdate.create({ operation, relationship })] });

const fullyConsistent = v1.Consistency.create({ requirement: { fullyConsistent: true, oneofKind: 'fullyConsistent' } });

const checkAccess = (tenantId: string, principalId: string, permission = 'access') =>
  v1.CheckPermissionRequest.create({
    consistency: fullyConsistent,
    permission,
    resource: objectReference('tenant', tenantId),
    subject: principal(principalId),
  });

const bulkItem = (tenantId: string, principalId: string, permission: string) =>
  v1.CheckBulkPermissionsRequestItem.create({
    permission,
    resource: objectReference('tenant', tenantId),
    subject: principal(principalId),
  });

// OntOS reads each pair's kind, permissionship and status code (context-access.ts).
const bulkPairResult = ({ response }: v1.CheckBulkPermissionsPair): Schema.Json => {
  if (response.oneofKind === 'item') {
    return { permissionship: response.item.permissionship };
  }
  if (response.oneofKind === 'error') {
    return { code: response.error.code, message: response.error.message };
  }
  return { kind: 'none' };
};

const checkJson = ({ checkedAt: _revision, ...response }: v1.CheckPermissionResponse) =>
  v1.CheckPermissionResponse.toJson(v1.CheckPermissionResponse.create(response));
const writeJson = ({ writtenAt: _revision, ...response }: v1.WriteRelationshipsResponse) =>
  v1.WriteRelationshipsResponse.toJson(v1.WriteRelationshipsResponse.create(response));
const schemaJson = ({ writtenAt: _revision, ...response }: v1.WriteSchemaResponse) =>
  v1.WriteSchemaResponse.toJson(v1.WriteSchemaResponse.create(response));
const granted = { json: { permissionship: 'PERMISSIONSHIP_HAS_PERMISSION' }, status: 'ok' };
const denied = { json: { permissionship: 'PERMISSIONSHIP_NO_PERMISSION' }, status: 'ok' };
const failedWith = (code: number) => ({ code: Option.some(code), status: 'failed' });

const transportParityProgram = Effect.gen(function* provesTransportParity() {
  const transports = yield* makeTransports;
  const crypto = yield* Crypto.Crypto;
  const [tenantId, memberId, strangerId] = yield* Effect.all([
    crypto.randomUUIDv4,
    crypto.randomUUIDv4,
    crypto.randomUUIDv4,
  ]);

  // WriteSchema: the bootstrapped schema rewrites idempotently; an invalid schema is rejected alike.
  expect(
    yield* parity(
      transports,
      (rpc) => rpc.writeSchema(v1.WriteSchemaRequest.create({ schema: ONTOS_SPICEDB_SCHEMA })),
      schemaJson,
    ),
  ).toStrictEqual({ json: {}, status: 'ok' });
  expect(
    yield* parity(
      transports,
      (rpc) => rpc.writeSchema(v1.WriteSchemaRequest.create({ schema: 'definition broken {' })),
      schemaJson,
    ),
  ).toStrictEqual(failedWith(3));

  // WriteRelationships TOUCH is idempotent through either transport.
  expect(
    yield* parity(
      transports,
      (rpc) => rpc.writeRelationships(update(v1.RelationshipUpdate_Operation.TOUCH, membership(tenantId, memberId))),
      writeJson,
    ),
  ).toStrictEqual({ json: {}, status: 'ok' });

  // CheckPermission: allowed, denied, and an unknown permission.
  expect(
    yield* parity(transports, (rpc) => rpc.checkPermission(checkAccess(tenantId, memberId)), checkJson),
  ).toStrictEqual(granted);
  expect(
    yield* parity(transports, (rpc) => rpc.checkPermission(checkAccess(tenantId, strangerId)), checkJson),
  ).toStrictEqual(denied);
  expect(
    yield* parity(
      transports,
      (rpc) => rpc.checkPermission(checkAccess(tenantId, memberId, 'not_a_permission')),
      checkJson,
    ),
  ).toStrictEqual(failedWith(9));

  // CheckBulkPermissions: per-item permissionship and per-item errors, in request order.
  expect(
    yield* parity(
      transports,
      (rpc) =>
        rpc.checkBulkPermissions(
          v1.CheckBulkPermissionsRequest.create({
            consistency: fullyConsistent,
            items: [
              bulkItem(tenantId, memberId, 'access'),
              bulkItem(tenantId, strangerId, 'access'),
              bulkItem(tenantId, memberId, 'not_a_permission'),
            ],
          }),
        ),
      (response) => response.pairs.map(bulkPairResult),
    ),
  ).toMatchObject({
    json: [
      { permissionship: v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION },
      { permissionship: v1.CheckPermissionResponse_Permissionship.NO_PERMISSION },
      { code: 9 },
    ],
    status: 'ok',
  });

  // ReadRelationships streams the same relationships.
  expect(
    yield* parity(
      transports,
      (rpc) =>
        rpc.readRelationships(
          v1.ReadRelationshipsRequest.create({
            consistency: fullyConsistent,
            relationshipFilter: v1.RelationshipFilter.create({ optionalResourceId: tenantId, resourceType: 'tenant' }),
          }),
        ),
      (responses) =>
        responses.map(({ afterResultCursor: _cursor, readAt: _revision, ...response }) =>
          v1.ReadRelationshipsResponse.toJson(v1.ReadRelationshipsResponse.create(response)),
        ),
    ),
  ).toStrictEqual({ json: [{ relationship: v1.Relationship.toJson(membership(tenantId, memberId)) }], status: 'ok' });

  // A read of an undefined resource type fails with the same status, whether the gateway rejects it
  // before streaming or in an error frame.
  expect(
    yield* parity(
      transports,
      (rpc) =>
        rpc.readRelationships(
          v1.ReadRelationshipsRequest.create({
            consistency: fullyConsistent,
            relationshipFilter: v1.RelationshipFilter.create({ resourceType: 'not_a_definition' }),
          }),
        ),
      (responses) => responses.length,
    ),
  ).toStrictEqual(failedWith(9));

  // CREATE of an existing relationship fails with ALREADY_EXISTS.
  expect(
    yield* parity(
      transports,
      (rpc) => rpc.writeRelationships(update(v1.RelationshipUpdate_Operation.CREATE, membership(tenantId, memberId))),
      writeJson,
    ),
  ).toStrictEqual(failedWith(6));

  // A failed precondition blocks the write with FAILED_PRECONDITION.
  expect(
    yield* parity(
      transports,
      (rpc) =>
        rpc.writeRelationships(
          v1.WriteRelationshipsRequest.create({
            optionalPreconditions: [
              v1.Precondition.create({
                filter: v1.RelationshipFilter.create({ optionalResourceId: tenantId, resourceType: 'tenant' }),
                operation: v1.Precondition_Operation.MUST_NOT_MATCH,
              }),
            ],
            updates: [
              v1.RelationshipUpdate.create({
                operation: v1.RelationshipUpdate_Operation.TOUCH,
                relationship: membership(tenantId, strangerId),
              }),
            ],
          }),
        ),
      writeJson,
    ),
  ).toStrictEqual(failedWith(9));

  // DELETE through the HTTP transport is observed identically by both.
  yield* transports.http.writeRelationships(
    update(v1.RelationshipUpdate_Operation.DELETE, membership(tenantId, memberId)),
  );
  expect(
    yield* parity(transports, (rpc) => rpc.checkPermission(checkAccess(tenantId, memberId)), checkJson),
  ).toStrictEqual(denied);

  // A wrong preshared key is rejected with PERMISSION_DENIED by every RPC through either transport.
  const wrongKey = { grpc: transports.wrongKeyGrpc, http: transports.wrongKeyHttp };
  const permissionDenied = failedWith(7);
  expect(
    yield* parity(wrongKey, (rpc) => rpc.checkPermission(checkAccess(tenantId, memberId)), checkJson),
  ).toStrictEqual(permissionDenied);
  expect(
    yield* parity(
      wrongKey,
      (rpc) =>
        rpc.checkBulkPermissions(
          v1.CheckBulkPermissionsRequest.create({
            consistency: fullyConsistent,
            items: [bulkItem(tenantId, memberId, 'access')],
          }),
        ),
      (response) => response.pairs.map(bulkPairResult),
    ),
  ).toStrictEqual(permissionDenied);
  expect(
    yield* parity(
      wrongKey,
      (rpc) => rpc.writeRelationships(update(v1.RelationshipUpdate_Operation.TOUCH, membership(tenantId, memberId))),
      writeJson,
    ),
  ).toStrictEqual(permissionDenied);
  expect(
    yield* parity(
      wrongKey,
      (rpc) =>
        rpc.readRelationships(
          v1.ReadRelationshipsRequest.create({
            consistency: fullyConsistent,
            relationshipFilter: v1.RelationshipFilter.create({ optionalResourceId: tenantId, resourceType: 'tenant' }),
          }),
        ),
      (responses) => responses.length,
    ),
  ).toStrictEqual(permissionDenied);
  expect(
    yield* parity(
      wrongKey,
      (rpc) => rpc.writeSchema(v1.WriteSchemaRequest.create({ schema: ONTOS_SPICEDB_SCHEMA })),
      schemaJson,
    ),
  ).toStrictEqual(permissionDenied);
});

it.layer(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer), { excludeTestServices: true })(
  'SpiceDB transport parity',
  (suite) => {
    suite.effect(
      'the HTTP gateway transport returns exactly what the gRPC transport returns for every RPC OntOS uses',
      () => transportParityProgram,
    );
  },
);
